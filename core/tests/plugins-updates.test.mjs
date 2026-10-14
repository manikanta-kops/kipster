import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startFixture } from '@kipster/plugins/fixture'
import { openRuntime, startTextServer } from '../dist/runtime.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { PluginServerSupervisor } from '../dist/plugins/supervisor.js'
import { updateStatus } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'
import { installedPluginsVersion, offlineNpm, pluginsCatalogue, pluginsCli, pluginsRelease, pluginsRoot } from './support/plugins-release.mjs'

const [major, minor] = installedPluginsVersion.split('.').map(Number)
assert.ok(minor > 0, 'the installed plugins version leaves room for an older release')
const newer = `${major}.${minor + 1}.0`, broken = `${major}.${minor + 2}.0`, older = `${major}.${minor - 1}.0`, recorded = `${major}.${minor + 3}.0`
const wait = async (read, predicate, label, ms = 60000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

// One private directory holds the release archives, built once from the installed package, and npm's offline configuration.
const shared = await realpath(await mkdtemp('/tmp/kipster-plugins-updates-'))
let archives
test.before(async () => {
  await offlineNpm(join(shared, 'npm-home'))
  archives = { [newer]: await pluginsRelease(shared, newer), [broken]: await pluginsRelease(shared, broken, { broken: true }), [recorded]: await pluginsRelease(shared, recorded) }
}, { timeout: 120000 })
test.after(() => rm(shared, { recursive: true, force: true }))

const entry = (version, extra = {}) => ({
  package: '@kipster/plugins', version, prerelease: version.includes('-'), notes: 'Plugins notes', publishedAt: '2026-10-02T09:00:00Z',
  files: archives[version] ? [{ name: archives[version].name, url: `/files/${archives[version].name}`, size: archives[version].size, sha256: archives[version].sha256 }]
    : [{ name: `kipster-plugins-${version}.tgz`, url: `/files/kipster-plugins-${version}.tgz`, size: 1, sha256: 'a'.repeat(64) }],
  ...extra,
})

/**
 * A Core runtime with a supervised plugin server on the installed package, and a loopback channel with its archives.
 * `highest` records a newer plugins version as already run with the plugin data, so the installed one is refused.
 */
async function setup(t, { managed = true, mode = 'notify', plugins = true, stable, highest } = {}) {
  const admin = new Postgres(adminUrl), name = `kipster_plugins_updates_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl); url.pathname = `/${name}`
  const home = await realpath(await mkdtemp('/tmp/kipster-plugins-home-'))
  if (highest) { await mkdir(join(home, 'plugins-host'), { recursive: true, mode: 0o700 }); await writeFile(join(home, 'plugins-host/highest-version'), `${highest}\n`, { mode: 0o600 }) }
  const service = await startFixture()
  const channel = { stable: stable ?? { schemaVersion: 1, packages: { '@kipster/plugins': entry(newer) } }, downloads: [] }
  const source = createServer((request, response) => {
    if (request.url.startsWith('/files/')) {
      const file = Object.values(archives).find(archive => request.url === `/files/${archive.name}`)
      channel.downloads.push(request.url)
      if (!file) { response.writeHead(404).end(); return }
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      createReadStream(file.path).pipe(response)
      return
    }
    const value = request.url === '/v1/stable.json' ? channel.stable : { schemaVersion: 1, packages: {} }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(value).replaceAll('"/files/', `"http://127.0.0.1:${source.address().port}/files/`))
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  const statuses = []
  const supervisor = plugins ? new PluginServerSupervisor({ home, module: pluginsCli, testOnly: { catalogue: pluginsCatalogue, baseUrl: service.url },
    backoff: { initialMs: 50, maxMs: 200, attempts: 2 }, readyTimeoutMs: 15000, onStatus: status => statuses.push(status) }) : undefined
  await supervisor?.start()
  if (supervisor) await wait(() => supervisor.status, status => status.state === (highest ? 'failed' : 'ready'), 'plugin server started')
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' },
    ...(supervisor ? { plugins: supervisor } : {}), updates: { channelUrl: `http://127.0.0.1:${source.address().port}/v1/`, coreVersion: '1.2.0', managed } })
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0 })
  t.after(async () => {
    await server.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await supervisor?.close().catch(() => undefined)
    await service.close().catch(() => undefined)
    await new Promise(resolve => source.close(resolve))
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.close()
    await rm(home, { recursive: true, force: true })
  })
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  await call('PUT', '/v1/settings/updates', { version: 1, operationId: randomUUID(), channel: 'stable', mode })
  const ctx = { home, runtime, server, supervisor, statuses, channel, call, actor,
    status: async () => updateStatus.parse((await call('GET', '/v1/updates')).data),
    check: async () => updateStatus.parse((await call('POST', '/v1/updates/check', { version: 1 })).data),
    install: (target, operationId = randomUUID()) => call('POST', '/v1/updates/plugins/install', { version: 1, operationId, target }),
    settled: () => wait(ctx.status, status => !['installing', 'checking'].includes(status.plugins.state), 'plugins install settled'),
    /** The plugin server answers with its token. */
    serving: async () => {
      const endpoint = supervisor.endpoint()
      return endpoint ? (await fetch(`${endpoint.url}/v1/plugins`, { headers: { authorization: `Bearer ${endpoint.token}` } })).status === 200 : false
    },
    current: () => readlink(join(home, 'plugins-host/current')).catch(() => null),
  }
  return ctx
}

