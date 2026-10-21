import type { TranscriptionResult } from '@kipster/core/transcription'
import type { Config } from './config.js'

export interface Request {
  path: string
  mimeType: string
  size: number
  config: Config
}
export type Reply = TranscriptionResult
export const provider = 'transcribe-cpp'
