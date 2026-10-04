import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { isLive, refuseAgent, type TrustedActor } from '../identity/public.js'
import { acceptIntent } from '../work/public.js'
import { chatPresent, publishThreadChange } from '../synchronization/public.js'
import { RefusedError } from '../../platform/errors/public.js'
import type { Context, TextSubmission, AcceptedReceipt, MessagePart } from '../../protocol/text.js'
import type { ArtifactService } from '../artifacts/public.js'
import { MAX_FILES_PER_MESSAGE, MAX_MESSAGE_FILE_BYTES } from '../artifacts/public.js'

export { removeThreads, type RemovedThread } from './removal.js'

interface ChatRow { id: string; installation_id: string; caller_id: string; context_kind: string; context_id: string; agent_id: string }
const contextId = (context: Context): string => context.kind === 'installation' ? context.installationId : context.organizationId
const removed = (lifecycle: string | undefined): boolean => lifecycle === 'deleting' || lifecycle === 'deleted'

/** New work in an organization that is being deleted is refused as `organization-deleted`. */
async function refuseDeletedOrganization(client: SqlClient, organizationId: string): Promise<void> {
  const row = (await client.query<{ lifecycle: string }>('SELECT lifecycle FROM kipster.organizations WHERE id=$1', [organizationId])).rows[0]
  if (removed(row?.lifecycle)) throw new RefusedError('organization-deleted', 'Organization is being deleted')
}

/** The caller may read the context's chats and control work already accepted in them. */
async function authorizeContext(client: SqlClient, actor: TrustedActor, context: Context): Promise<void> {
  const owner = await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [actor.installationId, actor.personId])
  if (!owner.rows.length) throw new Error('Owner access denied')
  if (context.kind === 'installation') {
    if (context.installationId !== actor.installationId) throw new Error('Installation access denied')
  } else {
    const organization = (await client.query<{ lifecycle: string; member: boolean }>('SELECT o.lifecycle,EXISTS (SELECT 1 FROM kipster.human_memberships h WHERE h.organization_id=o.id AND h.person_id=$3) AS member FROM kipster.organizations o WHERE o.id=$1 AND o.installation_id=$2 AND /* lifecycle visibility */ o.provisioned', [context.organizationId, actor.installationId, actor.personId])).rows[0]
    if (!organization) throw new Error('Organization access denied')
    if (removed(organization.lifecycle)) throw new RefusedError('organization-deleted', 'Organization is being deleted')
    if (!organization.member) throw new Error('Organization access denied')
  }
}

/**
 * The agent may take new work in the context: the live admin agent in the installation, or a live
 * agent member of a live organization. The membership, agent and organization rows stay locked
 * with FOR KEY SHARE until commit, so a concurrent removal or lifecycle change either waits for
 * the acceptance or makes it fail. An organization being deleted is refused as
 * `organization-deleted`, and a missing membership as `membership-removed`.
 */
async function requireAgentInContext(client: SqlClient, actor: TrustedActor, context: Context, agentId: string, live = true): Promise<void> {
  if (context.kind === 'installation') {
    const root = await client.query('SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role=$2', [agentId, 'root-admin'])
    if (!root.rows.length) throw new Error('Root agent required')
  } else {
    const member = await client.query('SELECT 1 FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2 FOR KEY SHARE', [context.organizationId, agentId])
    if (!member.rows.length) {
      await refuseDeletedOrganization(client, context.organizationId)
      throw new RefusedError('membership-removed', 'Agent is not a member of the organization')
    }
    if (live && !await isLive(client, actor.installationId, 'organization', context.organizationId)) {
      await refuseDeletedOrganization(client, context.organizationId)
      throw new Error('Organization access denied')
    }
  }
  if (live && !await isLive(client, actor.installationId, 'agent', agentId)) await refuseAgent(client, actor.installationId, agentId, 'Agent access denied')
}

/** Opens the chat with the agent in the context. A chat that exists opens even while its agent is archived, to read
 * its history; creating one needs a live agent and organization. */
