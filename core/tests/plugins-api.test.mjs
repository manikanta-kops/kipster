import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFixture } from '@kipster/plugins/fixture'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { PluginServerSupervisor } from '../dist/plugins/supervisor.js'
import { createClient } from '../dist/protocol/client/index.js'
import { pluginError, pluginPaths } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Core's plugin routes, sign-in callback, bootstrap flag, admin operations and execution MCP server, against the real
// plugin server that the supervisor runs in test-only mode with the package's fixture service and catalogue.

const packageRoot = dirname(fileURLToPath(import.meta.resolve('@kipster/plugins/package.json')))
const cli = join(packageRoot, 'dist/server/cli.js')
const catalogue = join(packageRoot, 'test/fixtures/catalogue')
const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const allowedHost = 'kipster.example.test'

async function until(read, label) {
  for (let n = 0; n < 600; n++) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out: ${label}`)
}
async function closedPort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/**
 * A runtime whose plugins are the supervised server behind a switch: `on`, `off` (not ready) or `broken` (an endpoint
 * nothing answers). Core's server listens with one extra allowed host; a dispatcher runs the fixture adapter.
 */
async function setup(t) {
  const service = await startFixture()
  t.after(() => service.close())
  const home = await realpath(await mkdtemp('/tmp/kipster-plugins-api-'))
  const supervisor = new PluginServerSupervisor({ home, module: cli, readyTimeoutMs: 15000, testOnly: { catalogue, baseUrl: service.url } })
  const brokenUrl = `http://127.0.0.1:${await closedPort()}`
  const plugins = { mode: 'on', endpoint() { const ready = supervisor.endpoint(); return this.mode === 'on' ? ready : this.mode === 'broken' && ready ? { url: brokenUrl, token: ready.token } : undefined } }
  const admin = new Postgres(adminUrl)
  const name = `kipster_plugins_api_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await supervisor.close()
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  await supervisor.start()
  const endpoint = await until(() => supervisor.endpoint(), 'plugin server ready')
  const runtime = await openRuntime({ connectionString: url.href, home: join(home, 'core'), names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' }, executionLimit: 4, plugins })
  closers.push(() => runtime.close())
  const { installationId, ownerId, rootAgentId } = runtime.bootstrap
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  closers.push(() => dispatcher.close())
  const server = await startTextServer(runtime, { installationId, personId: ownerId }, { host: '127.0.0.1', port: 0, allowedHosts: [allowedHost], dispatcher })
  closers.push(() => server.close())
  await dispatcher.start()
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  const ok = async (method, path, body) => {
    const response = await call(method, path, body)
    assert.ok([200, 202].includes(response.status), `${method} ${path}: ${JSON.stringify(response.data)}`)
    return response.data
  }
  await ok('PUT', `/v1/agents/${rootAgentId}/settings`, { version: 1, operationId: randomUUID(), settings: fixture })
  const installation = { kind: 'installation', installationId }
  const { chatId } = await ok('POST', '/v1/direct-chats', { version: 1, context: installation, agentId: rootAgentId })
  return {
    service, supervisor, endpoint, plugins, runtime, server, call, ok, executions, db: runtime.db,
    client: createClient({ baseUrl: server.url }),
    /** Starts a run of Kip and returns its execution; `tool` makes a run_admin_operation call from it. */
    async run(text = 'Plugins') {
      const accepted = await ok('POST', '/v1/text/submissions', { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context: installation, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
      const execution = await until(() => executions.find(e => e.context.runId === accepted.runId), `execution of ${accepted.runId}`)
      let n = 0
      return { ...execution, tool: (operation, args = {}) => execution.handle.callTool(`plugins-${++n}`, 'run_admin_operation', { operation, arguments: args }) }
    },
  }
}

/** Follows a redirect sign-in at the fixture as `user`; returns where the service sends the browser back. */
async function authorize(start, user) {
  assert.equal(start.status, 'redirect')
  const url = new URL(start.authorizationUrl)
  url.searchParams.set('user', user)
  const response = await fetch(url, { redirect: 'manual' })
  assert.equal(response.status, 302)
  return new URL(response.headers.get('location'))
}
async function completed(read, id) {
  return until(async () => { const status = await read(id); return status.status === 'completed' && status }, `sign-in ${id}`)
}
const refused = async (promise, status, code) => {
  await assert.rejects(promise, error => { assert.equal(error.status, status, error.message); assert.equal(error.code, code, error.message); return true })
}

test('every plugin route relays the plugin server, and a sign-in returns through Core\'s callback', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t)
  const { client } = ctx
  assert.equal((await client.bootstrap()).capabilities.plugins, true)

  const list = await client.listPlugins()
  assert.equal(list.version, 1)
  const summary = list.plugins.find(plugin => plugin.id === 'fixture')
  assert.equal(summary.accountCount, 0)
  assert.equal(summary.available, true)
  assert.deepEqual((await client.getPlugin('fixture')).plugin.accounts, [])
  await refused(client.getPlugin('nowhere'), 404, 'unknown-plugin')
  await refused(client.getPluginSignIn('nothing'), 404, 'unknown-sign-in')

  // The first account signs in through Core's own callback.
  const returnAddress = `${ctx.server.url}${pluginPaths.callback}`
  const first = await client.startPluginSignIn('fixture', { returnAddress })
  assert.equal(first.method, 'dcr')
  assert.equal(new URL(first.authorizationUrl).searchParams.get('redirect_uri'), returnAddress)
  assert.equal((await client.getPluginSignIn(first.id)).status, 'pending')
  const back = await authorize(first, 'alice')
  assert.equal(`${back.origin}${back.pathname}`, returnAddress)
  const page = await fetch(back)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /^text\/html/)
  assert.equal(page.headers.get('content-security-policy'), "default-src 'none'")
  assert.match(await page.text(), /Signed in as/)
  const alice = (await completed(id => client.getPluginSignIn(id), first.id)).account
  assert.equal(alice.plugin, 'fixture')
  // A replayed return is refused by the plugin server and Core passes its page through.
  const replay = await fetch(back)
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /unknown or has expired/)

  // Without a return address the plugin server's loopback callback is used.
  const second = await client.startPluginSignIn('fixture')
  const direct = await authorize(second, 'bob')
  assert.equal(direct.origin, ctx.endpoint.url)
  assert.equal(direct.pathname, '/callback')
  assert.equal((await fetch(direct)).status, 200)
  const bob = (await completed(id => client.getPluginSignIn(id), second.id)).account

  // Return addresses off Core's own callback are refused before the plugin server is asked.
  for (const address of ['http://evil.test/plugins/callback', `${ctx.server.url}/callback`, `${ctx.server.url}/plugins/callback/`, 'http://127.0.0.1:1/plugins/callback', `ftp://${new URL(ctx.server.url).host}/plugins/callback`, 'not a url'])
    await refused(client.startPluginSignIn('fixture', { returnAddress: address }), 400, 'return-address-refused')
  // An allowed host passes Core's check; the plugin server refuses plain HTTP off loopback.
  await refused(client.startPluginSignIn('fixture', { returnAddress: `http://${allowedHost}/plugins/callback` }), 400, 'invalid-return-address')
  await refused(client.startPluginSignIn('fixture', { returnAddress: `${returnAddress}?next=1` }), 400, 'invalid-return-address')
  const refusal = await ctx.call('POST', pluginPaths.signIn('fixture'), { version: 1, returnAddress: 'http://evil.test/plugins/callback' })
  assert.deepEqual(pluginError.parse(refusal.data).code, 'return-address-refused')

  // Two accounts for one plugin: rename, default, clear, remove.
  const accounts = await client.listPluginAccounts({ plugin: 'fixture' })
  assert.deepEqual(accounts.accounts.map(account => account.id).sort(), [alice.id, bob.id].sort())
  assert.equal((await client.listPluginAccounts()).accounts.length, 2)
  assert.deepEqual((await client.listPluginAccounts({ plugin: 'nowhere' })).accounts, [])
  const renamed = await client.renamePluginAccount(alice.id, 'Work')
  assert.equal(renamed.account.label, 'Work')
  await refused(client.renamePluginAccount(bob.id, 'work'), 400, 'invalid-label')
  await refused(client.renamePluginAccount(bob.id, ''), 400, 'invalid')
  await refused(client.renamePluginAccount('missing', 'Home'), 404, 'not-found')
  assert.deepEqual(await client.setDefaultPluginAccount('fixture', bob.id), { version: 1, plugin: 'fixture', defaultAccount: bob.id })
  const detail = await client.getPlugin('fixture')
  assert.equal(detail.plugin.accountCount, 2)
  assert.deepEqual(detail.plugin.accounts.filter(account => account.isDefault).map(account => account.id), [bob.id])
  assert.deepEqual(await client.clearDefaultPluginAccount('fixture'), { version: 1, plugin: 'fixture', defaultAccount: null })
  assert.ok((await client.getPlugin('fixture')).plugin.accounts.every(account => !account.isDefault))
  await client.setDefaultPluginAccount('fixture', alice.id)
  assert.deepEqual(await ctx.ok('PUT', pluginPaths.defaultAccount('fixture'), { version: 1, account: null }), { version: 1, plugin: 'fixture', defaultAccount: null })
  const removed = await client.removePluginAccount(bob.id)
  assert.equal(removed.removed, true)
  assert.equal(typeof removed.revoked, 'boolean')
  assert.deepEqual((await client.listPluginAccounts({ plugin: 'fixture' })).accounts.map(account => account.id), [alice.id])
  await refused(client.removePluginAccount(bob.id), 404, 'not-found')
  assert.equal((await ctx.call('GET', '/v1/plugins/accounts?plugin=')).status, 400)
  assert.equal((await ctx.call('POST', '/v1/plugins')).status, 404)
  assert.equal((await ctx.call('GET', '/v1/plugins/sign-ins')).status, 404)

  // CORS lets an allowed origin rename accounts.
  const preflight = await fetch(ctx.server.url + pluginPaths.account(alice.id), { method: 'OPTIONS', headers: { origin: ctx.server.url } })
  assert.match(preflight.headers.get('access-control-allow-methods'), /PATCH/)
  // The callback keeps Core's Host and Origin checks.
  assert.equal((await fetch(`${ctx.server.url}${pluginPaths.callback}?state=x`, { headers: { origin: 'http://evil.test' } })).status, 403)

  // Conversation executions get the plugins MCP server while it is ready; the token stays out of prompts and every
  // record, events included.
  const ready = await ctx.run('With plugins')
  assert.deepEqual(ready.context.mcpServers, [{ name: 'plugins', url: `${ctx.endpoint.url}/mcp`, bearerToken: ctx.endpoint.token }])
  for (const text of [ready.context.prompt, ready.context.instructions, JSON.stringify(ready.context.input)]) assert.ok(!text.includes(ctx.endpoint.token))
  ready.handle.release({ kind: 'text', attemptId: ready.context.attemptId, messageId: 'reply', text: 'Plugins are ready.', final: true })
  ready.handle.release({ kind: 'ended', attemptId: ready.context.attemptId, confirmed: true })
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [ready.context.runId])).rows[0].state === 'completed', 'run completed')
  const tables = (await ctx.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='kipster' AND table_type='BASE TABLE'")).rows.map(row => row.table_name)
  assert.ok(tables.length > 10)
  for (const table of tables) assert.equal(Number((await ctx.db.query(`SELECT count(*) FROM kipster."${table}" t WHERE t::text LIKE $1`, [`%${ctx.endpoint.token}%`])).rows[0].count), 0, table)

  // An endpoint nothing answers is a 502, not a crash.
  ctx.plugins.mode = 'broken'
  await refused(client.listPlugins(), 502, 'plugin-server-failed')
  const unreachable = await fetch(`${ctx.server.url}${pluginPaths.callback}?state=x`)
  assert.equal(unreachable.status, 502)
  assert.match(await unreachable.text(), /could not reach the plugin server/)

  // Not ready: plugins are off everywhere.
  ctx.plugins.mode = 'off'
  assert.equal((await client.bootstrap()).capabilities.plugins, false)
  const off = [
    ['GET', pluginPaths.plugins], ['GET', pluginPaths.plugin('fixture')], ['POST', pluginPaths.signIn('fixture'), { version: 1 }], ['POST', pluginPaths.signIn('fixture')],
    ['GET', pluginPaths.signInStatus(first.id)], ['GET', pluginPaths.accounts()], ['GET', pluginPaths.accounts('fixture')], ['PATCH', pluginPaths.account(alice.id), { version: 1, label: 'Home' }],
    ['PUT', pluginPaths.defaultAccount('fixture'), { version: 1, account: alice.id }], ['DELETE', pluginPaths.defaultAccount('fixture')], ['DELETE', pluginPaths.account(alice.id)],
  ]
  for (const [method, path, body] of off) {
    const response = await ctx.call(method, path, body)
    assert.equal(response.status, 503, `${method} ${path}`)
    assert.equal(pluginError.parse(response.data).code, 'plugins-unavailable')
  }
  const closed = await fetch(`${ctx.server.url}${pluginPaths.callback}?state=x&code=y`)
  assert.equal(closed.status, 503)
  assert.match(await closed.text(), /Plugins are off/)
  const without = await ctx.run('Without plugins')
  assert.equal(without.context.mcpServers, undefined)
  assert.ok(!('mcpServers' in without.context))
})

