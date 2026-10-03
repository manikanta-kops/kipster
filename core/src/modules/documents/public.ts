import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { isLive, type TrustedActor } from '../identity/public.js'
import { acceptTextIn } from '../conversations/public.js'
import type { ArtifactService } from '../artifacts/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { DOCUMENT_LIMITS, type DocumentComment, type DocumentDetail, type DocumentDraft, type DocumentDraftWrite, type DocumentRevision, type DocumentSummary, type DraftComment } from '../../protocol/documents.js'
import type { Context, MessagePart } from '../../protocol/text.js'
import { applyOperations, artifactIds, changes, checkBlocks, checkComments, editOperations, isKnown, unanswered, withoutAnswers, type WorkingCopy } from './blocks.js'
import { blockMarkdown, parseMarkdown, type StoredBlock } from './markdown.js'

export { parseMarkdown, blockMarkdown, documentMarkdown, MarkdownError, type StoredBlock } from './markdown.js'
export { applyOperations, changes, checkBlocks, editOperations } from './blocks.js'

/** A write that lost a race with another change: wrong turn, stale revision or stale draft version. */
export class DocumentConflictError extends Error {}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Run states after which the run's document turn ends. */
const finished = ['completed', 'failed', 'cancelled', 'recovery-needed']

interface DocumentRow { id: string; installation_id: string; context_kind: 'installation' | 'organization'; context_id: string; agent_id: string; chat_id: string; thread_id: string; title: string; turn: 'user' | 'agent'; turn_run_id: string | null; released_run_id: string | null; current_revision: number; draft_counter: number; revision: string; deleted_at: Date | null; created_at: Date; updated_at: Date }
type Changes = { added: string[]; updated: string[]; removed: string[] }
interface RevisionRow { number: number; author_kind: 'user' | 'agent'; author_id: string; title: string; blocks: StoredBlock[]; note: string; changes: Changes; created_at: Date }
interface DraftRow { draft_version: number; base_revision: number; title: string; blocks: StoredBlock[]; comments: DraftComment[]; note: string; updated_at: Date }
interface CommentRow { id: string; number: number; block_id: string; field: string; quote: string; start_offset: number; end_offset: number; body: string; state: 'open' | 'resolved'; reply: string | null; submitted_in_revision: number; resolved_in_revision: number | null; created_at: Date }
interface WorkingRow { run_id: string; agent_id: string; title: string; blocks: StoredBlock[]; resolutions: WorkingCopy['resolutions'] }
type Owner = Pick<DocumentRow, 'id' | 'installation_id' | 'context_kind' | 'context_id' | 'agent_id' | 'chat_id'>

const contextOf = (row: DocumentRow): DocumentSummary['context'] => row.context_kind === 'installation' ? { kind: 'installation', installationId: row.context_id } : { kind: 'organization', organizationId: row.context_id }

async function requireOwner(client: SqlClient, actor: TrustedActor): Promise<void> {
  const found = await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [actor.installationId, actor.personId])
  if (!found.rows.length) throw new Error('Owner access denied')
}

