import { open } from 'node:fs/promises'

export const maxInputBytes = 100 * 1024 * 1024

/** Decode only 16 kHz mono signed 16-bit PCM RIFF/WAVE; no resampling. */
export async function readWav(path: string): Promise<Float32Array> {
  const file = await open(path, 'r')
  let bytes: Buffer
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 12 || info.size > maxInputBytes)
      throw new Error('Invalid WAV size')
    bytes = await file.readFile()
  } finally {
    await file.close()
  }
  const invalid = () => {
    throw new Error('Expected 16 kHz mono 16-bit PCM RIFF/WAVE')
  }
  if (
    bytes.length < 12 ||
    bytes.toString('latin1', 0, 4) !== 'RIFF' ||
    bytes.toString('latin1', 8, 12) !== 'WAVE' ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    invalid()
  let format = false
  let data: Buffer | undefined
  let offset = 12
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalid()
    const kind = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8,
      end = start + size
    if (end + (size % 2) > bytes.length) invalid()
    if (kind === 'fmt ') {
      if (
        format ||
        size < 16 ||
        bytes.readUInt16LE(start) !== 1 ||
        bytes.readUInt16LE(start + 2) !== 1 ||
        bytes.readUInt32LE(start + 4) !== 16000 ||
        bytes.readUInt32LE(start + 8) !== 32000 ||
        bytes.readUInt16LE(start + 12) !== 2 ||
        bytes.readUInt16LE(start + 14) !== 16
      )
        invalid()
      format = true
    } else if (kind === 'data') {
      if (data || size % 2 !== 0) invalid()
      data = bytes.subarray(start, end)
    }
    offset = end + (size % 2)
  }
  if (!format || !data) return invalid()
  const samples = new Float32Array(data.length / 2)
  for (let i = 0; i < samples.length; i++)
    samples[i] = data.readInt16LE(i * 2) / 32768
  return samples
}
