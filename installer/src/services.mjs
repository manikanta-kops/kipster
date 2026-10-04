import { readFile, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
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
export const installedPlist = label => '/Library/LaunchDaemons/' + label + '.plist'
/**
 * System jobs start the Kipster app in a role, so macOS attributes Core, the
 * updater and every child to Kipster. The app reads the Node from runtime.json.
 */
export function templates(home, env, user = userInfo().username) {
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12)
  const make = (kind, supervision) => {
    const label = `app.kipster.${kind}.${suffix}`
    return { label, contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>UserName</key><string>${xml(user)}</string>
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
 * Writes everything the system jobs start: the Kipster app, the runtime
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
export function sudoSteps(home, jobs) {
  return describeSteps(jobs.flatMap(job => [
    { why: 'root ownership and mode 0644 are required in /Library/LaunchDaemons', program: '/usr/bin/install', args: ['-o', 'root', '-g', 'wheel', '-m', '644', join(home, 'services', job.label + '.plist'), installedPlist(job.label)] },
    { why: 'register a system LaunchDaemon that starts before login', program: '/bin/launchctl', args: ['bootstrap', 'system', installedPlist(job.label)] },
  ]))
}
function describeSteps(steps) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  return steps.map(step => ({ ...step, command: ['sudo', step.program, ...step.args].map(quote).join(' ') }))
}
export function removalSteps(jobs) {
  return describeSteps(jobs.flatMap(job => [
    { why: 'stop and unregister the system LaunchDaemon', program: '/bin/launchctl', args: ['bootout', `system/${job.label}`] },
    { why: 'remove the root-owned system LaunchDaemon plist', program: '/bin/rm', args: ['-f', installedPlist(job.label)] },
  ]))
}
const readPlist = path => readFile(path, 'utf8')
const absent = error => { if (error.code === 'ENOENT') return null; throw error }
export async function unregister(home, jobs, { runCommand = run, readInstalled = readPlist } = {}) {
  const steps = []
  // Verify both jobs before changing either; never remove a differing job.
  for (const job of jobs) {
    const loaded = await runCommand('/bin/launchctl', ['print', `system/${job.label}`], { timeout: 5000 }).then(() => true, () => false)
    const installed = await readInstalled(installedPlist(job.label)).catch(absent)
    if ((loaded || installed !== null) && installed !== job.contents) throw new Error(`Existing system job ${job.label} differs from this installation. Inspect it before uninstalling.`)
    const [bootout, remove] = removalSteps([job])
    if (loaded) steps.push(bootout)
    if (installed !== null) steps.push(remove)
  }
  for (const step of steps) console.log(`${step.command}\n  Requires sudo: ${step.why}.`)
  for (const step of steps) await runCommand('/usr/bin/sudo', [step.program, ...step.args], { inherit: true, label: 'System service removal' })
}
export async function register(home, jobs) {
  for (const job of jobs) {
    const loaded = await run('/bin/launchctl', ['print', `system/${job.label}`], { timeout: 5000 }).then(() => true, () => false)
    if (loaded) {
      const existing = await readFile(installedPlist(job.label), 'utf8').catch(() => '')
      if (existing !== job.contents) throw new Error(`Existing system job ${job.label} differs from the generated service. Inspect it before retrying installation.`)
      continue // Resume registration after a partially completed first install.
    }
    for (const step of sudoSteps(home, [job])) await run('/usr/bin/sudo', [step.program, ...step.args], { inherit: true, label: 'System service registration' })
  }
}

/**
 * Replaces this home's system jobs with `jobs`, written to <home>/services.
 * Each installed job must be the one this home recorded (`recorded`, by label)
 * or already the replacement; anything else is refused before any change.
 * `prepare` installs what the new jobs start, `stopCore` holds Core, and
 * `startCore` releases it and checks health. On failure the backed-up plists
 * are reinstalled, `restoreFiles` puts back the home's files and Core restarts.
 */
export async function replaceServices({ home, jobs, recorded, backup, prepare, stopCore, startCore, restoreFiles, runCommand = run, readInstalled = readPlist, log = console.log }) {
  const state = []
  for (const job of jobs) {
    const path = installedPlist(job.label)
    const installed = await readInstalled(path).catch(absent)
    const loaded = await runCommand('/bin/launchctl', ['print', `system/${job.label}`], { timeout: 5000 }).then(() => true, () => false)
    if (installed !== null && installed !== job.contents && installed !== recorded.get(job.label)) throw new Error(`System job ${job.label} does not match the service this installation recorded. Inspect ${path}; nothing was changed.`)
    if (installed === null && loaded) throw new Error(`System job ${job.label} is loaded without ${path}. Inspect it with launchctl print system/${job.label}; nothing was changed.`)
    state.push({ job, installed, loaded })
  }
  try { await prepare() } catch (error) { await restoreFiles(); throw error }
  const pending = state.filter(item => item.installed !== item.job.contents || !item.loaded)
  if (!pending.length) return { changed: false }
  await privateDirectory(backup)
  for (const item of pending) if (item.installed !== null) await atomic(join(backup, item.job.label + '.plist'), item.installed)
  const steps = pending.flatMap(item => [...(item.loaded ? removalSteps([item.job]).slice(0, 1) : []), ...(item.installed === item.job.contents ? sudoSteps(home, [item.job]).slice(1) : sudoSteps(home, [item.job]))])
  for (const step of steps) log(`${step.command}\n  Requires sudo: ${step.why}.`)
  await stopCore()
  try {
    for (const step of steps) await runCommand('/usr/bin/sudo', [step.program, ...step.args], { inherit: true, label: 'System service replacement' })
    await startCore()
    return { changed: true, backup }
  } catch (error) {
    log(`Restoring the previous system services from ${backup}.`)
    const failures = []
    const sudo = async (program, args) => { try { await runCommand('/usr/bin/sudo', [program, ...args], { inherit: true, label: 'System service restore' }) } catch { failures.push([program, ...args].join(' ')) } }
    for (const item of pending) {
      await runCommand('/usr/bin/sudo', ['/bin/launchctl', 'bootout', `system/${item.job.label}`], { inherit: true, label: 'System service restore' }).catch(() => {})
      if (item.installed === null) { await sudo('/bin/rm', ['-f', installedPlist(item.job.label)]); continue }
      await sudo('/usr/bin/install', ['-o', 'root', '-g', 'wheel', '-m', '644', join(backup, item.job.label + '.plist'), installedPlist(item.job.label)])
      if (item.loaded) await sudo('/bin/launchctl', ['bootstrap', 'system', installedPlist(item.job.label)])
    }
    await restoreFiles()
    await startCore().catch(failure => failures.push(failure instanceof Error ? failure.message : 'Core did not restart'))
    const detail = error instanceof Error ? error.message : 'Service replacement failed.'
    throw new Error(failures.length
      ? `${detail} Restoring the previous services was incomplete (${failures.join('; ')}); their plists are saved in ${backup}.`
      : `${detail} The previous services were restored from ${backup}.`)
  }
}