async function documentRow(client: SqlClient, id: string, installationId: string, lock = true): Promise<DocumentRow> {
  if (!uuid.test(id)) throw new Error('Document not found')
  const row = (await client.query<DocumentRow>(`SELECT * FROM kipster.documents WHERE id=$1 AND installation_id=$2 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [id, installationId])).rows[0]
  if (!row) throw new Error('Document not found')
  return row
}
async function revisionRow(client: SqlClient, documentId: string, number: number): Promise<RevisionRow> {
  const row = (await client.query<RevisionRow>('SELECT number,author_kind,author_id,title,blocks,note,changes,created_at FROM kipster.document_revisions WHERE document_id=$1 AND number=$2', [documentId, number])).rows[0]
  if (!row) throw new Error('Revision not found')
  return row
}
async function draftRow(client: SqlClient, documentId: string): Promise<DraftRow | undefined> {
  return (await client.query<DraftRow>('SELECT draft_version,base_revision,title,blocks,comments,note,updated_at FROM kipster.document_drafts WHERE document_id=$1', [documentId])).rows[0]
}

const revisionRecord = (row: RevisionRow): DocumentRevision => ({ number: row.number, authorKind: row.author_kind, authorId: row.author_id, title: row.title, blocks: row.blocks as DocumentRevision['blocks'], note: row.note, changes: row.changes, createdAt: row.created_at.toISOString() })
const draftRecord = (row: DraftRow): DocumentDraft => ({ draftVersion: row.draft_version, baseRevision: row.base_revision, title: row.title, blocks: row.blocks as DocumentDraft['blocks'], comments: row.comments, note: row.note, updatedAt: row.updated_at.toISOString() })
const commentRecord = (row: CommentRow): DocumentComment => ({ id: row.id, number: row.number, blockId: row.block_id, field: row.field, quote: row.quote, start: row.start_offset, end: row.end_offset, body: row.body, state: row.state, reply: row.reply, submittedInRevision: row.submitted_in_revision, resolvedInRevision: row.resolved_in_revision, createdAt: row.created_at.toISOString() })

async function summary(client: SqlClient, row: DocumentRow): Promise<DocumentSummary> {
  const draft = await draftRow(client, row.id)
  const blocks = draft?.blocks ?? (await revisionRow(client, row.id, row.current_revision)).blocks
  const open = (await client.query<{ n: string }>("SELECT count(*) AS n FROM kipster.document_comments WHERE document_id=$1 AND state='open'", [row.id])).rows[0]!
  return { id: row.id, title: row.title, context: contextOf(row), agentId: row.agent_id, chatId: row.chat_id, threadId: row.thread_id, turn: row.turn, currentRevision: row.current_revision, pendingQuestions: unanswered(blocks), openComments: Number(open.n), hasDraft: !!draft, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revision: Number(row.revision) }
}

/** Records a change of the document and publishes `document-changed` with its summary. */
async function changed(client: SqlClient, row: DocumentRow): Promise<DocumentRow> {
  const next = (await client.query<DocumentRow>('UPDATE kipster.documents SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [row.id])).rows[0]!
  await publishAppEvent(client, next.installation_id, 'document-changed', next.id, Number(next.revision), await summary(client, next))
  return next
}

async function removed(client: SqlClient, row: { id: string; installation_id: string }): Promise<void> {
  const next = (await client.query<{ revision: string }>('UPDATE kipster.documents SET deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision', [row.id])).rows[0]!
  await publishAppEvent(client, row.installation_id, 'document-removed', row.id, Number(next.revision), { id: row.id })
}

async function recordArtifacts(client: SqlClient, documentId: string, blocks: readonly StoredBlock[]): Promise<void> {
  const ids = artifactIds(blocks)
  if (ids.length) await client.query('INSERT INTO kipster.document_artifacts(document_id,artifact_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING', [documentId, ids])
}

/**
 * Image and file blocks may name a ready artifact of the installation that this document already
 * references, that belongs to the document's context or its home chat's context, or that is owned
 * by the document's agent or the editing agent.
 */
async function checkArtifacts(client: SqlClient, document: Owner, blocks: readonly StoredBlock[], editingAgentId: string | null): Promise<void> {
  const ids = artifactIds(blocks)
  if (!ids.length) return
  const chat = (await client.query<{ context_kind: string; context_id: string }>('SELECT context_kind,context_id FROM kipster.direct_chats WHERE id=$1', [document.chat_id])).rows[0]
  for (const id of ids) {
    if (!uuid.test(id)) throw new Error(`Invalid artifact ${id}`)
    const row = (await client.query<{ installation_id: string; owner_kind: string; owner_id: string; state: string; referenced: boolean }>(
      'SELECT a.installation_id,a.owner_kind,a.owner_id,a.state,EXISTS (SELECT 1 FROM kipster.document_artifacts r WHERE r.document_id=$2 AND r.artifact_id=a.id) AS referenced FROM kipster.artifacts a WHERE a.id=$1', [id, document.id])).rows[0]
    const readable = !!row && row.installation_id === document.installation_id && row.state === 'ready' && (row.referenced ||
      (row.owner_kind === document.context_kind && row.owner_id === document.context_id) ||
      (!!chat && row.owner_kind === chat.context_kind && row.owner_id === chat.context_id) ||
      (row.owner_kind === 'agent' && (row.owner_id === document.agent_id || row.owner_id === editingAgentId)))
    if (!readable) throw new Error(`Invalid artifact ${id}: it is not readable in this doc's context`)
  }
}

async function addRevision(client: SqlClient, documentId: string, number: number, author: { kind: 'user' | 'agent'; id: string }, title: string, blocks: readonly StoredBlock[], note: string, previous: readonly StoredBlock[]): Promise<void> {
  await client.query('INSERT INTO kipster.document_revisions(document_id,number,author_kind,author_id,title,blocks,note,changes) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',
    [documentId, number, author.kind, author.id, title, JSON.stringify(blocks), note, JSON.stringify(changes(previous, blocks))])
  await client.query('UPDATE kipster.documents SET current_revision=$2,title=$3 WHERE id=$1', [documentId, number, title])
  await recordArtifacts(client, documentId, blocks)
}

/**
 * Ends the agent's turn once its run has ended: the run's working copy becomes one agent revision,
 * resolving the comments it resolved, and the turn returns to the user. Caller holds the row lock.
 */
async function settleTurn(client: SqlClient, row: DocumentRow): Promise<DocumentRow> {
  if (row.turn !== 'agent' || !row.turn_run_id) return row
  const run = (await client.query<{ state: string }>('SELECT state FROM kipster.text_runs WHERE id=$1', [row.turn_run_id])).rows[0]
  if (run && !finished.includes(run.state)) return row
  const working = (await client.query<WorkingRow>('SELECT run_id,agent_id,title,blocks,resolutions FROM kipster.document_working_copies WHERE document_id=$1', [row.id])).rows[0]
  if (working?.run_id === row.turn_run_id) {
    const current = await revisionRow(client, row.id, row.current_revision)
    const number = row.current_revision + 1
    await addRevision(client, row.id, number, { kind: 'agent', id: working.agent_id }, working.title, working.blocks, '', current.blocks)
    for (const resolution of working.resolutions) {
      await client.query("UPDATE kipster.document_comments SET state='resolved',reply=$3,resolved_in_revision=$4 WHERE document_id=$1 AND id=$2 AND state='open'", [row.id, resolution.commentId, resolution.reply, number])
    }
  }
  await client.query('DELETE FROM kipster.document_working_copies WHERE document_id=$1', [row.id])
  await client.query("UPDATE kipster.documents SET turn='user',turn_run_id=NULL WHERE id=$1", [row.id])
  return changed(client, row)
}

async function settleEach(db: Postgres, sql: string, values: unknown[]): Promise<void> {
  const rows = await db.query<{ id: string }>(sql, values)
  for (const { id } of rows.rows) {
    await db.transaction(async client => {
      const row = (await client.query<DocumentRow>('SELECT * FROM kipster.documents WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
      if (row) await settleTurn(client, row)
    })
  }
}
const pendingTurns = `SELECT d.id FROM kipster.documents d LEFT JOIN kipster.text_runs r ON r.id=d.turn_run_id
  WHERE d.deleted_at IS NULL AND d.turn='agent' AND (r.id IS NULL OR r.state = ANY($2::text[]))`

/** Ends the document turns of a run that has ended. Reads do the same lazily, so a missed call only delays it. */
export async function finishRunDocuments(db: Postgres, runId: string): Promise<void> {
  if (uuid.test(runId)) await settleEach(db, `${pendingTurns} AND d.turn_run_id=$1`, [runId, finished])
}
async function settleInstallation(db: Postgres, installationId: string): Promise<void> {
  await settleEach(db, `${pendingTurns} AND d.installation_id=$1`, [installationId, finished])
}

async function detail(client: SqlClient, row: DocumentRow): Promise<DocumentDetail> {
  const current = await revisionRow(client, row.id, row.current_revision)
  const draft = await draftRow(client, row.id)
  const comments = await client.query<CommentRow>('SELECT * FROM kipster.document_comments WHERE document_id=$1 ORDER BY number', [row.id])
  const revisions = await client.query<{ number: number; author_kind: 'user' | 'agent'; author_id: string; note: string; created_at: Date }>('SELECT number,author_kind,author_id,note,created_at FROM kipster.document_revisions WHERE document_id=$1 ORDER BY number', [row.id])
  return {
    version: 1, document: await summary(client, row), current: revisionRecord(current), draft: draft ? draftRecord(draft) : null,
    comments: comments.rows.map(commentRecord),
    revisions: revisions.rows.map(entry => ({ number: entry.number, authorKind: entry.author_kind, authorId: entry.author_id, note: entry.note, createdAt: entry.created_at.toISOString() })),
  }
}

// Owner operations

export async function listDocuments(db: Postgres, actor: TrustedActor): Promise<{ version: 1; documents: DocumentSummary[] }> {
  await db.transaction(client => requireOwner(client, actor))
  await settleInstallation(db, actor.installationId)
  return db.transaction(async client => {
    const rows = await client.query<DocumentRow>('SELECT * FROM kipster.documents WHERE installation_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC,id', [actor.installationId])
    const documents: DocumentSummary[] = []
    for (const row of rows.rows) documents.push(await summary(client, row))
    return { version: 1 as const, documents }
  })
}

export async function readDocument(db: Postgres, actor: TrustedActor, id: string): Promise<DocumentDetail> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    return detail(client, await settleTurn(client, await documentRow(client, id, actor.installationId)))
  })
}

