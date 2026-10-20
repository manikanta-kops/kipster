import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appEnvironment } from '../local-app.mjs'
import { configuration, localPluginServer } from '../local-backend.mjs'
import { exists, initializeHome, locked } from '../local-common.mjs'

test('app build disables ambient development-server configuration', () => {
  const env = appEnvironment({
    PATH: '/bin',
    TAURI_CONFIG: '{"identifier":"wrong"}',
    CARGO_TARGET_DIR: '/tmp/wrong',
  })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.TAURI_CONFIG, undefined)
  assert.equal(env.CARGO_TARGET_DIR, undefined)
})

test('regenerating host configuration preserves user settings and isolates database/provider state', () => {
  const old = {
    listen: {
      host: '127.0.0.1',
      port: 43121,
      allowedHosts: [],
      allowedOrigins: ['tauri://localhost'],
    },
    embedding: {
      module: '/installed/embedding/dist/index.js',
      options: { endpoint: 'http://127.0.0.1:11434', model: 'saved-model' },
    },
    environment: { CUSTOM: 'saved' },
    adapters: [{ id: 'other', root: '/somewhere', entry: 'index.js' }],
  }
  const config = configuration('/tmp/kip ster', '/tmp/new-build', old)
  assert.deepEqual(config.listen, old.listen)
  assert.deepEqual(config.embedding, old.embedding)
  assert.equal(config.adapters[0].root, '/tmp/new-build')
  assert.deepEqual(config.adapters[2], old.adapters[0])
  assert.equal(config.environment.CUSTOM, 'saved')
  assert.equal(config.adapters[0].config, undefined)
  const url = new URL(config.databaseUrl)
  assert.equal(url.searchParams.get('host'), '/tmp/kip ster/pg-socket')
  assert.equal(new URL(config.taskDataUrl).username, 'kipster_task')
})

