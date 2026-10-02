import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { compareVersions, UpdatesService, UPDATE_CHECK_INTERVAL_MS } from '../dist/modules/updates/public.js'
import { writeUpdateFile } from '../dist/modules/updates/files.js'
import { MaintenanceService } from '../dist/modules/memory/public.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { snapshot, readEvents } from '../dist/modules/synchronization/public.js'
import { updateSettings, updateStatus, textEvent, stableError, updaterRequest } from '../dist/protocol/index.js'
import { validateHostConfig } from '../dist/host-config.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const entry = (version, extra = {}) => ({
  package: '@kipster/core', version, prerelease: version.split('+')[0].includes('-'), notes: 'Release notes', publishedAt: '2026-10-02T09:00:00Z',
  files: [{ name: `kipster-core-${version}.tgz`, url: `https://example.com/${version}.tgz`, size: 12345, sha256: 'a'.repeat(64), futureAsset: 'keep' }],
  protocolRange: { current: 1, oldest: 1, futureRange: true }, ...extra,
})
const catalog = value => ({ schemaVersion: 1, packages: value ? { '@kipster/core': value } : {} })
const setting = (channel = 'stable', mode = 'automatic', operationId = randomUUID()) => ({ version: 1, operationId, channel, mode })
const install = (target, extra = {}) => ({ version: 1, operationId: randomUUID(), target, ...extra })
const unpin = () => ({ version: 1, operationId: randomUUID() })
const backup = { id: 'backup-1.1.0', coreVersion: '1.1.0', createdAt: '2026-10-01T09:00:00Z' }
const fileStatus = (ctx, state, extra = {}) => ({ version: 1, requestId: randomUUID(), state, step: state === 'running' ? 'verifying' : null,
  from: '1.2.0', to: '1.3.0', error: state === 'failed' || state === 'rolled-back' ? 'Fixture updater failure' : null,
  updatedAt: ctx.time.now.toISOString(), backups: [backup], ...extra })

