import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { startFixture } from '@kipster/plugins/fixture'
import { PluginServerSupervisor } from '../dist/plugins/supervisor.js'
import { PluginControlClient } from '../dist/plugins/client.js'
import { pluginServerDiagnostic } from '../dist/host-diagnostics.js'
import { control, doctor, ownControl, validateHostConfig } from '../dist/host.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const packageRoot = dirname(fileURLToPath(import.meta.resolve('@kipster/plugins/package.json')))
const cli = join(packageRoot, 'dist/server/cli.js')
const catalogue = join(packageRoot, 'test/fixtures/catalogue')
const hostCli = fileURLToPath(new URL('../dist/host.js', import.meta.url))
const wait = async (predicate, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)) } throw new Error('Timed out') }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
/** The plugin server processes a parent started, with their full command lines. */
const children = (parent = process.pid, module = cli) => execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
  .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(match => match && Number(match[2]) === parent && match[3].includes(module))
  .map(match => ({ pid: Number(match[1]), command: match[3] }))
const v1 = (url, token) => fetch(`${url}/v1`, token ? { headers: { authorization: `Bearer ${token}` } } : {})

async function home(t) {
  const path = await realpath(await mkdtemp('/tmp/kipster-plugins-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
async function fixture(t) {
  const service = await startFixture()
  t.after(() => service.close())
  return service
}
function supervise(t, options) {
  const statuses = []
  const supervisor = new PluginServerSupervisor({ backoff: { initialMs: 50, maxMs: 200, attempts: 3 }, readyTimeoutMs: 15000, onStatus: status => statuses.push(status), ...options })
  t.after(() => supervisor.close())
  return { supervisor, statuses }
}
/**
 * A copy of the installed package as `version` under `directory`, returning its server module; `never` makes it never
 * ready. `migration` appends a state database migration to the copy, and `crash` makes its server open and migrate the
 * plugin data, as the real server does before it serves /health, and then exit.
 */
async function release(directory, version, { never = false, migration, crash = false } = {}) {
  const root = join(directory, 'node_modules/@kipster/plugins')
  await cp(packageRoot, root, { recursive: true })
  await symlink(join(packageRoot, '..', '..'), join(root, 'node_modules')).catch(() => undefined)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, version }))
  if (never) await writeFile(join(root, 'dist/server/cli.js'), 'setInterval(() => {}, 1000)\n')
  if (migration) {
    const file = join(root, 'dist/state/home.js'), source = await readFile(file, 'utf8')
    const migrated = source.replace(/\n\];\nexport function migrate\(/, `\n  ${JSON.stringify(migration)},\n];\nexport function migrate(`)
    assert.notEqual(migrated, source, 'the package keeps its migrations in dist/state/home.js')
    await writeFile(file, migrated)
  }
  if (crash) await writeFile(join(root, 'dist/server/cli.js'), `import { parseArgs } from 'node:util'
import { fileKeyBackend, openHome } from '../state/home.js'
const { values } = parseArgs({ strict: false, options: { home: { type: 'string' } } })
const home = await openHome(values.home, { keyBackend: fileKeyBackend(values.home) })
home.close()
process.exit(1)
`)
  return join(root, 'dist/server/cli.js')
}
/** The state database's schema version in a plugin home. */
function stateVersion(root) {
  const db = new DatabaseSync(join(root, 'plugins/state.db'), { readOnly: true })
  try { return db.prepare('PRAGMA user_version').get().user_version } finally { db.close() }
}
const highest = root => readFile(join(root, 'plugins-host/highest-version'), 'utf8').then(text => text.trim(), () => null)
const pendingName = 'highest-version.pending'
const pending = root => readFile(join(root, 'plugins-host', pendingName), 'utf8').then(text => text.trim(), () => null)
async function script(directory, name, source) {
  const path = join(directory, name)
  await writeFile(path, source)
  return path
}

