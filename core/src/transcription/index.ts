/** Provider boundary for derived audio text. Core owns authorization, input bytes and durable state. */
export type TranscriptionFailure = 'unavailable' | 'timeout' | 'cancelled' | 'invalid-input' | 'output-limit' | 'provider-error'
export type TranscriptionResult =
  | { readonly status: 'succeeded' | 'no-speech'; readonly text: string; readonly provider: string }
  | { readonly status: 'unavailable'; readonly reason: TranscriptionFailure; readonly provider: string }
export interface TranscriptionInput {
  /** Verified path within Core-managed immutable artifact storage. */
  readonly path: string
  readonly mimeType: string
  readonly size: number
  readonly signal: AbortSignal
}
export interface TranscriptionProvider {
  readonly id: string
  readonly contractMajor: 1
  /** MIME types accepted as exact types or type/* wildcards. */
  readonly inputTypes: readonly string[]
  readiness(): Promise<{ ready: boolean; reason?: string }>
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
  close(): Promise<void>
}

export function acceptsType(provider: Pick<TranscriptionProvider, 'inputTypes'>, mimeType: string): boolean {
  const type = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  return provider.inputTypes.some(pattern => {
    const accepted = pattern.trim().toLowerCase()
    return accepted.endsWith('/*') ? type.startsWith(accepted.slice(0, -1)) : accepted === type
  })
}
