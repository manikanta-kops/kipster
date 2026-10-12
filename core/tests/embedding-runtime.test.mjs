import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as tcpServer, connect } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { embeddingDocument, embeddingQuery } from '../dist/embedding/index.js'
import { EmbeddingServerSupervisor, supervisedEmbeddingProvider } from '../dist/embedding/supervisor.js'
import { embeddingServerDiagnostic } from '../dist/host-diagnostics.js'
import { doctor, ownControl, validateHostConfig } from '../dist/host.js'

const fake = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url))
const model = 'embeddinggemma-2-Q8_0'
const wait = async (predicate, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error('Timed out') }
async function freePort() {
  const server = tcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port
}
const accepting = port => new Promise(resolve => { const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false)) })
const health = async port => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).status } catch { return undefined } }

/** A Kipster home with an installed fake llama-server and model, as the installer lays them out. */
async function installed(t, control = {}) {
  const home = await realpath(await mkdtemp('/tmp/kipster-embedding-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'embedding/llama.cpp/b0'), models = join(home, 'embedding/models')
  await mkdir(directory, { recursive: true }); await mkdir(models, { recursive: true })
  const controlFile = join(home, 'control.json')
  await writeFile(controlFile, JSON.stringify(control))
  const binary = join(directory, 'llama-server')
  await writeFile(binary, `#!/bin/sh\nFAKE_LLAMA_CONTROL='${controlFile}' exec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 })
  const gguf = join(models, `${model}.gguf`)
  await writeFile(gguf, 'fake model bytes')
  const config = { binary, model: gguf, modelSha256: createHash('sha256').update('fake model bytes').digest('hex'), modelName: model, port: await freePort() }
  const launches = async () => { try { return (await readFile(controlFile + '.launches', 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
  return { home, config, launches }
}
function supervise(t, home, config, options = {}) {
  const statuses = []
  const supervisor = new EmbeddingServerSupervisor({ home, config, readyTimeoutMs: 10000, backoff: { initialMs: 50, maxMs: 1000, attempts: 5 }, watchIntervalMs: 100, ...options, onStatus: status => statuses.push({ ...status, at: Date.now() }) })
  t.after(() => supervisor.close())
  return { supervisor, statuses }
}

test('prompt formats match the EmbeddingGemma 2 model card', () => {
  assert.equal(embeddingQuery('What causes the northern lights?'), 'task: search result | query: What causes the northern lights?')
  assert.equal(embeddingDocument('The northern lights are caused by charged particles from the sun.'), 'title: none | text: The northern lights are caused by charged particles from the sun.')
  assert.equal(embeddingDocument('Planned Berlin with Priya.', 'Mon 12 Oct 2026, with Kip'), 'title: Mon 12 Oct 2026, with Kip | text: Planned Berlin with Priya.')
  for (const title of ['', '  ', undefined]) assert.equal(embeddingDocument('text', title), 'title: none | text: text')
})

test('starts the installed server in embedding mode and stops it when Core stops', async t => {
  const { home, config, launches } = await installed(t)
  const { supervisor, statuses } = supervise(t, home, config)
  await supervisor.start()
  assert.equal(await supervisor.whenReady(), `http://127.0.0.1:${config.port}`)
  assert.deepEqual(supervisor.status(), { state: 'ready', port: config.port, reused: false })
  assert.deepEqual(statuses.map(status => status.state), ['starting', 'starting', 'ready'])
  const [launch] = await launches()
  assert.deepEqual(launch.args, ['--embedding', '--model', config.model, '--alias', model, '--ctx-size', '8192', '--batch-size', '8192', '--ubatch-size', '8192', '--parallel', '1', '--host', '127.0.0.1', '--port', String(config.port), '--api-key-file', join(home, 'embedding/api-key'), '--no-webui', '--offline'])
  assert.equal(JSON.parse(await readFile(supervisor.stateFile, 'utf8')).port, config.port)
  assert.match(supervisor.apiKey, /^[a-f0-9]{64}$/)
  await supervisor.close()
  assert.equal(supervisor.status().state, 'stopped')
  assert.equal(await accepting(config.port), false)
  await assert.rejects(supervisor.whenReady(), /stopped/)
})

test('reuses a healthy Kipster server on the recorded port and leaves it running', async t => {
  const { home, config, launches } = await installed(t)
  // The first supervisor stands for a Core that ended without stopping its server.
  const { supervisor: first } = supervise(t, home, config)
  await first.start(); await first.whenReady()
  const { supervisor: second } = supervise(t, home, { ...config, port: await freePort() })
  await second.start()
  assert.equal(await second.whenReady(), `http://127.0.0.1:${config.port}`, 'the recorded port wins over host.json')
  assert.deepEqual(second.status(), { state: 'ready', port: config.port, reused: true })
  assert.equal((await launches()).length, 1)
  await second.close()
  assert.equal(await health(config.port), 200, 'a reused server keeps running')
  await first.close()
  assert.equal(await accepting(config.port), false)
})

test('picks and records another port when a foreign program holds the recorded one', async t => {
  const { home, config, launches } = await installed(t)
  const seen = []
  // A user's own llama-server: healthy, but it does not know Kipster's key.
  const foreign = createServer((request, response) => { seen.push([request.method, request.url]); response.writeHead(request.url === '/health' ? 200 : 401); response.end('{}') })
  await new Promise(resolve => foreign.listen(config.port, '127.0.0.1', resolve))
  t.after(() => { foreign.closeAllConnections(); return new Promise(resolve => foreign.close(resolve)) })
  const { supervisor } = supervise(t, home, config)
  await supervisor.start()
  const endpoint = await supervisor.whenReady()
  const port = Number(new URL(endpoint).port)
  assert.notEqual(port, config.port)
  assert.deepEqual(supervisor.status(), { state: 'ready', port, reused: false })
  assert.equal(JSON.parse(await readFile(supervisor.stateFile, 'utf8')).port, port)
  assert.deepEqual((await launches()).map(launch => launch.port), [port])
  assert.deepEqual(seen, [['GET', '/health'], ['GET', '/v1/models']], 'the foreign server is only probed')
  await supervisor.close()
  assert.equal(await accepting(port), false)
  assert.equal(await accepting(config.port), true, 'the foreign server is untouched')

  // A listener that never answers HTTP is foreign too.
  const sockets = new Set(), silent = tcpServer(socket => sockets.add(socket))
  await new Promise(resolve => silent.listen(port, '127.0.0.1', resolve))
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => silent.close(resolve)) })
  const { supervisor: again } = supervise(t, home, config)
  await again.start()
  assert.notEqual(Number(new URL(await again.whenReady()).port), port)
})

