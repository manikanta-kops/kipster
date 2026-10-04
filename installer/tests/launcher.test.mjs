// The native Kipster app: roles, runtime manifest, process lifecycle and the
// packed bundle. Builds an ad hoc signed app; macOS on Apple Silicon only.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from '../native/build.mjs'
import { installApp, installedApp, restoreApp, treeDigest, verifyApp, writeRuntime } from '../src/backend.mjs'
import { run } from '../src/process.mjs'
import { repository } from './support.mjs'

const skip = process.platform === 'darwin' && process.arch === 'arm64' ? false : 'The Kipster app runs on macOS on Apple Silicon.'
let app, executable
before(async () => {
  if (skip) return
  const out = await realpath(await mkdtemp(join(tmpdir(), 'kipster-app-build-')))
  app = build({ out }); executable = join(app, 'Contents/MacOS/Kipster')
})

// Stand-in role scripts report how they were started and then follow BEHAVIOR.
const script = `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.REPORT, JSON.stringify({ argv: process.argv.slice(1), execPath: process.execPath, pid: process.pid, ppid: process.ppid, path: process.env.PATH }))
const behavior = process.env.BEHAVIOR ?? ''
if (behavior.startsWith('exit:')) process.exit(Number(behavior.slice(5)))
if (behavior === 'abort') process.abort()
if (behavior.startsWith('trap:')) process.on(behavior.slice(5), signal => { writeFileSync(process.env.REPORT + '.signal', signal); process.exit(0) })
if (behavior.startsWith('trap:') || behavior === 'hang') { setInterval(() => {}, 1000); console.log('ready') }
`
async function home(t, { node = process.execPath, mode = 0o600 } = {}) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'kipster-app-home-')))
  t.after(() => rm(path, { recursive: true, force: true }))
  await mkdir(join(path, 'bin'))
  for (const name of ['core.mjs', 'kipster.mjs']) await writeFile(join(path, 'bin', name), script)
  if (node) { await writeRuntime(path, node); await chmod(join(path, 'runtime.json'), mode) }
  return path
}
function launch(args, { behavior = '', report = '/dev/null', onReady } = {}) {
  const child = spawn(executable, args, { env: { ...process.env, PATH: '/usr/bin:/bin', BEHAVIOR: behavior, REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', chunk => { if (String(chunk).includes('ready')) onReady?.(child) })
  return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, stderr, pid: child.pid })))
}
const role = (name, path, ...rest) => ['--role', name, '--home', path, ...(rest.length ? ['--', ...rest] : [])]

test('rejects unknown roles, misplaced arguments and unsafe homes', { skip }, async t => {
  const path = await home(t)
  assert.equal((await launch([])).code, 64)
  assert.equal((await launch(role('server', path))).code, 64)
  assert.equal((await launch(['--role', 'host', '--home', path, '--', 'extra'])).code, 64)
  assert.equal((await launch(['--role', 'host'])).code, 64)
  assert.equal((await launch(role('host', 'relative/home'))).code, 78)
  assert.equal((await launch(role('host', path + '/bin/..'))).code, 78)
  await chmod(path, 0o777)
  assert.match((await launch(role('host', path))).stderr, /not an absolute Kipster home/)
})

test('requires a private version 1 runtime manifest naming an executable Node', { skip }, async t => {
  const missing = await launch(role('host', await home(t, { node: null })))
  assert.equal(missing.code, 78)
  assert.match(missing.stderr, /runtime\.json is missing.*bin\/kipster runtime --node/)
  assert.equal((await launch(role('host', await home(t, { mode: 0o644 })))).code, 78)
  const notExecutable = await home(t)
  await writeRuntime(notExecutable, join(notExecutable, 'bin/core.mjs'))
  assert.match((await launch(role('host', notExecutable))).stderr, /not an executable file/)
  const future = await home(t)
  await writeFile(join(future, 'runtime.json'), JSON.stringify({ version: 2, node: process.execPath }), { mode: 0o600 })
  assert.match((await launch(role('host', future))).stderr, /not a version 1 runtime manifest/)
  await writeFile(join(future, 'runtime.json'), '[1, "/usr/bin/true"]')
  const list = await launch(role('host', future))
  assert.deepEqual([list.code, list.signal], [78, null])
})

test('host and updater roles start their stable scripts with the selected Node, first on PATH', { skip }, async t => {
  const path = await home(t), report = join(path, 'report.json')
  const host = await launch(role('host', path), { report })
  assert.equal(host.code, 0, host.stderr)
  const started = JSON.parse(await readFile(report, 'utf8'))
  assert.deepEqual(started.argv, [join(path, 'bin/core.mjs')])
  assert.equal(started.execPath, await realpath(process.execPath))
  assert.equal(started.ppid, host.pid)
  assert.equal(started.path, `${dirname(process.execPath)}:/usr/bin:/bin`)
  assert.equal((await launch(role('updater', path), { report })).code, 0)
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')).argv, [join(path, 'bin/kipster.mjs'), 'apply'])
})