export async function resolveDirectChat(db: Postgres, actor: TrustedActor, context: Context, agentId: string): Promise<{ chatId: string }> {
  return db.transaction(async client => {
    await authorizeContext(client, actor, context)
    const existing = (await client.query<{ id: string }>('SELECT id FROM kipster.direct_chats WHERE installation_id=$1 AND caller_id=$2 AND context_kind=$3 AND context_id=$4 AND agent_id=$5',
      [actor.installationId, actor.personId, context.kind, contextId(context), agentId])).rows[0]
    await requireAgentInContext(client, actor, context, agentId, !existing)
    if (existing && !await chatPresent(client, existing.id)) throw new RefusedError('gone', 'Chat is gone')
    if (existing) return { chatId: existing.id }
    const id = randomUUID()
    const row = await client.query<{ id: string }>(`INSERT INTO kipster.direct_chats(id,installation_id,caller_id,context_kind,context_id,agent_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (installation_id,caller_id,context_kind,context_id,agent_id)
      DO UPDATE SET id=kipster.direct_chats.id RETURNING id`, [id, actor.installationId, actor.personId, context.kind, contextId(context), agentId])
    return { chatId: row.rows[0]!.id }
  })
}

/**
 * A chat of the caller in the context. It stays readable, and its accepted work controllable, after its
 * agent leaves the organization or is archived. A chat that no longer exists, or whose agent or
 * organization is being deleted, is `gone`; for new work, an organization being deleted is reported as
 * `organization-deleted` instead.
 */
export async function authorizedChat(client: SqlClient, actor: TrustedActor, context: Context, chatId: string, newWork = false): Promise<ChatRow> {
  const chat = (await client.query<ChatRow & { present: boolean; allowed: boolean }>('SELECT *,kipster.chat_present(id) AS present,(installation_id=$2 AND caller_id=$3 AND context_kind=$4 AND context_id=$5) AS allowed FROM kipster.direct_chats WHERE id=$1', [chatId, actor.installationId, actor.personId, context.kind, contextId(context)])).rows[0]
  if (!chat) throw new RefusedError('gone', 'Chat is gone')
  if (!chat.allowed) throw new Error('Chat access denied')
  if (!chat.present) {
    if (newWork && context.kind === 'organization') await refuseDeletedOrganization(client, context.organizationId)
    throw new RefusedError('gone', 'Chat is gone')
  }
  await authorizeContext(client, actor, context)
  const { present: _present, allowed: _allowed, ...row } = chat
  return row
}

export async function acceptText(db: Postgres, jobs: Jobs, artifacts: ArtifactService, actor: TrustedActor, submission: TextSubmission): Promise<AcceptedReceipt> {
  if (submission.scope.installationId !== actor.installationId || submission.scope.callerId !== actor.personId) throw new Error('Caller scope mismatch')
  return db.transaction(client => acceptTextIn(client, jobs, artifacts, actor, submission))
}

