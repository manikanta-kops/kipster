import type {
  DocumentBlock,
  DocumentComment,
  DocumentRevision,
  DocumentSummary,
  DraftComment,
} from '@kipster/core/protocol'
import { check, incompatible, list, record } from './response.ts'
import { httpError } from './text.ts'
import { digest, parseArtifact } from './media.ts'
import type { Artifact } from '../features/chat/model.ts'

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T

export type Block = Mutable<DocumentBlock>
export type BlockType = Block['type']
/** A block type this client does not know. It is shown as a placeholder and saved back unchanged. */
export type UnknownBlock = { id: string; type: string; [key: string]: unknown }
export type AnyBlock = Block | UnknownBlock
export type Comment = Mutable<DocumentComment>
export type Draft = Mutable<DraftComment>
export type Summary = Omit<Mutable<DocumentSummary>, 'turn' | 'context'> & {
  turn: string
  context: { kind: string; installationId?: string; organizationId?: string }
}
export type Revision = Omit<
  Mutable<DocumentRevision>,
  'blocks' | 'authorKind'
> & { blocks: AnyBlock[]; authorKind: string }
export type RevisionInfo = Pick<
  Revision,
  'number' | 'authorKind' | 'authorId' | 'note' | 'createdAt'
>
export type DraftCopy = {
  draftVersion: number
  baseRevision: number
  title: string
  blocks: AnyBlock[]
  comments: Draft[]
  note: string
  updatedAt: string
}
export type Detail = {
  document: Summary
  current: Revision
  draft: DraftCopy | null
  comments: Comment[]
  revisions: RevisionInfo[]
}
export type DraftWrite = {
  baseRevision: number
  expectedDraftVersion: number
  title: string
  blocks: AnyBlock[]
  comments: Draft[]
  note: string
}

const knownTypes = new Set<string>([
  'paragraph',
  'heading',
  'list',
  'checklist',
  'quote',
  'callout',
  'code',
  'divider',
  'image',
  'file',
  'table',
  'toggle',
  'question',
  'scale',
])
const str = (v: unknown) => typeof v === 'string'
const strings = (v: unknown) => Array.isArray(v) && v.every(str)
const items = (v: unknown, test: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(v) && v.every((item) => record(item) && test(item))

/** A known block with a broken shape is kept as unknown, so it is never rendered wrongly or edited. */
export function isKnown(block: AnyBlock): block is Block {
  const b = block as Record<string, unknown>
  if (!knownTypes.has(block.type)) return false
  switch (block.type) {
    case 'paragraph':
    case 'quote':
      return str(b.text)
    case 'heading':
      return str(b.text) && [1, 2, 3].includes(b.level as number)
    case 'callout':
      return (
        str(b.text) && ['note', 'success', 'warning'].includes(b.tone as string)
      )
    case 'list':
      return (
        typeof b.ordered === 'boolean' &&
        items(b.items, (i) => str(i.id) && str(i.text))
      )
    case 'checklist':
      return items(
        b.items,
        (i) => str(i.id) && str(i.text) && typeof i.done === 'boolean',
      )
    case 'code':
      return str(b.language) && str(b.code)
    case 'divider':
      return true
    case 'image':
      return str(b.artifactId) && str(b.caption)
    case 'file':
      return str(b.artifactId)
    case 'table':
      return (
        strings(b.header) &&
        Array.isArray(b.rows) &&
        b.rows.every((row) => strings(row))
      )
    case 'toggle':
      return str(b.summary) && str(b.text)
    case 'question':
      return (
        str(b.prompt) &&
        str(b.help) &&
        typeof b.multiple === 'boolean' &&
        typeof b.other === 'boolean' &&
        items(b.options, (o) => str(o.id) && str(o.label) && str(o.hint)) &&
        (b.answer === null ||
          (record(b.answer) &&
            strings(b.answer.optionIds) &&
            str(b.answer.other)))
      )
    case 'scale':
      return (
        [b.min, b.max, b.step].every(Number.isSafeInteger) &&
        str(b.prompt) &&
        str(b.minLabel) &&
        str(b.maxLabel) &&
        (b.value === null || Number.isSafeInteger(b.value))
      )
  }
  return false
}

function parseBlock(value: unknown): AnyBlock {
  check(record(value) && str(value.id) && str(value.type))
  return value as AnyBlock
}
export function parseSummary(value: unknown): Summary {
  check(
    record(value) &&
      [
        value.id,
        value.title,
        value.agentId,
        value.chatId,
        value.threadId,
      ].every(str) &&
      str(value.turn) &&
      record(value.context) &&
      str(value.context.kind) &&
      [
        value.currentRevision,
        value.pendingQuestions,
        value.openComments,
        value.revision,
      ].every(Number.isSafeInteger) &&
      typeof value.hasDraft === 'boolean' &&
      str(value.createdAt) &&
      str(value.updatedAt),
  )
  return value as Summary
}
function parseRevision(value: unknown): Revision {
  check(
    record(value) &&
      Number.isSafeInteger(value.number) &&
      str(value.authorKind) &&
      str(value.authorId) &&
      str(value.title) &&
      str(value.note) &&
      str(value.createdAt) &&
      record(value.changes) &&
      strings(value.changes.added) &&
      strings(value.changes.updated) &&
      strings(value.changes.removed),
  )
  return { ...value, blocks: list(value.blocks, parseBlock) } as Revision
}
function parseComment(value: unknown): Comment {
  check(
    record(value) &&
      [value.id, value.blockId, value.field, value.quote, value.body].every(
        str,
      ) &&
      Number.isSafeInteger(value.number) &&
      Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.end) &&
      str(value.state) &&
      (value.reply === null || str(value.reply)),
  )
  return value as Comment
}
function parseDraftComment(value: unknown): Draft {
  check(
    record(value) &&
      [value.id, value.blockId, value.field, value.quote, value.body].every(
        str,
      ) &&
      Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.end),
  )
  return value as Draft
}
export function parseDetail(value: unknown): Detail {
  check(record(value) && record(value.document))
  const draft = value.draft
  check(
    draft === null ||
      (record(draft) &&
        Number.isSafeInteger(draft.draftVersion) &&
        Number.isSafeInteger(draft.baseRevision) &&
        str(draft.title) &&
        str(draft.note)),
  )
  return {
    document: parseSummary(value.document),
    current: parseRevision(value.current),
    draft: draft
      ? ({
          ...draft,
          blocks: list(draft.blocks, parseBlock),
          comments: list(draft.comments, parseDraftComment),
        } as DraftCopy)
      : null,
    comments: list(value.comments, parseComment),
    revisions: list(value.revisions, (info) => {
      check(
        record(info) &&
          Number.isSafeInteger(info.number) &&
          str(info.authorKind) &&
          str(info.authorId) &&
          str(info.note) &&
          str(info.createdAt),
      )
      return info as RevisionInfo
    }),
  }
}