export async function readRevision(db: Postgres, actor: TrustedActor, id: string, number: number): Promise<{ version: 1; revision: DocumentRevision }> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    const row = await documentRow(client, id, actor.installationId, false)
    return { version: 1 as const, revision: revisionRecord(await revisionRow(client, row.id, number)) }
  })
}

async function checkNewComments(client: SqlClient, documentId: string, comments: readonly DraftComment[]): Promise<void> {
  checkComments(comments)
  if (!comments.length) return
  const taken = (await client.query<{ id: string }>('SELECT id FROM kipster.document_comments WHERE document_id=$1 AND id = ANY($2::text[]) LIMIT 1', [documentId, comments.map(comment => comment.id)])).rows[0]
  if (taken) throw new Error(`Invalid comments: ID ${taken.id} is already used`)
}

/** Saves the user's draft. Allowed only on the user's turn, against the current revision and draft version. */
export async function saveDraft(db: Postgres, actor: TrustedActor, id: string, input: DocumentDraftWrite): Promise<{ version: 1; draftVersion: number; updatedAt: string }> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    const row = await settleTurn(client, await documentRow(client, id, actor.installationId))
    if (row.turn !== 'user') throw new DocumentConflictError('The kip is revising this doc')
    if (input.baseRevision !== row.current_revision) throw new DocumentConflictError('The doc has a newer revision')
    const draft = await draftRow(client, row.id)
    if ((draft?.draft_version ?? 0) !== input.expectedDraftVersion) throw new DocumentConflictError('The draft was changed elsewhere')
    if (!input.title.trim()) throw new Error('Invalid title')
    checkBlocks(input.blocks)
    await checkNewComments(client, row.id, input.comments)
    await checkArtifacts(client, row, input.blocks, null)
    const before = await summary(client, row)
    const draftVersion = row.draft_counter + 1
    const saved = (await client.query<{ updated_at: Date }>(`INSERT INTO kipster.document_drafts(document_id,draft_version,base_revision,title,blocks,comments,note) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
      ON CONFLICT (document_id) DO UPDATE SET draft_version=EXCLUDED.draft_version,base_revision=EXCLUDED.base_revision,title=EXCLUDED.title,blocks=EXCLUDED.blocks,comments=EXCLUDED.comments,note=EXCLUDED.note,updated_at=now()
      RETURNING updated_at`, [row.id, draftVersion, input.baseRevision, input.title, JSON.stringify(input.blocks), JSON.stringify(input.comments), input.note])).rows[0]!
    await client.query('UPDATE kipster.documents SET draft_counter=$2 WHERE id=$1', [row.id, draftVersion])
    await recordArtifacts(client, row.id, input.blocks)
    const after = await summary(client, row)
    // Autosave publishes only what the summary shows: whether a draft exists and its open questions.
    if (before.hasDraft !== after.hasDraft || before.pendingQuestions !== after.pendingQuestions) await changed(client, row)
    return { version: 1 as const, draftVersion, updatedAt: saved.updated_at.toISOString() }
  })
}

