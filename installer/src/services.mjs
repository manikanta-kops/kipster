import { mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { atomic, exists, json, privateDirectory } from './files.mjs'
import { run } from './process.mjs'
import { safeError } from './diagnostics.mjs'
import { bundleIdentifier, installApp, launcher, packagedApp, writeLaunchers, writeRuntime } from './backend.mjs'

export const hostCLI = release => join(release, 'node_modules/@kipster/core/dist/host.js')
export const runtimeEnvironment = config => ({ ...process.env, ...config.environment, PATH: `${dirname(process.execPath)}:${config.environment?.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}` })
export async function hostCommand(release, action, home, env, onSpawn) {
  if (action === 'setup') {
    const config = await json(join(home, 'host.json'))
    return run(process.execPath, [fileURLToPath(new URL('migrate.mjs', import.meta.url)), hostCLI(release), join(home, 'host.json')], { env, onSpawn, gated: true, input: 'migrate\n', timeout: 300000, label: 'Core setup', sanitizeStderr: error => safeError(error, config, env) })
  }
  return run(process.execPath, [hostCLI(release), action, '--config', join(home, 'host.json')], { env, onSpawn, timeout: action === 'setup' ? 300000 : 90000, label: `Core ${action}` })
}
export async function stop(release, home, env) {
  if (await exists(join(home, '.host-control'))) {
    try { await hostCommand(release, 'stop', home, env) }
    catch (error) {
      // Socket shutdown may race delivery of the stop acknowledgement. Only
      // disappearance of ownership proves that the uncertain stop completed.
      for (let i = 0; i < 20; i++) { if (!await exists(join(home, '.host-control'))) return; await delay(100) }
      throw error
    }
  }
}
export async function recoverOwnership(release, home) {
  const file = join(home, '.host-control/owner.json')
  if (!await exists(file)) return
  if (!await exists(join(home, 'updates/hold'))) throw new Error('Recovery requires the updater hold file.')
  const { instance } = await json(file)
  const host = await import(pathToFileURL(await realpath(hostCLI(release))).href)
  if (typeof host.recoverStoppedControl !== 'function') throw new Error('This Core cannot recover a stale startup socket. Preserve the backup and inspect the stopped host ownership manually.')
  await host.recoverStoppedControl(home, instance)
}
export async function health(config, expected, timeout) {
  const hostname = config.listen.host === '::1' ? '[::1]' : config.listen.host
  const address = `http://${hostname}:${config.listen.port}/v1/bootstrap`, deadline = Date.now() + timeout
  do {
    try {
      const response = await fetch(address, { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) })
      if (response.ok && (await response.json()).coreVersion === expected) return
    } catch { /* Startup and migrations may still be in progress. */ }
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error(`Core health check did not report ${expected} within ${timeout / 1000} seconds.`)
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
export const installedPlist = label => join(homedir(), 'Library/LaunchAgents', label + '.plist')
const domain = () => `gui/${process.getuid()}`
/**
 * Per-user login jobs start the Kipster app in a role, so macOS attributes Core,
 * the updater and every child to Kipster. They run in the owner's login session,
 * where the login keychain, consent dialogs and the GUI are available, from login
 * to logout, including while the screen is locked. The app reads the Node from runtime.json.
 */
export function templates(home, env) {
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12)
  const make = (kind, supervision) => {
    const label = `app.kipster.${kind}.${suffix}`
    return { label, contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[launcher(home), '--role', kind, '--home', home].map(item => `<string>${xml(item)}</string>`).join('')}</array>
<key>AssociatedBundleIdentifiers</key><array><string>${bundleIdentifier}</string></array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(homedir())}</string><key>PATH</key><string>${xml(env.PATH)}</string></dict>
<key>RunAtLoad</key><true/>
${supervision}
<key>StandardOutPath</key><string>${xml(join(home, 'logs', kind + '.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, 'logs', kind + '-error.log'))}</string>
<key>Umask</key><integer>63</integer><key>ExitTimeOut</key><integer>20</integer>
</dict></plist>\n` }
  }
  return [
    make('host', `<key>KeepAlive</key><dict><key>PathState</key><dict><key>${xml(join(home, 'updates/hold'))}</key><false/></dict></dict>`),
    make('updater', `<key>WatchPaths</key><array><string>${xml(join(home, 'updates/request.json'))}</string></array><key>StartInterval</key><integer>60</integer>`),
  ]
}
/**
 * Writes everything the login jobs start: the Kipster app, the runtime
 * manifest naming the Node, the stable entry points and the plists. launchd
 * installations need a stably signed app; manual ones use it when packaged.
 */
export async function writeServices(home, env, { services = 'launchd', node = process.execPath, source = packagedApp(), requireTeam = true } = {}) {
  await privateDirectory(join(home, 'bin')); await privateDirectory(join(home, 'services')); await privateDirectory(join(home, 'logs'))
  if (services === 'launchd' || await exists(source)) {
    if (!await exists(source)) throw new Error('This installer package has no Kipster app. Install a released @kipster/installer.')
    const { previous } = await installApp(home, source, { requireTeam: services === 'launchd' && requireTeam })
    if (previous) await rm(previous, { recursive: true, force: true })
  }
  await writeRuntime(home, node)
  await writeLaunchers(home)
  const jobs = templates(home, env)
  for (const job of jobs) await atomic(join(home, 'services', job.label + '.plist'), job.contents)
  return jobs
}
const readPlist = path => readFile(path, 'utf8')
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
const isLoaded = (runCommand, label) => runCommand('/bin/launchctl', ['print', `${domain()}/${label}`], { timeout: 5000 }).then(() => true, () => false)
/** Installs each job in ~/Library/LaunchAgents and loads it into the owner's login session. A differing job with the same label is refused. */
export async function register(home, jobs, { runCommand = run, readInstalled = readPlist, writeInstalled = async (path, contents) => { await mkdir(dirname(path), { recursive: true }); await atomic(path, contents) } } = {}) {
  for (const job of jobs) {
    const path = installedPlist(job.label), installed = await readInstalled(path).catch(absent)
    if (installed !== null && installed !== job.contents) throw new Error(`Existing login job ${path} differs from the generated service. Inspect it before retrying installation.`)
    if (await isLoaded(runCommand, job.label)) continue // Resume registration after a partially completed first install.
    if (installed === null) await writeInstalled(path, job.contents)
    await runCommand('/bin/launchctl', ['bootstrap', domain(), path], { timeout: 30000, label: 'Login service registration' })
  }
}
/** Unloads and removes this home's login jobs. Both are verified before either changes; a differing job is never removed. */
export async function unregister(home, jobs, { runCommand = run, readInstalled = readPlist, removeInstalled = path => rm(path, { force: true }) } = {}) {
  const found = []
  for (const job of jobs) {
    const path = installedPlist(job.label), installed = await readInstalled(path).catch(absent)
    if (installed !== null && installed !== job.contents) throw new Error(`Existing login job ${path} differs from this installation. Inspect it before uninstalling.`)
    found.push({ job, path, installed, loaded: await isLoaded(runCommand, job.label) })
  }
  for (const { job, path, installed, loaded } of found) {
    if (loaded) await runCommand('/bin/launchctl', ['bootout', `${domain()}/${job.label}`], { timeout: 30000, label: 'Login service removal' })
    if (installed !== null) await removeInstalled(path)
  }
}