test('notify mode shows the plugins release; the install action restarts only the plugin server on it', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t)
  const before = await ctx.status()
  assert.deepEqual(before.plugins, { version: installedPluginsVersion, available: null, state: 'idle', error: null, lastResult: null })
  const checked = await ctx.check()
  assert.equal(checked.plugins.available.version, newer)
  assert.equal(checked.plugins.available.files[0].sha256, archives[newer].sha256)
  assert.equal(checked.plugins.state, 'idle')
  assert.equal(checked.core.available, null, 'a channel without Core still checks plugins')
  await ctx.runtime.updates.tick()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await ctx.status()).plugins.state, 'idle', 'notify mode does not install')
  assert.deepEqual(ctx.channel.downloads, [])
  assert.equal(ctx.supervisor.packageVersion, installedPluginsVersion)

  const pid = process.pid, runtime = ctx.runtime, readyBefore = ctx.statuses.filter(status => status.state === 'ready').length
  const operationId = randomUUID()
  const accepted = await ctx.install(newer, operationId)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
  assert.equal(accepted.data.plugins.state, 'installing')
  assert.equal((await ctx.call('GET', '/v1/directory')).status, 200, 'Core serves while the plugins install')
  const done = await ctx.settled()
  assert.equal(done.plugins.state, 'idle', JSON.stringify(done.plugins))
  assert.equal(done.plugins.version, newer)
  assert.equal(done.plugins.available, null)
  assert.equal(done.plugins.error, null)
  assert.deepEqual({ ...done.plugins.lastResult, at: undefined }, { from: installedPluginsVersion, to: newer, outcome: 'installed', at: undefined })
  assert.equal(ctx.supervisor.packageVersion, newer)
  assert.equal(ctx.supervisor.module, join(ctx.home, 'plugins-host/versions', newer, 'node_modules/@kipster/plugins/dist/server/cli.js'))
  assert.equal(await ctx.current(), join('versions', newer))
  assert.ok(await ctx.serving(), 'the new plugin server answers')
  assert.equal(ctx.statuses.filter(status => status.state === 'ready').length, readyBefore + 1, 'the plugin server restarted once')
  assert.equal(process.pid, pid); assert.equal(ctx.runtime, runtime)
  assert.equal((await ctx.call('GET', '/v1/directory')).status, 200, 'the same Core keeps serving')
  assert.deepEqual(ctx.channel.downloads, [`/files/${archives[newer].name}`])
  assert.equal((await ctx.install(newer, operationId)).status, 200, 'a retry returns the recorded result')
  assert.equal((await ctx.install(newer)).data.code, 'update-already-installed')
  const events = await ctx.runtime.db.query("SELECT data FROM kipster.app_events WHERE type='updates-changed' ORDER BY position")
  assert.ok(events.rows.some(row => row.data.plugins?.state === 'installing') && events.rows.at(-1).data.plugins.version === newer, 'clients see the install through updates-changed')
})

test('automatic mode installs a newer plugins release on its own', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t, { mode: 'automatic' })
  await ctx.check()
  const done = await ctx.settled()
  assert.equal(done.plugins.version, newer, JSON.stringify(done.plugins))
  assert.equal(done.plugins.lastResult.outcome, 'installed')
  assert.ok(await ctx.serving())
})

