import { readFile } from 'node:fs/promises'

/** Length of a say-generated WAV, including any metadata chunks. */
export async function recordingDuration(path) {
  const bytes = await readFile(path)
  if (
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw Error('VOICE_WAV must be a RIFF WAV')
  let pcm = false,
    size
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > bytes.length) throw Error('Truncated WAV chunk')
    if (kind === 'fmt ' && length >= 16)
      pcm =
        bytes.readUInt16LE(start) === 1 &&
        bytes.readUInt16LE(start + 2) === 1 &&
        bytes.readUInt32LE(start + 4) === 16000 &&
        bytes.readUInt16LE(start + 14) === 16
    if (kind === 'data') size = length
    offset = start + length + (length % 2)
  }
  if (!pcm || !size)
    throw Error('VOICE_WAV must contain 16 kHz mono 16-bit PCM')
  const duration = Math.ceil(size / 32) + 500
  if (duration > 120000)
    throw Error('VOICE_WAV must be shorter than two minutes')
  return duration
}
