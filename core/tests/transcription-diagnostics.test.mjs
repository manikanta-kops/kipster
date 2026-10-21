import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { doctor } from '../dist/host.js'

async function fixture(t) {
  const home = await mkdtemp('/tmp/ktd-')
  t.after(() => rm(home, { recursive: true, force: true }))
  const model = join(home, 'parakeet.gguf'),
    module = join(home, 'provider.mjs'),
    calls = join(home, 'calls')
  await writeFile(model, 'fixture')
  const config = {
    version: 1,
    home,
    databaseUrl: 'postgresql://unused@127.0.0.1:1/unused',
    listen: { host: '127.0.0.1', port: 0 },
    adapters: [],
    transcription: { module, options: { model } },
  }
  return { config, model, module, calls }
}
const row = (rows) => rows.find((r) => r.check === 'transcription')

test('passive doctor names a readable model without importing the provider', async (t) => {
  const { config, module } = await fixture(t)
  await writeFile(
    module,
    "throw Error('Passive doctor must not import this module')",
  )
  const rows = await doctor(config)
  assert.equal(row(rows).status, 'ok')
  assert.match(
    row(rows).message,
    /parakeet.gguf.*present and readable.*not probed/,
  )
  assert.ok(!rows.some((r) => r.check === 'transcription-probe'))
})

test('passive doctor reports missing, unreadable and non-file models with a reinstall hint', async (t) => {
  const { config, model } = await fixture(t)
  await chmod(model, 0o000)
  assert.equal(row(await doctor(config)).status, 'unavailable')
  await rm(model)
  for (const path of [model, config.home]) {
    config.transcription.options.model = path
    const result = row(await doctor(config))
    assert.equal(result.status, 'unavailable')
    assert.match(result.message, /missing or unreadable.*Reinstall/)
  }
})

test('unconfigured and generic providers retain passive diagnostic rows', async (t) => {
  const { config } = await fixture(t)
  config.transcription.options = {}
  assert.equal(row(await doctor(config)).status, 'not-probed')
  delete config.transcription
  assert.equal(row(await doctor(config)).status, 'not-configured')
})

for (const ready of [true, false])
  test(`explicit doctor probe reports readiness ${ready} and closes without transcribing`, async (t) => {
    const { config, module, calls } = await fixture(t)
    await writeFile(
      module,
      `import { appendFileSync } from 'node:fs';
const record = text => appendFileSync(${JSON.stringify(calls)}, text + '\\n');
record('import');
export function createTranscriptionProvider(options) {
  if (options.model !== ${JSON.stringify(config.transcription.options.model)}) throw Error('Model not passed');
  record('create');
  return { id: 'transcribe-cpp', contractMajor: 1, inputTypes: ['audio/wav'],
    readiness: async () => { record('readiness'); return { ready: ${ready} }; },
    transcribe: async () => { record('transcribe'); throw Error('Never transcribe in doctor'); },
    close: async () => record('close') };
}`,
    )
    await doctor(config)
    await assert.rejects(stat(calls), { code: 'ENOENT' })
    const rows = await doctor(config, true)
    const probe = rows.find((r) => r.check === 'transcription-probe')
    assert.equal(probe.status, ready ? 'ok' : 'unavailable')
    assert.match(probe.message, /readiness check completed; no audio recorded/)
    assert.equal(
      await readFile(calls, 'utf8'),
      'import\ncreate\nreadiness\nclose\n',
    )
  })

test('an explicit probe reports a missing provider module as unavailable', async (t) => {
  const { config } = await fixture(t)
  const rows = await doctor(config, true)
  assert.equal(row(rows).status, 'ok')
  assert.equal(
    rows.find((r) => r.check === 'transcription-probe').status,
    'unavailable',
  )
})