async function until(read, predicate, label) {
  for (let n = 0; n < 400; n++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}
async function setup(t, version = '1.2.0') {
  const admin = new Postgres(adminUrl), name = `kipster_updates_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl); url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-updates-home-'))
  const time = { now: new Date(2026, 9, 3, 12) }
  const channel = { stable: catalog(entry('1.3.0')), next: catalog(entry('1.4.0-next.10')), status: 200, requests: [] }
  const source = createServer((req, res) => {
    channel.requests.push(req.url)
    const value = req.url === '/v1/stable.json' ? channel.stable : channel.next
    res.writeHead(channel.status, { 'content-type': 'application/json' })
    res.end(typeof value === 'string' ? value : JSON.stringify(value))
  })
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${source.address().port}/v1/`
  const config = { connectionString: url.href, home, clock: () => time.now, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' }, updates: { channelUrl: base, coreVersion: version } }
  const ctx = { admin, home, time, channel, source, config, runtime: null, server: null, actor: null, closers: [] }
  t.after(async () => {
    for (const close of ctx.closers.reverse()) await close().catch(() => undefined)
    await ctx.server?.close().catch(() => undefined)
    await ctx.runtime?.close().catch(() => undefined)
    await new Promise(resolve => source.close(resolve))
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`)
    await admin.close()
    await rm(home, { recursive: true, force: true })
  })
  ctx.restart = async nextVersion => {
    await ctx.server?.close(); await ctx.runtime?.close()
    if (nextVersion) config.updates.coreVersion = nextVersion
    ctx.runtime = await openRuntime(config)
    ctx.actor = { installationId: ctx.runtime.bootstrap.installationId, personId: ctx.runtime.bootstrap.ownerId }
    ctx.server = await startTextServer(ctx.runtime, ctx.actor, { host: '127.0.0.1', port: 0 })
  }
  await ctx.restart()
  ctx.status = () => ctx.runtime.updates.get(ctx.actor)
  ctx.call = async (method, path, body, server = ctx.server) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  ctx.write = async value => { await writeUpdateFile(join(home, 'updates'), 'status.json', value); await ctx.runtime.updates.refresh() }
  ctx.request = async () => updaterRequest.parse(JSON.parse(await readFile(join(home, 'updates', 'request.json'), 'utf8')))
  ctx.gate = async () => (await ctx.runtime.db.query('SELECT update_request_id FROM kipster.execution_permits WHERE installation_id=$1', [ctx.actor.installationId])).rows[0].update_request_id
  return ctx
}

test('semver follows prerelease ordering and ignores build metadata', () => {
  const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1']
  for (let i = 1; i < versions.length; i++) assert.ok(compareVersions(versions[i], versions[i - 1]) > 0)
  assert.equal(compareVersions('1.0.0+abc', '1.0.0+def'), 0)
  assert.ok(compareVersions('1.0.0-next.99999999999999999999', '1.0.0-next.9999999999999999999') > 0)
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-next.01', '../escape']) assert.throws(() => compareVersions(version, '1.0.0'), /Invalid semver/)
})

test('update response schemas retain metadata and provide neutral unknown-value fallbacks', () => {
  assert.deepEqual(updateSettings.parse({ version: 1, channel: 'future', mode: 'later', extra: 123 }), { version: 1, channel: 'unknown', mode: 'unknown' })
  const available = entry('1.3.0', { futureMetadata: { enabled: true } })
  const result = updateStatus.parse({ version: 1, channel: 'stable', mode: 'automatic', checkedAt: null, window: { start: '02:00', end: '05:00', future: true },
    core: { version: '1.2.0', pinned: null, available, state: 'future-state', step: 'future-step', error: null, backups: [],
      lastResult: { from: '1.1.0', to: '1.2.0', outcome: 'future-outcome', at: '2026-10-02T09:00:00Z' } } })
  assert.equal(result.core.state, 'unknown'); assert.equal(result.core.lastResult.outcome, 'unknown')
  assert.deepEqual(result.core.available, available)
})

test('host update catalog configuration is optional and uses explicit HTTP(S) URLs', () => {
  const config = { version: 1, home: '/tmp/kipster', databaseUrl: 'postgresql://localhost/kipster', listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [] }
  assert.equal(validateHostConfig(config), config)
  assert.equal(validateHostConfig({ ...config, updates: { channelUrl: 'http://localhost:8080/catalog' } }).updates.channelUrl, 'http://localhost:8080/catalog')
  for (const channelUrl of ['file:///tmp', 'relative/path', 'https://example.com/?channel=next', 'https://user:password@example.com/', 'https://example.com/#fragment', 123]) {
    assert.throws(() => validateHostConfig({ ...config, updates: { channelUrl } }))
  }
  assert.throws(() => validateHostConfig({ ...config, updates: { channel: 'next' } }))
})

test('owner settings round-trip, validate, deduplicate and survive restart', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  assert.deepEqual((await ctx.call('GET', '/v1/settings/updates')).data, { version: 1, channel: 'stable', mode: 'automatic' })
  const value = setting('next', 'notify')
  assert.deepEqual((await ctx.call('PUT', '/v1/settings/updates', value)).data, { version: 1, channel: 'next', mode: 'notify' })
  for (const body of [{ ...value, operationId: randomUUID(), channel: 'beta' }, { ...value, operationId: randomUUID(), mode: 'manual' },
    { ...value, operationId: randomUUID(), extra: true }, { version: 1, channel: 'stable', mode: 'automatic' }, { ...value, version: 2 }]) {
    assert.equal((await ctx.call('PUT', '/v1/settings/updates', body)).status, 400)
  }
  assert.equal((await ctx.call('PUT', '/v1/settings/updates', { ...value, mode: 'automatic' })).status, 409)
  await ctx.restart()
  assert.deepEqual(await ctx.runtime.updates.settings(ctx.actor), { version: 1, channel: 'next', mode: 'notify' })
  assert.equal((await ctx.call('PUT', '/v1/settings/updates', value)).status, 200)
  const outsider = await startTextServer(ctx.runtime, { ...ctx.actor, personId: randomUUID() }, { host: '127.0.0.1', port: 0 })
  ctx.closers.push(() => outsider.close())
  for (const [method, path, body] of [['GET', '/v1/settings/updates'], ['GET', '/v1/updates'], ['PUT', '/v1/settings/updates', setting()],
    ['POST', '/v1/updates/check', { version: 1 }], ['POST', '/v1/updates/install', install('1.4.0')], ['POST', '/v1/updates/unpin', unpin()]]) {
    assert.equal((await ctx.call(method, path, body, outsider)).status, 403)
  }
  assert.equal((await ctx.call('GET', '/v1/bootstrap')).data.capabilities.updates, true)
})

test('checker handles newer, same, older, absent, prerelease and malformed channel files', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const newer = entry('1.3.0', { futureMetadata: ['keep', 'all'] })
  for (const [value, expected] of [[newer, newer], [entry('1.2.0'), null], [entry('1.1.0'), null], [null, null]]) {
    ctx.channel.stable = catalog(value)
    const response = await ctx.call('POST', '/v1/updates/check', { version: 1 })
    assert.equal(response.status, 200)
    const status = updateStatus.parse(response.data)
    assert.deepEqual(status.core.available, expected); assert.equal(status.core.error, null)
    assert.equal(status.checkedAt, ctx.time.now.toISOString())
  }
  await ctx.runtime.updates.setSettings(ctx.actor, setting('next', 'notify'))
  await ctx.restart('1.4.0-next.2')
  assert.equal((await ctx.runtime.updates.check(ctx.actor)).core.available.version, '1.4.0-next.10')
  ctx.channel.next = catalog(entry('1.4.0'))
  assert.equal((await ctx.runtime.updates.check(ctx.actor)).core.available.version, '1.4.0')
  ctx.channel.next = catalog(entry('1.4.0-next.1'))
  assert.equal((await ctx.runtime.updates.check(ctx.actor)).core.available, null)
  await ctx.runtime.updates.setSettings(ctx.actor, setting('stable', 'automatic'))
  ctx.channel.stable = catalog(entry('1.3.0'))
  assert.equal((await ctx.runtime.updates.check(ctx.actor)).core.available, null, 'stable does not downgrade a next build')
  for (const malformed of ['broken JSON', { schemaVersion: 2, packages: {} }, { schemaVersion: 1, packages: [] },
    catalog({ ...entry('1.5.0'), files: [] }), catalog(entry('1.5.0-next.01')), catalog(entry('1.5.0', { protocolRange: { current: 1, oldest: 2 } }))]) {
    ctx.channel.stable = malformed
    const status = await ctx.runtime.updates.check(ctx.actor)
    assert.equal(status.core.state, 'idle'); assert.match(status.core.error, /Update check failed/)
  }
  ctx.channel.status = 503
  assert.match((await ctx.runtime.updates.check(ctx.actor)).core.error, /HTTP 503/)
  await new Promise(resolve => ctx.source.close(resolve))
  const unreachable = await ctx.runtime.updates.check(ctx.actor)
  assert.equal(unreachable.core.state, 'idle'); assert.match(unreachable.core.error, /Update check failed/)
  assert.equal((await ctx.call('POST', '/v1/updates/check', { version: 1, extra: true })).status, 400)
})

test('host startup checks after a delay and the injected clock enforces 12-hour checks without rapid retries', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  assert.equal(ctx.channel.requests.length, 0, 'opening a library runtime does no network I/O')
  await ctx.runtime.updates.start({ startupDelayMs: 20, pollIntervalMs: 60000 })
  assert.equal(ctx.channel.requests.length, 0)
  await until(() => ctx.status(), status => status.checkedAt !== null, 'delayed check')
  assert.equal(ctx.channel.requests.length, 1)
  ctx.time.now = new Date(ctx.time.now.getTime() + UPDATE_CHECK_INTERVAL_MS - 1)
  await ctx.runtime.updates.tick(); assert.equal(ctx.channel.requests.length, 1)
  ctx.time.now = new Date(ctx.time.now.getTime() + 1)
  ctx.channel.status = 503
  await ctx.runtime.updates.tick(); assert.equal(ctx.channel.requests.length, 2)
  for (let i = 0; i < 5; i++) await ctx.runtime.updates.tick()
  assert.equal(ctx.channel.requests.length, 2)
})

test('scheduler uses the local window, idle capacity, notify mode and pins', { skip: noDatabase }, async t => {
  for (const [label, hours, minutes, mode, pinned, busy, expected] of [
    ['before', 1, 59, 'automatic', null, null, false], ['start', 2, 0, 'automatic', null, null, true],
    ['last minute', 4, 59, 'automatic', null, null, true], ['end excluded', 5, 0, 'automatic', null, null, false],
    ['notify', 3, 0, 'notify', null, null, false], ['pinned', 3, 0, 'automatic', '1.2.0', null, false],
    ['preparing', 3, 0, 'automatic', null, 'preparing', false], ['issued', 3, 0, 'automatic', null, 'issued', false],
    ['uncertain', 3, 0, 'automatic', null, 'uncertain', false],
  ]) await t.test(label, async t => {
    const ctx = await setup(t)
    await ctx.runtime.updates.setSettings(ctx.actor, setting('stable', mode))
    if (pinned) await ctx.runtime.db.query('UPDATE kipster.update_settings SET pinned=$2 WHERE installation_id=$1', [ctx.actor.installationId, pinned])
    if (busy) await ctx.runtime.db.query('INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,$3)', [randomUUID(), ctx.actor.installationId, busy])
    ctx.time.now = new Date(2026, 9, 4, hours, minutes)
    await ctx.runtime.updates.check(ctx.actor)
    assert.equal((await ctx.gate()) !== null, expected)
    if (expected) {
      const request = await ctx.request()
      assert.deepEqual(request, { version: 1, id: await ctx.gate(), action: 'install', target: '1.3.0', reason: 'automatic', requestedAt: ctx.time.now.toISOString() })
      assert.equal((await ctx.status()).core.pinned, null)
      await ctx.runtime.updates.tick()
      assert.equal((await ctx.runtime.db.query('SELECT count(*)::int AS n FROM kipster.update_requests')).rows[0].n, 1)
    } else await assert.rejects(readFile(join(ctx.home, 'updates', 'request.json')), { code: 'ENOENT' })
  })
})

test('manual requests are immediate, pin by default, validate restores and deduplicate across restart', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.write(fileStatus(ctx, 'done', { from: '1.1.0', to: '1.2.0' }))
  for (const [body, code] of [[install('1.2.0'), 'update-already-installed'], [install('1.1.0'), 'update-backup-required'],
    [install('1.1.0', { backupId: 'missing', confirmDataLoss: true }), 'update-backup-mismatch'],
    [install('1.0.0', { backupId: backup.id, confirmDataLoss: true }), 'update-backup-mismatch'],
    [install('1.1.0', { backupId: backup.id }), 'update-confirmation-required'],
    [install('1.1.0', { backupId: backup.id, confirmDataLoss: false }), 'update-confirmation-required']]) {
    const response = await ctx.call('POST', '/v1/updates/install', body)
    assert.equal(response.status, 409); assert.equal(stableError.parse(response.data).code, code)
  }
  for (const body of [install('../escape'), install('1.3.0', { backupId: backup.id }), install('1.3.0', { extra: 1 })]) {
    assert.equal((await ctx.call('POST', '/v1/updates/install', body)).status, 400)
  }
  const value = install('1.3.0')
  await ctx.runtime.db.query("INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,'issued')", [randomUUID(), ctx.actor.installationId])
  const saved = await ctx.call('POST', '/v1/updates/install', value)
  assert.equal(saved.status, 200); assert.equal(saved.data.core.state, 'scheduled'); assert.equal(saved.data.core.pinned, '1.3.0')
  const request = await ctx.request()
  assert.deepEqual(request, { version: 1, id: await ctx.gate(), action: 'install', target: '1.3.0', reason: 'manual', requestedAt: ctx.time.now.toISOString() })
  assert.equal((await stat(join(ctx.home, 'updates', 'request.json'))).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(join(ctx.home, 'updates')), ['request.json', 'status.json'])
  assert.equal((await ctx.call('POST', '/v1/updates/install', install('1.4.0'))).data.code, 'update-in-progress')
  assert.equal((await ctx.call('POST', '/v1/updates/install', { ...value, target: '1.4.0' })).data.code, 'conflict')
  await ctx.restart()
  assert.equal((await ctx.call('POST', '/v1/updates/install', value)).status, 200)
  assert.deepEqual(await ctx.request(), request)
  const unpinValue = unpin()
  assert.equal((await ctx.call('POST', '/v1/updates/unpin', unpinValue)).data.core.pinned, null)
  assert.equal((await ctx.call('POST', '/v1/updates/unpin', unpinValue)).status, 200)
  ctx.time.now = new Date(ctx.time.now.getTime() + 1000)
  await ctx.write(fileStatus(ctx, 'done', { requestId: request.id }))
  await ctx.restart('1.3.0')
  assert.equal((await ctx.call('POST', '/v1/updates/install', value)).status, 200, 'retry remains valid after target becomes the running version')
  const restore = install('1.1.0', { backupId: backup.id, confirmDataLoss: true, pin: false })
  const restoring = await ctx.call('POST', '/v1/updates/install', restore)
  assert.equal(restoring.status, 200); assert.equal(restoring.data.core.pinned, null)
  assert.deepEqual(await ctx.request(), { version: 1, id: await ctx.gate(), action: 'restore', target: '1.1.0', backupId: backup.id, reason: 'manual', requestedAt: ctx.time.now.toISOString() })
})

test('all updater states and steps map into status, survive restarts and reject stale or malformed files', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.runtime.updates.install(ctx.actor, install('1.3.0'))
  const request = await ctx.request()
  await ctx.write(fileStatus(ctx, 'future-state', { requestId: request.id }))
  assert.equal((await ctx.status()).core.state, 'failed')
  assert.equal(await ctx.gate(), request.id, 'an unknown updater state never releases an accepted admission gate')
  for (const step of ['downloading', 'verifying', 'backing-up', 'installing', 'migrating', 'restarting', 'checking', 'restoring', null]) {
    ctx.time.now = new Date(ctx.time.now.getTime() + 1000)
    await ctx.write(fileStatus(ctx, 'running', { requestId: request.id, step }))
    assert.equal((await ctx.status()).core.state, 'installing'); assert.equal((await ctx.status()).core.step, step)
  }
  await ctx.restart()
  assert.equal((await ctx.status()).core.state, 'installing'); assert.equal(await ctx.gate(), request.id)
  const before = await ctx.status()
  await ctx.write(fileStatus(ctx, 'done', { requestId: 'old-request', updatedAt: new Date(ctx.time.now.getTime() + 1000).toISOString() }))
  assert.deepEqual(await ctx.status(), before)
  for (const [state, outcome] of [['done', 'installed'], ['failed', 'failed'], ['rolled-back', 'rolled-back']]) {
    ctx.time.now = new Date(ctx.time.now.getTime() + 1000)
    await ctx.write(fileStatus(ctx, state, { requestId: request.id }))
    const result = await ctx.status()
    assert.equal(result.core.state, state === 'done' ? 'idle' : 'failed'); assert.equal(result.core.step, null)
    assert.deepEqual(result.core.lastResult, { from: '1.2.0', to: '1.3.0', outcome, at: ctx.time.now.toISOString() })
    assert.deepEqual(result.core.backups, [backup]); assert.equal(await ctx.gate(), null)
    await ctx.restart(state === 'done' ? '1.3.0' : '1.2.0')
    assert.deepEqual((await ctx.status()).core.lastResult, result.core.lastResult)
  }
  const terminal = await ctx.status()
  await ctx.write(fileStatus(ctx, 'running', { requestId: request.id, updatedAt: new Date(ctx.time.now.getTime() + 1000).toISOString() }))
  assert.deepEqual(await ctx.status(), terminal, 'a terminal request cannot reopen')
  await writeFile(join(ctx.home, 'updates', 'status.json'), 'broken JSON')
  await ctx.runtime.updates.refresh()
  assert.match((await ctx.status()).core.error, /invalid or unreadable/)
  await ctx.write(fileStatus(ctx, 'rolled-back', { requestId: request.id }))
  assert.equal((await ctx.status()).core.error, 'Fixture updater failure', 'a repaired status file clears the malformed-file error')
  ctx.time.now = new Date(2026, 9, 5, 3)
  await ctx.runtime.updates.unpin(ctx.actor, unpin())
  await ctx.runtime.updates.check(ctx.actor)
  assert.equal(await ctx.gate(), null, 'failed targets are not repeatedly scheduled')
})

test('the file watcher sees atomic replacements and emits durable updates-changed events', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const scope = { kind: 'application', installationId: ctx.actor.installationId, callerId: ctx.actor.personId }
  const cursor = (await snapshot(ctx.runtime.db, scope)).cursor
  await ctx.runtime.updates.setSettings(ctx.actor, setting('next', 'notify'))
  await ctx.runtime.updates.check(ctx.actor)
  await ctx.runtime.updates.install(ctx.actor, install('1.4.0-next.10'))
  const request = await ctx.request()
  await ctx.runtime.updates.start({ startupDelayMs: 60000, pollIntervalMs: 60000 })
  const file = fileStatus(ctx, 'running', { requestId: request.id, to: request.target })
  await writeUpdateFile(join(ctx.home, 'updates'), 'status.json', file)
  await until(() => ctx.status(), status => status.core.state === 'installing', 'watched updater status')
  const updates = (await readEvents(ctx.runtime.db, scope, cursor)).events.map(event => textEvent.parse(event)).filter(event => event.type === 'updates-changed')
  assert.ok(updates.length >= 5)
  assert.deepEqual(updates.at(-1).data, await ctx.status())
  for (let i = 1; i < updates.length; i++) assert.ok(updates[i].revision > updates[i - 1].revision)
  assert.ok(updates.some(event => event.data.core.state === 'checking'))
  assert.ok(updates.some(event => event.data.core.state === 'scheduled'))
  const count = updates.length
  await ctx.runtime.updates.refresh()
  assert.equal((await readEvents(ctx.runtime.db, scope, cursor)).events.filter(event => event.type === 'updates-changed').length, count, 'unchanged reads emit no extra event')
})

test('an accepted outbox request recovers a failed file handoff on restart', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await mkdir(join(ctx.home, 'updates', 'request.json'), { recursive: true })
  const result = await ctx.runtime.updates.install(ctx.actor, install('1.3.0'))
  assert.equal(result.core.state, 'scheduled'); assert.match(result.core.error, /retry the handoff/)
  const id = await ctx.gate()
  await rm(join(ctx.home, 'updates', 'request.json'), { recursive: true })
  await ctx.restart()
  assert.equal((await ctx.request()).id, id)
  assert.equal((await ctx.status()).core.error, null)
  assert.equal((await ctx.runtime.db.query('SELECT delivered FROM kipster.update_requests WHERE id=$1', [id])).rows[0].delivered, true)
})

test('the automatic idle check shares the execution lock, and concurrent schedulers accept one request', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.runtime.updates.check(ctx.actor)
  ctx.time.now = new Date(2026, 9, 4, 3)
  let release, locked
  const canRelease = new Promise(resolve => { release = resolve })
  const hasLock = new Promise(resolve => { locked = resolve })
  const running = ctx.runtime.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [ctx.actor.installationId])
    locked(); await canRelease
    await client.query("INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,'issued')", [randomUUID(), ctx.actor.installationId])
  })
  await hasLock
  const scheduled = ctx.runtime.updates.tick()
  release(); await Promise.all([running, scheduled])
  assert.equal(await ctx.gate(), null)
  await ctx.runtime.db.query('DELETE FROM kipster.work_intents')
  const other = new UpdatesService(ctx.runtime.db, ctx.actor.installationId, ctx.home, '1.2.0', { channelUrl: ctx.config.updates.channelUrl, clock: () => ctx.time.now })
  ctx.closers.push(() => other.close())
  await other.initialize()
  await Promise.all([ctx.runtime.updates.tick(), other.tick()])
  assert.equal((await ctx.runtime.db.query('SELECT count(*)::int AS n FROM kipster.update_requests')).rows[0].n, 1)
})

test('automatic updates wait for running work, and the persisted gate blocks text and maintenance until completion', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const { runtime, actor } = ctx
  const agentId = runtime.bootstrap.rootAgentId, context = { kind: 'installation', installationId: actor.installationId }
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const { chatId } = await resolveDirectChat(runtime.db, actor, context, agentId)
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  ctx.closers.push(() => dispatcher.close())
  await dispatcher.start()
  const say = text => acceptText(runtime.db, runtime.jobs, runtime.artifacts, actor, { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
  const first = await say('Finish before the update')
  const active = await until(() => executions.find(item => item.context.runId === first.runId), Boolean, 'first text run')
  ctx.time.now = new Date(2026, 9, 4, 3)
  await runtime.updates.check(actor); assert.equal(await ctx.gate(), null)
  active.handle.release({ kind: 'text', attemptId: active.context.attemptId, messageId: randomUUID(), text: 'Finished.', final: true })
  active.handle.release({ kind: 'ended', attemptId: active.context.attemptId, confirmed: true })
  await until(async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [first.runId])).rows[0].state, state => state === 'completed', 'first completion')
  await runtime.updates.tick()
  const request = await ctx.request()
  const second = await say('Wait until after the update')
  const maintenance = new MaintenanceService(runtime.db, actor.installationId)
  await runtime.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [actor.installationId])
    assert.equal((await maintenance.claimSource(client, randomUUID(), true)).refused, 'update_in_progress')
    assert.equal((await maintenance.claimSleepRun(client, randomUUID(), true)).refused, 'update_in_progress')
  })
  await new Promise(resolve => setTimeout(resolve, 750))
  assert.equal(executions.some(item => item.context.runId === second.runId), false)
  assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [second.runId])).rows[0].state, 'queued')
  await ctx.write(fileStatus(ctx, 'done', { requestId: request.id }))
  const resumed = await until(() => executions.find(item => item.context.runId === second.runId), Boolean, 'queued work resumes')
  resumed.handle.release({ kind: 'text', attemptId: resumed.context.attemptId, messageId: randomUUID(), text: 'Resumed.', final: true })
  resumed.handle.release({ kind: 'ended', attemptId: resumed.context.attemptId, confirmed: true })
})

test('a manual update arriving during preparation defers issuance and preserves the work wakeup', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const { runtime, actor } = ctx
  const agentId = runtime.bootstrap.rootAgentId, context = { kind: 'installation', installationId: actor.installationId }
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const { chatId } = await resolveDirectChat(runtime.db, actor, context, agentId)
  let release, claimed
  const preparation = new Promise(resolve => { release = resolve })
  const claim = new Promise(resolve => { claimed = resolve })
  let dispatcher
  const executions = []
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } }, undefined,
    { async afterClaim() { claimed(); await preparation } })
  ctx.closers.push(async () => { release(); await dispatcher.close() })
  await dispatcher.start()
  const saved = await acceptText(runtime.db, runtime.jobs, runtime.artifacts, actor, { version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Keep this accepted work' }] })
  await claim
  await runtime.updates.install(actor, install('1.3.0'))
  const request = await ctx.request()
  release()
  await until(async () => (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [saved.runId])).rows[0].state, state => state === 'queued', 'preparation returned to queue')
  assert.equal(executions.length, 0)
  await ctx.write(fileStatus(ctx, 'done', { requestId: request.id }))
  const resumed = await until(() => executions[0], Boolean, 'unissued work resumes after updater result')
  resumed.handle.release({ kind: 'text', attemptId: resumed.context.attemptId, messageId: randomUUID(), text: 'Preserved.', final: true })
  resumed.handle.release({ kind: 'ended', attemptId: resumed.context.attemptId, confirmed: true })
})

test('a successful catalog check cannot schedule over malformed updater status', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await mkdir(join(ctx.home, 'updates'))
  await writeFile(join(ctx.home, 'updates', 'status.json'), 'broken JSON')
  ctx.time.now = new Date(2026, 9, 4, 3)
  const status = await ctx.runtime.updates.check(ctx.actor)
  assert.equal(status.core.state, 'failed'); assert.equal(status.core.step, null)
  assert.match(status.core.error, /invalid or unreadable/)
  assert.equal(status.core.available.version, '1.3.0')
  assert.equal(await ctx.gate(), null)
  await assert.rejects(readFile(join(ctx.home, 'updates', 'request.json')), { code: 'ENOENT' })
  await ctx.write(fileStatus(ctx, 'done', { from: '1.1.0', to: '1.2.0' }))
  await ctx.runtime.updates.check(ctx.actor)
  assert.notEqual(await ctx.gate(), null, 'a repaired file permits scheduling again')
})

test('startup adopts a matching restore after an old database snapshot reinstates a stale gate', { skip: noDatabase }, async t => {
  const ctx = await setup(t, '1.1.0')
  await ctx.runtime.updates.install(ctx.actor, install('1.2.0'))
  const original = await ctx.request()
  const oldRow = (await ctx.runtime.db.query('SELECT status,updater_status FROM kipster.update_settings')).rows[0]
  await ctx.write(fileStatus(ctx, 'done', { requestId: original.id, from: '1.1.0', to: '1.2.0' }))
  await ctx.restart('1.2.0')
  await ctx.runtime.updates.install(ctx.actor, install('1.1.0', { backupId: backup.id, confirmDataLoss: true }))
  const restore = await ctx.request()
  await writeUpdateFile(join(ctx.home, 'updates'), 'status.json', fileStatus(ctx, 'running', { requestId: restore.id, from: '1.2.0', to: '1.1.0', step: 'checking' }))
  // Model a restored database which lost the new request and resurrected the old gate. The
  // updater separately retains the current policy/pin; Core reconciles the shared files.
  await ctx.runtime.db.query('DELETE FROM kipster.update_requests WHERE id=$1', [restore.id])
  await ctx.runtime.db.query('UPDATE kipster.execution_permits SET update_request_id=$2 WHERE installation_id=$1', [ctx.actor.installationId, original.id])
  await ctx.runtime.db.query('UPDATE kipster.update_settings SET status=$2::jsonb,updater_status=$3::jsonb WHERE installation_id=$1', [ctx.actor.installationId, JSON.stringify(oldRow.status), JSON.stringify(oldRow.updater_status)])
  await ctx.restart('1.1.0')
  assert.equal(await ctx.gate(), restore.id)
  assert.equal((await ctx.status()).core.state, 'installing')
  assert.equal((await ctx.status()).core.pinned, '1.1.0')
  await ctx.write(fileStatus(ctx, 'done', { requestId: restore.id, from: '1.2.0', to: '1.1.0' }))
  assert.equal(await ctx.gate(), null)
  assert.equal((await ctx.status()).core.lastResult.outcome, 'installed')
  assert.equal((await ctx.status()).core.lastResult.to, '1.1.0')
})

test('a stale restore file at startup cannot replace a newer accepted request', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  await ctx.write(fileStatus(ctx, 'done', { from: '1.1.0', to: '1.2.0' }))
  await ctx.runtime.updates.install(ctx.actor, install('1.1.0', { backupId: backup.id, confirmDataLoss: true }))
  const restore = await ctx.request()
  await ctx.write(fileStatus(ctx, 'done', { requestId: restore.id, from: '1.2.0', to: '1.1.0' }))
  await ctx.restart('1.1.0')
  // Block delivery so request.json still carries the previous restore when Core restarts.
  await rm(join(ctx.home, 'updates', 'request.json'))
  await mkdir(join(ctx.home, 'updates', 'request.json'))
  await ctx.runtime.updates.install(ctx.actor, install('1.4.0'))
  const pending = await ctx.gate()
  await rm(join(ctx.home, 'updates', 'request.json'), { recursive: true })
  await writeUpdateFile(join(ctx.home, 'updates'), 'request.json', restore)
  await ctx.restart()
  assert.equal(await ctx.gate(), pending)
  assert.equal((await ctx.request()).id, pending)
  assert.equal((await ctx.status()).core.pinned, '1.4.0')
})
