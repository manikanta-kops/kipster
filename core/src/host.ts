#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open } from 'node:fs/promises'
import { constants, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost, AdapterRegistry, type Runtime, type TextServer } from './runtime.js'
import type { TranscriptionProvider } from './transcription/index.js'
import { MigrationHistoryError, Postgres } from './platform/postgres/public.js'
import { validateEmbeddingProvider, type EmbeddingProvider } from './embedding/index.js'
import { boundedEmbed } from './modules/memory/public.js'
import { readHostConfig, type HostConfig } from './host-config.js'
import { playground, playgroundNames } from './starter/playground.js'
import { control, ownControl, type HostStatus } from './host-control.js'
import { safeHostError } from './host-diagnostics.js'
export { readHostConfig, validateHostConfig } from './host-config.js'
export { control, ownControl, recoverStoppedControl } from './host-control.js'

function environment(config: HostConfig): void {
  for (const [key, value] of Object.entries(config.environment ?? {})) process.env[key] = value
}
const adapterData = (config: HostConfig, id: string) => join(config.home, 'providers', id)
async function transcription(config: HostConfig, signal?: AbortSignal): Promise<TranscriptionProvider | undefined> {
  if (!config.transcription) return undefined
  const module = await import(pathToFileURL(config.transcription.module).href) as { createTranscriptionProvider?: (options: unknown) => TranscriptionProvider }
  signal?.throwIfAborted()
  if (typeof module.createTranscriptionProvider !== 'function') throw new Error('Configured transcription package must export createTranscriptionProvider.')
  const provider = module.createTranscriptionProvider(config.transcription.options)
  if (provider.contractMajor !== 1 || typeof provider.readiness !== 'function' || typeof provider.close !== 'function' || !Array.isArray(provider.inputTypes)) throw new Error('Transcription contract is incompatible.')
  return provider
}
export async function loadEmbeddingProvider(config: HostConfig): Promise<EmbeddingProvider | undefined> {
  if (!config.embedding) return undefined
  const module = await import(pathToFileURL(config.embedding.module).href) as { createEmbeddingProvider?: (options: unknown) => EmbeddingProvider }
  if (typeof module.createEmbeddingProvider !== 'function') throw new Error('Configured embedding package must export createEmbeddingProvider.')
  const provider = module.createEmbeddingProvider(config.embedding.options)
  validateEmbeddingProvider(provider)
  return provider
}
async function runtime(config: HostConfig, providers: boolean, signal?: AbortSignal): Promise<Runtime> {
  const provider = providers ? await transcription(config, signal) : undefined
  try {
    signal?.throwIfAborted()
    return await openRuntime({ connectionString: config.databaseUrl, home: config.home, names: playgroundNames, starter: await playground(),
      ...(config.taskDataUrl ? { taskDataConnectionString: config.taskDataUrl } : {}),
      ...(config.executionLimit ? { executionLimit: config.executionLimit } : {}),
      ...(providers && config.embedding ? { embedding: (await loadEmbeddingProvider(config))! } : {}),
      ...(provider ? { transcription: provider } : {}),
      ...(config.updates ? { updates: config.updates } : {}),
      onError: error => { console.error(`A Core background operation failed: ${safeHostError(error, config, process.env)}`) },
    })
  } catch (error) { await provider?.close(); throw error }
}
/** Foreground composition only. Supervision belongs to the host service manager. */
export async function serve(config: HostConfig): Promise<void> {
  try { await access(join(config.home, 'updates', 'hold')); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  environment(config)
  const status: HostStatus = { state: 'starting', pid: process.pid, instance: randomUUID() }
  let requestStop!: () => void
  const stopped = new Promise<void>(resolve => { requestStop = resolve })
  const abort = new AbortController()
  let core: Runtime | undefined, registry: AdapterRegistry | undefined, dispatcher: TextDispatcher | undefined, server: TextServer | undefined
  let force: ReturnType<typeof setTimeout> | undefined
  let dispatcherClosing: Promise<void> | undefined
  const beginShutdown = () => {
    status.state = 'stopping'
    force ??= setTimeout(() => { console.error('Host shutdown exceeded 15 seconds; inspect ownership and recover durable work at next startup.'); process.exit(1) }, 15000)
    abort.abort()
    // close() synchronously fences a dispatcher whose start() is still awaiting recovery.
    if (dispatcher) {
      dispatcherClosing ??= dispatcher.close()
      void dispatcherClosing.catch(() => undefined)
    }
    requestStop()
  }
  const owner = await ownControl(config.home, status, beginShutdown)
  process.on('SIGTERM', beginShutdown); process.on('SIGINT', beginShutdown)
  const deadline = setTimeout(() => { console.error('Host startup exceeded 60 seconds. Inspect dependencies and the stale ownership directory.'); process.exit(1) }, 60000)
  try {
    if (abort.signal.aborted) return
    core = await runtime(config, true, abort.signal)
    if (abort.signal.aborted) return
    registry = new AdapterRegistry({ now: () => core!.clock().toISOString(), invokeTool: request => textPublicationHost(dispatcher!).invokeTool(request) }, join(config.home, 'adapter-generations'))
    await mkdir(join(config.home, 'adapter-generations'), { recursive: true, mode: 0o700 })
    if (abort.signal.aborted) return
    for (const adapter of config.adapters) {
      if (abort.signal.aborted) return
      try { await registry.register(adapter.id, adapter.root, adapter.entry, abort.signal, adapter.config, adapterData(config, adapter.id)) }
      catch (error) { if (!abort.signal.aborted) console.error(`Adapter ${adapter.id} is unavailable: ${safeHostError(error, config, process.env)}`) }
    }
    if (abort.signal.aborted) return
    dispatcher = new TextDispatcher(core, registry)
    await dispatcher.start()
    if (abort.signal.aborted) return
    server = await startTextServer(core, { installationId: core.bootstrap.installationId, personId: core.bootstrap.ownerId }, { ...config.listen, dispatcher })
    if (abort.signal.aborted) return
    await core.updates.start()
    if (abort.signal.aborted) return
    Object.assign(status, { state: 'running', installationId: core.bootstrap.installationId, url: server.url, adapters: registry.adapters().map(({id,available}) => ({id,available})) })
    console.log(JSON.stringify({ state: status.state, installationId: status.installationId, url: status.url }))
    clearTimeout(deadline)
    await stopped
  } catch (error) {
    if (!abort.signal.aborted) throw error
  } finally {
    clearTimeout(deadline)
    beginShutdown()
    let failure: unknown
    try {
      for (const close of [() => server?.close(), () => dispatcherClosing, () => registry?.close(), () => core?.close(), () => owner.close()]) {
        try { await close() } catch (error) { failure ??= error }
      }
    } finally { if (!failure) clearTimeout(force); process.off('SIGTERM', beginShutdown); process.off('SIGINT', beginShutdown) }
    if (failure) throw failure
  }
}

export async function setup(config: HostConfig): Promise<{ installationId: string }> {
  environment(config)
  const existing = await control(config.home, 'status')
  if (existing) throw new Error('Stop the configured host before setup.')
  const status: HostStatus = { state: 'starting', pid: process.pid, instance: randomUUID() }
  const owner = await ownControl(config.home, status, () => {})
  let core: Runtime | undefined
  try { core = await runtime(config, false); return { installationId: core.bootstrap.installationId } }
  finally { try { await core?.close() } finally { await owner.close() } }
}
export interface Diagnostic { check: string; status: 'ok' | 'unavailable' | 'not-configured' | 'not-probed'; message: string }
export async function doctor(config: HostConfig, probe = false): Promise<Diagnostic[]> {
  environment(config)
  const rows: Diagnostic[] = []
  const add = (check: string, status: Diagnostic['status'], message: string) => rows.push({ check, status, message })
  add('runtime', process.versions.node.startsWith('26.') && Number(process.versions.node.split('.')[1]) >= 10 ? 'ok' : 'unavailable', 'Core requires Node.js >=26.10.0 <27. Use the version declared by the installed package.')
  let db: Postgres | undefined
  try {
    const diagnosticURL = new URL(config.databaseUrl)
    diagnosticURL.searchParams.set('options', `${diagnosticURL.searchParams.get('options') ?? ''} -c statement_timeout=3000`)
    db = new Postgres(diagnosticURL.href, 1, 3000)
    const result = await db.query<{version:string; vector:string|null}>("SELECT current_setting('server_version') AS version,(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector")
    add('postgresql', Number.parseInt(result.rows[0]!.version, 10) >= 18 ? 'ok' : 'unavailable', `PostgreSQL ${result.rows[0]!.version} is reachable; this host requires PostgreSQL 18 or later.`)
    add('pgvector', result.rows[0]!.vector ? 'ok' : 'unavailable', result.rows[0]!.vector ? `pgvector ${result.rows[0]!.vector} is installed.` : 'Install pgvector in the configured database before setup.')
  } catch { add('postgresql', 'unavailable', 'Verify databaseUrl, the server, database and credentials. No credential value is printed.') }
  finally { await db?.close() }
  try { const status = await control(config.home, 'status'); add('host', status ? 'ok' : 'not-configured', status ? `Configured host is ${'state' in status ? status.state : 'stopping'}.` : 'Configured host is stopped.') }
  catch { add('host', 'unavailable', 'Ownership is incomplete, inaccessible or stale. Inspect the configured home before manual cleanup; no process was signalled.') }
  for (const adapter of config.adapters) {
    try { await access(join(adapter.root, adapter.entry), constants.R_OK); add(`adapter:${adapter.id}`, 'not-probed', 'Entry is readable. Readiness requires an explicit provider probe or host startup.') }
    catch { add(`adapter:${adapter.id}`, 'unavailable', 'Install the configured adapter package and verify its entry relative to the installation root.') }
  }
  if (!config.adapters.length) add('adapters', 'not-configured', 'Configure an execution adapter; source data remains readable without one.')
  add('embedding', config.embedding ? 'not-probed' : 'not-configured', config.embedding ? 'Configured module; no embedding request made by passive checks.' : 'Configure an embedding service to enable indexed memory.')
  add('transcription', config.transcription ? 'not-probed' : 'not-configured', config.transcription ? 'Configured module; passive checks do not invoke the provider or request microphone access.' : 'Voice recording/transcription is unavailable until explicitly configured.')
  if (probe) {
    environment(config)
    if (config.embedding) {
      try { await boundedEmbed((await loadEmbeddingProvider(config))!, 'Kipster readiness probe', 10000); add('embedding-probe', 'ok', 'Explicit synthetic embedding request succeeded.') }
      catch { add('embedding-probe', 'unavailable', 'Explicit embedding request failed. Verify endpoint/model/provider credentials.') }
    }
    let provider: TranscriptionProvider | undefined
    try { provider = await transcription(config); if (provider) add('transcription-probe', (await provider.readiness()).ready ? 'ok' : 'unavailable', 'Explicit configured transcription readiness check completed; no audio recorded.') }
    catch { add('transcription-probe', 'unavailable', 'Configured transcription module or CLI readiness failed.') }
    finally { await provider?.close() }
    const registry = new AdapterRegistry({ now: () => new Date().toISOString(), invokeTool: async () => { throw new Error('No execution in readiness probe') } })
    try {
      for (const adapter of config.adapters) {
        try { const result = await registry.register(adapter.id, adapter.root, adapter.entry, undefined, adapter.config, adapterData(config, adapter.id)); add(`adapter-probe:${adapter.id}`, result.readiness.ready ? 'ok' : 'unavailable', 'Explicit provider readiness check completed; no conversation run.') }
        catch { add(`adapter-probe:${adapter.id}`, 'unavailable', 'Explicit provider probe failed. Verify installed adapter, harness and operator sign-in.') }
      }
    } finally { await registry.close() }
  }
  return rows
}
export function launchdTemplate(configPath: string, home: string, executable = process.execPath, cli = fileURLToPath(import.meta.url)): string {
  const xml = (value: string) => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>app.kipster.host</string>\n<key>ProgramArguments</key><array>${[executable,cli,'serve','--config',resolve(configPath)].map(v=>`<string>${xml(v)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(home)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>StandardOutPath</key><string>${xml(join(home,'logs','host.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(home,'logs','host-error.log'))}</string>\n<key>Umask</key><integer>63</integer>\n<key>ExitTimeOut</key><integer>20</integer>\n</dict></plist>\n`
}
async function waitStopped(config: HostConfig, instance: string): Promise<void> {
  for (let i=0;i<100;i++) {
    await delay(200)
    const status = await control(config.home, 'status')
    if (!status) return
    if (status.instance !== instance) throw new Error('Another host instance took ownership; it was not stopped.')
  }
  throw new Error('Host did not stop within 20 seconds. Inspect its logs; no PID was signalled.')
}
async function start(config: HostConfig, configPath: string): Promise<unknown> {
  try { await access(join(config.home, 'updates', 'hold')); throw new Error('Host startup is held for an update; inspect updater status before restarting.') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const existing = await control(config.home, 'status')
  if (existing) return existing
  await mkdir(join(config.home, 'logs'), {recursive:true,mode:0o700})
  const output = await open(join(config.home, 'logs', 'host.log'), 'a', 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--config', configPath], { detached:true, stdio:['ignore',output.fd,output.fd], env:process.env })
  await output.close()
  let launchError = false
  child.once('error', () => { launchError = true }); child.unref()
  for (let i=0;i<300;i++) {
    await delay(200)
    if (launchError || child.exitCode !== null) throw new Error('Host startup failed. Inspect the configured home logs.')
    try { const status = await control(config.home, 'status'); if (status && 'state' in status && status.state === 'running') return status } catch { /* ownership may still be publishing */ }
  }
  // The child is one we just spawned; never use a stale PID record or port lookup.
  child.kill('SIGTERM')
  throw new Error('Host startup timed out. The owned launch received SIGTERM; inspect its log and ownership record.')
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, flag, path, option] = args
  if (!['setup','serve','start','stop','restart','status','doctor','service-template'].includes(command ?? '') || flag !== '--config' || !path || args.length > 4 || (option !== undefined && !(command === 'doctor' && option === '--probe'))) throw new Error('Usage: kipster-host setup|serve|start|stop|restart|status|doctor|service-template --config <file> [--probe for doctor only]')
  const {config, path: configPath} = await readHostConfig(path)
  if (command === 'serve') return serve(config)
  let result: unknown
  if (command === 'setup') result = await setup(config)
  else if (command === 'doctor') result = await doctor(config, option === '--probe')
  else if (command === 'status') result = await control(config.home, 'status') ?? {state:'stopped'}
  else if (command === 'service-template') { console.log(launchdTemplate(configPath, config.home)); return }
  else {
    if (command === 'stop' || command === 'restart') {
      const stopped = await control(config.home, 'stop')
      if (stopped) await waitStopped(config, stopped.instance)
      result = {state:'stopped'}
    }
    if (command === 'start' || command === 'restart') result = await start(config, configPath)
  }
  console.log(JSON.stringify(result, null, 2))
}
function invokedAsCommand(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
}
if (invokedAsCommand()) {
  const deadline = setTimeout(() => { console.error('Host command exceeded its deadline; inspect configuration/dependencies.'); process.exit(1) }, 120000)
  if (process.argv[2] === 'serve') clearTimeout(deadline)
  main().catch(error => { console.error(error instanceof MigrationHistoryError || error instanceof Error && /^(Usage:|Invalid host|Configure |Set the configured|Host |Stop the configured|Core requires|Kipster home|Another host|Environment|Adapter IDs|Execution limit)/.test(error.message) ? error.message : 'Host command failed. Verify configuration and dependency readiness with doctor.'); process.exitCode=1 }).finally(() => clearTimeout(deadline))
}
