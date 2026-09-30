import { WireError } from './wire.ts'
export interface MediaTarget {
  installationId: string
  callerId: string
  context:
    | { kind: 'installation'; installationId: string }
    | { kind: 'organization'; organizationId: string }
  chatId: string
  threadId?: string
}
export interface MediaIntent {
  uploadId: string
  target: MediaTarget
  name: string
  mimeType: string
  size: number
  sha256: string
  purpose: 'attachment' | 'voice_note'
}
export interface MediaArtifact {
  id: string
  name: string
  mimeType: string
  size: number
  sha256: string
  sourceId?: string
  revision: number
  availability: 'registered' | 'failed' | 'missing'
  ownership: { kind: 'installation' | 'organization' | 'agent'; id: string }
  provenance: { kind: 'upload' | 'generated' | 'published'; authorId: string }
}
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const json = (value: unknown) => Response.json(value)
const key = (t: MediaTarget) =>
  JSON.stringify([
    t.installationId,
    t.callerId,
    t.context.kind,
    t.context.kind === 'installation'
      ? t.context.installationId
      : t.context.organizationId,
    t.chatId,
    t.threadId ?? null,
  ])
const intentKey = (i: MediaIntent) =>
  JSON.stringify([
    i.uploadId,
    key(i.target),
    i.name,
    i.mimeType,
    i.size,
    i.sha256,
    i.purpose,
  ])
async function digest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}
function target(value: unknown): MediaTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid media target')
  const row = value as MediaTarget
  if (
    Object.keys(row).some(
      (k) =>
        ![
          'installationId',
          'callerId',
          'context',
          'chatId',
          'threadId',
        ].includes(k),
    ) ||
    typeof row.installationId !== 'string' ||
    typeof row.callerId !== 'string' ||
    typeof row.chatId !== 'string' ||
    (row.threadId !== undefined && typeof row.threadId !== 'string')
  )
    throw new Error('Invalid media target')
  const context = row.context
  if (
    !context ||
    (context.kind !== 'installation' && context.kind !== 'organization')
  )
    throw new Error('Invalid context')
  const field =
    context.kind === 'installation' ? 'installationId' : 'organizationId'
  if (
    Object.keys(context).some((k) => !['kind', field].includes(k)) ||
    !uuid.test(
      context.kind === 'installation'
        ? context.installationId
        : context.organizationId,
    )
  )
    throw new Error('Invalid context')
  return row
}
function query(url: URL): MediaTarget {
  const raw = url.searchParams.get('target')
  if (!raw || raw.length > 4096) throw new Error('Invalid media target')
  return target(JSON.parse(raw))
}
function intent(value: unknown): MediaIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid upload intent')
  const row = value as MediaIntent
  if (
    Object.keys(row).some(
      (k) =>
        ![
          'uploadId',
          'target',
          'name',
          'mimeType',
          'size',
          'sha256',
          'purpose',
        ].includes(k),
    ) ||
    typeof row.uploadId !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.mimeType !== 'string' ||
    typeof row.sha256 !== 'string' ||
    typeof row.size !== 'number' ||
    !['attachment', 'voice_note'].includes(row.purpose)
  )
    throw new Error('Invalid upload intent')
  target(row.target)
  if (
    ![
      row.uploadId,
      row.target.installationId,
      row.target.callerId,
      row.target.chatId,
      ...(row.target.threadId ? [row.target.threadId] : []),
    ].every((id) => uuid.test(id))
  )
    throw new Error('Invalid upload identity')
  if (
    !row.name ||
    row.name.length > 255 ||
    Array.from(row.name).some((char) => char.charCodeAt(0) < 32) ||
    !row.mimeType ||
    row.mimeType.length > 128 ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.size > MAX_UPLOAD_BYTES ||
    !/^[a-f0-9]{64}$/.test(row.sha256)
  )
    throw new Error('Invalid upload metadata')
  return row
}