test('development home refuses unrelated data and concurrent startup preserves the first lock', async (t) => {
  const home = await mkdtemp('/tmp/kipster-launch-test-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'keep.txt'), 'unrelated')
  await assert.rejects(initializeHome(home), /unrecognized/)
  assert.equal(await readFile(join(home, 'keep.txt'), 'utf8'), 'unrelated')
  await rm(join(home, 'keep.txt'))
  await locked(join(home, '.command-lock'), async () => {
    await initializeHome(home)
    await assert.rejects(
      locked(join(home, '.command-lock'), async () => {}),
      /Another command/,
    )
    assert.equal(await exists(join(home, '.command-lock')), true)
  })
  assert.equal(await exists(join(home, '.command-lock')), false)
  assert.deepEqual(await initializeHome(home), {
    kind: 'kipster-development',
    version: 1,
  })
})

test('regenerating the install preserves adapter-owned settings', () => {
  const custom = {
    codexHome: '/absolute/custom/home',
    executable: '/absolute/custom/codex',
    environment: { PLUGIN_OPTION: 'value' },
  }
  const saved = {
    adapters: [
      { id: 'codex-cli', root: '/old', entry: 'old.js', config: custom },
    ],
  }
  const next = configuration('/tmp/kipster', '/new', saved)
  assert.deepEqual(
    next.adapters.map((adapter) => adapter.id),
    ['codex-cli', 'claude-cli'],
    'Codex stays the default adapter',
  )
  assert.equal(next.adapters[0].root, '/new')
  assert.deepEqual(next.adapters[0].config, custom)
  assert.deepEqual(next.adapters[1], {
    id: 'claude-cli',
    root: '/new',
    entry: 'node_modules/@kipster/claude-cli/dist/index.js',
  })
})

test('a downloaded embedding runtime replaces the embedding entry and keeps its chosen port', () => {
  const runtime = {
    binary: '/tmp/kipster/embedding/llama.cpp/b11565/llama-server',
    model: '/tmp/kipster/embedding/models/embeddinggemma-2-Q8_0.gguf',
    modelSha256: 'a'.repeat(64),
    modelName: 'embeddinggemma-2-Q8_0',
    port: 43180,
  }
  const first = configuration(
    '/tmp/kipster',
    '/new',
    {
      embedding: {
        module: '/old/provider.js',
        options: { endpoint: 'http://127.0.0.1:1' },
      },
    },
    runtime,
  )
  assert.deepEqual(first.embedding, {
    module: '/new/node_modules/@kipster/embedding-llama-cpp/dist/index.js',
    options: {},
    server: runtime,
  })
  const moved = configuration(
    '/tmp/kipster',
    '/newer',
    {
      embedding: {
        ...first.embedding,
        options: { timeoutMs: 5000 },
        server: { ...runtime, port: 45000 },
      },
    },
    runtime,
  )
  assert.deepEqual(
    [
      moved.embedding.module,
      moved.embedding.options,
      moved.embedding.server.port,
    ],
    [
      '/newer/node_modules/@kipster/embedding-llama-cpp/dist/index.js',
      { timeoutMs: 5000 },
      45000,
    ],
  )
})

test('development hosts run the repository plugin server when it is installed', async () => {
  assert.match(
    localPluginServer,
    /\/node_modules\/@kipster\/plugins\/dist\/server\/cli\.js$/,
  )
  assert.equal(
    await exists(localPluginServer),
    true,
    'npm ci installs @kipster/plugins',
  )
  const config = configuration(
    '/tmp/kipster',
    '/new',
    {},
    undefined,
    localPluginServer,
  )
  assert.deepEqual(config.plugins, { module: localPluginServer })
  assert.equal(configuration('/tmp/kipster', '/new').plugins, undefined)
  assert.deepEqual(
    configuration('/tmp/kipster', '/newer', config).plugins,
    { module: localPluginServer },
    'a saved entry is kept',
  )
})

test('development transcription downloads only explicitly, verifies reuse, and refreshes installation paths', async (t) => {
  const { developmentTranscription } = await import('../local-backend.mjs')
  const { createHash } = await import('node:crypto')
  const { mkdir } = await import('node:fs/promises')
  const home = await mkdtemp('/tmp/kipster-transcription-test-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const bytes = Buffer.from('verified model'),
    model = join(home, 'transcription/models/test.gguf')
  const manifest = {
    model: {
      file: 'test.gguf',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  }
  let downloads = 0
  const install = async () => {
    downloads++
    return {
      available: true,
      options: { model, modelSha256: manifest.model.sha256 },
    }
  }
  assert.equal(
    await developmentTranscription(home, { manifest, install }),
    undefined,
  )
  assert.equal(downloads, 0)
  await mkdir(join(home, 'transcription/models'), { recursive: true })
  await writeFile(model, bytes)
  const options = await developmentTranscription(home, { manifest, install })
  assert.deepEqual(options, { model, modelSha256: manifest.model.sha256 })
  await writeFile(model, Buffer.from('corrupt! model'))
  assert.equal(
    await developmentTranscription(home, { manifest, install }),
    undefined,
  )
  await developmentTranscription(home, { manifest, install, download: true })
  assert.equal(downloads, 1)
  assert.equal(
    await developmentTranscription(home, {
      manifest,
      download: true,
      install: async () => ({ available: false, reason: 'unsupported' }),
    }),
    undefined,
  )
  const previous = {
    transcription: {
      module:
        '/old/node_modules/@kipster/transcription-transcribe-cpp/dist/index.js',
      options: { timeoutMs: 5000, model: '/old/model' },
    },
  }
  const config = configuration(
    home,
    '/new',
    previous,
    undefined,
    undefined,
    options,
  )
  assert.deepEqual(config.transcription, {
    module:
      '/new/node_modules/@kipster/transcription-transcribe-cpp/dist/index.js',
    options: { timeoutMs: 5000, ...options },
  })
  assert.deepEqual(
    configuration(home, '/new', previous).transcription,
    previous.transcription,
  )
})