export async function discardDraft(db: Postgres, actor: TrustedActor, id: string): Promise<DocumentDetail> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    let row = await settleTurn(client, await documentRow(client, id, actor.installationId))
    if ((await client.query('DELETE FROM kipster.document_drafts WHERE document_id=$1', [row.id])).rowCount) row = await changed(client, row)
    return detail(client, row)
  })
}

/**
 * Turns the draft (or, without one, the current content) into a user revision, opens its comments,
 * posts `[note, document card]` to the home thread and starts the agent's run there, as a reply
 * submission does. The agent's turn lasts until that run ends. Repeating an operation ID returns its result.
 */
export async function submitDocument(db: Postgres, jobs: Jobs, artifacts: ArtifactService, actor: TrustedActor, id: string, input: { operationId: string; draftVersion: number }): Promise<{ version: 1; document: DocumentSummary; messageId: string; runId: string }> {
  if (input.operationId.length > 200) throw new Error('Invalid operation ID')
  return db.transaction(async client => {
    await requireOwner(client, actor)
    const prior = (await client.query<{ document_id: string; message_id: string; run_id: string }>('SELECT document_id,message_id,run_id FROM kipster.document_submissions WHERE installation_id=$1 AND caller_id=$2 AND operation_id=$3', [actor.installationId, actor.personId, input.operationId])).rows[0]
    if (prior) {
      if (prior.document_id !== id) throw new DocumentConflictError('Operation ID was used for another doc')
      const row = (await client.query<DocumentRow>('SELECT * FROM kipster.documents WHERE id=$1', [id])).rows[0]!
      return { version: 1 as const, document: await summary(client, row), messageId: prior.message_id, runId: prior.run_id }
    }
    let row = await settleTurn(client, await documentRow(client, id, actor.installationId))
    if (row.turn !== 'user') throw new DocumentConflictError('The kip is revising this doc')
    const draft = await draftRow(client, row.id)
    if ((draft?.draft_version ?? 0) !== input.draftVersion) throw new DocumentConflictError('The draft was changed elsewhere')
    if (draft && draft.base_revision !== row.current_revision) throw new DocumentConflictError('The doc has a newer revision')
    const current = await revisionRow(client, row.id, row.current_revision)
    const title = draft?.title ?? current.title, blocks = draft?.blocks ?? current.blocks, note = draft?.note ?? '', comments = draft?.comments ?? []
    await checkNewComments(client, row.id, comments)
    const number = row.current_revision + 1
    await addRevision(client, row.id, number, { kind: 'user', id: actor.personId }, title, blocks, note, current.blocks)
    const last = (await client.query<{ n: number | null }>('SELECT max(number) AS n FROM kipster.document_comments WHERE document_id=$1', [row.id])).rows[0]!.n ?? 0
    for (const [index, comment] of comments.entries()) {
      await client.query(`INSERT INTO kipster.document_comments(document_id,id,number,block_id,field,quote,start_offset,end_offset,body,state,submitted_in_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10)`,
        [row.id, comment.id, last + index + 1, comment.blockId, comment.field, comment.quote, comment.start, comment.end, comment.body, number])
    }
    await client.query('DELETE FROM kipster.document_drafts WHERE document_id=$1', [row.id])
    const chat = (await client.query<{ context_kind: 'installation' | 'organization'; context_id: string }>('SELECT context_kind,context_id FROM kipster.direct_chats WHERE id=$1', [row.chat_id])).rows[0]
    if (!chat) throw new Error('Thread not found in chat')
    const chatContext: Context = chat.context_kind === 'installation' ? { kind: 'installation', installationId: chat.context_id } : { kind: 'organization', organizationId: chat.context_id }
    const receipt = await acceptTextIn(client, jobs, artifacts, actor, {
      version: 1, submissionId: `document:${input.operationId}`, scope: { installationId: actor.installationId, callerId: actor.personId },
      target: { context: chatContext, chatId: row.chat_id }, mode: 'reply', threadId: row.thread_id, parts: note.trim() ? [{ kind: 'text', text: note }] : [],
    }, [{ kind: 'document', documentId: row.id, revision: number }])
    if (receipt.alreadyAccepted) throw new DocumentConflictError('Operation ID was already used')
    await client.query('INSERT INTO kipster.document_submissions(installation_id,caller_id,operation_id,document_id,message_id,run_id) VALUES ($1,$2,$3,$4,$5,$6)', [actor.installationId, actor.personId, input.operationId, row.id, receipt.messageId, receipt.runId])
    await client.query("UPDATE kipster.documents SET turn='agent',turn_run_id=$2,released_run_id=NULL WHERE id=$1", [row.id, receipt.runId])
    row = await changed(client, row)
    return { version: 1 as const, document: await summary(client, row), messageId: receipt.messageId, runId: receipt.runId }
  })
}

