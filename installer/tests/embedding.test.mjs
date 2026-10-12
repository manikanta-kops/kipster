import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadVerified, embeddingRuntime, installEmbeddingRuntime, serverAsset, withEmbedding } from '../src/embedding.mjs'
import { install } from '../src/installer.mjs'
import { json } from '../src/files.mjs'
import { run } from '../src/process.mjs'
import { catalogs, configuration, database, directory, hooks, noDatabase } from './support.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
/** Serves a tiny fake llama.cpp release archive and model on loopback and records every request. */
async function fixture(t) {
  const root = await directory(t, 'kpi-runtime-'), files = new Map(), requests = []
  const release = join(root, 'source/llama-b0')
  await mkdir(release, { recursive: true })
  await writeFile(join(release, 'llama-server'), '#!/bin/sh\necho fake llama-server\n', { mode: 0o755 })
  await writeFile(join(release, 'libllama.0.1.dylib'), 'shared library')
  await symlink('libllama.0.1.dylib', join(release, 'libllama.0.dylib'))
  await run('tar', ['-czf', join(root, 'server.tar.gz'), '-C', join(root, 'source'), 'llama-b0'])
  await mkdir(join(root, 'other'))
  await writeFile(join(root, 'other/llama-server'), 'misplaced', { mode: 0o755 })
  await run('tar', ['-czf', join(root, 'misplaced.tar.gz'), '-C', root, 'other'])
  for (const name of ['server.tar.gz', 'misplaced.tar.gz']) files.set('/' + name, await readFile(join(root, name)))
  files.set('/model.gguf', Buffer.from('tiny fake model'))
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (!files.has(request.url)) { response.writeHead(404); response.end(); return }
    response.end(files.get(request.url))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const asset = name => ({ name, url: `${base}/${name}`, size: files.get('/' + name).length, sha256: sha256(files.get('/' + name)) })
  const manifest = {
    server: { build: 'b0', directory: 'llama-b0', platforms: { 'darwin-arm64': asset('server.tar.gz'), 'linux-x64': asset('server.tar.gz') } },
    model: { name: 'fixture-Q8_0', file: 'fixture-Q8_0.gguf', url: `${base}/model.gguf`, size: files.get('/model.gguf').length, sha256: sha256(files.get('/model.gguf')) },
    port: 43180,
  }
  return { manifest, requests, asset }
}

test('pins a llama.cpp build for each supported platform and the model from their primary sources', () => {
  const expected = { 'darwin-arm64': 'llama-b11565-bin-macos-arm64.tar.gz', 'darwin-x64': 'llama-b11565-bin-macos-x64.tar.gz', 'linux-x64': 'llama-b11565-bin-ubuntu-x64.tar.gz', 'linux-arm64': 'llama-b11565-bin-ubuntu-arm64.tar.gz' }
  for (const [platform, name] of Object.entries(expected)) {
    const asset = serverAsset(embeddingRuntime, ...platform.split('-'))
    assert.equal(asset.name, name)
    assert.equal(asset.url, `https://github.com/ggml-org/llama.cpp/releases/download/b11565/${name}`)
    assert.match(asset.sha256, /^[a-f0-9]{64}$/); assert.ok(asset.size > 0)
  }
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 's390x'], ['freebsd', 'x64']]) assert.equal(serverAsset(embeddingRuntime, platform, arch), null)
  assert.equal(serverAsset(null, 'darwin', 'arm64'), null)
  assert.deepEqual(embeddingRuntime.model, {
    name: 'embeddinggemma-2-Q8_0', file: 'embeddinggemma-2-Q8_0.gguf',
    url: 'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf',
    size: 309855456, sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  })
})

test('installs the platform build with its libraries and the model, then reuses what is verified', async t => {
  const home = await directory(t), { manifest, requests } = await fixture(t)
  const installed = await installEmbeddingRuntime(home, { manifest, platform: 'linux', arch: 'x64' })
  const directory_ = join(home, 'embedding/llama.cpp/b0')
  assert.deepEqual(installed, { available: true, server: { binary: join(directory_, 'llama-server'), model: join(home, 'embedding/models/fixture-Q8_0.gguf'), modelSha256: manifest.model.sha256, modelName: 'fixture-Q8_0', port: 43180 } })
  assert.equal(await run(installed.server.binary, []), 'fake llama-server')
  assert.equal(await readlink(join(directory_, 'libllama.0.dylib')), 'libllama.0.1.dylib')
  assert.equal(await readFile(installed.server.model, 'utf8'), 'tiny fake model')
  assert.equal((await stat(join(home, 'embedding'))).mode & 0o777, 0o700)
  assert.deepEqual((await readdir(join(home, 'embedding/llama.cpp'))).sort(), ['b0'], 'no archive or staging directory remains')
  assert.deepEqual(requests, ['/server.tar.gz', '/model.gguf'])

  assert.deepEqual(await installEmbeddingRuntime(home, { manifest, platform: 'linux', arch: 'x64' }), installed)
  assert.equal(requests.length, 2, 'verified files are reused without downloading')
  await writeFile(installed.server.model, 'tiny fake modeX')
  await installEmbeddingRuntime(home, { manifest, platform: 'linux', arch: 'x64' })
  assert.deepEqual(requests.slice(2), ['/model.gguf'], 'a changed model is downloaded again')
  assert.equal(await readFile(installed.server.model, 'utf8'), 'tiny fake model')
})

