import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { TranscribeModel } from 'transcribe-cpp'
import { provider, type Request, type Reply } from './messages.js'
import { readWav } from './wav.js'

let model: TranscribeModel | undefined

async function transcribe(request: Request): Promise<Reply> {
  let samples: Float32Array
  try {
    if ((await stat(request.path)).size !== request.size)
      throw new Error('Input size changed')
    samples = await readWav(request.path)
  } catch {
    return { status: 'unavailable', reason: 'invalid-input', provider }
  }
  if (!samples.length) return { status: 'no-speech', text: '', provider }
  try {
    if (!model) {
      const { config } = request
      const info = await stat(config.model)
      if (!info.isFile() || info.size !== config.modelSize)
        throw new Error('Model size mismatch')
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(config.model))
        hash.update(chunk)
      if (hash.digest('hex') !== config.modelSha256)
        throw new Error('Model SHA-256 mismatch')
      // Native libraries, model loading and inference remain in this process.
      const { TranscribeModel, setLogHandler } = await import('transcribe-cpp')
      setLogHandler(() => {})
      model = await TranscribeModel.load(config.model)
    }
    const result = await model.transcribe(samples)
    const text = result.text.trim()
    return { status: text ? 'succeeded' : 'no-speech', text, provider }
  } catch {
    return { status: 'unavailable', reason: 'provider-error', provider }
  }
}

process.on('message', async (request: Request) => {
  const result = await transcribe(request)
  process.send?.(result)
})
process.on('disconnect', () => process.exit(0))
