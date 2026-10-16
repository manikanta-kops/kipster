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
import { toolTitle } from '../dist/plugins/tools.js'
import { createClient } from '../dist/protocol/client/index.js'
import { pluginError, pluginPaths } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Core's plugin routes, sign-in callback, bootstrap flag, admin operations and plugin tools, against the real
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
async function setup(t, options = {}) {
  const service = await startFixture(options.fixture)
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
  const runtime = await openRuntime({ connectionString: url.href, home: join(home, 'core'), names: { owner: 'Owner', organization: 'Org', rootAgent: 'Kip' }, executionLimit: 4, plugins, ...(options.embedding ? { embedding: options.embedding } : {}) })
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
    service, supervisor, endpoint, plugins, runtime, server, call, ok, executions, db: runtime.db, chatId,
    /** Answers a run's pending approval card. */
    async answer(runId, answer) {
      const card = (await runtime.db.query("SELECT x.id,x.attempt_id,x.proposal_id,t.thread_id FROM kipster.interactions x JOIN kipster.text_runs t ON t.id=x.run_id WHERE x.run_id=$1 AND x.state='pending'", [runId])).rows[0]
      return ok('POST', '/v1/work/interactions/answer', { version: 1, operationId: randomUUID(), interactionId: card.id, threadId: card.thread_id, runId, attemptId: card.attempt_id, proposalId: card.proposal_id, answer })
    },
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

  // Conversation executions get the plugin tools while plugins are connected; the plugin server's token stays out of
  // prompts and every record, events included.
  const ready = await ctx.run('With plugins')
  assert.ok(!('mcpServers' in ready.context))
  assert.deepEqual(ready.context.tools.filter(tool => tool.name.includes('plugin')).map(tool => tool.name), ['search_plugin_tools', 'run_plugin_tool'])
  assert.match(ready.context.instructions, /Plugins: the person connected [Ff]ixture\./)
  // Without an embedding provider, keywords of three or more letters rank the tools.
  const byKeyword = await ready.handle.callTool('keywords', 'search_plugin_tools', { query: 'save a note' })
  assert.equal(byKeyword.plugins[0].tools[0].name, 'fixture__create_note')
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
  assert.ok(!without.context.tools.some(tool => tool.name.includes('plugin')))
  assert.doesNotMatch(without.context.instructions, /Plugins:/)
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

/** A deterministic embedder: each word sets one of 768 dimensions. */
const wordEmbedding = {
  id: 'words', model: 'words-1', contractMajor: 1,
  async embed(text) {
    const vector = new Array(768).fill(0)
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) vector[[...word].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 768, 7)] += 1
    vector[0] += 0.01
    return vector
  },
}