export class DocumentClient {
  readonly endpoint: string
  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
  }
  private async call(
    path: string,
    signal: AbortSignal | undefined,
    method = 'GET',
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/v1/documents${path}`, {
      method,
      cache: 'no-store',
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(15000),
      ]),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await httpError(response)
    if (response.status === 204) return null
    return response
      .json()
      .catch(() => (method === 'GET' ? incompatible() : null))
  }
  async list(signal?: AbortSignal): Promise<Summary[]> {
    const data = await this.call('', signal)
    check(record(data))
    return list(data.documents, parseSummary)
  }
  async detail(id: string, signal?: AbortSignal): Promise<Detail> {
    return parseDetail(await this.call(`/${encodeURIComponent(id)}`, signal))
  }
  async revision(
    id: string,
    number: number,
    signal?: AbortSignal,
  ): Promise<Revision> {
    const data = await this.call(
      `/${encodeURIComponent(id)}/revisions/${number}`,
      signal,
    )
    check(record(data))
    return parseRevision(data.revision)
  }
  async saveDraft(
    id: string,
    write: DraftWrite,
    signal?: AbortSignal,
  ): Promise<number> {
    const data = await this.call(
      `/${encodeURIComponent(id)}/draft`,
      signal,
      'PUT',
      { version: 1, ...write },
    )
    check(record(data) && Number.isSafeInteger(data.draftVersion))
    return data.draftVersion as number
  }
  async discardDraft(id: string) {
    await this.call(`/${encodeURIComponent(id)}/draft`, undefined, 'DELETE')
  }
  async submit(id: string, draftVersion: number, operationId: string) {
    await this.call(`/${encodeURIComponent(id)}/submit`, undefined, 'POST', {
      version: 1,
      operationId,
      draftVersion,
    })
  }
  async takeBack(id: string) {
    await this.call(`/${encodeURIComponent(id)}/take-back`, undefined, 'POST', {
      version: 1,
    })
  }
  async remove(id: string) {
    await this.call(`/${encodeURIComponent(id)}`, undefined, 'DELETE')
  }
  async artifact(
    id: string,
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<Artifact> {
    return parseArtifact(
      await this.call(
        `/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`,
        signal,
      ),
    )
  }
  async content(
    id: string,
    artifact: Artifact,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const response = await fetch(
      `${this.endpoint}/v1/documents/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
      { signal, cache: 'no-store' },
    )
    if (!response.ok) throw new Error('This file is unavailable.')
    const bytes = await response.blob()
    if (
      bytes.size !== artifact.size ||
      (artifact.sha256 && (await digest(bytes)) !== artifact.sha256)
    )
      throw new Error('File integrity verification failed.')
    return new Blob([bytes], { type: artifact.mimeType })
  }
}
