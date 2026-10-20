import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { version } from 'transcribe-cpp'
import { createTranscriptionProvider } from '../dist/index.js'
import { createProvider } from '../dist/provider.js'
import { configuration } from '../dist/config.js'
import { modelConfig, input, wav } from './helpers.mjs'

const ultra = '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59'
const fakeWorker = new URL('./fixtures/worker.mjs', import.meta.url)
async function fixture(t, options = {}) {
  const config = await modelConfig(t, options)
  const provider = createProvider(config, fakeWorker)
  t.after(() => provider.close())
  const path = (mode) => join(dirname(config.model), mode)
  const calls = async () => {
    try {
      return (await readFile(path('calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
    } catch (e) {
      if (e.code === 'ENOENT') return []
      throw e
    }
  }
  const waitForCalls = async (count) => {
    for (let i = 0; i < 500; i++) {
      const found = await calls()
      if (found.length >= count) return found
      await delay(10)
    }
    assert.fail('worker never received request')
  }
  return { provider, path, calls, waitForCalls, config }
}
const unavailable = (reason) => ({
  status: 'unavailable',
  reason,
  provider: 'transcribe-cpp',
})
function dead(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

test('native transcribe-cpp 0.4.0 binding loads on the pinned Node runtime', () => {
  assert.equal(version().version, '0.4.0')
})
test('options require an absolute model, SHA-256, known or explicit size, and bounded integer timeout', () => {
  const base = { model: '/tmp/model.gguf', modelSha256: ultra }
  for (const options of [
    null,
    [],
    1,
    {},
    { ...base, model: 'relative' },
    { ...base, model: '/bad\0path' },
    { ...base, modelSha256: 'x'.repeat(64) },
    { ...base, modelSha256: 'a'.repeat(63) },
    ...[0, -1, 1.2, '20', Infinity, 600001].map((timeoutMs) => ({
      ...base,
      timeoutMs,
    })),
    ...[0, -1, 1.2, '20', Infinity, 1].map((modelSize) => ({
      ...base,
      modelSize,
    })),
    { ...base, modelSha256: 'a'.repeat(64) },
  ])
    assert.throws(() => createTranscriptionProvider(options))
  assert.deepEqual(
    configuration({ ...base, modelSha256: ultra.toUpperCase() }),
    { ...base, modelSize: 740363168, timeoutMs: 60000 },
  )
  assert.equal(
    configuration({
      ...base,
      modelSha256: 'a'.repeat(64),
      modelSize: 12,
      timeoutMs: 1,
    }).modelSize,
    12,
  )
})
test('readiness checks missing/wrong-size models without starting the worker or loading native metadata', async (t) => {
  const { provider, config, calls } = await fixture(t)
  assert.deepEqual(await provider.readiness(), { ready: true })
  await writeFile(config.model, 'wrong')
  assert.equal((await provider.readiness()).ready, false)
  await rm(config.model)
  assert.equal((await provider.readiness()).ready, false)
  assert.deepEqual(await calls(), [])
  await provider.close()
  assert.equal((await provider.readiness()).ready, false)
})
test('contract, trimmed text and a single persistent worker for repeated requests', async (t) => {
  const { provider, path } = await fixture(t)
  assert.equal(provider.id, 'transcribe-cpp')
  assert.equal(provider.contractMajor, 1)
  assert.deepEqual(provider.inputTypes, ['audio/wav'])
  const first = await provider.transcribe(input(path('ok')))
  assert.equal(first.status, 'succeeded')
  assert.match(first.text, /^\d+$/)
  assert.equal(first.provider, 'transcribe-cpp')
  assert.deepEqual(await provider.transcribe(input(path('ok'))), first)
})
for (const mode of ['empty', 'whitespace'])
  test(`${mode} transcript is no-speech`, async (t) => {
    const { provider, path } = await fixture(t)
    assert.deepEqual(await provider.transcribe(input(path(mode))), {
      status: 'no-speech',
      text: '',
      provider: 'transcribe-cpp',
    })
  })
test('timeout kills a busy child and a later call gets a new worker', async (t) => {
  const { provider, path, waitForCalls } = await fixture(t, { timeoutMs: 1000 })
  assert.deepEqual(
    await provider.transcribe(input(path('hold'))),
    unavailable('timeout'),
  )
  const [first] = await waitForCalls(1)
  const next = await provider.transcribe(input(path('ok')))
  assert.equal(next.status, 'succeeded')
  assert.notEqual(Number(next.text), first.pid)
  dead(first.pid)
})
test('abort kills a busy child, returns cancelled and releases the next call', async (t) => {
  const { provider, path, waitForCalls } = await fixture(t)
  const controller = new AbortController()
  const pending = provider.transcribe(
    input(path('hold'), { signal: controller.signal }),
  )
  const [first] = await waitForCalls(1)
  controller.abort()
  assert.deepEqual(await pending, unavailable('cancelled'))
  const next = await provider.transcribe(input(path('ok')))
  assert.equal(next.status, 'succeeded')
  assert.notEqual(Number(next.text), first.pid)
  dead(first.pid)
})
test('already aborted and queued aborted inputs do not reach the worker or cancel another request', async (t) => {
  const { provider, path, calls, waitForCalls } = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(
    await provider.transcribe(input(path('ok'), { signal: controller.signal })),
    unavailable('cancelled'),
  )
  const running = provider.transcribe(input(path('slow')))
  await waitForCalls(1)
  const queuedAbort = new AbortController()
  const queued = provider.transcribe(
    input(path('ok'), { signal: queuedAbort.signal }),
  )
  queuedAbort.abort()
  assert.deepEqual(await queued, unavailable('cancelled'))
  assert.equal((await running).status, 'succeeded')
  assert.equal((await calls()).length, 1)
})
test('queue waiting counts toward timeout and does not start expired jobs', async (t) => {
  const { provider, path, calls } = await fixture(t, { timeoutMs: 200 })
  const results = await Promise.all([
    provider.transcribe(input(path('hold'))),
    provider.transcribe(input(path('ok'))),
  ])
  assert.deepEqual(results, [unavailable('timeout'), unavailable('timeout')])
  assert.equal((await calls()).length, 1)
})
for (const mode of ['die', 'malformed'])
  test(`${mode} worker returns provider-error and is replaced`, async (t) => {
    const { provider, path, waitForCalls } = await fixture(t)
    assert.deepEqual(
      await provider.transcribe(input(path(mode))),
      unavailable('provider-error'),
    )
    const [first] = await waitForCalls(1)
    const next = await provider.transcribe(input(path('ok')))
    assert.equal(next.status, 'succeeded')
    assert.notEqual(Number(next.text), first.pid)
    dead(first.pid)
  })
test('an invalid worker path returns provider-error', async (t) => {
  const provider = createProvider(
    await modelConfig(t),
    new URL('./missing.mjs', import.meta.url),
  )
  t.after(() => provider.close())
  assert.deepEqual(
    await provider.transcribe(input('/tmp/valid.wav')),
    unavailable('provider-error'),
  )
})
test('concurrent requests are FIFO, one at a time in the same child', async (t) => {
  const { provider, path, calls } = await fixture(t)
  const results = await Promise.all(
    ['slow', 'ok', 'slow', 'ok'].map((mode) =>
      provider.transcribe(input(path(mode))),
    ),
  )
  assert.ok(results.every((result) => result.status === 'succeeded'))
  assert.equal(new Set(results.map((result) => result.text)).size, 1)
  assert.deepEqual(
    (await calls()).map((call) => [call.mode, call.busy]),
    [
      ['slow', false],
      ['ok', false],
      ['slow', false],
      ['ok', false],
    ],
  )
})
for (const busy of [false, true])
  test(`close ends the ${busy ? 'busy' : 'idle'} child and settles queued calls`, async (t) => {
    const { provider, path, waitForCalls } = await fixture(t)
    const first = provider.transcribe(input(path(busy ? 'hold' : 'ok')))
    const [call] = await waitForCalls(1)
    if (!busy) await first
    const queued = busy ? provider.transcribe(input(path('ok'))) : undefined
    await Promise.all([provider.close(), provider.close()])
    if (busy) assert.deepEqual(await first, unavailable('cancelled'))
    if (queued) assert.deepEqual(await queued, unavailable('cancelled'))
    dead(call.pid)
    assert.deepEqual(
      await provider.transcribe(input(path('ok'))),
      unavailable('provider-error'),
    )
  })
test('bad metadata is invalid-input before starting a child', async (t) => {
  const { provider, path, calls } = await fixture(t)
  for (const options of [
    { path: 'relative' },
    { size: 0 },
    { size: -1 },
    { size: 100 * 1024 * 1024 + 1 },
    { size: 1.5 },
    { mimeType: 'audio/mpeg' },
  ]) {
    assert.deepEqual(
      await provider.transcribe(input(path('ok'), options)),
      unavailable('invalid-input'),
    )
  }
  assert.deepEqual(await calls(), [])
})
test('real worker rejects malformed WAV, missing audio and a changed model hash without inference', async (t) => {
  const config = await modelConfig(t)
  const provider = createTranscriptionProvider(config)
  t.after(() => provider.close())
  const path = join(dirname(config.model), 'input.wav')
  for (const bytes of [
    Buffer.from('not a wave file'),
    wav({ channels: 2 }),
    wav({ rate: 44100 }),
    wav({ bits: 8 }),
    wav({ format: 3 }),
  ]) {
    await writeFile(path, bytes)
    assert.deepEqual(
      await provider.transcribe(input(path, { size: bytes.length })),
      unavailable('invalid-input'),
    )
  }
  await rm(path)
  assert.deepEqual(
    await provider.transcribe(input(path)),
    unavailable('invalid-input'),
  )
  const bytes = wav()
  await writeFile(path, bytes)
  assert.deepEqual(
    await provider.transcribe(input(path, { size: 1 })),
    unavailable('invalid-input'),
  )
  await writeFile(config.model, 'same size!')
  assert.equal((await provider.readiness()).ready, true)
  assert.deepEqual(
    await provider.transcribe(input(path, { size: bytes.length })),
    unavailable('provider-error'),
  )
  await writeFile(config.model, 'short')
  assert.deepEqual(
    await provider.transcribe(input(path, { size: bytes.length })),
    unavailable('provider-error'),
  )
})
test('real worker returns no-speech for an empty WAV without loading a model', async (t) => {
  const config = await modelConfig(t)
  const provider = createTranscriptionProvider(config)
  t.after(() => provider.close())
  const path = join(dirname(config.model), 'empty.wav'),
    bytes = wav({ samples: [] })
  await writeFile(path, bytes)
  assert.deepEqual(
    await provider.transcribe(input(path, { size: bytes.length })),
    { status: 'no-speech', text: '', provider: 'transcribe-cpp' },
  )
})