export function createFakeMedia(options: {
  installationId: string
  callerId: string
  authorizeTarget?: (target: MediaTarget) => void
}) {
  const artifacts = new Map<
    string,
    { metadata: MediaArtifact; bytes: Uint8Array; target: MediaTarget }
  >()
  const uploads = new Map<
    string,
    { intent: MediaIntent; artifact: MediaArtifact }
  >()
  const pending = new Map<string, MediaIntent>()
  let generation = 0
  const deletedOwners = new Set<string>()
  function liveOwner(owner: MediaArtifact['ownership']) {
    if (deletedOwners.has(`${owner.kind}:${owner.id}`))
      throw new Error('Artifact owner access denied')
  }
  function authorize(t: MediaTarget) {
    if (t.context.kind === 'organization')
      liveOwner({ kind: 'organization', id: t.context.organizationId })
    if (
      t.installationId !== options.installationId ||
      t.callerId !== options.callerId
    )
      throw new Error('Caller scope mismatch')
    options.authorizeTarget?.(t)
  }
  function owned(a: MediaArtifact, t: MediaTarget) {
    if (
      a.ownership.kind === 'agent' ||
      a.ownership.kind !== t.context.kind ||
      a.ownership.id !==
        (t.context.kind === 'installation'
          ? t.context.installationId
          : t.context.organizationId)
    )
      throw new Error('Artifact access denied')
  }
  return {
    reset() {
      generation++
      deletedOwners.clear()
      artifacts.clear()
      uploads.clear()
      pending.clear()
    },
    deleteOwner(
      kind: 'agent' | 'organization',
      ownerId: string,
      references: readonly { artifactId: string; organizationId: string }[],
      copyFilesToOrganizations: boolean,
    ): {
      removed: string[]
      replacements: {
        artifactId: string
        organizationId: string
        replacementId: string
      }[]
    } {
      deletedOwners.add(`${kind}:${ownerId}`)
      const removed = [...artifacts.values()]
        .filter(
          (file) =>
            file.metadata.ownership.kind === kind &&
            file.metadata.ownership.id === ownerId,
        )
        .map((file) => file.metadata.id)
      const replacements: {
        artifactId: string
        organizationId: string
        replacementId: string
      }[] = []
      for (const ref of references) {
        if (
          !removed.includes(ref.artifactId) ||
          deletedOwners.has(`organization:${ref.organizationId}`)
        )
          continue
        const source = artifacts.get(ref.artifactId)!
        let copy = [...artifacts.values()].find(
          (file) =>
            file.metadata.sourceId === ref.artifactId &&
            file.metadata.ownership.kind === 'organization' &&
            file.metadata.ownership.id === ref.organizationId &&
            file.metadata.availability === 'registered',
        )
        if (
          !copy &&
          kind === 'agent' &&
          copyFilesToOrganizations &&
          source.metadata.availability === 'registered'
        ) {
          copy = {
            metadata: {
              ...structuredClone(source.metadata),
              id: crypto.randomUUID(),
              sourceId: ref.artifactId,
              revision: 1,
              ownership: { kind: 'organization', id: ref.organizationId },
              provenance: {
                kind: 'published',
                authorId: source.metadata.provenance.authorId,
              },
            },
            bytes: source.bytes.slice(),
            target: {
              ...source.target,
              context: {
                kind: 'organization',
                organizationId: ref.organizationId,
              },
            },
          }
          artifacts.set(copy.metadata.id, copy)
        }
        if (
          copy &&
          !replacements.some(
            (item) =>
              item.artifactId === ref.artifactId &&
              item.organizationId === ref.organizationId,
          )
        )
          replacements.push({ ...ref, replacementId: copy.metadata.id })
      }
      for (const id of removed) artifacts.delete(id)
      for (const [id, upload] of uploads)
        if (removed.includes(upload.artifact.id)) uploads.delete(id)
      return { removed, replacements }
    },
    async addArtifact(input: {
      id: string
      name: string
      mimeType: string
      bytes: Uint8Array
      target: MediaTarget
      provenance?: MediaArtifact['provenance']
      ownership?: MediaArtifact['ownership']
    }): Promise<MediaArtifact> {
      const started = generation
      const metadata: MediaArtifact = {
        id: input.id,
        name: input.name,
        mimeType: input.mimeType,
        size: input.bytes.length,
        sha256: await digest(input.bytes),
        revision: 1,
        availability: 'registered',
        ownership: input.ownership ?? {
          kind: input.target.context.kind,
          id:
            input.target.context.kind === 'installation'
              ? input.target.context.installationId
              : input.target.context.organizationId,
        },
        provenance: input.provenance ?? {
          kind: 'upload',
          authorId: input.target.callerId,
        },
      }
      if (started !== generation) throw new Error('Upload claim expired')
      liveOwner(metadata.ownership)
      if (input.target.context.kind === 'organization')
        liveOwner({
          kind: 'organization',
          id: input.target.context.organizationId,
        })
      artifacts.set(input.id, {
        metadata,
        bytes: input.bytes.slice(),
        target: structuredClone(input.target),
      })
      return structuredClone(metadata)
    },
    validateParts(
      t: MediaTarget,
      parts: readonly { kind: string; artifactId?: string }[],
    ) {
      authorize(t)
      const files = parts.filter((p) => p.kind === 'file')
      if (files.length > 10) throw new Error('Invalid file count')
      let size = 0
      for (const part of files) {
        const file = artifacts.get(part.artifactId ?? '')
        if (!file) throw new Error('Artifact not found')
        owned(file.metadata, t)
        if (file.metadata.availability !== 'registered')
          throw new Error('Artifact unavailable')
        size += file.metadata.size
      }
      if (size > 50 * 1024 * 1024) throw new Error('Invalid total file size')
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      if (
        request.method === 'GET' &&
        url.pathname === '/conversations/media/capabilities'
      )
        return json({ maxUploadBytes: MAX_UPLOAD_BYTES })
      const upload = /^\/conversations\/media\/uploads\/([0-9a-f-]{36})$/.exec(
        url.pathname,
      )
      if (upload && request.method === 'GET') {
        const t = query(url)
        authorize(t)
        const saved = uploads.get(upload[1])
        if (!saved) return json({ status: 'unknown', uploadId: upload[1] })
        if (key(saved.intent.target) !== key(t))
          throw new Error('Upload target mismatch')
        return json({ status: 'accepted', ...saved })
      }
      if (upload && request.method === 'PUT') {
        const raw = url.searchParams.get('intent')
        if (!raw || raw.length > 4096) throw new Error('Invalid upload intent')
        const i = intent(JSON.parse(raw))
        authorize(i.target)
        if (i.uploadId !== upload[1])
          throw new Error('Upload identity mismatch')
        const length = request.headers.get('content-length')
        if (
          length === null ||
          !/^\d+$/.test(length) ||
          Number(length) !== i.size
        )
          throw new Error('Invalid upload size')
        if (request.headers.get('content-type') !== 'application/octet-stream')
          throw new Error('Invalid upload content type')
        const saved = uploads.get(i.uploadId),
          busy = pending.get(i.uploadId)
        if (saved || busy) {
          if (intentKey((saved?.intent ?? busy)!) !== intentKey(i))
            throw new WireError(409, 'conflict', 'Upload intent conflict')
          return json(
            saved
              ? { status: 'accepted', ...saved }
              : { status: 'unknown', uploadId: i.uploadId },
          )
        }
        const started = generation
        pending.set(i.uploadId, i)
        try {
          const bytes = new Uint8Array(await request.arrayBuffer())
          request.signal.throwIfAborted()
          if (bytes.length !== i.size || (await digest(bytes)) !== i.sha256)
            throw new Error('Invalid upload integrity')
          if (started !== generation) throw new Error('Upload claim expired')
          authorize(i.target)
          const artifact = await this.addArtifact({
            id: crypto.randomUUID(),
            name: i.name,
            mimeType: i.mimeType,
            bytes,
            target: i.target,
          })
          if (started !== generation) throw new Error('Upload claim expired')
          authorize(i.target)
          uploads.set(i.uploadId, { intent: structuredClone(i), artifact })
          return json({ status: 'accepted', intent: i, artifact })
        } finally {
          if (pending.get(i.uploadId) === i) pending.delete(i.uploadId)
        }
      }
      const match =
        /^\/conversations\/media\/artifacts\/([0-9a-f-]{36})(\/content)?$/.exec(
          url.pathname,
        )
      if (match && request.method === 'GET') {
        const t = query(url)
        authorize(t)
        const file = artifacts.get(match[1])
        if (!file) throw new Error('Artifact not found')
        if (file.metadata.ownership.kind === 'agent') {
          if (
            file.target.chatId !== t.chatId ||
            (t.threadId && file.target.threadId !== t.threadId)
          )
            throw new Error('Artifact access denied')
        } else owned(file.metadata, t)
        if (file.metadata.availability !== 'registered')
          throw new Error('Artifact unavailable')
        if (!match[2]) return json(file.metadata)
        return new Response(file.bytes.slice().buffer, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(file.bytes.length),
            'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.metadata.name)}`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': 'sandbox',
            'cache-control': 'no-store',
          },
        })
      }
      return undefined
    },
  }
}
