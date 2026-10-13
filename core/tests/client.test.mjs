import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient, defineClientOptions, KipsterClientError } from '../dist/protocol/client/index.js'

test('normalizes an HTTP(S) address without mutating its input', () => {
  const input = { baseUrl: 'HTTPS://KIPSTER.EXAMPLE:443/core/' }
  const options = defineClientOptions(input)
  assert.deepEqual(options, { baseUrl: 'https://kipster.example/core/' })
  assert.deepEqual(input, { baseUrl: 'HTTPS://KIPSTER.EXAMPLE:443/core/' })
  assert.equal(Object.isFrozen(options), true)
  assert.deepEqual(defineClientOptions({ baseUrl: 'http://127.0.0.1:3000' }), {
    baseUrl: 'http://127.0.0.1:3000/',
  })
})

test('rejects relative addresses and non-HTTP transports', () => {
  for (const baseUrl of ['/core', 'not a URL', 'file:///tmp/kipster', 'ftp://example.com', 'javascript:void(0)']) {
    assert.throws(() => defineClientOptions({ baseUrl }), TypeError)
    assert.throws(() => createClient({ baseUrl }, async () => { throw new Error('no request') }), TypeError)
  }
})

const at = '2026-10-13T09:00:00.000Z'
const summary = { id: 'linear', name: 'Linear', description: 'Issues', category: 'productivity', website: 'https://linear.app', signIn: ['dcr'], available: true, probe: null, verification: 'probe', needsAddress: false, accountCount: 1 }
const account = { id: 'acc-1', plugin: 'linear', label: 'me@example.com', issuer: 'https://linear.app', identityVerified: true, identitySource: 'openid', status: 'working', isDefault: true, serverUrl: 'https://mcp.linear.app/mcp', createdAt: at, updatedAt: at }

/** A fake fetch that records each request and answers from `routes`, keyed by method and path. */
function fake(routes) {
  const requests = []
  const fetch = async (url, init) => {
    const { pathname, search } = new URL(url)
    requests.push({ url, method: init.method, path: pathname + search, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers, signal: init.signal })
    const answer = routes[`${init.method} ${pathname}${search}`]
    if (!answer) return Response.json({ version: 1, code: 'not-found', message: 'Route not found', requestId: 'r-404' }, { status: 404 })
    const [status, body] = typeof answer === 'function' ? answer() : answer
    return typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status })
  }
  return { requests, client: createClient({ baseUrl: 'http://127.0.0.1:4100/core/' }, fetch) }
}