/** Ends the agent's turn now: its unpublished edits are discarded and its run cannot edit again. */
export async function takeBack(db: Postgres, actor: TrustedActor, id: string): Promise<DocumentDetail> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    let row = await settleTurn(client, await documentRow(client, id, actor.installationId))
    if (row.turn === 'agent') {
      await client.query('DELETE FROM kipster.document_working_copies WHERE document_id=$1', [row.id])
      await client.query("UPDATE kipster.documents SET turn='user',released_run_id=turn_run_id,turn_run_id=NULL WHERE id=$1", [row.id])
      row = await changed(client, row)
    }
    return detail(client, row)
  })
}

export async function deleteDocument(db: Postgres, actor: TrustedActor, id: string): Promise<{ version: 1; id: string }> {
  return db.transaction(async client => {
    await requireOwner(client, actor)
    await removed(client, await documentRow(client, id, actor.installationId))
    return { version: 1 as const, id }
  })
}

/** Authorizes reading an artifact through a document: the document references it. */
export async function documentArtifact(db: Postgres, actor: TrustedActor, id: string, artifactId: string): Promise<void> {
  await db.transaction(async client => {
    await requireOwner(client, actor)
    const row = await documentRow(client, id, actor.installationId, false)
    const found = uuid.test(artifactId) && (await client.query('SELECT 1 FROM kipster.document_artifacts WHERE document_id=$1 AND artifact_id=$2', [row.id, artifactId])).rows.length > 0
    if (!found) throw new Error('Artifact not found')
  })
}

/** Removes the documents whose home is one of the threads being removed. Caller holds the thread locks. */
export async function removeThreadDocuments(client: SqlClient, installationId: string, threadId: string): Promise<void> {
  const rows = await client.query<{ id: string; revision: string; deleted_at: Date | null }>('DELETE FROM kipster.documents WHERE installation_id=$1 AND thread_id=$2 RETURNING id,revision,deleted_at', [installationId, threadId])
  for (const row of rows.rows) if (!row.deleted_at) await publishAppEvent(client, installationId, 'document-removed', row.id, Number(row.revision) + 1, { id: row.id })
}

/** Removes the documents that belong to an organization being deleted. */
export async function removeOrganizationDocuments(client: SqlClient, installationId: string, organizationId: string): Promise<void> {
  const rows = await client.query<{ id: string; revision: string; deleted_at: Date | null }>("DELETE FROM kipster.documents WHERE installation_id=$1 AND context_kind='organization' AND context_id=$2 RETURNING id,revision,deleted_at", [installationId, organizationId])
  for (const row of rows.rows) if (!row.deleted_at) await publishAppEvent(client, installationId, 'document-removed', row.id, Number(row.revision) + 1, { id: row.id })
}

// Agent tools

interface RunScope { runId: string; installationId: string; agentId: string; contextKind: 'installation' | 'organization'; contextId: string; rootAdmin: boolean }

/** The live run of an issued attempt. With `lock`, the run row is share-locked, so the run cannot end until the caller commits. */
async function boundRun(client: SqlClient, attemptId: string, incarnation: string, lock: boolean): Promise<RunScope> {
  const row = uuid.test(attemptId) ? (await client.query<{ run_id: string; installation_id: string; agent_id: string; context_kind: 'installation' | 'organization'; context_id: string; attempt_state: string; run_state: string; stop_requested: boolean; current_attempt_id: string }>(
    `SELECT r.id AS run_id,c.installation_id,COALESCE(d.recipient_agent_id,c.agent_id) AS agent_id,c.context_kind,c.context_id,a.state AS attempt_state,r.state AS run_state,r.stop_requested,r.current_attempt_id
     FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
     WHERE a.id=$1 AND a.incarnation=$2${lock ? ' FOR SHARE OF r' : ''}`, [attemptId, incarnation])).rows[0] : undefined
  if (!row || row.attempt_state !== 'issued' || row.current_attempt_id !== attemptId || !['running', 'waiting'].includes(row.run_state) || row.stop_requested) throw new Error('Attempt no longer owns document tools')
  const rootAdmin = (await client.query("SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role='root-admin'", [row.agent_id])).rows.length > 0
  return { runId: row.run_id, installationId: row.installation_id, agentId: row.agent_id, contextKind: row.context_kind, contextId: row.context_id, rootAdmin }
}

