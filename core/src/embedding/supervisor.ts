import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants, mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname, join, sep } from 'node:path'
import { validateEmbeddingProvider, type EmbeddingProvider } from './index.js'

/** The `embedding.server` entry of host.json: an installed llama-server and model inside the Kipster home. */
export interface EmbeddingServerConfig {
  binary: string
  model: string
  modelSha256: string
  modelName: string
  port: number
}
export type EmbeddingServerStatus =
  | { state: 'configured' }
  | { state: 'starting'; port?: number }
  | { state: 'ready'; port: number; reused: boolean }
  | { state: 'restarting'; attempt: number; reason: string }
  | { state: 'failed'; reason: string }
  | { state: 'stopped' }
export interface EmbeddingServerOptions {
  home: string
  config: EmbeddingServerConfig
  onStatus?: (status: EmbeddingServerStatus) => void
  log?: (message: string) => void
  /** Restart delays double from initialMs up to maxMs; after `attempts` consecutive failures the server is failed. */
  backoff?: { initialMs: number; maxMs: number; attempts: number }
  readyTimeoutMs?: number
  /** A server that stayed ready this long starts its next restart from the first attempt again. */
  stableMs?: number
  watchIntervalMs?: number
}

export const contextSize = 8192
const host = '127.0.0.1'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const inside = (path: string, root: string) => path.startsWith(root + sep)

async function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(true) })
    socket.once('error', error => resolve((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'))
  })
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer)
  return hash.digest('hex')
}

/**
 * Runs the Kipster-installed llama-server for embeddings. A server is Kipster's only when it
 * answers with the API key kept in the Kipster home and serves the expected model; Core never
 * starts or reuses another llama-server.
 */
export class EmbeddingServerSupervisor {
  readonly model: string
  #status: EmbeddingServerStatus = { state: 'configured' }
  #listeners = new Set<() => void>()
  #child: ChildProcess | undefined
  #closing = false
  #loop: Promise<void> | undefined
  #wake: (() => void) | undefined
  #key: string | undefined
  readonly #options: Required<Omit<EmbeddingServerOptions, 'onStatus' | 'log'>> & Pick<EmbeddingServerOptions, 'onStatus' | 'log'>
  readonly #directory: string

