import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readWav } from '../dist/wav.js'
import { directory, wav, chunk, riff } from './helpers.mjs'

async function read(t, bytes) {
  const path = join(await directory(t), 'input.wav')
  await writeFile(path, bytes)
  return readWav(path)
}
test('16 kHz mono PCM converts int16 to Float32 samples with padded metadata chunks', async (t) => {
  const samples = await read(
    t,
    wav({ extras: [chunk('JUNK', Buffer.from('x'))] }),
  )
  assert.ok(samples instanceof Float32Array)
  assert.deepEqual([...samples], [-1, -1 / 32768, 0, 1 / 32768, 32767 / 32768])
})
test('zero PCM samples form a valid empty recording', async (t) => {
  assert.equal((await read(t, wav({ samples: [] }))).length, 0)
})
for (const [name, options] of [
  ['stereo', { channels: 2 }],
  ['44.1 kHz', { rate: 44100 }],
  ['8-bit', { bits: 8 }],
  ['float WAV', { format: 3, bits: 32 }],
  ['extensible WAV', { format: 65534 }],
])
  test(`rejects ${name}`, async (t) => {
    await assert.rejects(read(t, wav(options)))
  })
for (const [name, make] of [
  ['non-RIFF', () => Buffer.from('not a WAV file')],
  [
    'wrong WAVE signature',
    () => {
      const b = wav()
      b.write('AVI ', 8)
      return b
    },
  ],
  [
    'high-bit RIFF lookalike',
    () => {
      const b = wav()
      b[0] |= 128
      return b
    },
  ],
  ['truncated header', () => wav().subarray(0, 10)],
  ['truncated data', () => wav().subarray(0, -1)],
  [
    'chunk exceeding container',
    () => {
      const b = wav()
      b.writeUInt32LE(500, 40)
      return b
    },
  ],
  ['partial chunk header', () => riff([Buffer.alloc(3)])],
  ['missing format', () => riff([chunk('data', Buffer.alloc(2))])],
  [
    'missing data',
    () =>
      wav()
        .subarray(0, 36)
        .map((b, i) => (i === 4 ? 28 : b)),
  ],
  [
    'odd sample bytes',
    () => riff([wav().subarray(12, 36), chunk('data', Buffer.alloc(1))]),
  ],
  [
    'short format',
    () =>
      riff([chunk('fmt ', Buffer.alloc(10)), chunk('data', Buffer.alloc(2))]),
  ],
  [
    'duplicate data',
    () => riff([wav().subarray(12), chunk('data', Buffer.alloc(2))]),
  ],
  [
    'duplicate format',
    () => riff([wav().subarray(12, 36), wav().subarray(12)]),
  ],
  [
    'wrong byte rate',
    () => {
      const b = wav()
      b.writeUInt32LE(1, 28)
      return b
    },
  ],
  [
    'wrong block alignment',
    () => {
      const b = wav()
      b.writeUInt16LE(4, 32)
      return b
    },
  ],
])
  test(`rejects ${name}`, async (t) => {
    await assert.rejects(read(t, make()))
  })
