import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { startTextServer } from '../dist/runtime.js'

// No database or real state: bootstrap reads return fake IDs. A malformed write must reach
// validation only after the authority/origin gate, and must never touch the database.
const runtime = { db: { async listen() { return () => {} } }, bootstrap: { installationId: 'fixture-installation', ownerId: 'fixture-owner', organizationId: 'fixture-org', rootAgentId: 'fixture-agent' } }
const actor = { installationId: 'fixture-installation', personId: 'fixture-owner' }
function request(server, { method = 'GET', path = '/v1/bootstrap', host = new URL(server.url).host, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.url, { method, path, headers: { host, ...(origin === undefined ? {} : { origin }), ...headers } }, response => {
      let body = ''
      response.setEncoding('utf8').on('data', value => { body += value })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? '{}' : undefined)
  })
}
async function setup(t, options = {}) {
  const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, ...options })
  t.after(() => server.close())
  return server
}

test('matching hostile Host and Origin cannot authorize reads, writes or preflight', async t => {
  const server = await setup(t)
  for (const target of [
    { method: 'GET' },
    { method: 'POST', path: '/v1/direct-chats' },
    { method: 'OPTIONS', path: '/v1/direct-chats' },
  ]) {
    const rejected = await request(server, { ...target, host: 'evil.example', origin: 'http://evil.example' })
    assert.equal(rejected.status, 403)
    assert.equal(rejected.body.code, 'forbidden')
    assert.equal(rejected.headers['access-control-allow-origin'], undefined)
  }
  assert.equal((await request(server, { host: 'evil.example' })).status, 403, 'same-origin browser GET can omit Origin')
  assert.equal((await request(server, { origin: 'http://evil.example' })).status, 403)
  assert.equal((await request(server, { host: 'evil.example', origin: server.url })).status, 403)
  assert.equal((await request(server, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, origin: 'https://evil.example' })).status, 403)
})

test('actual listening origin and originless trusted clients remain supported at an ephemeral port', async t => {
  const server = await setup(t)
  assert.notEqual(new URL(server.url).port, '0')
  for (const origin of [undefined, server.url]) {
    assert.equal((await request(server, { origin })).status, 200)
    assert.equal((await request(server, { origin, method: 'POST', path: '/v1/direct-chats' })).status, 400, 'allowed write reaches input validation')
  }
  const preflight = await request(server, { origin: server.url, method: 'OPTIONS', path: '/v1/direct-chats' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], server.url)
  assert.equal((await request(server, { path: 'http://evil.example/v1/bootstrap', origin: server.url })).status, 400)
})

test('explicit browser origins and proxy authorities are independent allowlists', async t => {
  const ui = 'https://ui.example', proxy = 'https://kipster.example'
  const server = await setup(t, { allowedOrigins: [ui, proxy], allowedHosts: ['kipster.example'] })
  for (const target of [{ origin: ui }, { host: 'kipster.example', origin: proxy }, { host: 'kipster.example' }]) {
    assert.equal((await request(server, target)).status, 200)
    assert.equal((await request(server, { ...target, method: 'POST', path: '/v1/direct-chats' })).status, 400)
  }
  assert.equal((await request(server, { host: 'ui.example', origin: ui })).status, 403, 'allowed Origin does not trust that Host')
  assert.equal((await request(server, { host: 'kipster.example', origin: 'http://kipster.example' })).status, 403, 'allowed Host does not trust an unlisted scheme/origin')
  const preflight = await request(server, { host: 'kipster.example', origin: proxy, method: 'OPTIONS' })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['access-control-allow-origin'], proxy)
})

test('host allowlist rejects credentials, paths and forwarded URL forms', async () => {
  for (const host of ['https://kipster.example', 'kipster.example/path', 'user@kipster.example', 'kipster.example#fragment', 'kipster.example?query', ' kipster.example']) {
    await assert.rejects(startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, allowedHosts: [host] }))
  }
})

test('bootstrap reports the Core release and the protocol range it serves', async t => {
  const server = await setup(t)
  const { body } = await request(server)
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(body.coreVersion, manifest.version)
  assert.deepEqual(body.protocol, { current: 1, oldest: 1 })
})