  constructor(options: EmbeddingServerOptions) {
    this.#options = { backoff: { initialMs: 1000, maxMs: 60000, attempts: 8 }, readyTimeoutMs: 120000, stableMs: 60000, watchIntervalMs: 5000, ...options }
    this.#directory = join(options.home, 'embedding')
    this.model = options.config.modelName
  }
  status(): EmbeddingServerStatus { return this.#status }
  get apiKey(): string | undefined { return this.#key }
  get stateFile(): string { return join(this.#directory, 'server.json') }

  /** Checks the installed files, then starts or reuses the server in the background. Failures become status. */
  async start(): Promise<void> {
    if (this.#loop || this.#closing) return
    this.#set({ state: 'starting' })
    try { await this.#prepare() } catch (error) { this.#set({ state: 'failed', reason: message(error) }); return }
    this.#loop = this.#run()
  }
  /** Resolves with the server endpoint once it is ready; rejects when it failed, stopped or stays unready. */
  async whenReady(signal?: AbortSignal, timeoutMs = 30000): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      signal?.throwIfAborted()
      const status = this.#status
      if (status.state === 'ready') return `http://${host}:${status.port}`
      if (status.state === 'failed') throw new Error(`Embedding server failed: ${status.reason}`)
      if (status.state === 'stopped' || this.#closing) throw new Error('Embedding server is stopped')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Embedding server is not ready (${status.state})`)
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); this.#listeners.delete(done); resolve() }
        const timer = setTimeout(done, remaining)
        signal?.addEventListener('abort', done, { once: true })
        this.#listeners.add(done)
      })
    }
  }
  /** Stops a server this supervisor started. A reused server keeps running. */
  async close(): Promise<void> {
    this.#closing = true
    this.#wake?.()
    await this.#stopChild()
    await this.#loop
    // A launch that was spawning while close began leaves its child for this second check.
    await this.#stopChild()
    this.#set({ state: 'stopped' })
  }
  async #stopChild(): Promise<void> {
    const child = this.#child
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }

  #set(status: EmbeddingServerStatus): void {
    if (this.#status.state === 'stopped') return
    this.#status = status
    this.#options.onStatus?.(status)
    for (const listener of [...this.#listeners]) listener()
  }
  async #prepare(): Promise<void> {
    const { home, config } = this.#options
    const root = await realpath(home)
    let binary: string, model: string
    try { [binary, model] = [await realpath(config.binary), await realpath(config.model)] }
    catch { throw new Error('The installed llama-server or embedding model is missing; reinstall or update Kipster') }
    // Symlinks must not lead Core to a llama.cpp or model outside the Kipster home.
    if (!inside(binary, root) || !inside(model, root)) throw new Error('Core runs only the llama-server and model installed in the Kipster home')
    try { await access(binary, constants.X_OK) } catch { throw new Error('The installed llama-server is not executable') }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const info = await stat(model), state = await this.#state()
    const known = state.model
    if (!(known?.path === model && known.size === info.size && known.mtimeMs === info.mtimeMs && known.sha256 === config.modelSha256)) {
      if (await sha256(model) !== config.modelSha256) throw new Error('The embedding model does not match its expected SHA-256; reinstall or update Kipster')
      await this.#save({ ...state, model: { path: model, size: info.size, mtimeMs: info.mtimeMs, sha256: config.modelSha256 } })
    }
    const keyFile = join(this.#directory, 'api-key')
    try { await writeFile(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    this.#key = (await readFile(keyFile, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/.test(this.#key)) throw new Error(`Embedding server key file is invalid; remove ${keyFile} to create a new one`)
  }
  async #state(): Promise<{ port?: number; model?: { path: string; size: number; mtimeMs: number; sha256: string } }> {
    try {
      const value = JSON.parse(await readFile(this.stateFile, 'utf8')) as Record<string, unknown>
      return value && typeof value === 'object' ? value : {}
    } catch { return {} }
  }
  async #save(state: object): Promise<void> {
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600 })
    await rename(temporary, this.stateFile)
  }
  async #sleep(ms: number): Promise<void> {
    if (this.#closing) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#wake = undefined; resolve() }, ms)
      this.#wake = () => { clearTimeout(timer); this.#wake = undefined; resolve() }
    })
  }
  async #request(port: number, path: string, key = this.#key, timeoutMs = 2000): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`http://${host}:${port}${path}`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) })
    let body: unknown
    try { body = await response.json() } catch { body = undefined }
    return { status: response.status, body }
  }
  /**
   * True when the server refuses a wrong key, answers Kipster's key and serves the expected model.
   * Answering the key alone proves nothing: a server without a key accepts any.
   */
  async #ours(port: number): Promise<boolean> {
    try {
      if ((await this.#request(port, '/v1/models', randomBytes(32).toString('hex'))).status !== 401) return false
      const { status, body } = await this.#request(port, '/v1/models')
      const models = (body as { data?: { id?: unknown }[] } | undefined)?.data
      return status === 200 && Array.isArray(models) && models.some(item => item?.id === this.model)
    } catch { return false }
  }
  async #health(port: number): Promise<number | undefined> {
    try { return (await this.#request(port, '/health')).status } catch { return undefined }
  }
  async #healthy(port: number): Promise<boolean> { return await this.#health(port) === 200 }
  /** Reuses Kipster's server on the recorded port, or picks a port: the recorded one when free, another when held. */
  async #choosePort(): Promise<{ port: number; reused: boolean }> {
    const state = await this.#state()
    const recorded = Number.isInteger(state.port) ? state.port! : this.#options.config.port
    if (await listening(recorded)) {
      // A Kipster server left running answers 503 while it still loads its model.
      const deadline = Date.now() + Math.min(this.#options.readyTimeoutMs, 30000)
      while (!this.#closing) {
        const health = await this.#health(recorded)
        if (health === 200 && await this.#ours(recorded)) return { port: recorded, reused: true }
        if (health !== 503 || Date.now() >= deadline) break
        await this.#sleep(500)
      }
      if (await listening(recorded)) {
        const port = await freePort()
        this.#options.log?.(`Embedding server port ${recorded} is held by another program; using ${port}.`)
        await this.#save({ ...await this.#state(), port })
        return { port, reused: false }
      }
    }
    if (state.port !== recorded) await this.#save({ ...state, port: recorded })
    return { port: recorded, reused: false }
  }
  async #run(): Promise<void> {
    const { backoff } = this.#options
    let attempt = 0
    while (!this.#closing) {
      let reason: string
      try {
        const outcome = await this.#launch()
        if (this.#closing) break
        if (outcome.stable) attempt = 0
        reason = outcome.reason
      } catch (error) {
        if (this.#closing) break
        reason = message(error)
      }
      attempt++
      if (attempt > backoff.attempts) {
        this.#set({ state: 'failed', reason: `llama-server failed ${backoff.attempts} restarts; last: ${reason}` })
        return
      }
      this.#options.log?.(`Embedding server stopped (${reason}); restart ${attempt} follows.`)
      this.#set({ state: 'restarting', attempt, reason })
      await this.#sleep(Math.min(backoff.initialMs * 2 ** (attempt - 1), backoff.maxMs))
    }
  }
  /** Runs one server until it ends: resolves with why it ended, or throws when it never became ready. */
  async #launch(): Promise<{ reason: string; stable: boolean }> {
    const { port, reused } = await this.#choosePort()
    if (this.#closing) return { reason: 'closing', stable: false }
    if (reused) {
      this.#set({ state: 'ready', port, reused: true })
      const readyAt = Date.now()
      let misses = 0
      while (!this.#closing && misses < 3) {
        await this.#sleep(this.#options.watchIntervalMs)
        misses = !this.#closing && !await this.#healthy(port) ? misses + 1 : 0
      }
      return { reason: 'the reused llama-server stopped answering', stable: Date.now() - readyAt >= this.#options.stableMs }
    }
    this.#set({ state: 'starting', port })
    const { child, exited } = await this.#spawn(port)
    let exitReason: string | undefined
    void exited.then(reason => { exitReason = reason })
    const deadline = Date.now() + this.#options.readyTimeoutMs
    while (!exitReason && !this.#closing && !(await this.#healthy(port) && await this.#ours(port))) {
      if (Date.now() >= deadline) {
        child.kill('SIGKILL'); await exited
        throw new Error(`llama-server was not ready within ${this.#options.readyTimeoutMs} ms`)
      }
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 250))])
    }
    if (exitReason) throw new Error(`${exitReason} before it was ready`)
    if (this.#closing) return { reason: 'closing', stable: false }
    this.#set({ state: 'ready', port, reused: false })
    const readyAt = Date.now()
    const reason = await exited
    return { reason, stable: Date.now() - readyAt >= this.#options.stableMs }
  }
  async #spawn(port: number): Promise<{ child: ChildProcess; exited: Promise<string> }> {
    const { home, config } = this.#options
    await mkdir(join(home, 'logs'), { recursive: true, mode: 0o700 })
    const log = await open(join(home, 'logs', 'embedding-server.log'), 'a', 0o600)
    try {
      // No inherited environment: llama-server reads LLAMA_ARG_* variables, and Core's own
      // configuration must decide every setting. The release keeps its libraries beside it.
      const child = spawn(config.binary, [
        '--embedding', '--model', config.model, '--alias', config.modelName,
        '--ctx-size', String(contextSize), '--batch-size', String(contextSize), '--ubatch-size', String(contextSize), '--parallel', '1',
        '--host', host, '--port', String(port), '--api-key-file', join(this.#directory, 'api-key'), '--no-webui', '--offline',
      ], { cwd: dirname(config.binary), env: process.platform === 'linux' ? { LD_LIBRARY_PATH: dirname(config.binary) } : {}, stdio: ['ignore', log.fd, log.fd] })
      this.#child = child
      const exited = new Promise<string>(resolve => {
        child.once('error', error => resolve(`llama-server could not start: ${error.message}`))
        child.once('exit', (code, signal) => resolve(`llama-server exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
      return { child, exited }
    } finally { await log.close() }
  }
}

/**
 * An EmbeddingProvider for Core that waits for the supervised server and sends each request to
 * its current endpoint, creating the configured package's provider again when the port changes.
 */
export function supervisedEmbeddingProvider(supervisor: EmbeddingServerSupervisor, create: (options: unknown) => EmbeddingProvider, options: Record<string, unknown>, port: number): EmbeddingProvider {
  const make = (endpoint: string) => {
    const apiKey = supervisor.apiKey
    const provider = create({ ...options, endpoint, model: supervisor.model, ...(apiKey ? { apiKey } : {}) })
    validateEmbeddingProvider(provider)
    return { endpoint, apiKey, provider }
  }
  let current = make(`http://${host}:${port}`)
  return {
    id: current.provider.id, model: current.provider.model, contractMajor: 1,
    async embed(text, signal) {
      const endpoint = await supervisor.whenReady(signal)
      if (endpoint !== current.endpoint || supervisor.apiKey !== current.apiKey) current = make(endpoint)
      return current.provider.embed(text, signal)
    },
  }
}