test('kips find plugin tools through search and run them after the person approves', { skip: noDatabase, timeout: 180000 }, async t => {
  const ctx = await setup(t, { fixture: { extraTools: true }, embedding: wordEmbedding })
  const { client } = ctx
  const signIn = async user => {
    const start = await client.startPluginSignIn('fixture')
    assert.equal((await fetch(await authorize(start, user))).status, 200)
    return (await completed(id => client.getPluginSignIn(id), start.id)).account
  }
  const body = result => JSON.parse(result.text.split('\n\n')[0])
  const finish = async execution => {
    execution.handle.release({ kind: 'ended', attemptId: execution.context.attemptId, confirmed: true })
  }
  const next = (runId, attemptId) => until(() => ctx.executions.find(e => e.context.runId === runId && e.context.attemptId !== attemptId), `next execution of ${runId}`)

  // Without an account kips get no plugin tools, only the line that nothing is connected.
  const none = await ctx.run('Anything connected?')
  assert.ok(!none.context.tools.some(tool => tool.name.includes('plugin')))
  assert.match(none.context.instructions, /Plugins: no services are connected/)
  await finish(none)

  const alice = await signIn('alice')
  const first = await ctx.run('Save a note that says hello')
  const search = (call, args) => first.handle.callTool(call, 'search_plugin_tools', args)
  const run = (execution, call, args) => execution.handle.callTool(call, 'run_plugin_tool', args)
  assert.deepEqual(first.context.tools.filter(tool => tool.name.includes('plugin')).map(tool => tool.name), ['search_plugin_tools', 'run_plugin_tool'])

  // The first search waits for the first sync; tools are found by meaning and keywords, an exact name first.
  const found = await search('s1', { query: 'save a note' })
  assert.equal(found.plugins.length, 1)
  assert.equal(found.plugins[0].plugin, 'fixture')
  assert.equal(found.plugins[0].name, 'Fixture')
  assert.deepEqual(found.plugins[0].accounts, [{ id: alice.id, label: alice.label, default: true, status: 'connected' }])
  const note = found.plugins[0].tools.find(tool => tool.name === 'fixture__create_note')
  assert.deepEqual(note.inputSchema.required, ['text'])
  assert.equal(note.title, 'create note')
  assert.equal((await search('s2', { query: 'whoami' })).plugins[0].tools[0].name, 'fixture__whoami')
  assert.equal((await search('s3', { query: 'fixture__echo' })).plugins[0].tools[0].name, 'fixture__echo')
  const listed = await search('s4', { plugin: 'fixture' })
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['fixture__create_note', 'fixture__echo', 'fixture__whoami'])
  assert.ok(listed.tools.every(tool => !('inputSchema' in tool)))
  // Meaning search always offers the nearest tools; the kip judges whether one fits.
  assert.ok((await search('s5', { query: 'zzzz qqqq' })).plugins[0].tools.length <= 8)
  assert.match((await search('s6', { plugin: 'github' })).error, /No connected plugin "github"/)
  const embedded = await ctx.db.query('SELECT name, embedding_model FROM kipster.plugin_tools ORDER BY name')
  assert.deepEqual(embedded.rows, [{ name: 'fixture__create_note', embedding_model: 'words-1' }, { name: 'fixture__echo', embedding_model: 'words-1' }, { name: 'fixture__whoami', embedding_model: 'words-1' }])

  // Calls are checked before anyone is asked.
  assert.match((await run(first, 'r0', { tool: 'fixture__create_note', arguments: {} })).error, /missing text/)
  assert.match((await run(first, 'r1', { tool: 'fixture__missing', arguments: {} })).error, /No connected plugin tool is named fixture__missing/)
  assert.match((await run(first, 'r2', { tool: 'fixture__whoami', account: 'nobody' })).error, /has no account "nobody"/)

  // The first use asks: the card names the tool, plugin and account and offers the conversation and always grants.
  const asked = await run(first, 'r3', { tool: 'fixture__create_note', arguments: { text: 'hello' } })
  assert.equal(asked.status, 'pending')
  const card = (await ctx.db.query('SELECT prompt, proposal, grant_offer FROM kipster.interactions WHERE id=$1', [asked.interactionId])).rows[0]
  assert.equal(card.prompt, `Use create note from Fixture with ${alice.label}?`)
  assert.match(card.proposal, /"text": "hello"/)
  assert.deepEqual(card.grant_offer, { key: 'plugin:fixture__create_note', label: 'Fixture: create note', scopes: ['conversation', 'always'] })
  await finish(first)
  await ctx.answer(first.context.runId, { kind: 'approve' })

  // Approved once: the same call runs once in the continuation, with a progress note in the work block.
  const second = await next(first.context.runId, first.context.attemptId)
  assert.match(second.context.instructions, /Plugins: the person connected Fixture\./)
  const ran = await run(second, 'r5', { tool: 'fixture__create_note', arguments: { text: 'hello' } })
  assert.equal(ran.text, `${JSON.stringify({ id: 1, text: 'hello', owner: 'alice' })}\n\nAccount: ${alice.label}`)
  assert.deepEqual(ran.structuredContent, { id: 1, text: 'hello', owner: 'alice' })
  const notes = await ctx.db.query("SELECT parts FROM kipster.messages WHERE progress AND source_attempt_id=$1", [second.context.attemptId])
  assert.deepEqual(notes.rows.map(row => row.parts), [[{ kind: 'text', text: 'Fixture: create note' }]])
  await finish(second)
  await until(async () => (await ctx.db.query('SELECT state FROM kipster.text_runs WHERE id=$1', [first.context.runId])).rows[0].state === 'completed', 'first run completed')

  // "Always allow" saves a grant for every kip; later calls of that tool run without a card.
  const third = await ctx.run('Save another note')
  assert.equal((await run(third, 'r6', { tool: 'fixture__create_note', arguments: { text: 'again' } })).status, 'pending', 'an approval is used once')
  await finish(third)
  await ctx.answer(third.context.runId, { kind: 'approve', scope: 'always' })
  const fourth = await next(third.context.runId, third.context.attemptId)
  assert.equal(body(await run(fourth, 'r7', { tool: 'fixture__create_note', arguments: { text: 'again' } })).text, 'again')
  assert.equal(body(await run(fourth, 'r8', { tool: 'fixture__create_note', arguments: { text: 'third' } })).text, 'third')
  await finish(fourth)
  assert.deepEqual((await ctx.db.query('SELECT key FROM kipster.approval_grants WHERE thread_id IS NULL')).rows, [{ key: 'plugin:fixture__create_note' }])

  // A second account: the plugin server's account argument leaves the stored schemas; kips pass `account` instead,
  // and a tool's own `account` argument stays its own.
  const bob = await signIn('bob')
  await ctx.runtime.pluginTools.sync()
  const fifth = await ctx.run('Who am I on both accounts?')
  const both = await fifth.handle.callTool('s7', 'search_plugin_tools', { plugin: 'fixture', query: 'echo' })
  assert.deepEqual(both.plugins[0].accounts.map(account => account.id).sort(), [alice.id, bob.id].sort())
  const echo = both.plugins[0].tools.find(tool => tool.name === 'fixture__echo')
  assert.deepEqual(Object.keys(echo.inputSchema.properties), ['account'])
  const stored = (await ctx.db.query("SELECT input_schema FROM kipster.plugin_tools WHERE name='fixture__create_note'")).rows[0].input_schema
  assert.deepEqual(Object.keys(stored.properties), ['text'])
  // Full access runs every plugin tool without a card.
  await ctx.db.query("INSERT INTO kipster.permission_settings(installation_id,revision,mode) VALUES ($1,1,'fullAccess') ON CONFLICT (installation_id) DO UPDATE SET mode='fullAccess'", [ctx.runtime.bootstrap.installationId])
  const echoed = await run(fifth, 'r9', { tool: 'fixture__echo', account: bob.id, arguments: { account: 'mine' } })
  assert.deepEqual(body(echoed), { account: 'mine', user: 'bob' })
  assert.equal(body(await run(fifth, 'r10', { tool: 'fixture__whoami', account: alice.label })).login, 'alice')
  await finish(fifth)

  // Removing the plugin's accounts removes its tools and the plugin tools themselves.
  await client.removePluginAccount(alice.id)
  await client.removePluginAccount(bob.id)
  await ctx.runtime.pluginTools.sync()
  assert.equal(Number((await ctx.db.query('SELECT count(*) FROM kipster.plugin_tools')).rows[0].count), 0)
  const last = await ctx.run('Anything now?')
  assert.match(last.context.instructions, /Plugins: no services are connected/)
  await finish(last)
})

test('a tool title drops a leading plugin name', () => {
  assert.equal(toolTitle({ name: 'todoist__find-tasks', title: 'Todoist: Find Tasks', pluginName: 'Todoist' }), 'Find Tasks')
  assert.equal(toolTitle({ name: 'todoist__find-tasks', title: 'Find Tasks', pluginName: 'Todoist' }), 'Find Tasks')
  assert.equal(toolTitle({ name: 'fixture__create_note', title: null, pluginName: 'Fixture' }), 'create note')
})