test('starts the plugin server to ready with a private token that opens /v1', async t => {
  const root = await home(t), service = await fixture(t)
  const { supervisor, statuses } = supervise(t, { home: root, module: cli, testOnly: { catalogue, baseUrl: service.url } })
  assert.equal(supervisor.endpoint(), undefined)
  await supervisor.start()
  const ready = await wait(() => supervisor.status.state === 'ready' && supervisor.status)
  const endpoint = supervisor.endpoint()
  assert.equal(endpoint.url, `http://127.0.0.1:${ready.port}`)
  assert.equal(typeof ready.version, 'string')
  assert.deepEqual(statuses.map(status => status.state).slice(0, 3), ['starting', 'starting', 'ready'])

  const authorized = await v1(endpoint.url, endpoint.token)
  assert.equal(authorized.status, 200)
  assert.equal((await authorized.json()).version, 'v1')
  assert.equal((await v1(endpoint.url)).status, 401)
  assert.equal((await v1(endpoint.url, 'x'.repeat(43))).status, 401)
  const plugins = await (await fetch(`${endpoint.url}/v1/plugins`, { headers: { authorization: `Bearer ${endpoint.token}` } })).json()
  assert.ok(JSON.stringify(plugins).includes('fixture'), 'serves the test-only catalogue')

  // >=32 random bytes, private files, never in the server's arguments.
  assert.match(endpoint.token, /^[A-Za-z0-9_-]{43,}$/)
  assert.equal((await stat(join(root, 'plugins-host'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, 'plugins-host/token'))).mode & 0o777, 0o600)
  assert.equal((await readFile(join(root, 'plugins-host/token'), 'utf8')).trim(), endpoint.token)
  assert.equal(Number(await readFile(join(root, 'plugins-host/port'), 'utf8')), ready.port)
  const [child] = children()
  assert.ok(child, 'the server is Core\'s child')
  assert.ok(!child.command.includes(endpoint.token))
  for (const argument of [`--port ${ready.port}`, `--home ${join(root, 'plugins')}`, '--key-backend file', `--catalogue ${catalogue}`, `--test-only-base-url ${service.url}`]) assert.ok(child.command.includes(argument), argument)
  assert.equal((await stat(join(root, 'plugins'))).isDirectory(), true)
  await stat(join(root, 'logs/plugins.log'))
})

test('restarts after the server is killed, and close stops it', async t => {
  const root = await home(t), service = await fixture(t)
  const { supervisor, statuses } = supervise(t, { home: root, module: cli, testOnly: { catalogue, baseUrl: service.url } })
  await supervisor.start()
  await wait(() => supervisor.endpoint())
  const { token } = supervisor.endpoint()
  const [first] = children()
  process.kill(first.pid, 'SIGKILL')
  await wait(() => statuses.some(status => status.state === 'restarting'))
  const endpoint = await wait(() => supervisor.endpoint())
  const [second] = children()
  assert.notEqual(second.pid, first.pid)
  assert.equal(endpoint.token, token)
  assert.match(statuses.find(status => status.state === 'restarting').reason, /signal SIGKILL/)
  assert.equal((await v1(endpoint.url, endpoint.token)).status, 200)

  await supervisor.close()
  assert.equal(supervisor.endpoint(), undefined)
  assert.deepEqual(supervisor.status, { state: 'stopped' })
  assert.equal(alive(second.pid), false)
  await assert.rejects(fetch(`${endpoint.url}/health`))
})

