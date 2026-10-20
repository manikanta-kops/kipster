import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  transcriptionPackage,
  transcriptionRuntime,
  installTranscriptionRuntime,
  withTranscription,
} from '../src/transcription.mjs'
import { install } from '../src/installer.mjs'
import { json } from '../src/files.mjs'
import {
  catalogs,
  configuration,
  database,
  directory,
  hooks,
  noDatabase,
} from './support.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  let bytes = Buffer.from('tiny fake speech model')
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const model = () => ({
    name: 'fixture-Q8_0',
    file: 'fixture.gguf',
    url: `http://127.0.0.1:${server.address().port}/model.gguf`,
    size: bytes.length,
    sha256: sha256(bytes),
  })
  return {
    manifest: { platforms: transcriptionRuntime.platforms, model: model() },
    requests,
    change: () => {
      bytes = Buffer.from('new pinned speech model')
      return model()
    },
  }
}

test('pins Parakeet Ultra Q8_0 and the native platforms', () => {
  assert.equal(transcriptionPackage, '@kipster/transcription-transcribe-cpp')
  assert.deepEqual(transcriptionRuntime.platforms, [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  assert.deepEqual(transcriptionRuntime.model, {
    name: 'Parakeet Ultra Q8_0',
    file: 'parakeet-ultra-Q8_0.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf',
    size: 740363168,
    sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
  })
})

test('downloads privately, reuses verified bytes, and repairs a corrupted model', async (t) => {
  const home = await directory(t),
    { manifest, requests } = await fixture(t)
  const options = { manifest, platform: 'linux', arch: 'arm64' }
  const result = await installTranscriptionRuntime(home, options)
  assert.deepEqual(result, {
    available: true,
    options: {
      model: join(home, 'transcription/models/fixture.gguf'),
      modelSha256: manifest.model.sha256,
    },
  })
  assert.equal(
    await readFile(result.options.model, 'utf8'),
    'tiny fake speech model',
  )
  for (const path of ['transcription', 'transcription/models'])
    assert.equal((await stat(join(home, path))).mode & 0o777, 0o700)
  assert.equal((await stat(result.options.model)).mode & 0o777, 0o600)
  assert.deepEqual(await installTranscriptionRuntime(home, options), result)
  assert.deepEqual(requests, ['/model.gguf'])
  await writeFile(result.options.model, 'tiny fake speech modeX')
  await installTranscriptionRuntime(home, options)
  assert.equal(
    await readFile(result.options.model, 'utf8'),
    'tiny fake speech model',
  )
  assert.equal(requests.length, 2)
  assert.deepEqual(await readdir(join(home, 'transcription/models')), [
    'fixture.gguf',
  ])
})

test('downloads again when the pinned model changes', async (t) => {
  const home = await directory(t),
    f = await fixture(t)
  const options = { manifest: f.manifest, platform: 'darwin', arch: 'x64' }
  await installTranscriptionRuntime(home, options)
  f.manifest.model = f.change()
  const result = await installTranscriptionRuntime(home, options)
  assert.equal(result.options.modelSha256, f.manifest.model.sha256)
  assert.equal(
    await readFile(result.options.model, 'utf8'),
    'new pinned speech model',
  )
  assert.equal(f.requests.length, 2)
})

for (const field of ['sha256', 'size'])
  test(`rejects a ${field} mismatch without leaving a partial model`, async (t) => {
    const home = await directory(t),
      { manifest } = await fixture(t)
    manifest.model[field] = field === 'sha256' ? '0'.repeat(64) : 1
    await assert.rejects(
      installTranscriptionRuntime(home, {
        manifest,
        platform: 'linux',
        arch: 'x64',
      }),
      /mismatch/,
    )
    assert.deepEqual(await readdir(join(home, 'transcription/models')), [])
  })

test('skips unsupported platforms without creating directories or downloading', async (t) => {
  const home = await directory(t),
    { manifest, requests } = await fixture(t)
  const result = await installTranscriptionRuntime(home, {
    manifest,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal(result.available, false)
  assert.match(result.reason, /no win32-x64 native package.*unavailable/)
  assert.deepEqual(requests, [])
  await assert.rejects(stat(join(home, 'transcription')), { code: 'ENOENT' })
})

test('gates host.json on the channel release and model, and refreshes model options', async () => {
  const config = { version: 1, home: '/tmp/home', adapters: [] }
  const runtime = {
    available: true,
    options: {
      model: '/tmp/home/transcription/models/model.gguf',
      modelSha256: 'a'.repeat(64),
    },
  }
  let installs = 0
  const unreleased = await withTranscription(
    config,
    config.home,
    false,
    async () => {
      installs++
      return runtime
    },
  )
  assert.deepEqual(unreleased.config, config)
  assert.equal(installs, 0)
  assert.match(unreleased.report, /no release on this channel yet/)
  const result = await withTranscription(
    config,
    config.home,
    true,
    async () => runtime,
  )
  assert.deepEqual(result.config, {
    ...config,
    transcription: {
      module:
        '/tmp/home/current/node_modules/@kipster/transcription-transcribe-cpp/dist/index.js',
      options: runtime.options,
    },
  })
  assert.match(result.report, /model.*verified/)
  const prior = {
    ...config,
    transcription: {
      ...result.config.transcription,
      options: { model: '/old/model', modelSha256: 'old', timeoutMs: 5000 },
    },
  }
  assert.deepEqual(
    (await withTranscription(prior, config.home, true, async () => runtime))
      .config.transcription.options,
    { ...runtime.options, timeoutMs: 5000 },
  )
  assert.deepEqual(
    (await withTranscription(prior, config.home, false, async () => runtime))
      .config,
    config,
  )
  assert.deepEqual(
    await withTranscription(prior, config.home, true, async () => ({
      available: false,
      reason: 'unsupported platform',
    })),
    { config, report: 'unsupported platform' },
  )
})

test(
  'first install writes the exact released provider entry and succeeds without unavailable transcription',
  { skip: noDatabase, timeout: 180000 },
  async (t) => {
    const catalog = await catalogs(t, {
      versions: ['0.1.0'],
      adapters: ['codex-cli', 'transcription-transcribe-cpp'],
    })
    const speechRelease = catalog.catalogs.stable.packages[transcriptionPackage]
    delete catalog.catalogs.stable.packages[transcriptionPackage]
    for (const scenario of [
      'unreleased',
      'released',
      'unsupported',
      'checksum',
    ])
      await t.test(scenario, async (t) => {
        const home = await directory(t),
          { databaseUrl } = await database(t),
          { manifest, requests } = await fixture(t)
        if (scenario !== 'unreleased')
          catalog.catalogs.stable.packages[transcriptionPackage] = speechRelease
        if (scenario === 'checksum') manifest.model.sha256 = 'f'.repeat(64)
        const { path, maintenancePath } = await configuration(
          t,
          home,
          databaseUrl,
        )
        const result = await install(
          {
            home,
            config: path,
            maintenanceConfig: maintenancePath,
            catalog: catalog.base,
            noLaunchd: true,
            healthTimeout: 1000,
          },
          {
            ...hooks,
            transcription: {
              manifest,
              platform: scenario === 'unsupported' ? 'win32' : 'darwin',
              arch: 'arm64',
            },
          },
        )
        assert.equal(result.update.state, 'done')
        const host = await json(join(home, 'host.json'))
        const packages = (
          await json(join(home, 'current/release.json'))
        ).packages.map((p) => p.package)
        if (scenario === 'released') {
          assert.deepEqual(host.transcription, {
            module: join(
              home,
              'current/node_modules/@kipster/transcription-transcribe-cpp/dist/index.js',
            ),
            options: {
              model: join(home, 'transcription/models/fixture.gguf'),
              modelSha256: manifest.model.sha256,
            },
          })
          assert.ok(packages.includes(transcriptionPackage))
          assert.match(result.transcription, /verified/)
        } else {
          assert.equal(host.transcription, undefined)
          assert.ok(!packages.includes(transcriptionPackage))
          assert.match(
            result.transcription,
            /no release|no win32-arm64 native package|could not be installed.*mismatch/,
          )
          if (scenario === 'checksum') {
            assert.deepEqual(
              await readdir(join(home, 'transcription/models')),
              [],
            )
            assert.match(
              await readFile(join(home, 'logs/installer-error.log'), 'utf8'),
              /transcription model could not be installed/,
            )
          } else assert.deepEqual(requests, [])
        }
      })
  },
)