/** `acceptText` in the caller's transaction. `coreParts` are parts Core appends after the submitted ones, such as a document card. */
export async function acceptTextIn(client: SqlClient, jobs: Jobs, artifacts: ArtifactService, actor: TrustedActor, submission: TextSubmission, coreParts: readonly MessagePart[] = []): Promise<AcceptedReceipt> {
  if (submission.scope.installationId !== actor.installationId || submission.scope.callerId !== actor.personId) throw new Error('Caller scope mismatch')
  let agentId = ''
  const receipt = await acceptIntent(client, jobs, actor, submission.submissionId,
    async c => { agentId = (await authorizedChat(c, actor, submission.target.context, submission.target.chatId, true)).agent_id },
    async (c, intentId) => {
      // Only new work needs the membership; a repeated submission ID returns its receipt first.
      await requireAgentInContext(c, actor, submission.target.context, agentId)
      const files=submission.parts.flatMap((part,index)=>part.kind==='file'?[{part,index}]:[])
      if(files.length>MAX_FILES_PER_MESSAGE)throw new Error('Invalid file count')
      let total=0
      for(const {part} of files){const record=await artifacts.authorizedArtifact(c,actor,submission.target.context,part.artifactId);total+=Number(record.size_bytes);if(total>MAX_MESSAGE_FILE_BYTES)throw new Error('Invalid total file size')}
      let threadId = submission.mode === 'root' ? randomUUID() : submission.threadId
      if (submission.mode === 'root') {
        await c.query('INSERT INTO kipster.threads(id,chat_id) VALUES ($1,$2)', [threadId, submission.target.chatId])
      } else {
        const found = await c.query('SELECT 1 FROM kipster.threads WHERE id=$1 AND chat_id=$2 AND internal=false', [threadId, submission.target.chatId])
        if (!found.rows.length) throw new Error('Thread not found in chat')
      }
      // Row lock serializes canonical positions and all later thread event positions.
      const counter = (await c.query<{ next_message_position: string; next_queue_position: string }>('SELECT next_message_position,next_queue_position FROM kipster.threads WHERE id=$1 FOR UPDATE', [threadId])).rows[0]!
      const messageId = randomUUID()
      const position = Number(counter.next_message_position), queuePosition = Number(counter.next_queue_position)
      await c.query('UPDATE kipster.threads SET next_message_position=next_message_position+1,next_queue_position=next_queue_position+1,revision=revision+1 WHERE id=$1', [threadId])
      await c.query('INSERT INTO kipster.messages(id,thread_id,position,author_id,parts) VALUES ($1,$2,$3,$4,$5::jsonb)', [messageId, threadId, position, actor.personId, JSON.stringify([...submission.parts, ...coreParts])])
      for(const {part,index} of files){
        const record=await artifacts.authorizedArtifact(c,actor,submission.target.context,part.artifactId)
        await c.query('INSERT INTO kipster.message_artifacts(message_id,ordinal,artifact_id,purpose) VALUES ($1,$2,$3,$4)',[messageId,index,part.artifactId,part.purpose])
        if(part.purpose==='voice_note')await c.query("INSERT INTO kipster.voice_preparations(message_id,ordinal,artifact_id,source_sha256,status) VALUES ($1,$2,$3,$4,'pending')",[messageId,index,part.artifactId,record.sha256])
      }
      await c.query('INSERT INTO kipster.text_runs(id,thread_id,input_message_id,state,queue_position) VALUES ($1,$2,$3,$4,$5)', [intentId, threadId, messageId, 'queued', queuePosition])
      await publishThreadChange(c, actor.installationId, actor.personId, threadId, submission.target.chatId, 'message-final', messageId, 1, await messageRecord(c, messageId), 'queued', messageId)
      await publishThreadChange(c, actor.installationId, actor.personId, threadId, submission.target.chatId, 'work-changed', intentId, 1, await workRecord(c, intentId), 'queued', null)
      return { version: 1, status: 'accepted', chatId: submission.target.chatId, threadId, messageId, runId: intentId }
    })
  return { ...receipt, version: 1, status: 'accepted', chatId: String(receipt.chatId), threadId: String(receipt.threadId), messageId: String(receipt.messageId), runId: String(receipt.runId) } as AcceptedReceipt
}

export async function runContext(db: Postgres, runId: string): Promise<{ actor: TrustedActor; context: Context; agentId: string; threadId: string; chatId: string; inputMessageId: string } | null> {
  const row = (await db.query<{ installation_id: string; caller_id: string; context_kind: 'installation'|'organization'; context_id: string; agent_id: string; thread_id: string; chat_id: string; input_message_id: string }>(`SELECT c.installation_id,c.caller_id,c.context_kind,c.context_id,COALESCE(d.recipient_agent_id,c.agent_id) AS agent_id,r.thread_id,t.chat_id,r.input_message_id
    FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id WHERE r.id=$1`, [runId])).rows[0]
  if (!row) return null
  return { actor: { installationId: row.installation_id, personId: row.caller_id }, context: row.context_kind === 'installation' ? { kind: 'installation', installationId: row.context_id } : { kind: 'organization', organizationId: row.context_id }, agentId: row.agent_id, threadId: row.thread_id, chatId: row.chat_id, inputMessageId: row.input_message_id }
}