test('reuses the recorded port and token, and moves when the port is busy', async t => {
  const root = await home(t), service = await fixture(t)
  const options = { home: root, module: cli, testOnly: { catalogue, baseUrl: service.url } }
  const first = supervise(t, options).supervisor
  await first.start()
  const before = await wait(() => first.endpoint())
  await first.close()

  const second = supervise(t, options).supervisor
  await second.start()
  assert.deepEqual(await wait(() => second.endpoint()), before)
  await second.close()

  const busy = createServer()
  await new Promise(resolve => busy.listen(Number(new URL(before.url).port), '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => busy.close(resolve)))
  const third = supervise(t, options).supervisor
  await third.start()
  const moved = await wait(() => third.endpoint())
  assert.notEqual(moved.url, before.url)
  assert.equal(moved.token, before.token)
  assert.equal(Number(await readFile(join(root, 'plugins-host/port'), 'utf8')), Number(new URL(moved.url).port))
  assert.equal((await v1(moved.url, moved.token)).status, 200)
  await third.close()

  // Core's listener and the embedding server's port are never taken, even while they are free.
  const reservedPort = Number(new URL(moved.url).port)
  const fourth = supervise(t, { ...options, reservedPorts: [reservedPort] }).supervisor
  await fourth.start()
  const avoided = await wait(() => fourth.endpoint())
  assert.notEqual(Number(new URL(avoided.url).port), reservedPort)
})

test('overlapping restarts run one server and the old endpoint ends at once', async t => {
  const root = await home(t), service = await fixture(t)
  const { supervisor } = supervise(t, { home: root, module: cli, testOnly: { catalogue, baseUrl: service.url } })
  await supervisor.start()
  await wait(() => supervisor.endpoint())
  const [before] = children()
  const restarts = [supervisor.restart(), supervisor.restart(), supervisor.restart(cli)]
  assert.equal(supervisor.endpoint(), undefined)
  await Promise.all(restarts)
  const endpoint = await wait(() => supervisor.endpoint())
  assert.equal(alive(before.pid), false)
  assert.equal(children().length, 1)
  assert.equal((await v1(endpoint.url, endpoint.token)).status, 200)

  const restarting = supervisor.restart()
  const closing = supervisor.close()
  assert.equal(supervisor.endpoint(), undefined)
  assert.deepEqual(supervisor.status, { state: 'stopped' })
  await Promise.all([restarting, closing])
  assert.deepEqual(children(), [])
  assert.deepEqual(supervisor.status, { state: 'stopped' })
})

test('a missing module or a server that never becomes ready leaves plugins off', async t => {
  const root = await home(t)
  const missing = supervise(t, { home: root, module: join(root, 'missing/cli.js') }).supervisor
  await missing.start()
  assert.equal(missing.status.state, 'failed')
  assert.match(missing.status.reason, /module is missing/)
  assert.equal(missing.endpoint(), undefined)

  const silent = await script(root, 'silent.mjs', 'setInterval(() => {}, 1000)\n')
  const never = supervise(t, { home: root, module: silent, readyTimeoutMs: 300, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } })
  await never.supervisor.start()
  await wait(() => never.supervisor.status.state === 'failed')
  assert.match(never.supervisor.status.reason, /failed 1 restarts; last: The plugin server was not ready within 300 ms/)
  assert.ok(never.statuses.every(status => status.state !== 'ready'))
  assert.equal(never.supervisor.endpoint(), undefined)
  assert.deepEqual(children(), [])

  // A server without control API v1 is incompatible: failed at once, without restarts.
  const old = await script(root, 'old.mjs', `import { createServer } from 'node:http'
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
createServer((req, res) => res.end(JSON.stringify({ status: 'ok', version: '0.0.1', controlApiVersions: ['v0'] }))).listen(port, '127.0.0.1')
`)
  const incompatible = supervise(t, { home: root, module: old })
  await incompatible.supervisor.start()
  await wait(() => incompatible.supervisor.status.state === 'failed')
  assert.match(incompatible.supervisor.status.reason, /control API v1/)
  assert.ok(incompatible.statuses.every(status => status.state !== 'restarting'))

  // restart(module) switches only this server to another module.
  const service = await fixture(t)
  const switched = supervise(t, { home: root, module: silent, testOnly: { catalogue, baseUrl: service.url } }).supervisor
  await switched.start()
  await switched.restart(cli)
  assert.equal(switched.module, cli)
  const endpoint = await wait(() => switched.endpoint())
  assert.equal((await v1(endpoint.url, endpoint.token)).status, 200)
})

test('asking for plugins after the server gave up starts it again', async t => {
  const root = await home(t), service = await fixture(t)
  const later = join(root, 'later/cli.js')
  const { supervisor } = supervise(t, { home: root, module: later, testOnly: { catalogue, baseUrl: service.url } })
  await supervisor.start()
  assert.equal(supervisor.status.state, 'failed')
  // The cause goes away, as after a fixed install; the next request for plugins retries.
  await mkdir(dirname(later), { recursive: true })
  await symlink(cli, later)
  const client = new PluginControlClient(supervisor)
  assert.throws(() => client.requireReady(), error => error.status === 503 && error.code === 'plugins-unavailable')
  const endpoint = await wait(() => supervisor.endpoint())
  assert.equal((await v1(endpoint.url, endpoint.token)).status, 200)
  client.requireReady()
})

test('never starts a plugin server older than one that already ran with the plugin data', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }
  const v3 = await release(join(root, 'core-0.3.0'), '0.3.0'), v2 = await release(join(root, 'core-0.2.0'), '0.2.0')
  const first = supervise(t, { home: root, module: v3, testOnly }).supervisor
  assert.equal(first.highestVersion, null)
  await first.start()
  await wait(() => first.endpoint())
  assert.equal(await highest(root), '0.3.0', 'recorded once ready')
  assert.equal(first.highestVersion, '0.3.0')
  assert.equal((await stat(join(root, 'plugins-host/highest-version'))).mode & 0o777, 0o600)
  await first.close()

  // A Core restore points host.json's module at an older release, and Core installed none in plugins-host.
  const { supervisor, statuses } = supervise(t, { home: root, module: v2, testOnly })
  await supervisor.start()
  assert.equal(supervisor.status.state, 'failed')
  assert.equal(supervisor.status.reason, 'The plugin server 0.2.0 is older than 0.3.0, which already ran with this plugin data; install @kipster/plugins 0.3.0 or newer')
  assert.equal(supervisor.endpoint(), undefined)
  assert.ok(statuses.every(status => status.state !== 'ready' && status.state !== 'restarting'))
  assert.deepEqual(children(process.pid, v2), [], '0.2.0 never spawned')
  assert.ok(statuses.every(status => status.port === undefined), 'no launch began')
  assert.equal(await highest(root), '0.3.0')
  assert.deepEqual(pluginServerDiagnostic(supervisor.status), { status: 'unavailable', message: `Plugin server failed: ${supervisor.status.reason}. Plugins are off; inspect logs/plugins.log.` })

  // Installing 0.3.0 or newer into plugins-host and restarting starts it.
  await release(join(root, 'plugins-host/versions/0.3.0'), '0.3.0')
  await symlink('versions/0.3.0', join(root, 'plugins-host/current'))
  await supervisor.restart()
  await wait(() => supervisor.endpoint())
  assert.equal(supervisor.packageVersion, '0.3.0')
  assert.equal(await highest(root), '0.3.0')
  await supervisor.close()
})

