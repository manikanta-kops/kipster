import { array, boolean, boundedInteger, boundedString, integer, literal, nonempty, nullable, object, string, union, utcTimestamp, type Infer, type Schema } from './schema.js'

const id = nonempty()
/**
 * Text inside a block: a small inline Markdown subset of `**bold**`, `*italic*`, `~~strike~~`,
 * `` `code` `` and `[label](https://…)`. Block structure is never encoded in it.
 */
const inline = boundedString(0, 20000)

export const DOCUMENT_LIMITS = { blocks: 500, items: 200, options: 12, tableRows: 100, tableColumns: 12, comments: 200, titleLength: 200, noteLength: 8000, bytes: 512 * 1024 } as const

export const documentContext = union(
  object({ kind: literal('installation'), installationId: id }),
  object({ kind: literal('organization'), organizationId: id }),
)

/** Blocks Core understands. Responses may carry newer block types; clients show a neutral placeholder for them. */
export const documentBlock = union(
  object({ id, type: literal('paragraph'), text: inline }, false),
  object({ id, type: literal('heading'), level: boundedInteger(1, 3), text: inline }, false),
  object({ id, type: literal('list'), ordered: boolean(), items: array(object({ id, text: inline }, false)) }, false),
  object({ id, type: literal('checklist'), items: array(object({ id, text: inline, done: boolean() }, false)) }, false),
  object({ id, type: literal('quote'), text: inline }, false),
  object({ id, type: literal('callout'), tone: union(literal('note'), literal('success'), literal('warning')), text: inline }, false),
  object({ id, type: literal('code'), language: string(), code: string() }, false),
  object({ id, type: literal('divider') }, false),
  object({ id, type: literal('image'), artifactId: id, caption: inline }, false),
  object({ id, type: literal('file'), artifactId: id }, false),
  object({ id, type: literal('table'), header: array(inline), rows: array(array(inline)) }, false),
  object({ id, type: literal('toggle'), summary: inline, text: inline }, false),
  object({ id, type: literal('question'), prompt: inline, help: inline, multiple: boolean(), other: boolean(), options: array(object({ id, label: inline, hint: inline }, false)), answer: nullable(object({ optionIds: array(id), other: string() }, false)) }, false),
  object({ id, type: literal('scale'), prompt: inline, min: boundedInteger(0, 1000), max: boundedInteger(1, 1000), step: boundedInteger(1, 1000), minLabel: inline, maxLabel: inline, value: nullable(boundedInteger(0, 1000)) }, false),
)
export type DocumentBlock = Infer<typeof documentBlock>
const unknownBlock = object({ id, type: nonempty() }, false)
const anyBlock: Schema<DocumentBlock | Infer<typeof unknownBlock>> = union(documentBlock, unknownBlock)

/**
 * Where a comment points: `field` names the text inside the block (`text`, `prompt`, `help`, `caption`,
 * `summary`, `item:<itemId>`, `option:<optionId>`, `cell:<row>:<column>` with header row -1), and
 * `start`/`end` are offsets in that field's plain text with inline Markdown removed.
 */
const anchor = { blockId: id, field: nonempty(), quote: string(), start: integer(), end: integer() }
export const draftComment = object({ id, ...anchor, body: boundedString(1, 4000) }, false)
export type DraftComment = Infer<typeof draftComment>
/** A submitted comment. `open` until a kip resolves it, optionally with a reply. */
export const documentComment = object({ id, number: integer(), ...anchor, body: string(), state: union(literal('open'), literal('resolved')), reply: nullable(string()), submittedInRevision: integer(), resolvedInRevision: nullable(integer()), createdAt: utcTimestamp() }, false)
export type DocumentComment = Infer<typeof documentComment>

const author = union(literal('user'), literal('agent'))
/** `turn` is whose move it is: the user edits and submits, then the kip revises while the doc is locked. */
export const documentSummary = object({
  id,
  title: string(),
  context: documentContext,
  agentId: id,
  chatId: id,
  threadId: id,
  turn: author,
  currentRevision: integer(),
  pendingQuestions: integer(),
  openComments: integer(),
  hasDraft: boolean(),
  createdAt: utcTimestamp(),
  updatedAt: utcTimestamp(),
  revision: integer(),
}, false)
export type DocumentSummary = Infer<typeof documentSummary>
export const documentRevisionInfo = object({ number: integer(), authorKind: author, authorId: id, note: string(), createdAt: utcTimestamp() }, false)
/** `changes` compares this revision with the one before it, by block ID. */
export const documentRevision = object({ number: integer(), authorKind: author, authorId: id, title: string(), blocks: array(anyBlock), note: string(), changes: object({ added: array(id), updated: array(id), removed: array(id) }, false), createdAt: utcTimestamp() }, false)
export type DocumentRevision = Infer<typeof documentRevision>
/** The user's unsubmitted working copy, saved as they go. */
export const documentDraft = object({ draftVersion: integer(), baseRevision: integer(), title: string(), blocks: array(anyBlock), comments: array(draftComment), note: string(), updatedAt: utcTimestamp() }, false)
export type DocumentDraft = Infer<typeof documentDraft>
export const documentDetail = object({ version: literal(1), document: documentSummary, current: documentRevision, draft: nullable(documentDraft), comments: array(documentComment), revisions: array(documentRevisionInfo) }, false)
export type DocumentDetail = Infer<typeof documentDetail>
export const documentList = object({ version: literal(1), documents: array(documentSummary) }, false)
export const documentRevisionResult = object({ version: literal(1), revision: documentRevision }, false)

/** `expectedDraftVersion` is 0 when no draft exists yet. Saving is allowed only on the user's turn. */
export const documentDraftWrite = object({ version: literal(1), baseRevision: integer(), expectedDraftVersion: integer(), title: boundedString(1, DOCUMENT_LIMITS.titleLength), blocks: array(documentBlock), comments: array(draftComment), note: boundedString(0, DOCUMENT_LIMITS.noteLength) })
export type DocumentDraftWrite = Infer<typeof documentDraftWrite>
export const documentDraftResult = object({ version: literal(1), draftVersion: integer(), updatedAt: utcTimestamp() }, false)
/** Turns the saved draft into a user revision, posts it to the doc's thread and starts the kip's run. */
export const documentSubmit = object({ version: literal(1), operationId: id, draftVersion: integer() })
export const documentSubmitResult = object({ version: literal(1), document: documentSummary, messageId: id, runId: id }, false)
export const documentTakeBack = object({ version: literal(1) })

export const documentRemoved = object({ id }, false)
/** A message part that shows a doc card. Core writes it; clients never submit it. */
export const documentPart = object({ kind: literal('document'), documentId: id, revision: integer() }, false)
