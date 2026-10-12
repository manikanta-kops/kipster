import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createEmbeddingProvider } from '../dist/index.js'

const vector = Array.from({ length: 768 }, (_, index) => (index + 1) / 768)
async function fake(t, handler) {
  const received = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part
    received.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
    await handler(request, response)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { endpoint: `http://127.0.0.1:${server.address().port}`, received }
}
const json = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }

test('posts the text to the OpenAI-compatible endpoint with the model and API key', async t => {
  const server = await fake(t, (request, response) => json(response, 200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: vector }], model: 'embeddinggemma-2-Q8_0' }))
  for (const path of ['', '/']) {
    const provider = createEmbeddingProvider({ endpoint: server.endpoint + path, model: 'embeddinggemma-2-Q8_0', apiKey: 'private-key' })
    assert.equal(provider.id, 'llama-cpp'); assert.equal(provider.contractMajor, 1); assert.equal(provider.model, 'embeddinggemma-2-Q8_0')
    assert.deepEqual(await provider.embed('title: none | text: hello', new AbortController().signal), vector)
    assert.deepEqual(server.received.at(-1), { method: 'POST', path: '/v1/embeddings', authorization: 'Bearer private-key', body: { model: 'embeddinggemma-2-Q8_0', input: 'title: none | text: hello', encoding_format: 'float' } })
  }
  await createEmbeddingProvider({ endpoint: server.endpoint, model: 'fixture' }).embed('no key', new AbortController().signal)
  assert.equal(server.received.at(-1).authorization, undefined)
})

test('rejects vectors that are not 768 dimensions and missing embeddings', async t => {
  let reply = { data: [{ embedding: vector.slice(0, 512) }] }
  const server = await fake(t, (request, response) => json(response, 200, reply))
  const provider = createEmbeddingProvider({ endpoint: server.endpoint, model: 'fixture' })
  await assert.rejects(provider.embed('short', new AbortController().signal), /returned 512 dimensions; expected 768/)
  reply = { data: [] }
  await assert.rejects(provider.embed('none', new AbortController().signal), /returned no embedding/)
})

test('reports HTTP failures with the server message, a rejected key and an unreachable server', async t => {
  let status = 500
  const server = await fake(t, (request, response) => json(response, status, { error: { code: status, message: 'input (17098 tokens) is too large to process. increase the physical batch size (current batch size: 8192)', type: 'server_error' } }))
  const provider = createEmbeddingProvider({ endpoint: server.endpoint, model: 'fixture', apiKey: 'wrong' })
  await assert.rejects(provider.embed('long', new AbortController().signal), /HTTP 500\): input \(17098 tokens\) is too large/)
  status = 401
  await assert.rejects(provider.embed('key', new AbortController().signal), /rejected the API key/)
  const closed = createEmbeddingProvider({ endpoint: 'http://127.0.0.1:9', model: 'fixture' })
  await assert.rejects(closed.embed('hello', new AbortController().signal), /unreachable at http:\/\/127\.0\.0\.1:9/)
})

test('honours the abort signal and applies its own timeout', async t => {
  const server = await fake(t, () => { /* Never answers. */ })
  const provider = createEmbeddingProvider({ endpoint: server.endpoint, model: 'fixture', timeoutMs: 100 })
  await assert.rejects(provider.embed('slow', new AbortController().signal), /did not answer within 100 ms/)
  const controller = new AbortController(), reason = new Error('turn cancelled')
  const pending = createEmbeddingProvider({ endpoint: server.endpoint, model: 'fixture' }).embed('cancel', controller.signal)
  setTimeout(() => controller.abort(reason), 20)
  await assert.rejects(pending, error => error === reason)
  await assert.rejects(provider.embed('already', AbortSignal.abort(reason)), error => error === reason)
})

test('validates its options', () => {
  const valid = { endpoint: 'http://127.0.0.1:43180', model: 'fixture' }
  for (const options of [null, [], {}, { ...valid, endpoint: 'not a url' }, { ...valid, endpoint: 'https://127.0.0.1:43180' }, { ...valid, endpoint: 'http://example.com' }, { ...valid, endpoint: 'http://user:pass@127.0.0.1' }, { ...valid, endpoint: 'http://127.0.0.1/?key=secret' }, { ...valid, endpoint: 'http://127.0.0.1/#fragment' }, { ...valid, model: ' ' }, { ...valid, apiKey: '' }, { ...valid, apiKey: 42 }, { ...valid, timeoutMs: 0 }, { ...valid, timeoutMs: 1.5 }]) assert.throws(() => createEmbeddingProvider(options), /Invalid/)
  for (const endpoint of ['http://localhost:1', 'http://[::1]:1', 'http://127.0.0.1:1/prefix']) assert.equal(createEmbeddingProvider({ ...valid, endpoint }).model, 'fixture')
})