test('records the plugin server version once its process starts, ready or not, and only upward', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }, file = join(root, 'plugins-host/highest-version')
  const v4 = await release(join(root, 'core-0.4.0'), '0.4.0'), v5 = await release(join(root, 'core-0.5.0'), '0.5.0', { never: true })
  const ran = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await ran.start()
  await wait(() => ran.endpoint())
  assert.equal(await highest(root), '0.4.0')
  await ran.close()

  // A recorded newer version is never lowered; 0.4.0 is refused instead.
  await writeFile(file, '0.4.1\n')
  const lower = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await lower.start()
  assert.match(lower.status.reason, /0\.4\.0 is older than 0\.4\.1/)
  assert.equal(await highest(root), '0.4.1')
  await lower.close()

  // An invalid record is logged and ignored like an unreadable port file, kept until a server starts, then replaced.
  await writeFile(file, 'not a version\n')
  const logs = []
  const invalid = supervise(t, { home: root, module: v4, testOnly, log: line => logs.push(line) }).supervisor
  await invalid.start()
  assert.equal(await readFile(file, 'utf8'), 'not a version\n')
  await wait(() => invalid.endpoint())
  assert.ok(logs.some(line => line === `Ignoring invalid ${file}.`), logs.join('\n'))
  assert.equal(await highest(root), '0.4.0')

  await invalid.close()

  // A module whose version cannot be read runs as before and records nothing.
  const silent = await script(root, 'silent.mjs', 'setInterval(() => {}, 1000)\n')
  const unversioned = supervise(t, { home: root, module: silent, readyTimeoutMs: 300, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } }).supervisor
  await unversioned.start()
  await wait(() => unversioned.status.state === 'failed')
  assert.match(unversioned.status.reason, /not ready within/, 'started, not refused')
  assert.equal(await highest(root), '0.4.0')

  // A newer server that never becomes ready still ran with the plugin data, so its version is kept.
  const never = supervise(t, { home: root, module: v5, testOnly, readyTimeoutMs: 300, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } }).supervisor
  await never.start()
  await wait(() => never.status.state === 'failed')
  assert.match(never.status.reason, /not ready within/)
  assert.equal(never.highestVersion, '0.5.0')
  assert.equal(await highest(root), '0.5.0', 'a server that never became ready keeps its version')
  assert.equal(await pending(root), null, 'the record is complete')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const refused = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await refused.start()
  assert.match(refused.status.reason, /0\.4\.0 is older than 0\.5\.0/)
  assert.deepEqual(children(process.pid, v4), [])
})

