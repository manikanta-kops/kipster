import type { TranscriptionProvider } from '@kipster/core/transcription'
import { createProvider } from './provider.js'

export function createTranscriptionProvider(
  options: unknown,
): TranscriptionProvider {
  return createProvider(options)
}