/** An agent sees the documents of the context it works in; the admin agent sees every document. */
async function visibleDocument(client: SqlClient, scope: RunScope, id: string): Promise<DocumentRow> {
  const row = await documentRow(client, id, scope.installationId)
  if (!scope.rootAdmin && (row.context_kind !== scope.contextKind || row.context_id !== scope.contextId)) throw new Error('Document not found')
  return row
}

function fields(value: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Invalid ${tool} arguments: unknown field ${key}`)
}
function documentIdArgument(value: Record<string, unknown>, tool: string): string {
  if (typeof value.documentId !== 'string' || !value.documentId) throw new Error(`Invalid ${tool} arguments: documentId is required`)
  return value.documentId
}

async function artifactNames(client: SqlClient, blocks: readonly StoredBlock[]): Promise<Map<string, string>> {
  const ids = artifactIds(blocks).filter(id => uuid.test(id))
  if (!ids.length) return new Map()
  const rows = await client.query<{ id: string; name: string }>('SELECT id,name FROM kipster.artifacts WHERE id = ANY($1::uuid[])', [ids])
  return new Map(rows.rows.map(row => [row.id, row.name]))
}
async function markdownBlocks(client: SqlClient, blocks: readonly StoredBlock[]): Promise<{ id: string; markdown: string }[]> {
  const names = await artifactNames(client, blocks)
  return blocks.map(block => ({ id: block.id, markdown: blockMarkdown(block, names) }))
}

export interface DocumentCreation { title: string; markdown: string; organizationId?: string }
export function documentCreation(value: Record<string, unknown>): DocumentCreation {
  fields(value, ['title', 'markdown', 'organizationId'], 'documents.create')
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > DOCUMENT_LIMITS.titleLength) throw new Error(`Invalid title: 1 to ${DOCUMENT_LIMITS.titleLength} characters`)
  if (typeof value.markdown !== 'string' || Buffer.byteLength(value.markdown) > DOCUMENT_LIMITS.bytes) throw new Error('Invalid markdown: a string of at most 512 KiB')
  if (value.organizationId !== undefined && (typeof value.organizationId !== 'string' || !uuid.test(value.organizationId))) throw new Error('Invalid organizationId')
  return { title: value.title.trim(), markdown: value.markdown, ...(typeof value.organizationId === 'string' ? { organizationId: value.organizationId } : {}) }
}

/**
 * Creates a document as revision 1 by the agent, on the user's turn, in the run's context or, for the
 * admin agent, an organization it names. Runs in the transaction that publishes the returned
 * document card in the run's thread. One call ID creates one document.
 */
export async function createDocumentIn(client: SqlClient, run: { installationId: string; attemptId: string; agentId: string; chatId: string; threadId: string; context: Context }, callId: string, input: DocumentCreation): Promise<MessagePart[]> {
  const prior = (await client.query<{ id: string }>('SELECT id FROM kipster.documents WHERE created_attempt_id=$1 AND created_call_id=$2', [run.attemptId, callId])).rows[0]
  if (prior) return [{ kind: 'document', documentId: prior.id, revision: 1 }]
  let context = run.context
  if (input.organizationId !== undefined && !(context.kind === 'organization' && context.organizationId === input.organizationId)) {
    const root = (await client.query("SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role='root-admin'", [run.agentId])).rows.length > 0
    if (!root) throw new Error('Only Kip can create a doc in another workspace')
    if (!await isLive(client, run.installationId, 'organization', input.organizationId, false)) throw new Error('Organization not found')
    context = { kind: 'organization', organizationId: input.organizationId }
  }
  const blocks = parseMarkdown(input.markdown)
  checkBlocks(blocks)
  const document: Owner = { id: randomUUID(), installation_id: run.installationId, context_kind: context.kind, context_id: context.kind === 'installation' ? context.installationId : context.organizationId, agent_id: run.agentId, chat_id: run.chatId }
  await checkArtifacts(client, document, blocks, run.agentId)
  await client.query(`INSERT INTO kipster.documents(id,installation_id,context_kind,context_id,agent_id,chat_id,thread_id,title,turn,current_revision,created_attempt_id,created_call_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',1,$9,$10)`,
    [document.id, document.installation_id, document.context_kind, document.context_id, run.agentId, run.chatId, run.threadId, input.title, run.attemptId, callId])
  await addRevision(client, document.id, 1, { kind: 'agent', id: run.agentId }, input.title, blocks, '', [])
  const row = (await client.query<DocumentRow>('SELECT * FROM kipster.documents WHERE id=$1', [document.id])).rows[0]!
  await publishAppEvent(client, row.installation_id, 'document-changed', row.id, Number(row.revision), await summary(client, row))
  return [{ kind: 'document', documentId: row.id, revision: 1 }]
}

export async function createdDocument(db: Postgres, attemptId: string, callId: string): Promise<{ documentId: string; revision: number }> {
  const row = (await db.query<{ id: string }>('SELECT id FROM kipster.documents WHERE created_attempt_id=$1 AND created_call_id=$2', [attemptId, callId])).rows[0]
  if (!row) throw new Error('Document not found')
  return { documentId: row.id, revision: 1 }
}