test('the cli role preserves argument boundaries and exit codes', { skip }, async t => {
  const path = await home(t), report = join(path, 'report.json')
  const args = ['status', 'two words', '', "it's", '--', '--role', 'host']
  const result = await launch(role('cli', path, ...args), { report, behavior: 'exit:7' })
  assert.equal(result.code, 7)
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')).argv, [join(path, 'bin/kipster.mjs'), ...args])
})

test('runtime --node runs with the candidate even when the stored Node is gone', { skip }, async t => {
  const path = await home(t, { node: '/nonexistent/node' }), report = join(path, 'report.json')
  assert.equal((await launch(role('cli', path, 'status'), { report })).code, 78)
  const candidate = join(path, 'candidate-node')
  await cp(process.execPath, candidate)
  const result = await launch(role('cli', path, 'runtime', '--node', candidate), { report })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(await readFile(report, 'utf8')).execPath, candidate)
  assert.equal((await launch(role('cli', path, 'runtime', '--node', join(path, 'bin/core.mjs')))).code, 78)
})

test('termination signals reach Node and its outcome becomes the launcher outcome', { skip }, async t => {
  const path = await home(t), report = join(path, 'report.json')
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handled = await launch(role('host', path), { report, behavior: `trap:${signal}`, onReady: child => child.kill(signal) })
    assert.deepEqual([handled.code, handled.signal], [0, null], signal)
    assert.equal(await readFile(report + '.signal', 'utf8'), signal)
  }
  const killed = await launch(role('host', path), { report, behavior: 'hang', onReady: child => child.kill('SIGTERM') })
  assert.deepEqual([killed.code, killed.signal], [null, 'SIGTERM'])
  // A crashing Node is reported as a status, so Kipster itself does not crash.
  const crashed = await launch(role('host', path), { report, behavior: 'abort' })
  assert.deepEqual([crashed.code, crashed.signal], [134, null])
})

test('the launcher stays the parent of Node until Node exits', { skip }, async t => {
  const path = await home(t), report = join(path, 'report.json')
  let launcher, parent, group
  const result = await launch(role('host', path), { report, behavior: 'hang', onReady: async child => {
    const { pid } = JSON.parse(await readFile(report, 'utf8'))
    ;[parent, group] = execFileSync('/bin/ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
    launcher = child.pid
    child.kill('SIGTERM')
  } })
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(parent, launcher)
  // Node stays in the job's process group, so launchd can stop the whole job.
  assert.equal(group, Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()))
})

test('the packed installer carries a sealed app that installs, refreshes and restores intact', { skip, timeout: 120000 }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'kipster-app-pack-')))
  t.after(() => rm(work, { recursive: true, force: true }))
  const source = join(work, 'installer')
  await mkdir(join(source, 'launchers'), { recursive: true })
  for (const name of ['src', 'package.json', 'README.md', 'launchers/core.mjs', 'launchers/kipster.mjs']) await cp(join(repository, 'installer', name), join(source, name), { recursive: true })
  build({ out: join(source, 'launchers/macos') })
  const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], { cwd: source }))
  assert.ok(packed[0].files.some(file => file.path === 'launchers/macos/Kipster.app/Contents/MacOS/Kipster' && file.mode === 0o755))
  const installation = join(work, 'installation')
  await mkdir(installation)
  await writeFile(join(installation, 'package.json'), '{"private":true}')
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(work, packed[0].filename)], { cwd: installation, timeout: 60000 })
  const extracted = join(installation, 'node_modules/@kipster/installer/launchers/macos/Kipster.app')
  assert.equal(await verifyApp(extracted), null) // ad hoc: valid, but no signing team
  await assert.rejects(verifyApp(extracted, { requireTeam: true }), /no stable signing identity/)

  const path = await home(t)
  assert.deepEqual(await installApp(path, extracted), { changed: true, previous: null })
  assert.equal(await treeDigest(installedApp(path)), await treeDigest(extracted))
  assert.deepEqual(await installApp(path, extracted), { changed: false, previous: null })
  // A different signed build replaces it; the previous one is kept for rollback.
  const next = build({ out: join(work, 'next'), version: '99.0.0' })
  let recorded
  const replaced = await installApp(path, next, { onPrevious: previous => { recorded = previous } })
  assert.equal(replaced.previous, recorded)
  assert.match(await readFile(join(installedApp(path), 'Contents/Info.plist'), 'utf8'), /99\.0\.0/)
  await restoreApp(path, replaced.previous)
  assert.equal(await treeDigest(installedApp(path)), await treeDigest(extracted))
  // A broken seal is refused and leaves the installed app untouched.
  const tampered = join(work, 'tampered/Kipster.app')
  await cp(next, tampered, { recursive: true })
  await writeFile(join(tampered, 'Contents/Resources/extra.txt'), 'not sealed')
  await assert.rejects(installApp(path, tampered), /not a validly signed Kipster app/)
  assert.equal(await treeDigest(installedApp(path)), await treeDigest(extracted))
  // The installed app runs the host role from its fixed path.
  const report = join(path, 'report.json')
  const result = await new Promise(resolve => spawn(join(installedApp(path), 'Contents/MacOS/Kipster'), role('host', path), { env: { ...process.env, REPORT: report }, stdio: 'ignore' }).once('close', resolve))
  assert.equal(result, 0)
  await delay(10)
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')).argv, [join(path, 'bin/core.mjs')])
})