test('a newer version that cannot be staged never starts', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }
  const v3 = await release(join(root, 'core-0.3.0'), '0.3.0'), v4 = await release(join(root, 'core-0.4.0'), '0.4.0')
  const { supervisor, statuses } = supervise(t, { home: root, module: v3, testOnly })
  await supervisor.start()
  await wait(() => supervisor.endpoint())
  assert.equal(await highest(root), '0.3.0')

  // A directory at the staged name makes the write fail before 0.4.0 is spawned.
  await mkdir(join(root, 'plugins-host', pendingName))
  await supervisor.restart(v4)
  const failed = await wait(() => supervisor.status.state === 'failed' && supervisor.status)
  assert.match(failed.reason, /^Core could not record plugin server version 0\.4\.0 in .*highest-version \(.*EISDIR.*\), so it did not start the server; make .*plugins-host writable and restart Core$/)
  assert.equal(supervisor.endpoint(), undefined)
  assert.deepEqual(children(process.pid, v4), [], '0.4.0 never spawned')
  assert.equal(supervisor.highestVersion, '0.3.0')
  assert.equal(await highest(root), '0.3.0')
  assert.equal(statuses.filter(status => status.state === 'restarting').length, 0, 'not retried')

  await rm(join(root, 'plugins-host', pendingName), { recursive: true })
  await supervisor.restart(v4)
  await wait(() => supervisor.endpoint())
  assert.equal(await highest(root), '0.4.0')
  assert.equal(await pending(root), null)
})

test('a newer version whose record cannot be completed is stopped and refuses older ones in a later Core', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }, file = join(root, 'plugins-host/highest-version')
  const v3 = await release(join(root, 'core-0.3.0'), '0.3.0'), v4 = await release(join(root, 'core-0.4.0'), '0.4.0')
  const first = supervise(t, { home: root, module: v3, testOnly }).supervisor
  await first.start()
  await wait(() => first.endpoint())
  await first.close()

  // A non-empty directory in place of the record makes the rename fail after 0.4.0 is ready.
  await rm(file)
  await mkdir(join(file, 'blocked'), { recursive: true })
  const { supervisor, statuses } = supervise(t, { home: root, module: v4, testOnly })
  await supervisor.start()
  const failed = await wait(() => supervisor.status.state === 'failed' && supervisor.status)
  assert.match(failed.reason, /^Core could not record plugin server version 0\.4\.0 in .*highest-version \(.*\), so it stopped the server; make .*plugins-host writable and restart Core$/)
  assert.ok(statuses.every(status => status.state !== 'ready' && status.state !== 'restarting'))
  assert.equal(supervisor.endpoint(), undefined)
  await wait(() => children(process.pid, v4).length === 0)
  assert.equal(supervisor.highestVersion, '0.4.0', 'counts for this process')
  assert.equal(await pending(root), '0.4.0', 'and stays staged for the next')
  assert.equal((await stat(join(root, 'plugins-host', pendingName))).mode & 0o777, 0o600)
  await supervisor.close()

  // A later Core, with no memory of the failed record, still refuses 0.3.0.
  const later = supervise(t, { home: root, module: v3, testOnly }).supervisor
  await later.start()
  assert.equal(later.status.reason, 'The plugin server 0.3.0 is older than 0.4.0, which already ran with this plugin data; install @kipster/plugins 0.4.0 or newer')
  assert.deepEqual(children(process.pid, v3), [])
  assert.equal(later.highestVersion, '0.4.0')
  await later.close()

  await rm(file, { recursive: true })
  const recovered = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await recovered.start()
  await wait(() => recovered.endpoint())
  assert.equal(await highest(root), '0.4.0')
  assert.equal(await pending(root), null)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('a version staged by a Core that stopped while its server started still counts', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }
  const v3 = await release(join(root, 'core-0.3.0'), '0.3.0'), v4 = await release(join(root, 'core-0.4.0'), '0.4.0')
  await mkdir(join(root, 'plugins-host'), { recursive: true })
  await writeFile(join(root, 'plugins-host/highest-version'), '0.3.0\n')
  await writeFile(join(root, 'plugins-host', pendingName), '0.4.0\n')

  const older = supervise(t, { home: root, module: v3, testOnly }).supervisor
  await older.start()
  assert.match(older.status.reason, /0\.3\.0 is older than 0\.4\.0/)
  assert.deepEqual(children(process.pid, v3), [])
  await older.close()

  const ran = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await ran.start()
  await wait(() => ran.endpoint())
  assert.equal(await highest(root), '0.4.0')
  assert.equal(await pending(root), null)
})