test('calls every plugin route with its method, path and body, and returns the parsed response', async () => {
  const signIn = { version: 1, status: 'redirect', id: 'sign-1', method: 'dcr', authorizationUrl: 'https://linear.app/oauth/authorize?x=1', serverUrl: 'https://mcp.linear.app/mcp', expiresAt: at }
  const { client, requests } = fake({
    'GET /core/v1/bootstrap': [200, { version: 1, coreVersion: '0.9.0', protocol: { current: 1, oldest: 1 }, installationId: 'i', callerId: 'c', organizationId: 'o', rootAgentId: 'k', capabilities: { voiceRecording: false, plugins: true } }],
    'GET /core/v1/plugins': [200, { version: 1, plugins: [summary] }],
    'GET /core/v1/plugins/linear': [200, { version: 1, plugin: { ...summary, accounts: [account] } }],
    'POST /core/v1/plugins/linear/sign-in': [200, signIn],
    'GET /core/v1/plugins/sign-ins/sign-1': [200, { version: 1, id: 'sign-1', status: 'completed', plugin: 'linear', account, duplicate: false }],
    'GET /core/v1/plugins/accounts': [200, { version: 1, accounts: [account] }],
    'GET /core/v1/plugins/accounts?plugin=linear': [200, { version: 1, accounts: [account] }],
    'PATCH /core/v1/plugins/accounts/acc-1': [200, { version: 1, account: { ...account, label: 'Work' } }],
    'PUT /core/v1/plugins/linear/default-account': [200, { version: 1, plugin: 'linear', defaultAccount: 'acc-1' }],
    'DELETE /core/v1/plugins/linear/default-account': [200, { version: 1, plugin: 'linear', defaultAccount: null }],
    'DELETE /core/v1/plugins/accounts/acc-1': [200, { version: 1, removed: true, revoked: false }],
  })
  const controller = new AbortController()
  assert.equal((await client.bootstrap()).capabilities.plugins, true)
  assert.deepEqual(await client.listPlugins({ signal: controller.signal }), { version: 1, plugins: [summary] })
  assert.deepEqual((await client.getPlugin('linear')).plugin.accounts, [account])
  assert.deepEqual(await client.startPluginSignIn('linear', { returnAddress: 'http://127.0.0.1:4100/plugins/callback' }), signIn)
  const status = await client.getPluginSignIn('sign-1')
  assert.equal(status.status, 'completed')
  assert.equal(status.status === 'completed' && status.account.id, 'acc-1')
  assert.equal((await client.listPluginAccounts()).accounts.length, 1)
  assert.equal((await client.listPluginAccounts({ plugin: 'linear' })).accounts.length, 1)
  assert.equal((await client.renamePluginAccount('acc-1', 'Work')).account.label, 'Work')
  assert.deepEqual(await client.setDefaultPluginAccount('linear', 'acc-1'), { version: 1, plugin: 'linear', defaultAccount: 'acc-1' })
  assert.equal((await client.clearDefaultPluginAccount('linear')).defaultAccount, null)
  assert.deepEqual(await client.removePluginAccount('acc-1'), { version: 1, removed: true, revoked: false })

  assert.deepEqual(requests.map(r => [r.method, r.path, r.body]), [
    ['GET', '/core/v1/bootstrap', undefined],
    ['GET', '/core/v1/plugins', undefined],
    ['GET', '/core/v1/plugins/linear', undefined],
    ['POST', '/core/v1/plugins/linear/sign-in', { version: 1, returnAddress: 'http://127.0.0.1:4100/plugins/callback' }],
    ['GET', '/core/v1/plugins/sign-ins/sign-1', undefined],
    ['GET', '/core/v1/plugins/accounts', undefined],
    ['GET', '/core/v1/plugins/accounts?plugin=linear', undefined],
    ['PATCH', '/core/v1/plugins/accounts/acc-1', { version: 1, label: 'Work' }],
    ['PUT', '/core/v1/plugins/linear/default-account', { version: 1, account: 'acc-1' }],
    ['DELETE', '/core/v1/plugins/linear/default-account', undefined],
    ['DELETE', '/core/v1/plugins/accounts/acc-1', undefined],
  ])
  assert.equal(requests[1].signal, controller.signal)
  assert.equal(requests[0].signal, undefined)
  assert.deepEqual(requests[3].headers, { Accept: 'application/json', 'Content-Type': 'application/json' })
  assert.deepEqual(requests[0].headers, { Accept: 'application/json' })
})

test('encodes identifiers so they stay within their path segment', async () => {
  const { client, requests } = fake({})
  await assert.rejects(client.getPlugin('../accounts'), KipsterClientError)
  await assert.rejects(client.listPluginAccounts({ plugin: 'a&b=c' }), KipsterClientError)
  await assert.rejects(client.removePluginAccount('x/y?z'), KipsterClientError)
  assert.deepEqual(requests.map(r => r.path), ['/core/v1/plugins/..%2Faccounts', '/core/v1/plugins/accounts?plugin=a%26b%3Dc', '/core/v1/plugins/accounts/x%2Fy%3Fz'])
})

test('errors keep Core\'s or the plugin server\'s code, status and request ID', async () => {
  const { client } = fake({
    'GET /core/v1/plugins': [503, { version: 1, code: 'plugins-unavailable', message: 'Plugins are not running', requestId: 'r-1' }],
    'PATCH /core/v1/plugins/accounts/acc-1': [400, { version: 1, code: 'invalid-label', message: 'Label is taken', requestId: 'r-2' }],
    'POST /core/v1/plugins/linear/sign-in': [502, 'Bad gateway'],
    'GET /core/v1/plugins/linear': [200, { version: 1, plugin: { id: 'linear' } }],
  })
  await assert.rejects(client.listPlugins(), error => error instanceof KipsterClientError && error.status === 503 && error.code === 'plugins-unavailable' && error.requestId === 'r-1' && error.message === 'Plugins are not running')
  await assert.rejects(client.renamePluginAccount('acc-1', 'Taken'), { status: 400, code: 'invalid-label', message: 'Label is taken' })
  await assert.rejects(client.startPluginSignIn('linear'), { status: 502, code: 'invalid-response', requestId: null })
  await assert.rejects(client.getPlugin('linear'), { status: 200, code: 'invalid-response' })
})
