import { spawn } from 'node:child_process'

/** Two hours of 16 kHz mono 16-bit PCM. */
export const maxDecodedBytes = 2 * 60 * 60 * 16000 * 2

export class DecodedTooLong extends Error {}

/** Decode the first audio stream of any FFmpeg-readable file to 16 kHz mono samples. */
export function decodeWithFfmpeg(
  ffmpeg: string,
  path: string,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-protocol_whitelist',
        'file',
        '-i',
        path,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const chunks: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maxDecodedBytes) {
        failure ??= new DecodedTooLong('Decoded audio exceeds two hours')
        child.kill('SIGKILL')
      } else chunks.push(chunk)
    })
    child.once('error', (error) => {
      failure ??= error
    })
    child.once('close', (code) => {
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`FFmpeg exited with ${code}`))
      const data = Buffer.concat(chunks)
      const samples = new Float32Array(Math.floor(data.length / 2))
      for (let i = 0; i < samples.length; i++)
        samples[i] = data.readInt16LE(i * 2) / 32768
      resolve(samples)
    })
  })
}