test('a release whose server, libraries, modes or links changed is downloaded and extracted again', async t => {
  const home = await directory(t), { manifest, requests } = await fixture(t)
  const options = { manifest, platform: 'darwin', arch: 'arm64' }
  const installed = await installEmbeddingRuntime(home, options), release = join(home, 'embedding/llama.cpp/b0')
  const downloads = () => requests.filter(url => url === '/server.tar.gz').length
  const changes = [
    ['a changed server', () => writeFile(installed.server.binary, '#!/bin/sh\necho corrupted\n')],
    ['a changed shared library', () => writeFile(join(release, 'libllama.0.1.dylib'), 'corrupted library')],
    ['a server that is no longer executable', () => chmod(installed.server.binary, 0o600)],
    ['a removed shared library', () => rm(join(release, 'libllama.0.1.dylib'))],
    ['a retargeted link', async () => { await rm(join(release, 'libllama.0.dylib')); await writeFile(join(release, 'other.dylib'), 'x'); await symlink('other.dylib', join(release, 'libllama.0.dylib')) }],
    ['an added file', () => writeFile(join(release, 'libextra.dylib'), 'extra')],
    ['a marker without its file list', async () => { const marker = await json(join(release, '.kipster-release.json')); delete marker.files; await writeFile(join(release, '.kipster-release.json'), JSON.stringify(marker)) }],
  ]
  for (const [index, [label, change]] of changes.entries()) {
    await change()
    assert.deepEqual(await installEmbeddingRuntime(home, options), installed, label)
    assert.equal(downloads(), index + 2, `${label} is downloaded again`)
    assert.equal(await run(installed.server.binary, []), 'fake llama-server', `${label} is repaired`)
    assert.equal((await stat(installed.server.binary)).mode & 0o777, 0o755)
    assert.equal(await readFile(join(release, 'libllama.0.1.dylib'), 'utf8'), 'shared library')
    assert.equal(await readlink(join(release, 'libllama.0.dylib')), 'libllama.0.1.dylib')
    assert.deepEqual((await readdir(release)).sort(), ['.kipster-release.json', 'libllama.0.1.dylib', 'libllama.0.dylib', 'llama-server'])
  }
  await installEmbeddingRuntime(home, options)
  assert.equal(downloads(), changes.length + 1, 'an intact release is reused')
})

test('rejects a checksum mismatch and leaves nothing behind', async t => {
  const home = await directory(t), { manifest, asset } = await fixture(t)
  const wrongServer = { ...manifest, server: { ...manifest.server, platforms: { 'darwin-arm64': { ...asset('server.tar.gz'), sha256: '0'.repeat(64) } } } }
  await assert.rejects(installEmbeddingRuntime(home, { manifest: wrongServer, platform: 'darwin', arch: 'arm64' }), /SHA-256 mismatch.*discarded/)
  assert.deepEqual(await readdir(join(home, 'embedding/llama.cpp')), [])
  const wrongModel = { ...manifest, model: { ...manifest.model, sha256: 'f'.repeat(64) } }
  await assert.rejects(installEmbeddingRuntime(home, { manifest: wrongModel, platform: 'darwin', arch: 'arm64' }), /SHA-256 mismatch/)
  assert.deepEqual(await readdir(join(home, 'embedding/models')), [])
  const destination = join(home, 'short.gguf')
  await assert.rejects(downloadVerified(manifest.model.url, destination, { ...manifest.model, size: 4 }), /Size mismatch/)
  await assert.rejects(downloadVerified(manifest.model.url.replace('model.gguf', 'absent'), destination, manifest.model), /HTTP 404/)
  await assert.rejects(downloadVerified('http://example.com/model.gguf', destination, manifest.model), /require HTTPS/)
  assert.deepEqual((await readdir(home)).filter(name => name !== 'embedding'), [])
  const misplaced = { ...manifest, server: { ...manifest.server, platforms: { 'darwin-arm64': asset('misplaced.tar.gz') } } }
  // The model failure above came after the server was installed; a bad archive keeps that release.
  await assert.rejects(installEmbeddingRuntime(home, { manifest: misplaced, platform: 'darwin', arch: 'arm64' }), /unexpected layout/)
  assert.deepEqual(await readdir(join(home, 'embedding/llama.cpp')), ['b0'])
  assert.equal(await run(join(home, 'embedding/llama.cpp/b0/llama-server'), []), 'fake llama-server')
})