test('restarts a crashed server with exponential backoff and reports each attempt', async t => {
  const { home, config, launches } = await installed(t, { crashes: 2, crashAfterMs: 100 })
  const { supervisor, statuses } = supervise(t, home, config, { backoff: { initialMs: 150, maxMs: 1000, attempts: 5 } })
  await supervisor.start()
  await wait(async () => (await launches()).length === 3 && supervisor.status().state === 'ready')
  const restarts = statuses.filter(status => status.state === 'restarting')
  assert.deepEqual(restarts.map(({ attempt, reason }) => ({ attempt, reason })), [{ attempt: 1, reason: 'llama-server exited with code 3' }, { attempt: 2, reason: 'llama-server exited with code 3' }])
  const [, second, third] = await launches()
  assert.ok(second.at - restarts[0].at >= 150, 'first restart waits the initial delay')
  assert.ok(third.at - restarts[1].at >= 300, 'second restart waits twice as long')
  assert.deepEqual(supervisor.status(), { state: 'ready', port: config.port, reused: false })
  assert.match(embeddingServerDiagnostic(restarts[1]).message, /restarting, attempt 2: llama-server exited with code 3/)
  assert.equal(embeddingServerDiagnostic(restarts[1]).status, 'unavailable')
})

test('fails with a reason after repeated crashes, a wrong model checksum or files outside the home', async t => {
  const crashing = await installed(t, { crashes: 99, crashAfterMs: 0 })
  const { supervisor } = supervise(t, crashing.home, crashing.config, { backoff: { initialMs: 10, maxMs: 20, attempts: 2 } })
  await supervisor.start()
  await wait(() => supervisor.status().state === 'failed')
  assert.match(supervisor.status().reason, /^llama-server failed 2 restarts; last: llama-server exited with code 3/)
  await assert.rejects(supervisor.whenReady(), /Embedding server failed: llama-server failed 2 restarts/)
  assert.equal((await crashing.launches()).length, 3)
  assert.match(embeddingServerDiagnostic(supervisor.status()).message, /failed: .*Memory search is unavailable/)

  const corrupt = await installed(t)
  const { supervisor: mismatch } = supervise(t, corrupt.home, { ...corrupt.config, modelSha256: '0'.repeat(64) })
  await mismatch.start()
  assert.deepEqual(mismatch.status(), { state: 'failed', reason: 'The embedding model does not match its expected SHA-256; reinstall or update Kipster' })
  assert.deepEqual(await corrupt.launches(), [])

  const outside = await installed(t)
  const link = join(outside.home, 'embedding/llama.cpp/b0/linked-server')
  await symlink('/bin/sh', link)
  const { supervisor: escaped } = supervise(t, outside.home, { ...outside.config, binary: link })
  await escaped.start()
  assert.match(escaped.status().reason, /only the llama-server and model installed in the Kipster home/)

  const base = { version: 1, home: outside.home, databaseUrl: 'postgresql://kipster@localhost/unused', listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [] }
  const embedding = server => ({ ...base, embedding: { module: join(outside.home, 'current/node_modules/@kipster/embedding-llama-cpp/dist/index.js'), options: {}, server } })
  assert.equal(validateHostConfig(embedding(outside.config)).embedding.server.port, outside.config.port)
  for (const server of [{ ...outside.config, binary: '/opt/homebrew/opt/llama.cpp/bin/llama-server' }, { ...outside.config, model: join(outside.home, '../elsewhere.gguf') }, { ...outside.config, modelSha256: 'abc' }, { ...outside.config, modelName: '../x' }, { ...outside.config, port: 43120 }, { ...outside.config, port: 80 }, { ...outside.config, endpoint: 'http://127.0.0.1:11434' }, 'server'])
    assert.throws(() => validateHostConfig(embedding(server)), /Configure embedding.server/)
})

