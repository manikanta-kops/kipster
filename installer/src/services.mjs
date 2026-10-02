import { access, chmod, copyFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { atomic, exists, json, privateDirectory } from './files.mjs'
import { run } from './process.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export const hostCLI = release => join(release, 'node_modules/@kipster/core/dist/host.js')
export const runtimeEnvironment = config => ({ ...process.env, ...config.environment, PATH: `${dirname(process.execPath)}:${config.environment?.PATH ?? process.env.PATH ?? '/usr/bin:/bin'}` })
export async function hostCommand(release, action, home, env, onSpawn) {
  if (action === 'setup') return run(process.execPath, [fileURLToPath(new URL('migrate.mjs', import.meta.url)), hostCLI(release), join(home, 'host.json')], { env, onSpawn, gated: true, input: 'migrate\n', timeout: 300000, label: 'Core setup' })
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
export function templates(home, env, node = process.execPath, user = userInfo().username) {
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12)
  const make = (kind, arguments_, supervision) => {
    const label = `app.kipster.${kind}.${suffix}`
    return { label, contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>UserName</key><string>${xml(user)}</string>
<key>ProgramArguments</key><array>${[node, ...arguments_].map(item => `<string>${xml(item)}</string>`).join('')}</array>
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
    make('host', [join(home, 'bin/core.mjs')], `<key>KeepAlive</key><dict><key>PathState</key><dict><key>${xml(join(home, 'updates/hold'))}</key><false/></dict></dict>`),
    make('updater', [join(home, 'bin/kipster'), 'apply'], `<key>WatchPaths</key><array><string>${xml(join(home, 'updates/request.json'))}</string></array><key>StartInterval</key><integer>60</integer>`),
  ]
}
export async function writeServices(home, env) {
  await privateDirectory(join(home, 'bin')); await privateDirectory(join(home, 'services')); await privateDirectory(join(home, 'logs'))
  await copyFile(join(packageRoot, 'launchers/core.mjs'), join(home, 'bin/core.mjs'))
  const source = await readFile(join(packageRoot, 'launchers/kipster.mjs'), 'utf8')
  await atomic(join(home, 'bin/kipster'), source.replace('#!/usr/bin/env node', `#!${process.execPath}`))
  await chmod(join(home, 'bin/kipster'), 0o700)
  const jobs = templates(home, env)
  for (const job of jobs) await atomic(join(home, 'services', job.label + '.plist'), job.contents)
  return jobs
}
export function sudoSteps(home, jobs) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  return jobs.flatMap(job => [
    { why: 'root ownership and mode 0644 are required in /Library/LaunchDaemons', program: '/usr/bin/install', args: ['-o', 'root', '-g', 'wheel', '-m', '644', join(home, 'services', job.label + '.plist'), '/Library/LaunchDaemons/' + job.label + '.plist'] },
    { why: 'register a system LaunchDaemon that starts before login', program: '/bin/launchctl', args: ['bootstrap', 'system', '/Library/LaunchDaemons/' + job.label + '.plist'] },
  ]).map(step => ({ ...step, command: ['sudo', step.program, ...step.args].map(quote).join(' ') }))
}
export async function register(home, jobs) {
  for (const job of jobs) {
    const loaded = await run('/bin/launchctl', ['print', `system/${job.label}`], { timeout: 5000 }).then(() => true, () => false)
    if (loaded) {
      const existing = await readFile('/Library/LaunchDaemons/' + job.label + '.plist', 'utf8').catch(() => '')
      if (existing !== job.contents) throw new Error(`Existing system job ${job.label} differs from the generated service. Inspect it before retrying installation.`)
      continue // Resume registration after a partially completed first install.
    }
    for (const step of sudoSteps(home, [job])) await run('/usr/bin/sudo', [step.program, ...step.args], { inherit: true, label: 'System service registration' })
  }
}