test('a newer server that migrated the plugin data and exited before it was ready stays the floor', async t => {
  const root = await home(t), service = await fixture(t), testOnly = { catalogue, baseUrl: service.url }
  const migration = 'CREATE TABLE newer_state (id INTEGER PRIMARY KEY);'
  const v4 = await release(join(root, 'core-0.4.0'), '0.4.0'), broken = await release(join(root, 'core-0.5.0'), '0.5.0', { migration, crash: true })
  const first = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await first.start()
  await wait(() => first.endpoint())
  await first.close()
  const migrated = stateVersion(root)

  const { supervisor } = supervise(t, { home: root, module: broken, testOnly, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } })
  await supervisor.start()
  await wait(() => supervisor.status.state === 'failed')
  assert.match(supervisor.status.reason, /exited with code 1 before it was ready/)
  assert.equal(stateVersion(root), migrated + 1, '0.5.0 migrated the plugin data')
  assert.equal(supervisor.highestVersion, '0.5.0')
  assert.equal(await highest(root), '0.5.0')
  assert.equal(await pending(root), null)
  assert.equal((await stat(join(root, 'plugins-host/highest-version'))).mode & 0o777, 0o600)
  await supervisor.close()

  // A later Core refuses 0.4.0, whose server would fail on the newer state database.
  const later = supervise(t, { home: root, module: v4, testOnly })
  await later.supervisor.start()
  assert.equal(later.supervisor.status.reason, 'The plugin server 0.4.0 is older than 0.5.0, which already ran with this plugin data; install @kipster/plugins 0.5.0 or newer')
  assert.equal(later.supervisor.highestVersion, '0.5.0')
  assert.deepEqual(children(process.pid, v4), [], '0.4.0 never spawned')
  assert.ok(later.statuses.every(status => status.port === undefined), 'no launch began')

  // A fixed release at the recorded version starts again.
  await release(join(root, 'plugins-host/versions/0.5.0'), '0.5.0', { migration })
  await symlink('versions/0.5.0', join(root, 'plugins-host/current'))
  await later.supervisor.restart()
  await wait(() => later.supervisor.endpoint())
  assert.equal(later.supervisor.packageVersion, '0.5.0')
  assert.equal(await highest(root), '0.5.0')
})