test('the provider waits for the server and follows its current endpoint', async t => {
  const { home, config } = await installed(t)
  const { supervisor } = supervise(t, home, config)
  const created = []
  const create = options => { created.push(options); return { id: 'llama-cpp', model: options.model, contractMajor: 1, async embed(text) { const response = await fetch(`${options.endpoint}/v1/embeddings`, { method: 'POST', headers: { authorization: `Bearer ${options.apiKey}` }, body: JSON.stringify({ input: text }) }); return (await response.json()).data[0].embedding } } }
  const provider = supervisedEmbeddingProvider(supervisor, create, { timeoutMs: 1000 }, config.port)
  assert.equal(provider.id, 'llama-cpp'); assert.equal(provider.model, model)
  const pending = provider.embed('hello', new AbortController().signal)
  await supervisor.start()
  assert.equal((await pending).length, 768)
  assert.deepEqual(created.at(-1), { timeoutMs: 1000, endpoint: `http://127.0.0.1:${config.port}`, model, apiKey: supervisor.apiKey })
  await assert.rejects(provider.embed('cancelled', AbortSignal.abort(new Error('cancelled'))), /cancelled/)
  await supervisor.close()
  await assert.rejects(provider.embed('after', new AbortController().signal), /stopped/)
})

test('doctor reports the running host embedding server status and missing files', async t => {
  const { home, config } = await installed(t)
  const host = { version: 1, home, databaseUrl: 'postgresql://kipster@127.0.0.1:1/unused', listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: [] }, adapters: [], embedding: { module: join(home, 'module.mjs'), options: {}, server: config } }
  const row = async () => (await doctor(host)).find(item => item.check === 'embedding')
  assert.deepEqual(await row(), { check: 'embedding', status: 'not-probed', message: 'Embedding server (llama-server) is configured; the running host starts it.' })
  const status = { state: 'running', pid: process.pid, instance: randomUUID(), embedding: { state: 'restarting', attempt: 2, reason: 'llama-server exited with code 3' } }
  const owner = await ownControl(home, status, () => {})
  t.after(() => owner.close().catch(() => {}))
  assert.deepEqual(await row(), { check: 'embedding', status: 'unavailable', message: 'Embedding server (llama-server) is restarting, attempt 2: llama-server exited with code 3. Memory search is unavailable meanwhile.' })
  status.embedding = { state: 'ready', port: config.port, reused: true }
  assert.equal((await row()).status, 'ok')
  assert.match((await row()).message, new RegExp(`ready on port ${config.port}, reusing`))
  await rm(config.model)
  assert.equal((await row()).status, 'unavailable')
  assert.match((await row()).message, /missing/)
})