test('a platform without a build reports memory search unavailable without downloading', async t => {
  const home = await directory(t), { manifest, requests } = await fixture(t)
  const result = await installEmbeddingRuntime(home, { manifest, platform: 'win32', arch: 'x64' })
  assert.equal(result.available, false)
  assert.match(result.reason, /no win32-x64 build.*memory search is unavailable on this platform/)
  assert.deepEqual(requests, [])
})

test('host.json names the embedding package only once its channel has released it', async () => {
  const config = { version: 1, home: '/tmp/home', adapters: [] }
  let installs = 0
  const runtime = { available: true, server: { binary: '/tmp/home/embedding/llama.cpp/b0/llama-server', model: '/tmp/home/embedding/models/m.gguf', modelSha256: 'a'.repeat(64), modelName: 'm', port: 43180 } }
  const unreleased = await withEmbedding(config, '/tmp/home', false, async () => { installs++; return runtime })
  assert.equal(unreleased.config, config); assert.equal(installs, 0)
  assert.match(unreleased.report, /no release on this channel yet; memory works without search/)
  const released = await withEmbedding(config, '/tmp/home', true, async () => runtime)
  assert.deepEqual(released, { config: { ...config, embedding: { module: '/tmp/home/current/node_modules/@kipster/embedding-llama-cpp/dist/index.js', options: {}, server: runtime.server } }, report: null })
  const kept = await withEmbedding({ ...config, embedding: { ...released.config.embedding, options: { timeoutMs: 5000 }, server: { ...runtime.server, port: 45000 } } }, '/tmp/home', true, async () => runtime)
  assert.deepEqual([kept.config.embedding.options, kept.config.embedding.server.port], [{ timeoutMs: 5000 }, 45000])
  const retired = await withEmbedding({ ...config, embedding: { module: '/tmp/home/current/node_modules/@kipster/embedding-retired/dist/index.js', options: { endpoint: 'http://127.0.0.1:1' } } }, '/tmp/home', true, async () => runtime)
  assert.deepEqual(retired.config.embedding.options, {})
  const unsupported = await withEmbedding(config, '/tmp/home', true, async () => ({ available: false, reason: 'unavailable on this platform' }))
  assert.deepEqual(unsupported, { config, report: 'unavailable on this platform' })
})

test('first install adds the verified runtime to host.json once the package is released, and installs without it before', { skip: noDatabase, timeout: 120000 }, async t => {
  const { manifest } = await fixture(t)
  for (const released of [false, true]) {
    const home = await directory(t), { databaseUrl } = await database(t)
    const catalog = await catalogs(t, { versions: ['0.1.0'], adapters: released ? ['codex-cli', 'embedding-llama-cpp'] : ['codex-cli'] })
    const { path, maintenancePath } = await configuration(t, home, databaseUrl)
    const result = await install({ home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }, { ...hooks, embedding: { manifest, platform: 'darwin', arch: 'arm64' } })
    assert.equal(result.update.state, 'done')
    const host = await json(join(home, 'host.json'))
    if (!released) {
      assert.equal(host.embedding, undefined)
      assert.match(result.embedding, /no release on this channel yet/)
      await assert.rejects(stat(join(home, 'embedding')), { code: 'ENOENT' })
      continue
    }
    assert.equal(result.embedding, undefined)
    assert.deepEqual(host.embedding, { module: join(home, 'current/node_modules/@kipster/embedding-llama-cpp/dist/index.js'), options: {}, server: { binary: join(home, 'embedding/llama.cpp/b0/llama-server'), model: join(home, 'embedding/models/fixture-Q8_0.gguf'), modelSha256: manifest.model.sha256, modelName: 'fixture-Q8_0', port: 43180 } })
    assert.deepEqual((await json(join(home, 'current/release.json'))).packages.map(item => item.package).sort(), ['@kipster/codex-cli', '@kipster/core', '@kipster/embedding-llama-cpp'])
  }
})