test('a newer server stopped or timed out before it was ready stays the floor', async t => {
  const root = await home(t), testOnly = { catalogue, baseUrl: 'http://127.0.0.1:1' }
  const v3 = await release(join(root, 'core-0.3.0'), '0.3.0', { never: true }), v4 = await release(join(root, 'core-0.4.0'), '0.4.0', { never: true })
  const timedOut = supervise(t, { home: root, module: v3, testOnly, readyTimeoutMs: 300, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } }).supervisor
  await timedOut.start()
  await wait(() => timedOut.status.state === 'failed')
  assert.match(timedOut.status.reason, /not ready within 300 ms/)
  assert.equal(timedOut.highestVersion, '0.3.0')
  assert.equal(await highest(root), '0.3.0')

  const stopped = supervise(t, { home: root, module: v4, testOnly }).supervisor
  await stopped.start()
  await wait(() => children(process.pid, v4).length === 1)
  assert.equal(stopped.status.state, 'starting')
  await stopped.close()
  assert.deepEqual(children(process.pid, v4), [])
  assert.equal(stopped.highestVersion, '0.4.0')
  assert.equal(await highest(root), '0.4.0')
  assert.equal(await pending(root), null)

  const later = supervise(t, { home: root, module: v3, testOnly }).supervisor
  await later.start()
  assert.match(later.status.reason, /0\.3\.0 is older than 0\.4\.0/)
  assert.deepEqual(children(process.pid, v3), [])
})

test('a launch that fails before its server process exists does not raise the floor', async t => {
  const root = await home(t), testOnly = { catalogue, baseUrl: 'http://127.0.0.1:1' }
  const v5 = await release(join(root, 'core-0.5.0'), '0.5.0')
  await mkdir(join(root, 'plugins-host'), { recursive: true })
  await writeFile(join(root, 'plugins-host/highest-version'), '0.3.0\n')
  // A directory where the server's log belongs makes the launch fail before it spawns anything.
  await mkdir(join(root, 'logs/plugins.log'), { recursive: true })
  const options = { home: root, module: v5, testOnly, backoff: { initialMs: 10, maxMs: 10, attempts: 1 } }

  const first = supervise(t, options).supervisor
  await first.start()
  await wait(() => first.status.state === 'failed')
  assert.match(first.status.reason, /EISDIR/)
  assert.deepEqual(children(process.pid, v5), [])
  assert.equal(first.highestVersion, '0.3.0')
  assert.equal(await highest(root), '0.3.0')
  assert.equal(await pending(root), null, 'the staged version is dropped')
  await first.close()

  // A version staged by an earlier Core is put back, and still counts.
  await writeFile(join(root, 'plugins-host', pendingName), '0.4.0\n')
  const second = supervise(t, options).supervisor
  await second.start()
  await wait(() => second.status.state === 'failed')
  assert.match(second.status.reason, /EISDIR/)
  assert.equal(second.highestVersion, '0.4.0')
  assert.equal(await highest(root), '0.3.0')
  assert.equal(await pending(root), '0.4.0')
})

test('the server stops when the Core process that started it dies', async t => {
  const root = await home(t), service = await fixture(t)
  const supervisorUrl = new URL('../dist/plugins/supervisor.js', import.meta.url).href
  const source = `const { PluginServerSupervisor } = await import(${JSON.stringify(supervisorUrl)})
const supervisor = new PluginServerSupervisor({ home: ${JSON.stringify(root)}, module: ${JSON.stringify(cli)}, testOnly: { catalogue: ${JSON.stringify(catalogue)}, baseUrl: ${JSON.stringify(service.url)} },
  onStatus: status => { if (status.state === 'ready') console.log('ready') } })
await supervisor.start()
setInterval(() => {}, 1000)
`
  const core = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => core.kill('SIGKILL'))
  await new Promise((resolve, reject) => { core.stdout.on('data', chunk => String(chunk).includes('ready') && resolve()); core.once('exit', reject) })
  const [server] = children(core.pid)
  assert.ok(server)
  core.kill('SIGKILL')
  await wait(() => !alive(server.pid), 10000)
})

test('host configuration accepts only an absolute plugin server module', () => {
  const value = { version: 1, home: '/tmp/kipster', databaseUrl: 'postgresql://kipster@localhost/unused', listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [] }
  assert.equal(validateHostConfig(value).plugins, undefined)
  assert.deepEqual(validateHostConfig({ ...value, plugins: { module: cli } }).plugins, { module: cli })
  for (const plugins of [null, [], 'module', {}, { module: '' }, { module: 'node_modules/@kipster/plugins/dist/server/cli.js' }, { module: cli, testOnly: { catalogue, baseUrl: 'http://127.0.0.1:1' } }, { module: cli, port: 1 }])
    assert.throws(() => validateHostConfig({ ...value, plugins }), /Configure plugins with only an absolute module/)
})

