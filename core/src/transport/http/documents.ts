import type { Runtime } from '../../runtime.js'
import type { TrustedActor } from '../../modules/identity/public.js'
import { deleteDocument, discardDraft, documentArtifact, listDocuments, readDocument, readRevision, saveDraft, submitDocument, takeBack } from '../../modules/documents/public.js'
import { DOCUMENT_LIMITS, documentDraftWrite, documentSubmit, documentTakeBack } from '../../protocol/documents.js'

export type DocumentReply = { status: number; body: unknown } | { status: 200; bytes: Buffer; headers: Record<string, string | number> }

const route = /^\/v1\/documents\/([0-9a-f-]{36})(?:\/(draft|submit|take-back|revisions\/(\d{1,9})|artifacts\/([0-9a-f-]{36})(\/content)?))?$/
/** A draft holds up to the document size in blocks plus its comments and note. */
const draftBodyBytes = 4 * DOCUMENT_LIMITS.bytes

/** Trusted-owner document routes. Returns null when the path is not a document route. */
export async function documentRoute(runtime: Runtime, actor: TrustedActor, method: string, path: string, body: (limit?: number) => Promise<unknown>, afterAccepted?: (runId: string) => Promise<void>): Promise<DocumentReply | null> {
  if (path === '/v1/documents' && method === 'GET') return { status: 200, body: await listDocuments(runtime.db, actor) }
  const match = route.exec(path)
  if (!match) return null
  const [, id, action, revision, artifactId, content] = match as unknown as [string, string, string | undefined, string | undefined, string | undefined, string | undefined]
  if (!action) {
    if (method === 'GET') return { status: 200, body: await readDocument(runtime.db, actor, id) }
    if (method === 'DELETE') return { status: 200, body: await deleteDocument(runtime.db, actor, id) }
    return null
  }
  if (revision !== undefined && method === 'GET') return { status: 200, body: await readRevision(runtime.db, actor, id, Number(revision)) }
  if (action === 'draft' && method === 'PUT') return { status: 200, body: await saveDraft(runtime.db, actor, id, documentDraftWrite.parse(await body(draftBodyBytes))) }
  if (action === 'draft' && method === 'DELETE') return { status: 200, body: await discardDraft(runtime.db, actor, id) }
  if (action === 'submit' && method === 'POST') {
    const input = documentSubmit.parse(await body())
    const result = await submitDocument(runtime.db, runtime.jobs, runtime.artifacts, actor, id, input)
    await afterAccepted?.(result.runId)
    return { status: 200, body: result }
  }
  if (action === 'take-back' && method === 'POST') {
    documentTakeBack.parse(await body())
    return { status: 200, body: await takeBack(runtime.db, actor, id) }
  }
  if (artifactId !== undefined && method === 'GET') {
    await documentArtifact(runtime.db, actor, id, artifactId)
    const file = await runtime.artifacts.referenced(actor.installationId, artifactId)
    if (!content) return { status: 200, body: file.metadata }
    const filename = encodeURIComponent(file.metadata.name)
    return { status: 200, bytes: file.bytes, headers: { 'content-type': 'application/octet-stream', 'content-length': file.bytes.length, 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' } }
  }
  return null
}
