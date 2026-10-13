import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, constants, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'

export type PluginServerStatus =
  | { state: 'configured' }
  | { state: 'starting'; port?: number }
  | { state: 'ready'; port: number; version?: string }
  | { state: 'restarting'; attempt: number; reason: string }
  | { state: 'failed'; reason: string }
  | { state: 'stopped' }
/** How later Core work reaches the plugin server: an endpoint only while it is ready. */
export interface PluginServerEndpoint {
  endpoint(): { url: string; token: string } | undefined
}
export interface PluginServerOptions {
  home: string
  /** Absolute path of the package's `dist/server/cli.js`. */
  module: string
  onStatus?: (status: PluginServerStatus) => void
  log?: (message: string) => void
  /** Restart delays double from initialMs up to maxMs; after `attempts` consecutive failures the server is failed. */
  backoff?: { initialMs: number; maxMs: number; attempts: number }
  readyTimeoutMs?: number
  /** A server that stayed ready this long starts its next restart from the first attempt again. */
  stableMs?: number
  /** Tests only: a local catalogue and fixture service instead of real services. host.json cannot set this. */
  testOnly?: { catalogue: string; baseUrl: string }
}

const host = '127.0.0.1'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
// Variables the plugin server may need; Core's database URLs, provider keys and NODE_OPTIONS stay out.
const inherited = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'KIPSTER_PLUGINS_CLIENT_METADATA_URL']
// Preloaded into the server: it stops when Core's end of stdin closes, so a crashed Core leaves no server behind.
const parentWatch = "data:text/javascript,process.stdin.on('end',()=>process.kill(process.pid,'SIGTERM'));process.stdin.resume();process.stdin.unref()"

async function bindable(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
    return true
  } catch { return false } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
class Incompatible extends Error {}

/**
 * Runs the `@kipster/plugins` server named by host.json. It listens on loopback with a bearer
 * token Core keeps in `<home>/plugins-host`; plugins are off whenever it is not ready.
 */
export class PluginServerSupervisor implements PluginServerEndpoint {
  #status: PluginServerStatus = { state: 'configured' }
  #module: string
  #child: ChildProcess | undefined
  #closing = false
  #stopping = false
  #loop: Promise<void> | undefined
  #wake: (() => void) | undefined
  #token: string | undefined
  readonly #options: Required<Omit<PluginServerOptions, 'onStatus' | 'log' | 'testOnly'>> & Pick<PluginServerOptions, 'onStatus' | 'log' | 'testOnly'>
  readonly #directory: string