/** `documents.list`, `documents.read`, `documents.edit` and `documents.delete` for the agent of a live attempt. */
export async function documentTool(db: Postgres, attemptId: string, incarnation: string, name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === 'documents.list') {
    fields(input, [], name)
    const scope = await db.transaction(client => boundRun(client, attemptId, incarnation, false))
    await settleInstallation(db, scope.installationId)
    return db.transaction(async client => {
      const rows = await client.query<DocumentRow>(`SELECT * FROM kipster.documents WHERE installation_id=$1 AND deleted_at IS NULL AND ($2 OR (context_kind=$3 AND context_id=$4)) ORDER BY updated_at DESC,id`, [scope.installationId, scope.rootAdmin, scope.contextKind, scope.contextId])
      const documents = []
      for (const row of rows.rows) {
        const item = await summary(client, row)
        documents.push({ documentId: item.id, title: item.title, context: item.context, agentId: item.agentId, turn: item.turn, revision: item.currentRevision, pendingQuestions: item.pendingQuestions, openComments: item.openComments, updatedAt: item.updatedAt })
      }
      return { documents }
    })
  }
  if (name === 'documents.read') {
    fields(input, ['documentId', 'revision'], name)
    const id = documentIdArgument(input, name)
    if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1)) throw new Error('Invalid documents.read arguments: revision must be a positive integer')
    return db.transaction(async client => {
      const scope = await boundRun(client, attemptId, incarnation, false)
      const row = await settleTurn(client, await visibleDocument(client, scope, id))
      const working = input.revision === undefined && row.turn === 'agent' && row.turn_run_id === scope.runId
        ? (await client.query<WorkingRow>('SELECT run_id,agent_id,title,blocks,resolutions FROM kipster.document_working_copies WHERE document_id=$1 AND run_id=$2', [row.id, scope.runId])).rows[0]
        : undefined
      const shown = working ?? await revisionRow(client, row.id, (input.revision as number | undefined) ?? row.current_revision)
      const resolved = new Set(working?.resolutions.map(entry => entry.commentId) ?? [])
      const open = (await client.query<CommentRow>("SELECT * FROM kipster.document_comments WHERE document_id=$1 AND state='open' ORDER BY number", [row.id])).rows.filter(comment => !resolved.has(comment.id))
      const last = (await client.query<{ number: number; note: string; created_at: Date }>("SELECT number,note,created_at FROM kipster.document_revisions WHERE document_id=$1 AND author_kind='user' ORDER BY number DESC LIMIT 1", [row.id])).rows[0]
      return {
        documentId: row.id, title: shown.title, revision: 'number' in shown ? shown.number : row.current_revision, turn: row.turn,
        ...(working ? { unpublishedEdits: true } : {}),
        blocks: await markdownBlocks(client, shown.blocks),
        openComments: open.map(comment => ({ id: comment.id, number: comment.number, blockId: comment.block_id, quote: comment.quote, body: comment.body })),
        ...(last ? { lastSubmission: { revision: last.number, note: last.note, submittedAt: last.created_at.toISOString() } } : {}),
      }
    })
  }
  if (name === 'documents.edit') {
    fields(input, ['documentId', 'operations'], name)
    const id = documentIdArgument(input, name)
    const operations = editOperations(input.operations)
    return db.transaction(async client => {
      const scope = await boundRun(client, attemptId, incarnation, true)
      let row = await settleTurn(client, await visibleDocument(client, scope, id))
      if (row.released_run_id === scope.runId) throw new Error('The user took this doc back, so this run can no longer edit it. Ask the user before editing it again.')
      if (row.turn === 'agent' && row.turn_run_id !== scope.runId) throw new Error('Another run is revising this doc. Try again after it finishes.')
      const taking = row.turn === 'user'
      if (taking && await draftRow(client, row.id)) throw new Error('The user has unsubmitted changes in this doc, so it cannot be edited now. Ask the user to submit the doc first.')
      const saved = taking ? undefined : (await client.query<WorkingRow>('SELECT run_id,agent_id,title,blocks,resolutions FROM kipster.document_working_copies WHERE document_id=$1 AND run_id=$2', [row.id, scope.runId])).rows[0]
      const base = saved ?? { ...await revisionRow(client, row.id, row.current_revision), resolutions: [] }
      const open = new Set((await client.query<{ id: string }>("SELECT id FROM kipster.document_comments WHERE document_id=$1 AND state='open'", [row.id])).rows.map(comment => comment.id))
      const copy = applyOperations({ title: base.title, blocks: base.blocks, resolutions: base.resolutions }, operations, open)
      checkBlocks(copy.blocks)
      await checkArtifacts(client, row, copy.blocks, scope.agentId)
      await client.query(`INSERT INTO kipster.document_working_copies(document_id,run_id,agent_id,title,blocks,resolutions) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
        ON CONFLICT (document_id) DO UPDATE SET run_id=EXCLUDED.run_id,agent_id=EXCLUDED.agent_id,title=EXCLUDED.title,blocks=EXCLUDED.blocks,resolutions=EXCLUDED.resolutions,updated_at=now()`,
        [row.id, scope.runId, scope.agentId, copy.title, JSON.stringify(copy.blocks), JSON.stringify(copy.resolutions)])
      await recordArtifacts(client, row.id, copy.blocks)
      if (taking) {
        await client.query("UPDATE kipster.documents SET turn='agent',turn_run_id=$2 WHERE id=$1", [row.id, scope.runId])
        row = await changed(client, row)
      }
      return {
        documentId: row.id, title: copy.title, publishedRevision: row.current_revision,
        blocks: await markdownBlocks(client, copy.blocks), resolvedComments: copy.resolutions.map(entry => entry.commentId),
        note: `These edits become revision ${row.current_revision + 1} when this run ends.`,
      }
    })
  }
  if (name === 'documents.delete') {
    fields(input, ['documentId'], name)
    const id = documentIdArgument(input, name)
    return db.transaction(async client => {
      const scope = await boundRun(client, attemptId, incarnation, true)
      await removed(client, await visibleDocument(client, scope, id))
      return { documentId: id, deleted: true }
    })
  }
  throw new Error('Unsupported document tool')
}