test('Kip manages plugins through the admin operations', { skip: noDatabase, timeout: 120000 }, async t => {
  const ctx = await setup(t)
  const run = await ctx.run('Connect my fixture account')
  const listing = await run.handle.callTool('list', 'list_admin_operations', { area: 'plugins' })
  assert.deepEqual(listing.areas.map(area => area.operations.map(item => [item.operation, item.kind])), [[
    ['plugins.list', 'read'], ['plugins.get', 'read'], ['plugins.sign_in', 'write'], ['plugins.sign_in_status', 'read'], ['plugins.accounts_list', 'read'],
    ['plugins.account_rename', 'write'], ['plugins.default_set', 'write'], ['plugins.default_clear', 'write'], ['plugins.account_remove', 'write'],
  ]])
  const signIn = await run.handle.callTool('describe', 'list_admin_operations', { operation: 'plugins.sign_in' })
  assert.deepEqual(Object.keys(signIn.arguments.properties), ['pluginId', 'address'], 'Kip never passes a return address')

  assert.deepEqual(await run.tool('plugins.list'), await ctx.ok('GET', '/v1/plugins'))
  assert.deepEqual(await run.tool('plugins.get', { pluginId: 'fixture' }), await ctx.ok('GET', '/v1/plugins/fixture'))
  await assert.rejects(run.tool('plugins.get', { pluginId: 'nowhere' }), /unknown-plugin/)
  await assert.rejects(run.tool('plugins.sign_in', { pluginId: 'fixture', returnAddress: `${ctx.server.url}/plugins/callback` }), /Invalid wire value/)

  const accounts = []
  for (const user of ['alice', 'bob']) {
    const start = await run.tool('plugins.sign_in', { pluginId: 'fixture' })
    const back = await authorize(start, user)
    assert.equal(`${back.origin}${back.pathname}`, `${ctx.endpoint.url}/callback`)
    assert.equal((await fetch(back)).status, 200)
    accounts.push((await completed(id => run.tool('plugins.sign_in_status', { signInId: id }), start.id)).account)
  }
  const [alice, bob] = accounts
  assert.deepEqual((await run.tool('plugins.accounts_list', { pluginId: 'fixture' })).accounts.map(account => account.id).sort(), [alice.id, bob.id].sort())
  assert.equal((await run.tool('plugins.accounts_list')).accounts.length, 2)
  assert.equal((await run.tool('plugins.account_rename', { accountId: bob.id, label: 'Personal' })).account.label, 'Personal')
  await assert.rejects(run.tool('plugins.account_rename', { accountId: alice.id, label: 'personal' }), /invalid-label/)
  assert.equal((await run.tool('plugins.default_set', { pluginId: 'fixture', accountId: bob.id })).defaultAccount, bob.id)
  assert.equal((await ctx.ok('GET', '/v1/plugins/fixture')).plugin.accounts.find(account => account.isDefault).id, bob.id)
  assert.equal((await run.tool('plugins.default_clear', { pluginId: 'fixture' })).defaultAccount, null)
  assert.equal((await run.tool('plugins.account_remove', { accountId: alice.id })).removed, true)
  assert.deepEqual((await ctx.ok('GET', '/v1/plugins/accounts')).accounts.map(account => account.label), ['Personal'])

  ctx.plugins.mode = 'off'
  await assert.rejects(run.tool('plugins.list'), /plugins-unavailable/)
  await assert.rejects(run.tool('plugins.sign_in', { pluginId: 'fixture' }), /plugins-unavailable/)
})
