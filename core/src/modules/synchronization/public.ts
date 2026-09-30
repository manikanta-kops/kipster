export { eventSignals } from './signals.js'
import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { RefusedError } from '../../platform/errors/public.js'

export type Stream = { kind: 'application'; installationId: string; callerId: string } | { kind: 'thread'; installationId: string; callerId: string; threadId: string }
export interface StreamEvent { version: 1; eventId: string; scope: Stream; cursor: string; occurredAt: string; resourceId: string; revision: number; type: string; data: unknown }
const appCursor = (id: string, n: number) => `a:${id}:${n}`
const threadCursor = (id: string, n: number) => `t:${id}:${n}`
const streamCursor = (scope: Stream, n: number) => scope.kind === 'application' ? appCursor(scope.installationId, n) : threadCursor(scope.threadId, n)

function parseCursor(scope: Stream, value: string): number {
  const prefix = scope.kind === 'application' ? `a:${scope.installationId}:` : `t:${scope.threadId}:`
  if (!value.startsWith(prefix) || !/^(0|[1-9]\d*)$/.test(value.slice(prefix.length))) throw new Error('Invalid stream cursor')
  const position = Number(value.slice(prefix.length))
  if (!Number.isSafeInteger(position)) throw new Error('Invalid stream cursor')
  return position
}

async function authorized(client: SqlClient, scope: Stream): Promise<void> {
  const owner = await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [scope.installationId, scope.callerId])
  if (!owner.rows.length) throw new Error('Owner access denied')
  if (scope.kind === 'thread') {
    const thread = (await client.query<{ internal: boolean; installation_id: string; caller_id: string; present: boolean }>('SELECT t.internal,c.installation_id,c.caller_id,kipster.chat_present(c.id) AS present FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE t.id=$1', [scope.threadId])).rows[0]
    if (!thread) throw new RefusedError('gone', 'Thread is gone')
    if (thread.internal || thread.installation_id !== scope.installationId || thread.caller_id !== scope.callerId) throw new Error('Thread access denied')
    if (!thread.present) throw new RefusedError('gone', 'Thread is gone')
  }
}

/** Whether clients may still see the chat: see `kipster.chat_present`. */
export async function chatPresent(client: SqlClient, chatId: string): Promise<boolean> {
  return !!(await client.query<{ present: boolean }>('SELECT kipster.chat_present($1) AS present', [chatId])).rows[0]?.present
}

/** Wake readers after a transaction changes visibility without adding a thread event. */
export async function notifyThread(client: SqlClient, threadId: string): Promise<void> {
  await client.query("SELECT pg_notify('kipster_events',$1)", [`t:${threadId}`])
}

