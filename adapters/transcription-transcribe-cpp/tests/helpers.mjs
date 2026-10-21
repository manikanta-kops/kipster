import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

export function chunk(name, bytes) {
  const head = Buffer.alloc(8)
  head.write(name)
  head.writeUInt32LE(bytes.length, 4)
  return Buffer.concat([
    head,
    bytes,
    ...(bytes.length % 2 ? [Buffer.alloc(1)] : []),
  ])
}
export function wav({
  format = 1,
  channels = 1,
  rate = 16000,
  bits = 16,
  samples = [-32768, -1, 0, 1, 32767],
  extras = [],
} = {}) {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(format, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(rate, 4)
  fmt.writeUInt32LE((rate * channels * bits) / 8, 8)
  fmt.writeUInt16LE((channels * bits) / 8, 12)
  fmt.writeUInt16LE(bits, 14)
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, i) => data.writeInt16LE(sample, i * 2))
  return riff([chunk('fmt ', fmt), ...extras, chunk('data', data)])
}
export function riff(chunks) {
  const body = Buffer.concat([Buffer.from('WAVE'), ...chunks])
  const header = Buffer.alloc(8)
  header.write('RIFF')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}
export async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'kipster-transcription-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
export async function modelConfig(t, extra = {}) {
  const path = await directory(t)
  const bytes = Buffer.from('fake model')
  const model = join(path, 'model.gguf')
  await writeFile(model, bytes)
  return {
    model,
    modelSha256: createHash('sha256').update(bytes).digest('hex'),
    modelSize: bytes.length,
    ...extra,
  }
}
export const input = (path, extra = {}) => ({
  path,
  size: 54,
  mimeType: 'audio/wav',
  signal: new AbortController().signal,
  ...extra,
})
