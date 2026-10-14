import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, constants, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { compareVersions } from '../platform/semver/public.js'

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
/** What Core's update check needs to install a plugins release and restart only the plugin server. */
export interface PluginServerControl extends PluginServerEndpoint {
  /** Core's files for the server, `<home>/plugins-host`; Core installs plugins releases under `versions/` with `current` naming one. */
  readonly directory: string
  /** The `@kipster/plugins` version of the module the server runs, or null when its package cannot be read. */
  readonly packageVersion: string | null
  /** The newest `@kipster/plugins` version that has run with this installation's plugin data, or null when none is recorded. */
  readonly highestVersion?: string | null
  restart(module?: string): Promise<void>
  /** The next status that ends a start: ready, restarting after a failed launch, failed or stopped. */
  settled(): Promise<PluginServerStatus>
}
export const pluginsPackageName = '@kipster/plugins'
/** The server module inside an installation directory of the `@kipster/plugins` package. */
export const pluginServerModule = (installation: string) => join(installation, 'node_modules', pluginsPackageName, 'dist/server/cli.js')
/** The `@kipster/plugins` version of a `dist/server/cli.js` module, or null when it has no readable package. */
export async function pluginModuleVersion(module: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(resolve(module, '../../../package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== pluginsPackageName || typeof manifest.version !== 'string') return null
    compareVersions(manifest.version, manifest.version)
    return manifest.version
  } catch { return null }
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
  /** Ports the server must never take, such as Core's listener and the embedding server, which may still be free while it starts. */
  reservedPorts?: readonly number[]
  /** Tests only: a local catalogue and fixture service instead of real services. host.json cannot set this. */
  testOnly?: { catalogue: string; baseUrl: string }
}

const host = '127.0.0.1'
const highestFile = 'highest-version'
// The version a launch stages before it spawns its server; renamed onto highest-version once the process exists.
const pendingFile = 'highest-version.pending'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const higher = (a: string | null, b: string | null) => a === null ? b : b === null || compareVersions(a, b) >= 0 ? a : b
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
class Unrecorded extends Error {}

/**
 * Runs the `@kipster/plugins` server named by host.json, or the newer release Core installed in
 * `<home>/plugins-host/current`. It listens on loopback with a bearer token Core keeps in
 * `<home>/plugins-host`; plugins are off whenever it is not ready. It never starts a release older than the newest whose
 * process has started, recorded in `<home>/plugins-host/highest-version`: that one may have migrated the plugin data
 * before it was ready, or without ever becoming ready. A newer release's version is staged in `highest-version.pending`
 * before it is spawned, so a record that cannot be completed, or a Core that stops in between, still counts it.
 */
export class PluginServerSupervisor implements PluginServerControl {
  #status: PluginServerStatus = { state: 'configured' }
  #configured: string
  #module: string
  #version: string | null = null
  #highest: string | null = null
  #recorded: string | null = null
  #pending: string | null = null
  readonly #watchers = new Set<(status: PluginServerStatus) => void>()
  #child: ChildProcess | undefined
  #closing = false
  #stopping = false
  #loop: Promise<void> | undefined
  #queue: Promise<void> = Promise.resolve()
  #wake: (() => void) | undefined
  #token: string | undefined
  readonly #options: Required<Omit<PluginServerOptions, 'onStatus' | 'log' | 'testOnly'>> & Pick<PluginServerOptions, 'onStatus' | 'log' | 'testOnly'>
  readonly #reserved: Set<number>
  readonly #directory: string

  constructor(options: PluginServerOptions) {
    this.#options = { backoff: { initialMs: 1000, maxMs: 60000, attempts: 8 }, readyTimeoutMs: 30000, stableMs: 60000, reservedPorts: [], ...options }
    this.#reserved = new Set(this.#options.reservedPorts)
    this.#configured = this.#module = options.module
    this.#directory = join(options.home, 'plugins-host')
  }
  get status(): PluginServerStatus { return this.#status }
  /** The module the server runs: the configured one, or Core's installed release when that is newer. */
  get module(): string { return this.#module }
  get packageVersion(): string | null { return this.#version }
  get highestVersion(): string | null { return this.#highest }
  get directory(): string { return this.#directory }
  endpoint(): { url: string; token: string } | undefined {
    const status = this.#status
    return status.state === 'ready' && this.#token ? { url: `http://${host}:${status.port}`, token: this.#token } : undefined
  }

  /** Checks the module and token, then runs the server in the background. Failures become status. */
  start(): Promise<void> { return this.#serial(() => this.#begin()) }
  /**
   * Stops only this server and starts it again, replacing the configured module when given. It starts the newer of
   * the configured module and Core's installed release, so switching `current` and restarting runs that release.
   */
  restart(module?: string): Promise<void> {
    if (this.#closing) return Promise.resolve()
    // The old server's endpoint ends now, not when its process has exited.
    this.#set({ state: 'starting' })
    this.#halt()
    return this.#serial(async () => {
      await this.#stopped()
      if (module !== undefined) this.#configured = module
      await this.#begin()
    })
  }
  settled(): Promise<PluginServerStatus> {
    if (this.#closing) return Promise.resolve({ state: 'stopped' })
    return new Promise(resolve => {
      const watcher = (status: PluginServerStatus) => {
        if (!['ready', 'restarting', 'failed', 'stopped'].includes(status.state)) return
        this.#watchers.delete(watcher)
        resolve(status)
      }
      this.#watchers.add(watcher)
    })
  }
  close(): Promise<void> {
    this.#closing = true
    this.#set({ state: 'stopped' })
    this.#halt()
    return this.#serial(() => this.#stopped())
  }

  /** Runs start, restart and close one at a time, so only one loop and one server ever run. */
  #serial(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work)
    this.#queue = next.catch(() => undefined)
    return next
  }
  async #begin(): Promise<void> {
    if (this.#loop || this.#closing) return
    this.#stopping = false
    this.#set({ state: 'starting' })
    try { await this.#prepare() } catch (error) { this.#set({ state: 'failed', reason: message(error) }); return }
    if (this.#closing) return
    this.#loop = this.#run()
  }
  #halt(): void {
    this.#stopping = true
    this.#wake?.()
    void this.#stopChild()
  }
  async #stopped(): Promise<void> {
    // A start queued before this stop may have cleared the flag.
    this.#stopping = true
    this.#wake?.()
    await this.#stopChild()
    await this.#loop
    // A launch that was spawning while the stop began leaves its child for this second check.
    await this.#stopChild()
    this.#loop = undefined
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
    for (const watcher of [...this.#watchers]) watcher(status)
  }
  /** The configured module, or the release in `current` when its version is newer. An unreadable release is ignored. */
  async #choose(): Promise<void> {
    const configured = await pluginModuleVersion(this.#configured)
    let installed: { module: string; version: string } | undefined
    try {
      const module = await realpath(pluginServerModule(join(this.#directory, 'current')))
      const version = await pluginModuleVersion(module)
      if (version !== null) installed = { module, version }
    } catch { /* No release installed by Core. */ }
    const useInstalled = installed && (configured === null || compareVersions(installed.version, configured) > 0)
    this.#module = useInstalled ? installed!.module : this.#configured
    this.#version = useInstalled ? installed!.version : configured
  }
  /**
   * A recorded version. A missing file means none; an unreadable or invalid one is ignored, like an unreadable port
   * file, and logged but kept until a server starts and records its own version.
   */
  async #readVersion(name: string): Promise<string | null> {
    const file = join(this.#directory, name)
    let text: string
    try { text = await readFile(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#options.log?.(`Ignoring unreadable ${file}: ${message(error)}`)
      return null
    }
    try { const version = text.trim(); compareVersions(version, version); return version }
    catch { this.#options.log?.(`Ignoring invalid ${file}.`); return null }
  }
  /** Whether the server's version is newer than the record, so a launch stages it and records it once spawned. */
  #raises(): boolean {
    return this.#version !== null && (this.#recorded === null || compareVersions(this.#version, this.#recorded) > 0)
  }
  #unrecorded(error: unknown, stopped: boolean): Unrecorded {
    const file = join(this.#directory, highestFile)
    return new Unrecorded(`Core could not record plugin server version ${this.#version} in ${file} (${message(error)}), so it ${stopped ? 'stopped' : 'did not start'} the server; make ${this.#directory} writable and restart Core`)
  }
  /** Replaces the staged version through a temporary file, so a version staged earlier is never left half written. */
  async #writePending(version: string): Promise<void> {
    const file = join(this.#directory, pendingFile), temporary = `${file}.${process.pid}.tmp`
    try {
      await writeFile(temporary, `${version}\n`, { mode: 0o600 })
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
  /** Stages a newer version before its server starts; a failure throws so the server never runs unrecorded. */
  async #stage(): Promise<void> {
    if (!this.#raises()) return
    try { await this.#writePending(this.#version!) } catch (error) { throw this.#unrecorded(error, false) }
  }
  /** After a launch that created no server process, the staged version no longer counts; one staged by an earlier Core still does. */
  async #unstage(): Promise<void> {
    if (!this.#raises()) return
    const file = join(this.#directory, pendingFile)
    try {
      if (this.#pending === null) await rm(file, { force: true })
      else if (this.#pending !== this.#version) await this.#writePending(this.#pending)
    } catch (error) { this.#options.log?.(`Could not reset ${file}: ${message(error)}`) }
  }
  /**
   * Renames the staged version onto the record once its server process exists, ready or not. It counts for this process
   * even when the rename fails, and the staged file keeps counting it for the next; the failure throws so the server is
   * stopped.
   */
  async #recordHighest(): Promise<void> {
    if (!this.#raises()) return
    const version = this.#version!
    this.#highest = higher(version, this.#highest)
    try { await rename(join(this.#directory, pendingFile), join(this.#directory, highestFile)) } catch (error) { throw this.#unrecorded(error, true) }
    this.#recorded = version
    this.#pending = null
  }
  async #prepare(): Promise<void> {
    await this.#choose()
    // Read even when the module is missing, so the update check never offers a release this record refuses. A newer
    // version that ran in this process but could not be recorded still counts, and so does one staged on disk.
    this.#recorded = await this.#readVersion(highestFile)
    const pending = await this.#readVersion(pendingFile)
    this.#pending = pending !== null && (this.#recorded === null || compareVersions(pending, this.#recorded) > 0) ? pending : null
    this.#highest = higher(higher(this.#recorded, this.#pending), this.#highest)
    try { await access(this.#module, constants.R_OK) } catch { throw new Error(`The plugin server module is missing: ${this.#module}`) }
    if (this.#version !== null && this.#highest !== null && compareVersions(this.#version, this.#highest) < 0)
      throw new Error(`The plugin server ${this.#version} is older than ${this.#highest}, which already ran with this plugin data; install ${pluginsPackageName} ${this.#highest} or newer`)
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
    if (recorded && Number.isInteger(recorded) && recorded > 0 && recorded < 65536 && !this.#reserved.has(recorded) && await bindable(recorded)) return recorded
    let port = await freePort()
    while (this.#reserved.has(port)) port = await freePort()
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
        if (error instanceof Incompatible || error instanceof Unrecorded) { this.#set({ state: 'failed', reason: error.message }); return }
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
    await this.#stage()
    const { child, exited } = await this.#spawn(port).catch(async error => { await this.#unstage(); throw error })
    let exitReason: string | undefined
    void exited.then(reason => { exitReason = reason })
    // The server opens and migrates the plugin data before it is ready, so a spawned version counts even if it never is.
    try { await this.#recordHighest() } catch (error) { await this.#stopChild(); throw error }
    const deadline = Date.now() + this.#options.readyTimeoutMs
    let ready: { version?: string } | undefined
    try {
      while (!exitReason && !this.#stopping && !(ready = await this.#ready(port))) {
        if (Date.now() >= deadline) throw new Error(`The plugin server was not ready within ${this.#options.readyTimeoutMs} ms`)
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 100))])
      }
      if (exitReason) throw new Error(`${exitReason} before it was ready`)
    } catch (error) {
      child.kill('SIGKILL'); await exited
      throw error
    }
    if (!ready || this.#stopping) { await this.#stopChild(); return { reason: 'stopping', stable: false } }
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