test('a download whose SHA-256 or size differs from the channel is refused and the running version is kept', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t)
  for (const [field, value, message] of [['sha256', 'b'.repeat(64), /SHA-256/], ['size', 7, /size/]]) {
    const changed = entry(newer)
    changed.files[0][field] = value
    ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': changed } }
    await ctx.check()
    assert.equal((await ctx.install(newer)).status, 200)
    const failed = await ctx.settled()
    assert.equal(failed.plugins.state, 'failed')
    assert.match(failed.plugins.error, message)
    assert.equal(failed.plugins.lastResult.outcome, 'failed')
    assert.equal(failed.plugins.version, installedPluginsVersion)
    assert.equal(ctx.supervisor.packageVersion, installedPluginsVersion)
    assert.equal(await ctx.current(), null)
    assert.ok(await ctx.serving(), 'the running plugin server is untouched')
  }
  assert.deepEqual(await readdir(join(ctx.home, 'plugins-host/versions')), [], 'nothing is left of the refused downloads')
})

test('a release that fails readiness rolls back to the previous version', { skip: noDatabase, timeout: 240000 }, async t => {
  const ctx = await setup(t)
  await ctx.check()
  await ctx.install(newer)
  assert.equal((await ctx.settled()).plugins.version, newer)
  ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': entry(broken) } }
  assert.equal((await ctx.check()).plugins.available.version, broken)
  assert.equal((await ctx.install(broken)).status, 200)
  const rolled = await ctx.settled()
  assert.equal(rolled.plugins.state, 'failed')
  assert.equal(rolled.plugins.lastResult.outcome, 'rolled-back')
  assert.deepEqual([rolled.plugins.lastResult.from, rolled.plugins.lastResult.to], [newer, broken])
  assert.match(rolled.plugins.error, new RegExp(`${broken.replaceAll('.', '\\.')} did not start .*${newer.replaceAll('.', '\\.')} runs again`))
  assert.equal(rolled.plugins.version, newer)
  assert.equal(rolled.plugins.available.version, broken, 'the release stays available to retry')
  assert.equal(await ctx.current(), join('versions', newer))
  assert.deepEqual(await readdir(join(ctx.home, 'plugins-host/versions')), [newer])
  assert.ok(await ctx.serving(), 'the previous plugin server runs again')
  // A failed release is not retried automatically.
  await ctx.call('PUT', '/v1/settings/updates', { version: 1, operationId: randomUUID(), channel: 'stable', mode: 'automatic' })
  await ctx.check()
  assert.equal((await ctx.status()).plugins.state, 'failed')
})

test('installs that the channel or host does not allow are refused', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t, { stable: { schemaVersion: 1, packages: {} } })
  assert.equal((await ctx.check()).plugins.available, null)
  const missing = await ctx.install(newer)
  assert.deepEqual([missing.status, missing.data.code], [409, 'update-not-available'], 'the channel has no plugins release')
  ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': entry(newer) } }
  await ctx.check()
  assert.equal((await ctx.install(`${major}.${minor + 9}.0`)).data.code, 'update-not-available', 'a version the channel does not name')
  assert.equal((await ctx.install(installedPluginsVersion)).data.code, 'update-already-installed')
  ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': entry(older) } }
  assert.equal((await ctx.check()).plugins.available, null, 'an older release is not offered')
  assert.equal((await ctx.install(older)).data.code, 'update-not-available', 'no downgrade')
  ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': { ...entry(newer), files: [] } } }
  const invalid = await ctx.check()
  assert.match(invalid.plugins.error, /Invalid plugins channel entry/)
  assert.equal(invalid.core.error, null, 'a bad plugins entry fails only the plugins check')
  assert.equal((await ctx.install('not-a-version')).status, 400)
  assert.equal((await ctx.call('POST', '/v1/updates/plugins/install', { version: 1, operationId: randomUUID(), target: newer, extra: true })).status, 400)
  assert.deepEqual(ctx.channel.downloads, [])
  assert.equal(await ctx.current(), null)
})

