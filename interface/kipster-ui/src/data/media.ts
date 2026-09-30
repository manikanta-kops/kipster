import { check, incompatible, record } from './response.ts'
import type { ConversationTarget } from './conversations.js'
import type { Artifact } from '../features/chat/model.js'
export type MediaPurpose = 'attachment' | 'voice_note'
export interface UploadIntent {
  uploadId: string
  target: ConversationTarget
  name: string
  mimeType: string
  size: number
  sha256: string
  purpose: MediaPurpose
}
export type UploadReceipt =
  | { status: 'unknown'; uploadId: string }
  | { status: 'accepted'; intent: UploadIntent; artifact: Artifact }
export interface MediaClient {
  capabilities(signal: AbortSignal): Promise<{ maxUploadBytes: number }>
  upload(
    intent: UploadIntent,
    bytes: Blob,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ): Promise<UploadReceipt>
  receipt(intent: UploadIntent, signal: AbortSignal): Promise<UploadReceipt>
  metadata(
    id: string,
    target: ConversationTarget,
    signal: AbortSignal,
  ): Promise<Artifact>
  content(
    artifact: Artifact,
    target: ConversationTarget,
    signal: AbortSignal,
  ): Promise<Blob>
}
export const targetIdentity = (t: ConversationTarget) =>
  JSON.stringify([
    t.installationId,
    t.callerId,
    t.context.kind,
    t.context.kind === 'organization'
      ? t.context.organizationId
      : t.context.installationId,
    t.chatId,
    t.threadId ?? null,
  ])
export async function digest(bytes: Blob) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer()),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}
export function parseArtifact(value: unknown): Artifact {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.size === 'number' &&
      typeof value.availability === 'string' &&
      (value.mimeType === undefined || typeof value.mimeType === 'string') &&
      (value.sha256 === undefined || typeof value.sha256 === 'string') &&
      (value.revision === undefined || typeof value.revision === 'number') &&
      (value.ownership === undefined ||
        (record(value.ownership) &&
          typeof value.ownership.kind === 'string' &&
          (value.ownership.id === undefined ||
            typeof value.ownership.id === 'string'))) &&
      (value.provenance === undefined ||
        (record(value.provenance) &&
          typeof value.provenance.kind === 'string')),
  )
  return value as unknown as Artifact
}

export function createMediaClient(endpoint: string): MediaClient {
  const base = `${endpoint}/conversations/media`
  const query = (target: ConversationTarget) =>
    new URLSearchParams({ target: JSON.stringify(target) })
  async function json(path: string, signal: AbortSignal) {
    const response = await fetch(base + path, { signal, cache: 'no-store' })
    if (!response.ok)
      throw new Error(`Media service unavailable (HTTP ${response.status}).`)
    return response.json().catch(() => incompatible())
  }
  function receipt(value: unknown, intent: UploadIntent): UploadReceipt {
    check(record(value) && typeof value.status === 'string')
    if (value.status !== 'accepted')
      return { status: 'unknown', uploadId: intent.uploadId }
    return {
      status: 'accepted',
      intent,
      artifact: parseArtifact(value.artifact),
    }
  }

  return {
    async capabilities(signal) {
      const result = await json('/capabilities', signal)
      check(record(result) && typeof result.maxUploadBytes === 'number')
      return { maxUploadBytes: result.maxUploadBytes }
    },
    upload(intent, bytes, signal, progress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        const abort = () => xhr.abort()
        xhr.open(
          'PUT',
          `${base}/uploads/${encodeURIComponent(intent.uploadId)}?intent=${encodeURIComponent(JSON.stringify(intent))}`,
        )
        xhr.timeout = 30000
        xhr.setRequestHeader('Content-Type', 'application/octet-stream')
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) progress(event.loaded / event.total)
        }
        xhr.onload = () => {
          try {
            if (xhr.status !== 200)
              throw new Error(
                `Upload acknowledgement unavailable (HTTP ${xhr.status}).`,
              )
            let value: unknown
            try {
              value = JSON.parse(xhr.responseText)
            } catch {
              incompatible()
            }
            resolve(receipt(value, intent))
          } catch (error) {
            reject(error)
          }
        }
        xhr.onerror = xhr.ontimeout = () =>
          reject(
            new Error(
              'Upload acknowledgement unavailable. Check receipt or retry the same upload.',
            ),
          )
        xhr.onabort = () =>
          reject(
            new DOMException(
              'Upload cancelled locally; remote outcome may be unknown.',
              'AbortError',
            ),
          )
        xhr.onloadend = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          reject(new DOMException('Cancelled', 'AbortError'))
          return
        }
        xhr.send(bytes)
      })
    },
    async receipt(intent, signal) {
      return receipt(
        await json(
          `/uploads/${encodeURIComponent(intent.uploadId)}?${query(intent.target)}`,
          signal,
        ),
        intent,
      )
    },
    async metadata(id, target, signal) {
      const a = parseArtifact(
        await json(
          `/artifacts/${encodeURIComponent(id)}?${query(target)}`,
          signal,
        ),
      )
      return a
    },
    async content(artifact, target, signal) {
      const response = await fetch(
        `${base}/artifacts/${encodeURIComponent(artifact.id)}/content?${query(target)}`,
        { signal, cache: 'no-store' },
      )
      if (!response.ok)
        throw new Error('File content is missing or unavailable.')
      const bytes = await response.blob()
      if (
        bytes.size !== artifact.size ||
        (await digest(bytes)) !== artifact.sha256
      )
        throw new Error('File integrity verification failed.')
      return new Blob([bytes], { type: artifact.mimeType })
    },
  }
}