/** Caller already holds the thread row. Thread and app counters are commit-order locks. */
export async function publishThreadChange(client: SqlClient, installationId: string, callerId: string, threadId: string, chatId: string, type: string, resourceId: string, revision: number, data: unknown, state: string, lastMessageId: string | null, summarize = true): Promise<void> {
  const thread = (await client.query<{ next_event_position: string; revision: string; created_at: Date; internal:boolean }>('UPDATE kipster.threads SET next_event_position=next_event_position+1,revision=revision+1 WHERE id=$1 RETURNING next_event_position,revision,created_at,internal', [threadId])).rows[0]!
  const threadPosition = Number(thread.next_event_position) - 1
  await client.query('INSERT INTO kipster.thread_events(thread_id,position,event_id,type,resource_id,revision,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [threadId, threadPosition, randomUUID(), type, resourceId, revision, JSON.stringify(data)])
  await notifyThread(client, threadId)
  await retainEvents(client, 'thread', threadId, threadPosition)
  if(thread.internal || !summarize)return
  const chat = (await client.query<{ context_kind: string; context_id: string; agent_id: string; present: boolean }>('SELECT context_kind,context_id,agent_id,kipster.chat_present(id) AS present FROM kipster.direct_chats WHERE id=$1', [chatId])).rows[0]!
  // A chat that is gone leaves the application projection; clients drop it with its owner.
  if (!chat.present) return
  await client.query('INSERT INTO kipster.app_streams(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [installationId])
  const app = (await client.query<{ next_position: string }>('SELECT next_position FROM kipster.app_streams WHERE installation_id=$1 FOR UPDATE', [installationId])).rows[0]!
  const position = Number(app.next_position)
  const threadRevision = Number(thread.revision)
  const previous = (await client.query<{ last_message_id: string }>('SELECT last_message_id FROM kipster.app_thread_summaries WHERE installation_id=$1 AND caller_id=$2 AND thread_id=$3', [installationId, callerId, threadId])).rows[0]
  const latestMessageId = lastMessageId ?? previous?.last_message_id
  if (!latestMessageId) throw new Error('Thread summary requires a canonical message')
  await client.query('UPDATE kipster.app_streams SET next_position=next_position+1 WHERE installation_id=$1', [installationId])
  await client.query(`INSERT INTO kipster.app_thread_summaries(installation_id,caller_id,thread_id,chat_id,revision,state,last_message_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (installation_id,caller_id,thread_id) DO UPDATE
    SET revision=EXCLUDED.revision,state=EXCLUDED.state,last_message_id=EXCLUDED.last_message_id
    WHERE kipster.app_thread_summaries.revision <= EXCLUDED.revision`, [installationId, callerId, threadId, chatId, threadRevision, state, latestMessageId])
  const intentId = randomUUID()
  await client.query('INSERT INTO kipster.app_projection_intents(id,installation_id,thread_id,resource_revision,app_position,projected) VALUES ($1,$2,$3,$4,$5,true)', [intentId, installationId, threadId, threadRevision, position])
  await client.query('INSERT INTO kipster.app_events(installation_id,position,event_id,type,resource_id,revision,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [installationId, position, randomUUID(), 'thread-summary', threadId, threadRevision, JSON.stringify({ threadId, chatId, contextKind: chat.context_kind, contextId: chat.context_id, agentId: chat.agent_id, revision: threadRevision, state, lastMessageId: latestMessageId, createdAt: thread.created_at.toISOString() })])
  await client.query("SELECT pg_notify('kipster_events',$1)", [`a:${installationId}`])
  await retainEvents(client, 'application', installationId, position)
}

/** Installation-wide application event, ordered by the caller's transaction. */
export async function publishAppEvent(client: SqlClient, installationId: string, type: string, resourceId: string, revision: number, data: unknown): Promise<void> {
  await client.query('INSERT INTO kipster.app_streams(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [installationId])
  const counter = (await client.query<{ next_position: string }>('SELECT next_position FROM kipster.app_streams WHERE installation_id=$1 FOR UPDATE', [installationId])).rows[0]!
  await client.query('UPDATE kipster.app_streams SET next_position=next_position+1 WHERE installation_id=$1', [installationId])
  await client.query('INSERT INTO kipster.app_events(installation_id,position,event_id,type,resource_id,revision,data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [installationId, Number(counter.next_position), randomUUID(), type, resourceId, revision, JSON.stringify(data)])
  await client.query("SELECT pg_notify('kipster_events',$1)", [`a:${installationId}`])
  await retainEvents(client, 'application', installationId, Number(counter.next_position))
}

interface NotificationRow { id: string; thread_id: string; run_id: string; kind: string; interaction_id: string | null; interaction_state: string | null; read_at: Date | null; revision: string; created_at: Date }
const notificationColumns = 'n.id,n.thread_id,n.run_id,n.kind,n.interaction_id,x.state AS interaction_state,n.read_at,n.revision,n.created_at'
const notificationSource = 'kipster.notifications n JOIN kipster.threads t ON t.id=n.thread_id LEFT JOIN kipster.interactions x ON x.id=n.interaction_id'
function notificationRecord(row: NotificationRow): Record<string, unknown> {
  return { id: row.id, threadId: row.thread_id, runId: row.run_id, kind: row.kind, ...(row.interaction_id ? { interactionId: row.interaction_id, interactionState: row.interaction_state } : {}), read: row.read_at !== null, revision: Number(row.revision), createdAt: row.created_at.toISOString() }
}

/** Locks the application stream counter. Notification writers take it before the notification row. */
async function lockApplicationStream(client: SqlClient, installationId: string): Promise<void> {
  await client.query('INSERT INTO kipster.app_streams(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [installationId])
  await client.query('SELECT 1 FROM kipster.app_streams WHERE installation_id=$1 FOR UPDATE', [installationId])
}
async function publishNotification(client: SqlClient, installationId: string, notificationId: string): Promise<void> {
  const row = (await client.query<NotificationRow>(`SELECT ${notificationColumns} FROM ${notificationSource} WHERE n.id=$1`, [notificationId])).rows[0]!
  await publishAppEvent(client, installationId, 'notification', row.id, Number(row.revision), notificationRecord(row))
}
async function insertNotification(client: SqlClient, installationId: string, callerId: string, threadId: string, runId: string, kind: string, interactionId: string | null): Promise<void> {
  const thread = (await client.query<{ internal: boolean; present: boolean }>('SELECT internal,kipster.chat_present(chat_id) AS present FROM kipster.threads WHERE id=$1', [threadId])).rows[0]
  if (!thread || thread.internal || !thread.present) return
  await lockApplicationStream(client, installationId)
  const saved = await client.query<{ id: string }>(`INSERT INTO kipster.notifications(id,installation_id,recipient_id,thread_id,run_id,kind,interaction_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), installationId, callerId, threadId, runId, kind, interactionId])
  if (saved.rows[0]) await publishNotification(client, installationId, saved.rows[0].id)
}

/** Stable attention identity and read state are independent of replay retention. */
export async function createNotification(client: SqlClient, installationId: string, callerId: string, threadId: string, runId: string, kind: 'completed'|'failed'|'recovery-needed'): Promise<void> {
  await insertNotification(client, installationId, callerId, threadId, runId, kind, null)
}

export async function createInteractionNotification(client: SqlClient, installationId: string, callerId: string, threadId: string, runId: string, interactionId: string): Promise<void> {
  await insertNotification(client, installationId, callerId, threadId, runId, 'interaction', interactionId)
}

/**
 * Publishes the interaction's notification again after the interaction settled, was cancelled or was
 * superseded, so every client sees its current state. Call it in the transaction that changed the
 * interaction, after the change.
 */
export async function interactionNotificationChanged(client: SqlClient, interactionId: string): Promise<void> {
  const target = (await client.query<{ id: string; installation_id: string; present: boolean }>('SELECT n.id,n.installation_id,kipster.chat_present(t.chat_id) AS present FROM kipster.notifications n JOIN kipster.threads t ON t.id=n.thread_id WHERE n.interaction_id=$1', [interactionId])).rows[0]
  if (!target?.present) return
  await lockApplicationStream(client, target.installation_id)
  await client.query('UPDATE kipster.notifications SET revision=revision+1 WHERE id=$1', [target.id])
  await publishNotification(client, target.installation_id, target.id)
}

/** Marks a notification read. Its interaction, if any, stays as it is. */
export async function markNotificationRead(db: Postgres, scope: Extract<Stream, {kind:'application'}>, notificationId: string): Promise<void> {
  await db.transaction(async client => {
    await authorized(client, scope)
    await lockApplicationStream(client, scope.installationId)
    const row = (await client.query<{ installation_id: string; recipient_id: string; read_at: Date|null; present: boolean }>('SELECT n.installation_id,n.recipient_id,n.read_at,kipster.chat_present(t.chat_id) AS present FROM kipster.notifications n JOIN kipster.threads t ON t.id=n.thread_id WHERE n.id=$1 FOR UPDATE OF n', [notificationId])).rows[0]
    if (!row) throw new RefusedError('gone', 'Notification is gone')
    if (row.installation_id !== scope.installationId || row.recipient_id !== scope.callerId) throw new Error('Notification access denied')
    if (!row.present) throw new RefusedError('gone', 'Notification is gone')
    if (row.read_at) return
    await client.query('UPDATE kipster.notifications SET read_at=now(),revision=revision+1 WHERE id=$1', [notificationId])
    await publishNotification(client, scope.installationId, notificationId)
  })
}

interface StoredEvent { position: string; event_id: string; type: string; resource_id: string; revision: string; data: unknown; occurred_at: Date }
function wire(scope: Stream, row: StoredEvent): StreamEvent { return { version: 1, eventId: row.event_id, scope, cursor: streamCursor(scope, Number(row.position)), occurredAt: row.occurred_at.toISOString(), resourceId: row.resource_id, revision: Number(row.revision), type: row.type, data: row.data } }

async function streamBounds(client: SqlClient, scope: Stream): Promise<{ floor: number; head: number }> {
  if (scope.kind === 'thread') {
    const row = (await client.query<{ event_floor: string; next_event_position: string }>('SELECT event_floor,next_event_position FROM kipster.threads WHERE id=$1', [scope.threadId])).rows[0]
    if (!row) throw new Error('Thread not found')
    return { floor: Number(row.event_floor), head: Number(row.next_event_position) - 1 }
  }
  const row = (await client.query<{ event_floor: string; next_position: string }>('SELECT event_floor,next_position FROM kipster.app_streams WHERE installation_id=$1', [scope.installationId])).rows[0]
  return row ? { floor: Number(row.event_floor), head: Number(row.next_position) - 1 } : { floor: 0, head: 0 }
}
/** The application stream head, for snapshots read in the caller's transaction. */
export async function applicationCursor(client: SqlClient, installationId: string): Promise<string> {
  const row = (await client.query<{ next_position: string }>('SELECT next_position FROM kipster.app_streams WHERE installation_id=$1', [installationId])).rows[0]
  return appCursor(installationId, row ? Number(row.next_position) - 1 : 0)
}
function checkedAfter(scope: Stream, after: string, bounds: { floor: number; head: number }): number {
  const position = parseCursor(scope, after)
  if (position < bounds.floor) throw new Error('resync-required')
  if (position > bounds.head) throw new Error('Future stream cursor')
  return position
}

export interface SnapshotPage { afterThreadId?: string; afterNotificationId?: string; afterMessagePosition?: number; afterWorkPosition?: number; atCursor?: string; limit?: number }
export async function snapshot(db: Postgres, scope: Stream, page: SnapshotPage = {}): Promise<Record<string, unknown>> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorized(client, scope)
    const bounds = await streamBounds(client, scope)
    if (page.atCursor !== undefined && checkedAfter(scope, page.atCursor, bounds) !== bounds.head) throw new Error('resync-required')
    const pageLimit = page.limit ?? (scope.kind === 'application' ? 100 : 1000)
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > (scope.kind === 'application' ? 100 : 1000)) throw new Error('Invalid snapshot page limit')
    if (scope.kind === 'application') {
      const rows = await client.query<{ thread_id: string; chat_id: string; context_kind: string; context_id: string; agent_id: string; revision: string; state: string; last_message_id: string; created_at: Date }>('SELECT s.thread_id,s.chat_id,c.context_kind,c.context_id,c.agent_id,s.revision,s.state,s.last_message_id,t.created_at FROM kipster.app_thread_summaries s JOIN kipster.threads t ON t.id=s.thread_id JOIN kipster.direct_chats c ON c.id=s.chat_id WHERE s.installation_id=$1 AND s.caller_id=$2 AND t.internal=false AND kipster.chat_present(c.id) AND ($3::uuid IS NULL OR s.thread_id>$3) ORDER BY s.thread_id LIMIT $4', [scope.installationId, scope.callerId, page.afterThreadId ?? null, pageLimit + 1])
      // Notifications are paged oldest first; the page anchor is the last notification returned.
      if (page.afterNotificationId && !(await client.query('SELECT 1 FROM kipster.notifications WHERE id=$1', [page.afterNotificationId])).rows.length) throw new Error('resync-required')
      const notifications = await client.query<NotificationRow>(`SELECT ${notificationColumns} FROM ${notificationSource}
        WHERE n.installation_id=$1 AND n.recipient_id=$2 AND kipster.chat_present(t.chat_id)
          AND ($3::uuid IS NULL OR (n.created_at,n.id) > (SELECT created_at,id FROM kipster.notifications WHERE id=$3))
        ORDER BY n.created_at,n.id LIMIT $4`, [scope.installationId, scope.callerId, page.afterNotificationId ?? null, pageLimit + 1])
      const threads = rows.rows.slice(0, pageLimit), notes = notifications.rows.slice(0, pageLimit)
      const hasMore = rows.rows.length > pageLimit || notifications.rows.length > pageLimit
      return { version: 1, scope, cursor: streamCursor(scope, bounds.head), threads: threads.map(row => ({ threadId: row.thread_id, chatId: row.chat_id, contextKind: row.context_kind, contextId: row.context_id, agentId: row.agent_id, revision: Number(row.revision), state: row.state, lastMessageId: row.last_message_id, createdAt: row.created_at.toISOString() })), notifications: notes.map(notificationRecord), next: hasMore ? { afterThreadId: threads.at(-1)?.thread_id ?? page.afterThreadId ?? null, afterNotificationId: notes.at(-1)?.id ?? page.afterNotificationId ?? null } : null }
    }
    const messages = await client.query<{ id: string; thread_id: string; author_id: string; parts: unknown; final: boolean; revision: string; position: string }>('SELECT id,thread_id,author_id,parts,final,revision,position FROM kipster.messages WHERE thread_id=$1 AND position>$2 ORDER BY position LIMIT $3', [scope.threadId, page.afterMessagePosition ?? 0, pageLimit + 1])
    const runs = await client.query<{ id: string; state: string; current_attempt_id: string|null; queue_hold: boolean; cancel_delivery:string; revision: string; queue_position: string; input_message_id: string; failure: string|null }>('SELECT id,state,current_attempt_id,queue_hold,cancel_delivery,revision,queue_position,input_message_id,failure FROM kipster.text_runs WHERE thread_id=$1 AND queue_position>$2 ORDER BY queue_position LIMIT $3', [scope.threadId, page.afterWorkPosition ?? 0, pageLimit + 1])
    const messagePage = messages.rows.slice(0, pageLimit), workPage = runs.rows.slice(0, pageLimit)
    const interactions = await client.query<{ id:string; run_id:string; attempt_id:string; kind:string; proposal_id:string|null; proposal:string|null; prompt:string; options:unknown; free_text:boolean; state:string; answer:unknown; answer_operation_id:string|null; answer_actor_id:string|null; answered_at:Date|null; revision:string; source_agent_id:string|null }>('SELECT x.*,d.recipient_agent_id AS source_agent_id FROM kipster.interactions x JOIN kipster.text_runs r ON r.id=x.run_id LEFT JOIN kipster.delegations d ON d.child_run_id=x.run_id WHERE (r.thread_id=$1 AND r.queue_position=ANY($2::bigint[])) OR d.origin_thread_id=$1 ORDER BY x.created_at,x.id',[scope.threadId,workPage.map(row=>row.queue_position)])
    const delegations=await client.query<{id:string;parent_run_id:string|null;child_run_id:string|null;sender_agent_id:string;recipient_agent_id:string;origin_thread_id:string;depth:number;ordinal:number;request:string;state:string;failure:string|null;revision:string}>(`SELECT id,parent_run_id,child_run_id,sender_agent_id,recipient_agent_id,origin_thread_id,depth,ordinal,request,state,failure,revision FROM kipster.delegations WHERE origin_thread_id=$1 ORDER BY depth,ordinal,id LIMIT 1000`,[scope.threadId])
    const hasMore = messages.rows.length > pageLimit || runs.rows.length > pageLimit
    return { version: 1, scope, cursor: streamCursor(scope, bounds.head), messages: await Promise.all(messagePage.map(async row => ({ id: row.id, threadId: row.thread_id, authorId: row.author_id, parts: row.parts, final: row.final, revision: Number(row.revision), position: Number(row.position), preparation: (await client.query<{ordinal:number;artifact_id:string;status:string;provider_id:string|null;transcript:string|null;failure:string|null;revision:string}>("SELECT ordinal,artifact_id,status,provider_id,transcript,failure,revision FROM kipster.voice_preparations WHERE message_id=$1 ORDER BY ordinal",[row.id])).rows.map(item=>({id:`${row.id}:${item.ordinal}`,partIndex:item.ordinal,artifactId:item.artifact_id,status:item.status==='pending'?'preparing':item.status,provider:item.provider_id??'unconfigured',revision:Number(item.revision),...(item.transcript!==null?{transcript:item.transcript}:{}),...(item.failure?{error:item.failure}:{})})) }))), work: workPage.map(row => ({ runId: row.id, attemptId: row.current_attempt_id, state: row.state, queueHold: row.queue_hold, cancelDelivery: row.cancel_delivery, revision: Number(row.revision), queuePosition: Number(row.queue_position), messageId: row.input_message_id, failure: row.failure })), interactions: interactions.rows.map(row=>({ id:row.id,version:1,runId:row.run_id,attemptId:row.attempt_id,kind:row.kind,...(row.proposal_id?{proposalId:row.proposal_id}:{}),...(row.proposal?{proposal:row.proposal}:{}),prompt:row.prompt,options:row.options,freeText:row.free_text,state:row.state,revision:Number(row.revision),...(row.source_agent_id?{sourceAgentId:row.source_agent_id}:{}),...(row.answer&&row.answer_operation_id&&row.answer_actor_id&&row.answered_at?{response:{operationId:row.answer_operation_id,actorId:row.answer_actor_id,answer:row.answer,acceptedAt:row.answered_at.toISOString()}}:{})})), delegations:delegations.rows.map(row=>({id:row.id,parentRunId:row.parent_run_id,childRunId:row.child_run_id,senderAgentId:row.sender_agent_id,recipientAgentId:row.recipient_agent_id,originThreadId:row.origin_thread_id,depth:row.depth,ordinal:row.ordinal,request:row.request,state:row.state,...(row.failure!==null?{failure:row.failure}:{}),revision:Number(row.revision)})), next: hasMore ? { afterMessagePosition: messagePage.at(-1) ? Number(messagePage.at(-1)!.position) : page.afterMessagePosition ?? null, afterWorkPosition: workPage.at(-1) ? Number(workPage.at(-1)!.queue_position) : page.afterWorkPosition ?? null } : null }
  })
}

export async function readEvents(db: Postgres, scope: Stream, after: string, limit = 100, maxBytes = Infinity): Promise<{ events: StreamEvent[]; head: string }> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorized(client, scope)
    const bounds = await streamBounds(client, scope)
    const position = checkedAfter(scope, after, bounds)
    const identity = scope.kind === 'thread' ? scope.threadId : scope.installationId
    const table = scope.kind === 'thread' ? 'kipster.thread_events' : 'kipster.app_events'
    const key = scope.kind === 'thread' ? 'thread_id' : 'installation_id'
    let count = limit
    if (Number.isFinite(maxBytes)) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Invalid stream byte limit')
      // Read sizes first so a large canonical reply never enters an SSE query batch.
      const sizes = await client.query<{ bytes: number }>(`SELECT octet_length(data::text) AS bytes FROM ${table} WHERE ${key}=$1 AND position>$2 ORDER BY position LIMIT $3`, [identity, position, limit])
      let used = 0
      count = 0
      for (const row of sizes.rows) {
        if (row.bytes > maxBytes) throw new Error('resync-required')
        if (used + row.bytes > maxBytes) break
        used += row.bytes
        count++
      }
    }
    const result = await client.query<StoredEvent>(`SELECT position,event_id,type,resource_id,revision,data,occurred_at FROM ${table} WHERE ${key}=$1 AND position>$2 ORDER BY position LIMIT $3`, [identity, position, count])
    return { events: result.rows.map(row => wire(scope, row)), head: streamCursor(scope, bounds.head) }
  })
}

/** Bounded replay: prune in batches while holding the stream's commit-order lock.
 * Canonical records survive; cursors older than the floor require a fresh snapshot. */
async function retainEvents(client: SqlClient, kind: Stream['kind'], id: string, head: number, keep = 2048): Promise<void> {
  if (head % 128 !== 0) return
  await trimEvents(client, kind, id, Math.max(0, head - keep))
}
async function trimEvents(client: SqlClient, kind: Stream['kind'], id: string, floor: number): Promise<void> {
  const thread = kind === 'thread'
  await client.query(`DELETE FROM kipster.${thread ? 'thread_events' : 'app_events'} WHERE ${thread ? 'thread_id' : 'installation_id'}=$1 AND position<=$2`, [id, floor])
  await client.query(`UPDATE kipster.${thread ? 'threads' : 'app_streams'} SET event_floor=GREATEST(event_floor,$2) WHERE ${thread ? 'id' : 'installation_id'}=$1`, [id, floor])
  if (!thread) await client.query('DELETE FROM kipster.app_projection_intents WHERE installation_id=$1 AND projected=true AND app_position<=$2', [id, floor])
}

/** Compaction never removes canonical messages, run state or app summaries. */
export async function retainLast(db: Postgres, scope: Stream, keep: number): Promise<void> {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('Invalid retention count')
  await db.transaction(async client => {
    await authorized(client, scope)
    if (scope.kind === 'thread') {
      const row = (await client.query<{ next_event_position: string }>('SELECT next_event_position FROM kipster.threads WHERE id=$1 FOR UPDATE', [scope.threadId])).rows[0]!
      const floor = Math.max(0, Number(row.next_event_position) - 1 - keep)
      await trimEvents(client, 'thread', scope.threadId, floor)
    } else {
      const row = (await client.query<{ next_position: string }>('SELECT next_position FROM kipster.app_streams WHERE installation_id=$1 FOR UPDATE', [scope.installationId])).rows[0]
      if (!row) return
      const floor = Math.max(0, Number(row.next_position) - 1 - keep)
      await trimEvents(client, 'application', scope.installationId, floor)
    }
  })
}