test('diagnostics report the running host plugin server', async t => {
  const root = await home(t)
  const host = { version: 1, home: root, databaseUrl: 'postgresql://kipster@127.0.0.1:1/unused', listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [] }
  const row = async config => (await doctor(config)).find(item => item.check === 'plugins')
  assert.deepEqual(await row(host), { check: 'plugins', status: 'not-configured', message: 'No plugin server is configured, so plugins are off.' })
  assert.equal((await row({ ...host, plugins: { module: join(root, 'missing.js') } })).status, 'unavailable')
  const configured = { ...host, plugins: { module: cli } }
  assert.deepEqual(await row(configured), { check: 'plugins', status: 'not-probed', message: 'Plugin server is configured; the running host starts it.' })
  const status = { state: 'running', pid: process.pid, instance: randomUUID(), plugins: { state: 'ready', port: 45123, version: '0.1.0' } }
  const owner = await ownControl(root, status, () => {})
  t.after(() => owner.close().catch(() => {}))
  assert.deepEqual(await row(configured), { check: 'plugins', status: 'ok', message: 'Plugin server 0.1.0 is ready on port 45123.' })
  status.plugins = { state: 'failed', reason: 'The plugin server exited with code 1' }
  assert.equal((await row(configured)).status, 'unavailable')
  assert.match((await row(configured)).message, /Plugins are off; inspect logs\/plugins.log/)
  assert.equal(pluginServerDiagnostic({ state: 'restarting', attempt: 2, reason: 'x' }).status, 'unavailable')
})

test('the host runs the configured plugin server and keeps running without it', { skip: noDatabase, timeout: 120000 }, async t => {
  const admin = new Postgres(adminUrl), database = 'kipster_plugins_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl); url.pathname = '/' + database
  const root = await realpath(await mkdtemp('/tmp/lhp-'))
  t.after(async () => { await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.close(); await rm(root, { recursive: true, force: true }) })
  const port = await new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) }) })
  const config = { version: 1, home: root, databaseUrl: url.href, listen: { host: '127.0.0.1', port, allowedHosts: [], allowedOrigins: [] }, adapters: [] }
  const serve = async plugins => {
    const file = join(root, 'host.json')
    await writeFile(file, JSON.stringify({ ...config, plugins }))
    const host = spawn(process.execPath, [hostCli, 'serve', '--config', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; host.stdout.on('data', chunk => output += chunk); host.stderr.on('data', chunk => output += chunk)
    t.after(() => host.kill('SIGKILL'))
    const status = await wait(async () => { const value = await control(root, 'status').catch(() => null); return value?.state === 'running' && value }, 60000)
    return { host, status, output: () => output }
  }
  const stop = async host => { await control(root, 'stop'); await new Promise(resolve => host.exitCode !== null ? resolve() : host.once('exit', resolve)) }

  const absent = await serve({ module: join(root, 'missing/cli.js') })
  assert.equal(absent.status.plugins.state, 'failed')
  assert.equal((await fetch(`${absent.status.url}/v1/bootstrap`)).status, 200)
  assert.match(absent.output(), /Plugin server failed: The plugin server module is missing/)
  await stop(absent.host)

  const running = await serve({ module: cli })
  const ready = await wait(async () => { const value = await control(root, 'status'); return value.plugins?.state === 'ready' && value.plugins })
  const token = (await readFile(join(root, 'plugins-host/token'), 'utf8')).trim()
  assert.equal((await v1(`http://127.0.0.1:${ready.port}`, token)).status, 200)
  assert.equal((await doctor({ ...config, plugins: { module: cli } })).find(item => item.check === 'plugins').status, 'ok')
  const [server] = children(running.host.pid)
  await stop(running.host)
  assert.equal(alive(server.pid), false)
})