// Execution input

const quoted = (text: string): string => JSON.stringify(text.replace(/\s+/g, ' ').trim())

/** The text an agent receives for a document card in its conversation history. */
export async function documentInput(db: Postgres, documentId: string, number: number): Promise<string> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const row = uuid.test(documentId) ? (await client.query<DocumentRow>('SELECT * FROM kipster.documents WHERE id=$1', [documentId])).rows[0] : undefined
    const revision = row && !row.deleted_at ? (await client.query<RevisionRow>('SELECT number,author_kind,author_id,title,blocks,note,changes,created_at FROM kipster.document_revisions WHERE document_id=$1 AND number=$2', [documentId, number])).rows[0] : undefined
    if (!revision) return `[Rich doc ${documentId}, revision ${number}, was deleted.]`
    const label = `rich doc ${quoted(revision.title)} (doc ID ${documentId}, revision ${number})`
    if (revision.author_kind === 'agent') return `[Shared ${label}. Read it with documents_read and change it with documents_edit.]`
    const previous = number > 1 ? await revisionRow(client, documentId, number - 1) : undefined
    const before = new Map((previous?.blocks ?? []).map(block => [block.id, block]))
    const names = await artifactNames(client, revision.blocks)
    const lines = [`The user submitted ${label}.`]
    if (previous && previous.title !== revision.title) lines.push(`Title changed from ${quoted(previous.title)} to ${quoted(revision.title)}.`)
    if (revision.note.trim()) lines.push('', 'Note from the user:', revision.note.trim())
    const answers: string[] = [], checks: string[] = []
    for (const block of revision.blocks) {
      if (!isKnown(block)) continue
      if (block.type === 'question') {
        const chosen = block.answer ? block.options.filter(option => block.answer!.optionIds.includes(option.id)).map(option => option.label) : []
        if (block.answer?.other) chosen.push(`Other: ${block.answer.other}`)
        answers.push(`- ${quoted(block.prompt)} (block ${block.id}): ${chosen.length ? chosen.join('; ') : 'no answer'}`)
      }
      if (block.type === 'scale') answers.push(`- ${quoted(block.prompt)} (block ${block.id}): ${block.value === null ? 'no answer' : `${block.value} on ${block.min} to ${block.max}`}`)
      const old = before.get(block.id)
      if (block.type === 'checklist' && old && isKnown(old) && old.type === 'checklist') {
        for (const item of block.items) {
          const was = old.items.find(entry => entry.id === item.id)
          if (was && was.done !== item.done) checks.push(`- ${item.done ? 'Checked' : 'Unchecked'} ${quoted(item.text)} (block ${block.id})`)
        }
      }
    }
    if (answers.length) lines.push('', 'Answers:', ...answers)
    if (checks.length) lines.push('', 'Checklist changes:', ...checks)
    const edits: string[] = []
    for (const id of revision.changes.added) {
      const block = revision.blocks.find(entry => entry.id === id)
      if (block) edits.push(`- Added block ${id}:`, blockMarkdown(block, names))
    }
    for (const id of revision.changes.updated) {
      const block = revision.blocks.find(entry => entry.id === id), old = before.get(id)
      if (block && old && JSON.stringify(withoutAnswers(block)) !== JSON.stringify(withoutAnswers(old))) edits.push(`- Edited block ${id}:`, blockMarkdown(block, names))
    }
    for (const id of revision.changes.removed) edits.push(`- Removed block ${id} (${before.get(id)?.type ?? 'block'})`)
    if (edits.length) lines.push('', 'Edits:', ...edits)
    const comments = (await client.query<CommentRow>('SELECT * FROM kipster.document_comments WHERE document_id=$1 AND submitted_in_revision=$2 ORDER BY number', [documentId, number])).rows
    if (comments.length) lines.push('', 'Comments:', ...comments.map(comment => `- Comment ${comment.id} (#${comment.number}) on block ${comment.block_id}, quoting ${quoted(comment.quote)}: ${comment.body}`))
    lines.push('', `Call documents_read with documentId ${documentId} to see the whole doc, then documents_edit to revise it and resolve each comment (op "resolve" with its comment ID and an optional reply). Your edits become the next revision when this run ends.`)
    return lines.join('\n')
  })
}
