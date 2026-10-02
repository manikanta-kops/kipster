import type { MediaArtifact } from './media.ts'
import { json, record, text, WireError, type Context } from './wire.ts'

type Block = { id: string; type: string; [key: string]: unknown }
type Anchor = {
  blockId: string
  field: string
  quote: string
  start: number
  end: number
}
type DraftComment = Anchor & { id: string; body: string }
type Comment = Anchor & {
  id: string
  number: number
  body: string
  state: 'open' | 'resolved'
  reply: string | null
  submittedInRevision: number
  resolvedInRevision: number | null
  createdAt: string
}
type Revision = {
  number: number
  authorKind: 'user' | 'agent'
  authorId: string
  title: string
  blocks: Block[]
  note: string
  changes: { added: string[]; updated: string[]; removed: string[] }
  createdAt: string
}
type Draft = {
  draftVersion: number
  baseRevision: number
  title: string
  blocks: Block[]
  comments: DraftComment[]
  note: string
  updatedAt: string
}
type Summary = {
  id: string
  title: string
  context: Context
  agentId: string
  chatId: string
  threadId: string
  turn: 'user' | 'agent'
  currentRevision: number
  pendingQuestions: number
  openComments: number
  hasDraft: boolean
  createdAt: string
  updatedAt: string
  revision: number
}
type Doc = {
  summary: Summary
  revisions: Revision[]
  draft: Draft | null
  comments: Comment[]
  /** The kip's unpublished edits during its turn. */
  working: { blocks: Block[]; replies: Map<string, string> } | null
  runId: string | null
  deleted: boolean
}
export type DocumentPart = {
  kind: 'document'
  documentId: string
  revision: number
}
type Part = { kind: 'text'; text: string } | DocumentPart

const LIMITS = { blocks: 500, comments: 200, title: 200, note: 8000 }
const MAX_BODY = 512 * 1024
const REPLIES = [
  'Good call. I reworded this so it reads clearer.',
  'Added it to the plan.',
  'Kept as is for now, and noted why below.',
]
const now = () => new Date().toISOString()
const clone = <T>(value: T): T => structuredClone(value)
const current = (doc: Doc) => doc.revisions.at(-1)!
const conflict = (message: string) => new WireError(409, 'conflict', message)

function diff(before: Block[], after: Block[]) {
  const old = new Map(before.map((b) => [b.id, JSON.stringify(b)]))
  const ids = new Set(after.map((b) => b.id))
  return {
    added: after.filter((b) => !old.has(b.id)).map((b) => b.id),
    updated: after
      .filter((b) => old.has(b.id) && old.get(b.id) !== JSON.stringify(b))
      .map((b) => b.id),
    removed: before.filter((b) => !ids.has(b.id)).map((b) => b.id),
  }
}
const answered = (block: Block) =>
  block.type === 'scale'
    ? block.value !== null
    : !!block.answer &&
      ((block.answer as { optionIds: string[] }).optionIds.length > 0 ||
        !!(block.answer as { other: string }).other.trim())
const artifactIds = (blocks: Block[]) =>
  blocks.flatMap((b) =>
    (b.type === 'image' || b.type === 'file') &&
    typeof b.artifactId === 'string'
      ? [b.artifactId]
      : [],
  )

async function readBody(request: Request) {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY)
    throw new Error('Invalid request body size')
  const row = record(JSON.parse(raw))
  if (row.version !== 1) throw new Error('Invalid protocol version')
  return row
}
const integer = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid integer')
  return value as number
}
function exact(row: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(row).some((key) => !keys.includes(key)) ||
    keys.some((key) => row[key] === undefined)
  )
    throw new Error('Invalid fields')
  return row
}