test('while an older plugin server is refused, only a release at or above the recorded version is offered and installed', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t, { mode: 'automatic', highest: recorded })
  assert.match(ctx.supervisor.status.reason, /is older than .*already ran with this plugin data/)
  assert.equal(ctx.supervisor.highestVersion, recorded)
  const below = await ctx.check()
  assert.equal(below.plugins.version, installedPluginsVersion)
  assert.equal(below.plugins.available, null, 'a release below the recorded version is not offered')
  await ctx.runtime.updates.tick()
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal((await ctx.status()).plugins.state, 'idle', 'nor installed automatically')
  const refused = await ctx.install(newer)
  assert.deepEqual([refused.status, refused.data.code], [409, 'update-not-available'])
  assert.match(refused.data.message, new RegExp(`${recorded.replaceAll('.', '\\.')} already ran with this plugin data`))
  assert.deepEqual(ctx.channel.downloads, [])
  assert.equal(ctx.supervisor.endpoint(), undefined, 'plugins stay off')

  ctx.channel.stable = { schemaVersion: 1, packages: { '@kipster/plugins': entry(recorded) } }
  assert.equal((await ctx.check()).plugins.available?.version, recorded, 'the recorded version itself is offered')
  const done = await ctx.settled()
  assert.equal(done.plugins.version, recorded, JSON.stringify(done.plugins))
  assert.equal(done.plugins.lastResult.outcome, 'installed')
  assert.equal(ctx.supervisor.status.state, 'ready')
  assert.ok(await ctx.serving(), 'plugins are on again')
})

test('unmanaged hosts and hosts without a plugin server never install', { skip: noDatabase, timeout: 180000 }, async t => {
  const unmanaged = await setup(t, { managed: false, mode: 'automatic' })
  assert.equal((await unmanaged.check()).plugins.available.version, newer)
  await unmanaged.runtime.updates.tick()
  assert.equal((await unmanaged.status()).plugins.state, 'idle', 'automatic mode does not install on an unmanaged host')
  const refused = await unmanaged.install(newer)
  assert.deepEqual([refused.status, refused.data.code], [409, 'update-unmanaged'])
  assert.deepEqual(unmanaged.channel.downloads, [])
  const without = await setup(t, { plugins: false })
  const status = await without.check()
  assert.equal(status.plugins, undefined, 'no plugins status without a plugin server')
  assert.equal((await without.install(newer)).data.code, 'update-not-available')
})

test('the plugin server runs the newer of the host.json module and the release Core installed', { timeout: 60000 }, async t => {
  const home = await realpath(await mkdtemp('/tmp/kipster-plugins-newest-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const copy = async (directory, version) => {
    const root = join(directory, 'node_modules/@kipster/plugins')
    await cp(pluginsRoot, root, { recursive: true })
    await symlink(join(pluginsRoot, '..', '..'), join(root, 'node_modules')).catch(() => undefined)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, version }))
    return join(root, 'dist/server/cli.js')
  }
  const installed = await copy(join(home, 'plugins-host/versions', newer), newer)
  await symlink(join('versions', newer), join(home, 'plugins-host/current'))
  const service = await startFixture()
  t.after(() => service.close())
  const run = async module => {
    const supervisor = new PluginServerSupervisor({ home, module, testOnly: { catalogue: pluginsCatalogue, baseUrl: service.url }, readyTimeoutMs: 15000 })
    try {
      await supervisor.start()
      const status = await wait(() => supervisor.status, status => ['ready', 'failed'].includes(status.state), 'ready or failed')
      return status.state === 'ready' ? [supervisor.module, supervisor.packageVersion] : status
    } finally { await supervisor.close() }
  }
  assert.deepEqual(await run(pluginsCli), [installed, newer], 'a newer installed release wins over host.json')
  await mkdir(join(home, 'host'), { recursive: true })
  const newest = await copy(join(home, 'host'), `${major}.${minor + 5}.0`)
  assert.deepEqual(await run(newest), [newest, `${major}.${minor + 5}.0`], 'a newer host.json module wins, so a Core update never downgrades plugins')
  await rm(join(home, 'plugins-host/current'))
  const refused = await run(pluginsCli)
  assert.equal(refused.state, 'failed', 'an older module never runs once a newer one has')
  assert.match(refused.reason, new RegExp(`${installedPluginsVersion.replaceAll('.', '\\.')} is older than ${major}\\.${minor + 5}\\.0`))
})
