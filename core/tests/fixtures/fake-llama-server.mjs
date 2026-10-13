// A stand-in for llama.cpp's llama-server in embedding mode: health, models and embeddings.
// FAKE_LLAMA_CONTROL names a JSON file: { "crashes": n, "crashAfterMs": ms, "readyAfterMs": ms }.
// Each launch appends { port, args } to <control>.launches; the first `crashes` launches exit
// with code 3 `crashAfterMs` after they first list their model, which is when Core sees them ready.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const option = name => args[args.indexOf(name) + 1]
const control = process.env.FAKE_LLAMA_CONTROL
const settings = control ? JSON.parse(readFileSync(control, 'utf8')) : {}
let launch = 0
if (control) {
  try { launch = readFileSync(control + '.launches', 'utf8').split('\n').filter(Boolean).length } catch {}
  appendFileSync(control + '.launches', JSON.stringify({ port: Number(option('--port')), args, at: Date.now() }) + '\n')
}
const key = readFileSync(option('--api-key-file'), 'utf8').trim(), alias = option('--alias')
const started = Date.now(), loaded = () => Date.now() - started >= (settings.readyAfterMs ?? 0)
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
const server = createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += part
  if (request.url === '/health') return loaded() ? send(response, 200, { status: 'ok' }) : send(response, 503, { error: { code: 503, message: 'Loading model' } })
  if (request.headers.authorization !== `Bearer ${key}`) return send(response, 401, { error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' } })
  if (request.url === '/v1/models') {
    if (launch < (settings.crashes ?? 0)) setTimeout(() => process.exit(3), settings.crashAfterMs ?? 0)
    return send(response, 200, { object: 'list', data: [{ id: alias, object: 'model', owned_by: 'llamacpp' }] })
  }
  if (request.url === '/v1/embeddings' && request.method === 'POST') {
    const { input } = JSON.parse(body)
    return send(response, 200, { object: 'list', model: alias, data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: 768 }, (_, index) => (index === input.length % 768 ? 1 : 0)) }] })
  }
  send(response, 404, { error: { code: 404, message: 'Not found' } })
})
server.listen(Number(option('--port')), option('--host'))
server.once('error', () => process.exit(4))
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