/** In-memory rich docs with the same routes, turns and events as Core. */
export function createFakeDocuments(host: {
  callerId: () => string
  emit: (
    type: string,
    data: unknown,
    resourceId: string,
    revision: number,
  ) => void
  /** Posts a message in a thread; with `run`, the kip starts working on it. */
  post: (
    threadId: string,
    authorId: string,
    parts: Part[],
    run: boolean,
  ) => { messageId: string; runId?: string }
  cancel: (threadId: string, runId: string) => void
  artifact: (
    id: string,
  ) => { metadata: MediaArtifact; bytes: Uint8Array } | undefined
}) {
  const docs = new Map<string, Doc>()
  const receipts = new Map<string, unknown>()

  function changed(doc: Doc) {
    const blocks =
      doc.summary.turn === 'user'
        ? (doc.draft?.blocks ?? current(doc).blocks)
        : []
    Object.assign(doc.summary, {
      title: doc.draft?.title ?? current(doc).title,
      currentRevision: current(doc).number,
      pendingQuestions: blocks.filter(
        (b) => (b.type === 'question' || b.type === 'scale') && !answered(b),
      ).length,
      openComments: doc.comments.filter((c) => c.state === 'open').length,
      hasDraft: !!doc.draft,
      updatedAt: now(),
      revision: doc.summary.revision + 1,
    })
    host.emit(
      'document-changed',
      doc.summary,
      doc.summary.id,
      doc.summary.revision,
    )
  }
  const detail = (doc: Doc) => ({
    version: 1,
    document: doc.summary,
    current: current(doc),
    draft: doc.draft,
    comments: doc.comments,
    revisions: doc.revisions.map(
      ({ number, authorKind, authorId, note, createdAt }) => ({
        number,
        authorKind,
        authorId,
        note,
        createdAt,
      }),
    ),
  })
  function find(id: string) {
    const doc = docs.get(id)
    if (!doc || doc.deleted)
      throw new WireError(404, 'not-found', 'Document not found')
    return doc
  }
  function publish(
    doc: Doc,
    revision: Omit<Revision, 'number' | 'changes' | 'createdAt'>,
  ) {
    const number = current(doc).number + 1
    doc.revisions.push({
      ...revision,
      number,
      changes: diff(current(doc).blocks, revision.blocks),
      createdAt: now(),
    })
    return number
  }

  function validBlocks(value: unknown) {
    if (!Array.isArray(value) || value.length > LIMITS.blocks)
      throw new Error('Invalid blocks')
    const ids = new Set<string>()
    for (const item of value) {
      const block = record(item)
      if (typeof block.type !== 'string' || ids.has(text(block.id)))
        throw new Error('Invalid block')
      ids.add(block.id as string)
    }
    for (const id of artifactIds(value as Block[]))
      if (!host.artifact(id)) throw new Error('Invalid block artifact')
    return value as Block[]
  }
  function validComments(value: unknown, blocks: Block[]) {
    if (!Array.isArray(value) || value.length > LIMITS.comments)
      throw new Error('Invalid comments')
    return value.map((item) => {
      const row = exact(record(item), [
        'id',
        'blockId',
        'field',
        'quote',
        'start',
        'end',
        'body',
      ])
      if (
        !blocks.some((b) => b.id === text(row.blockId)) ||
        typeof row.quote !== 'string' ||
        text(row.body).length > 4000
      )
        throw new Error('Invalid comment')
      text(row.id)
      text(row.field)
      integer(row.start)
      integer(row.end)
      return row as DraftComment
    })
  }

  return {
    reset() {
      docs.clear()
      receipts.clear()
    },
    /** Adds a doc with its history, as a kip created and revised it. */
    seed(input: {
      id: string
      context: Context
      agentId: string
      chatId: string
      threadId: string
      revisions: Revision[]
      comments: Comment[]
    }) {
      const first = input.revisions[0]
      const doc: Doc = {
        summary: {
          id: input.id,
          title: '',
          context: input.context,
          agentId: input.agentId,
          chatId: input.chatId,
          threadId: input.threadId,
          turn: 'user',
          currentRevision: 0,
          pendingQuestions: 0,
          openComments: 0,
          hasDraft: false,
          createdAt: first.createdAt,
          updatedAt: first.createdAt,
          revision: 0,
        },
        revisions: clone(input.revisions),
        draft: null,
        comments: clone(input.comments),
        working: null,
        runId: null,
        deleted: false,
      }
      docs.set(doc.summary.id, doc)
      changed(doc)
    },
    inspect: () =>
      [...docs.values()].map(({ working, ...doc }) => ({
        ...clone(doc),
        working: !!working,
      })),
    /** The kip's scripted edits: it resolves comments, records decisions and adds a follow-up. */
    work(runId: string) {
      const doc = [...docs.values()].find((d) => d.runId === runId)
      if (!doc) return
      const blocks = clone(current(doc).blocks)
      const replies = new Map<string, string>()
      doc.comments
        .filter((c) => c.state === 'open')
        .forEach((c, index) =>
          replies.set(c.id, REPLIES[index % REPLIES.length]),
        )
      for (const question of blocks.filter(
        (b) => b.type === 'question' && answered(b),
      )) {
        const id = `decided-${question.id}`
        if (blocks.some((b) => b.id === id)) continue
        const answer = question.answer as { optionIds: string[]; other: string }
        const labels = [
          ...(question.options as { id: string; label: string }[])
            .filter((o) => answer.optionIds.includes(o.id))
            .map((o) => o.label),
          ...(answer.other.trim() ? [answer.other.trim()] : []),
        ]
        blocks.splice(blocks.indexOf(question) + 1, 0, {
          id,
          type: 'callout',
          tone: 'success',
          text: `**Decided:** ${labels.join(', ')}. I updated the plan to match.`,
        })
      }
      const checklist = blocks.find((b) => b.type === 'checklist')
      const items = checklist?.items as
        { id: string; text: string; done: boolean }[] | undefined
      if (items && !items.some((i) => i.text === 'Follow up on your notes'))
        items.push({
          id: `follow-${runId.slice(0, 6)}`,
          text: 'Follow up on your notes',
          done: false,
        })
      doc.working = { blocks, replies }
    },
    /** Publishes the kip's edits as one revision and hands the doc back. */
    finish(runId: string) {
      const doc = [...docs.values()].find((d) => d.runId === runId)
      if (!doc) return undefined
      const working = doc.working
      doc.runId = null
      doc.working = null
      doc.summary.turn = 'user'
      let number = current(doc).number
      let resolved = 0
      if (working) {
        number = publish(doc, {
          authorKind: 'agent',
          authorId: doc.summary.agentId,
          title: current(doc).title,
          blocks: working.blocks,
          note: working.replies.size
            ? `Resolved ${working.replies.size} comment${working.replies.size === 1 ? '' : 's'}`
            : 'Revised the doc',
        })
        for (const comment of doc.comments) {
          const reply = working.replies.get(comment.id)
          if (reply === undefined) continue
          Object.assign(comment, {
            state: 'resolved',
            reply,
            resolvedInRevision: number,
          })
          resolved++
        }
      }
      changed(doc)
      return { documentId: doc.summary.id, revision: number, resolved }
    },
    /** A kip run ended some other way: its edits still become a revision. */
    runEnded(runId: string) {
      this.finish(runId)
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url)
      const match =
        /^\/v1\/documents(?:\/([^/]+)(?:\/(draft|submit|take-back|revisions\/(\d+)|artifacts\/([^/]+)(\/content)?))?)?$/.exec(
          url.pathname,
        )
      if (!match) return undefined
      const [, id, action, revision, artifactId, content] = match
      const method = request.method
      if (!id && method === 'GET')
        return json({
          version: 1,
          documents: [...docs.values()]
            .filter((doc) => !doc.deleted)
            .map((doc) => doc.summary),
        })
      if (!id) return undefined
      const doc = find(decodeURIComponent(id))
      if (!action && method === 'GET') return json(detail(doc))
      if (!action && method === 'DELETE') {
        doc.deleted = true
        const runId = doc.runId
        doc.runId = null
        if (runId) host.cancel(doc.summary.threadId, runId)
        host.emit(
          'document-removed',
          { id: doc.summary.id },
          doc.summary.id,
          doc.summary.revision + 1,
        )
        return json({ version: 1 })
      }
      if (revision && method === 'GET') {
        const found = doc.revisions.find((r) => r.number === Number(revision))
        if (!found) throw new WireError(404, 'not-found', 'Revision not found')
        return json({ version: 1, revision: found })
      }
      if (artifactId && method === 'GET') {
        const aid = decodeURIComponent(artifactId)
        const referenced = [
          ...doc.revisions.flatMap((r) => artifactIds(r.blocks)),
          ...artifactIds(doc.draft?.blocks ?? []),
        ].includes(aid)
        const file = referenced ? host.artifact(aid) : undefined
        if (!file) throw new WireError(404, 'not-found', 'Artifact not found')
        if (!content) return json(file.metadata)
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
      if (action === 'draft' && method === 'PUT') {
        const row = exact(await readBody(request), [
          'version',
          'baseRevision',
          'expectedDraftVersion',
          'title',
          'blocks',
          'comments',
          'note',
        ])
        const title = text(row.title)
        if (title.length > LIMITS.title) throw new Error('Invalid title')
        if (typeof row.note !== 'string' || row.note.length > LIMITS.note)
          throw new Error('Invalid note')
        const blocks = validBlocks(row.blocks)
        const comments = validComments(row.comments, blocks)
        if (doc.summary.turn !== 'user')
          throw conflict('The kip is revising this doc.')
        if (integer(row.baseRevision) !== current(doc).number)
          throw conflict('The doc has a newer revision.')
        if (
          integer(row.expectedDraftVersion) !== (doc.draft?.draftVersion ?? 0)
        )
          throw conflict('The draft changed elsewhere.')
        doc.draft = {
          draftVersion: (doc.draft?.draftVersion ?? 0) + 1,
          baseRevision: current(doc).number,
          title,
          blocks,
          comments,
          note: row.note,
          updatedAt: now(),
        }
        changed(doc)
        return json({
          version: 1,
          draftVersion: doc.draft.draftVersion,
          updatedAt: doc.draft.updatedAt,
        })
      }
      if (action === 'draft' && method === 'DELETE') {
        if (doc.draft) {
          doc.draft = null
          changed(doc)
        }
        return json({ version: 1 })
      }
      if (action === 'submit' && method === 'POST') {
        const row = exact(await readBody(request), [
          'version',
          'operationId',
          'draftVersion',
        ])
        const operationId = text(row.operationId)
        const prior = receipts.get(operationId)
        if (prior) return json(prior)
        const draft = doc.draft
        if (doc.summary.turn !== 'user')
          throw conflict('The kip is revising this doc.')
        if (!draft || integer(row.draftVersion) !== draft.draftVersion)
          throw conflict('Save the doc before submitting.')
        const number = publish(doc, {
          authorKind: 'user',
          authorId: host.callerId(),
          title: draft.title,
          blocks: draft.blocks,
          note: draft.note,
        })
        let next = Math.max(0, ...doc.comments.map((c) => c.number))
        for (const comment of draft.comments)
          doc.comments.push({
            ...comment,
            number: ++next,
            state: 'open',
            reply: null,
            submittedInRevision: number,
            resolvedInRevision: null,
            createdAt: now(),
          })
        doc.draft = null
        doc.summary.turn = 'agent'
        const posted = host.post(
          doc.summary.threadId,
          host.callerId(),
          [
            ...(draft.note.trim()
              ? [{ kind: 'text' as const, text: draft.note.trim() }]
              : []),
            { kind: 'document', documentId: doc.summary.id, revision: number },
          ],
          true,
        )
        doc.runId = posted.runId!
        changed(doc)
        const receipt = {
          version: 1,
          document: clone(doc.summary),
          messageId: posted.messageId,
          runId: posted.runId,
        }
        receipts.set(operationId, receipt)
        return json(receipt)
      }
      if (action === 'take-back' && method === 'POST') {
        exact(await readBody(request), ['version'])
        if (doc.summary.turn !== 'agent' || !doc.runId)
          throw conflict('The doc is already yours.')
        const runId = doc.runId
        doc.runId = null
        doc.working = null
        doc.summary.turn = 'user'
        host.cancel(doc.summary.threadId, runId)
        changed(doc)
        return json({ version: 1, document: doc.summary })
      }
      throw new WireError(404, 'not-found', 'Route not found')
    },
  }
}