export async function messageRecord(client: SqlClient, messageId: string): Promise<{ id: string; runId?: string; threadId: string; authorId: string; parts: MessagePart[]; final: boolean; revision: number; position: number; preparation?: {id:string;partIndex:number;artifactId:string;status:string;provider:string;revision:number;transcript?:string;error?:string}[] }> {
  const row = (await client.query<{ id: string; thread_id: string; author_id: string; parts: MessagePart[]; final: boolean; revision: string; position: string; run_id: string|null }>('SELECT m.id,m.thread_id,m.author_id,m.parts,m.final,m.revision,m.position,a.intent_id AS run_id FROM kipster.messages m LEFT JOIN kipster.attempts a ON a.id=m.source_attempt_id WHERE m.id=$1', [messageId])).rows[0]
  if (!row) throw new Error('Message not found')
  const prepared=await client.query<{ordinal:number;artifact_id:string;status:string;provider_id:string|null;transcript:string|null;failure:string|null;revision:string}>("SELECT ordinal,artifact_id,status,provider_id,transcript,failure,revision FROM kipster.voice_preparations WHERE message_id=$1 ORDER BY ordinal",[messageId])
  return { id: row.id, ...(row.run_id ? { runId: row.run_id } : {}), threadId: row.thread_id, authorId: row.author_id, parts: row.parts, final: row.final, revision: Number(row.revision), position: Number(row.position), preparation: prepared.rows.map(item=>({id:`${row.id}:${item.ordinal}`,partIndex:item.ordinal,artifactId:item.artifact_id,status:item.status==='pending'?'preparing':item.status,provider:item.provider_id??'unconfigured',revision:Number(item.revision),...(item.transcript!==null?{transcript:item.transcript}:{}),...(item.failure?{error:item.failure}:{})})) }
}

export async function workRecord(client: SqlClient, runId: string): Promise<{ runId: string; attemptId: string|null; state: string; queueHold: boolean; cancelDelivery: string; revision: number; queuePosition: number; messageId: string; failure: string|null }> {
  const row = (await client.query<{ id: string; current_attempt_id: string|null; state: string; queue_hold: boolean; cancel_delivery: string; revision: string; queue_position: string; input_message_id: string; failure: string|null }>('SELECT id,current_attempt_id,state,queue_hold,cancel_delivery,revision,queue_position,input_message_id,failure FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]
  if (!row) throw new Error('Run not found')
  return { runId: row.id, attemptId: row.current_attempt_id, state: row.state, queueHold: row.queue_hold, cancelDelivery: row.cancel_delivery, revision: Number(row.revision), queuePosition: Number(row.queue_position), messageId: row.input_message_id, failure: row.failure }
}

/** Logical run order excludes later queued human turns, regardless of physical message position. */
export async function executionHistory(db: Postgres, runId: string): Promise<{ messages: { messageId: string; text: string; parts: MessagePart[] }[] }> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const run = (await client.query<{ thread_id: string; queue_position: string }>('SELECT thread_id,queue_position FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]
    if (!run) throw new Error('Run not found')
    const result = await client.query<{ id: string; parts: MessagePart[] }>(`SELECT id,parts FROM (
      SELECT m.id,m.parts,r.queue_position AS logical_position,0 AS source_order,m.position AS message_position
      FROM kipster.text_runs r JOIN kipster.messages m ON m.id=r.input_message_id
      WHERE r.thread_id=$1 AND r.queue_position<=$2
      UNION ALL
      SELECT m.id,m.parts,r.queue_position AS logical_position,1 AS source_order,m.position AS message_position
      FROM kipster.text_runs r JOIN kipster.attempts a ON a.intent_id=r.id JOIN kipster.messages m ON m.source_attempt_id=a.id
      WHERE r.thread_id=$1 AND r.queue_position<$2 AND r.state='completed' AND m.final=true
    ) history ORDER BY logical_position,source_order,message_position`, [run.thread_id, run.queue_position])
    return { messages: result.rows.map(row => ({ messageId: row.id, text: row.parts.flatMap(part=>part.kind==='text'?[part.text]:[]).join('\n'),parts:row.parts })) }
  })
}

/** Seal visible partial output when an attempt can no longer publish. Caller holds
 * the thread lock. Sealing does not mark its run successful or admit it to history. */
export async function sealAttemptMessages(client: SqlClient, attemptId: string, state: string): Promise<void> {
  const target = (await client.query<{ thread_id: string; chat_id: string; installation_id: string; caller_id: string }>(`SELECT r.thread_id,t.chat_id,c.installation_id,c.caller_id
    FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE a.id=$1`, [attemptId])).rows[0]
  if (!target) return
  const messages = await client.query<{ id: string; revision: string }>('UPDATE kipster.messages SET final=true,revision=revision+1 WHERE source_attempt_id=$1 AND final=false RETURNING id,revision', [attemptId])
  for (const message of messages.rows) await publishThreadChange(client, target.installation_id, target.caller_id, target.thread_id, target.chat_id, 'message-final', message.id, Number(message.revision), await messageRecord(client, message.id), state, null)
}