  constructor(options: PluginServerOptions) {
    this.#options = { backoff: { initialMs: 1000, maxMs: 60000, attempts: 8 }, readyTimeoutMs: 30000, stableMs: 60000, ...options }
    this.#module = options.module
    this.#directory = join(options.home, 'plugins-host')
  }
  get status(): PluginServerStatus { return this.#status }
  get module(): string { return this.#module }
  endpoint(): { url: string; token: string } | undefined {
    const status = this.#status
    return status.state === 'ready' && this.#token ? { url: `http://${host}:${status.port}`, token: this.#token } : undefined
  }

  /** Checks the module and token, then runs the server in the background. Failures become status. */
  async start(): Promise<void> {
    if (this.#loop || this.#closing) return
    this.#stopping = false
    this.#set({ state: 'starting' })
    try { await this.#prepare() } catch (error) { this.#set({ state: 'failed', reason: message(error) }); return }
    if (this.#closing) return
    this.#loop = this.#run()
  }
  /** Stops only this server and starts it again, from `module` when given (for example after an update). */
  async restart(module?: string): Promise<void> {
    if (this.#closing) return
    this.#stopping = true
    this.#wake?.()
    await this.#stopChild()
    await this.#loop
    await this.#stopChild()
    this.#loop = undefined
    if (module !== undefined) this.#module = module
    await this.start()
  }
  async close(): Promise<void> {
    this.#closing = this.#stopping = true
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
  #set(status: PluginServerStatus): void {
    if (this.#status.state === 'stopped' && this.#closing) return
    this.#status = status
    this.#options.onStatus?.(status)
  }
  async #prepare(): Promise<void> {
    try { await access(this.#module, constants.R_OK) } catch { throw new Error(`The plugin server module is missing: ${this.#module}`) }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await chmod(this.#directory, 0o700)
    const file = join(this.#directory, 'token')
    try { await writeFile(file, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await chmod(file, 0o600)
    const token = (await readFile(file, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error(`The plugin server token file is invalid; remove ${file} to create a new one`)
    this.#token = token
  }
  /** The recorded port when it is free, otherwise another free loopback port, recorded for next time. */
  async #choosePort(): Promise<number> {
    const file = join(this.#directory, 'port')
    let recorded: number | undefined
    try { recorded = Number((await readFile(file, 'utf8')).trim()) } catch { /* first start */ }
    if (recorded && Number.isInteger(recorded) && recorded > 0 && recorded < 65536 && await bindable(recorded)) return recorded
    const port = await freePort()
    if (recorded) this.#options.log?.(`Plugin server port ${recorded} is in use; using ${port}.`)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${port}\n`, { mode: 0o600 })
    await rename(temporary, file)
    return port
  }
  async #sleep(ms: number): Promise<void> {
    if (this.#stopping) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#wake = undefined; resolve() }, ms)
      this.#wake = () => { clearTimeout(timer); this.#wake = undefined; resolve() }
    })
  }
  /** The server's version once /health is ok with control API v1 and the token opens /v1; undefined while not ready. */
  async #ready(port: number): Promise<{ version?: string } | undefined> {
    try {
      const health = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (health.status !== 200) return undefined
      const body = await health.json() as { status?: unknown; version?: unknown; controlApiVersions?: unknown }
      if (body.status !== 'ok') return undefined
      if (!Array.isArray(body.controlApiVersions) || !body.controlApiVersions.includes('v1')) throw new Incompatible('The plugin server does not offer control API v1; install a compatible @kipster/plugins')
      const control = await fetch(`http://${host}:${port}/v1`, { headers: { authorization: `Bearer ${this.#token}` }, signal: AbortSignal.timeout(2000) })
      await control.body?.cancel()
      if (control.status !== 200) return undefined
      return typeof body.version === 'string' ? { version: body.version } : {}
    } catch (error) {
      if (error instanceof Incompatible) throw error
      return undefined
    }
  }
  async #run(): Promise<void> {
    const { backoff } = this.#options
    let attempt = 0
    while (!this.#stopping) {
      let reason: string
      try {
        const outcome = await this.#launch()
        if (this.#stopping) break
        if (outcome.stable) attempt = 0
        reason = outcome.reason
      } catch (error) {
        if (this.#stopping) break
        if (error instanceof Incompatible) { this.#set({ state: 'failed', reason: error.message }); return }
        reason = message(error)
      }
      attempt++
      if (attempt > backoff.attempts) {
        this.#set({ state: 'failed', reason: `The plugin server failed ${backoff.attempts} restarts; last: ${reason}` })
        return
      }
      this.#options.log?.(`Plugin server stopped (${reason}); restart ${attempt} follows.`)
      this.#set({ state: 'restarting', attempt, reason })
      await this.#sleep(Math.min(backoff.initialMs * 2 ** (attempt - 1), backoff.maxMs))
    }
  }
  /** Runs one server until it ends: resolves with why it ended, or throws when it never became ready. */
  async #launch(): Promise<{ reason: string; stable: boolean }> {
    const port = await this.#choosePort()
    if (this.#stopping) return { reason: 'stopping', stable: false }
    this.#set({ state: 'starting', port })
    const { child, exited } = await this.#spawn(port)
    let exitReason: string | undefined
    void exited.then(reason => { exitReason = reason })
    const deadline = Date.now() + this.#options.readyTimeoutMs
    let ready: { version?: string } | undefined
    try {
      while (!exitReason && !this.#stopping && !(ready = await this.#ready(port))) {
        if (Date.now() >= deadline) throw new Error(`The plugin server was not ready within ${this.#options.readyTimeoutMs} ms`)
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 100))])
      }
    } catch (error) {
      child.kill('SIGKILL'); await exited
      throw error
    }
    if (exitReason) throw new Error(`${exitReason} before it was ready`)
    if (this.#stopping) return { reason: 'stopping', stable: false }
    this.#set({ state: 'ready', port, ...ready })
    const readyAt = Date.now()
    const reason = await exited
    return { reason, stable: Date.now() - readyAt >= this.#options.stableMs }
  }
  async #spawn(port: number): Promise<{ child: ChildProcess; exited: Promise<string> }> {
    const { home, testOnly } = this.#options
    await mkdir(join(home, 'logs'), { recursive: true, mode: 0o700 })
    const log = await open(join(home, 'logs', 'plugins.log'), 'a', 0o600)
    try {
      const env: Record<string, string> = {}
      for (const name of inherited) if (process.env[name] !== undefined) env[name] = process.env[name]!
      // The token reaches the server only through its environment, never its arguments.
      env.KIPSTER_PLUGINS_TOKEN = this.#token!
      // Always the file key backend: a background host cannot answer keychain prompts.
      const args = ['--import', parentWatch, this.#module, '--port', String(port), '--home', join(home, 'plugins'), '--key-backend', 'file',
        ...(testOnly ? ['--catalogue', testOnly.catalogue, '--test-only-base-url', testOnly.baseUrl] : [])]
      const child = spawn(process.execPath, args, { cwd: home, env, stdio: ['pipe', log.fd, log.fd] })
      this.#child = child
      const exited = new Promise<string>(resolve => {
        child.once('error', error => resolve(`The plugin server could not start: ${error.message}`))
        child.once('exit', (code, signal) => resolve(`The plugin server exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      })
      return { child, exited }
    } finally { await log.close() }
  }
}
