import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import type { TrustedActor } from '../identity/public.js'
import { publishThreadChange, createInteractionNotification, interactionNotificationChanged, chatPresent } from '../synchronization/public.js'
import { RefusedError } from '../../platform/errors/public.js'
import { workRecord } from '../conversations/public.js'
import { saveApprovalGrant } from '../settings/public.js'

export interface InteractionInput {
  kind: 'question' | 'approval'
  prompt: string
  options?: readonly { id: string; label: string }[]
  freeText?: boolean
  proposalId?: string
  proposal?: string
  /** Only provider approvals raised through an adapter may offer one; see `AdapterHost.invokeTool`. */
  grant?: ApprovalGrantOffer
}
export type ApprovalScope = 'conversation' | 'always'
/** `key` is the adapter's own match for the action; it stays in Core and is never shown. */
export interface ApprovalGrantOffer { key: string; label: string; scopes: ApprovalScope[] }
export type InteractionAnswer = { kind: 'choice'; optionId: string; text?: string } | { kind: 'text'; text: string } | { kind: 'dismiss' } | { kind: 'approve'; comment?: string; scope?: ApprovalScope } | { kind: 'decline'; comment?: string }
export interface InteractionRecord {
  id: string; version: 1; kind: 'question' | 'approval'; runId: string; attemptId: string; proposalId?: string; proposal?: string
  prompt: string; options: { id: string; label: string }[]; freeText: boolean; state: string
  grant?: { label: string; scopes: ApprovalScope[] }
  response?: { operationId: string; actorId: string; answer: InteractionAnswer; acceptedAt: string }
  revision: number
  sourceAgentId?: string
}
interface ScopeRow { thread_id: string; chat_id: string; installation_id: string; caller_id: string; agent_id: string; state: string; current_attempt_id: string | null; stop_requested: boolean }
async function scope(client: SqlClient, runId: string): Promise<ScopeRow | undefined> {
  return (await client.query<ScopeRow>(`SELECT r.thread_id,t.chat_id,c.installation_id,c.caller_id,c.agent_id,r.state,r.current_attempt_id,r.stop_requested FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE r.id=$1`, [runId])).rows[0]
}
export async function lockInstallation(client: SqlClient, installationId: string): Promise<void> {
  await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [installationId])
  await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [installationId])
}
async function event(client: SqlClient, row: ScopeRow, record: InteractionRecord): Promise<void> {
  await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'interaction-changed', record.id, record.revision, record, row.state, null)
  const origin=(await client.query<{origin_thread_id:string}>(`SELECT d.origin_thread_id FROM kipster.delegations d WHERE d.child_run_id=$1`,[record.runId])).rows[0]
  if(origin)await publishThreadChange(client,row.installation_id,row.caller_id,origin.origin_thread_id,row.chat_id,'interaction-changed',record.id,record.revision,record,row.state,null)
}
export async function interactionRecord(client: SqlClient, id: string): Promise<InteractionRecord> {
  const row = (await client.query<{ id:string; run_id:string; attempt_id:string; kind:'question'|'approval'; proposal_id:string|null; proposal:string|null; prompt:string; options:{id:string;label:string}[]; free_text:boolean; grant_offer:ApprovalGrantOffer|null; state:string; answer:InteractionAnswer|null; answer_operation_id:string|null; answer_actor_id:string|null; answered_at:Date|null; revision:string; source_agent_id:string|null }>('SELECT x.*,d.recipient_agent_id AS source_agent_id FROM kipster.interactions x LEFT JOIN kipster.delegations d ON d.child_run_id=x.run_id WHERE x.id=$1', [id])).rows[0]
  if (!row) throw new Error('Interaction not found')
  return { id: row.id, version: 1, runId: row.run_id, attemptId: row.attempt_id, kind: row.kind, ...(row.proposal_id ? { proposalId: row.proposal_id } : {}), ...(row.proposal ? {proposal:row.proposal}:{}), prompt: row.prompt, options: row.options, freeText: row.free_text, ...(row.grant_offer ? { grant: { label: row.grant_offer.label, scopes: row.grant_offer.scopes } } : {}), state: row.state, ...(row.answer && row.answer_operation_id && row.answer_actor_id && row.answered_at ? { response: { operationId: row.answer_operation_id, actorId: row.answer_actor_id, answer: row.answer, acceptedAt: row.answered_at.toISOString() } } : {}), revision: Number(row.revision),...(row.source_agent_id?{sourceAgentId:row.source_agent_id}:{}) }
}
/** The thread the card appears on must still be present. */
async function presentThread(client: SqlClient, threadId: string): Promise<void> {
  const chat = (await client.query<{ chat_id: string }>('SELECT chat_id FROM kipster.threads WHERE id=$1', [threadId])).rows[0]
  if (!chat || !await chatPresent(client, chat.chat_id)) throw new RefusedError('gone', 'Thread is gone')
}
function checkInput(input: InteractionInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>!['kind','prompt','options','freeText','proposalId','proposal','grant'].includes(key))) throw new Error('Invalid interaction fields')
  if (input.kind !== 'question' && input.kind !== 'approval') throw new Error('Invalid interaction kind')
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 8000) throw new Error('Invalid interaction prompt')
  if (input.freeText !== undefined && typeof input.freeText !== 'boolean') throw new Error('Invalid free-text flag')
  const options = input.options ?? []
  if (!Array.isArray(options) || options.length > 5 || options.some(x => !x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some(key=>!['id','label'].includes(key)) || typeof x.id !== 'string' || typeof x.label !== 'string' || !x.id || !x.label || x.id.length > 100 || x.label.length > 200) || new Set(options.map(x => x.id)).size !== options.length) throw new Error('Invalid interaction options')
  if (input.kind === 'approval' && (typeof input.proposalId !== 'string' || !input.proposalId || input.proposalId.length > 200 || typeof input.proposal !== 'string' || !input.proposal.trim() || input.proposal.length > 8000 || options.length || input.freeText)) throw new Error('Invalid approval proposal')
  if (input.kind === 'question' && (input.proposalId!==undefined || input.proposal!==undefined || input.grant!==undefined)) throw new Error('Invalid question proposal')
  if (input.grant !== undefined) {
    const grant = input.grant as unknown as Record<string, unknown>
    const scopes = grant?.scopes
    if (!grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).some(key => !['key','label','scopes'].includes(key))
      || typeof grant.key !== 'string' || !grant.key || grant.key.length > 500 || typeof grant.label !== 'string' || !grant.label.trim() || grant.label.length > 200
      || !Array.isArray(scopes) || !scopes.length || scopes.some(scope => scope !== 'conversation' && scope !== 'always') || new Set(scopes).size !== scopes.length) throw new Error('Invalid approval grant')
  }
  if (input.kind === 'question' && !options.length && !input.freeText) throw new Error('Question needs a choice or free text')
}
/** Tool identity is bound to an admitted attempt. Duplicate call IDs return the original card. */
export async function askInteraction(db: Postgres, attemptId: string, callId: string, input: InteractionInput, bind?: (client: SqlClient, interactionId: string) => Promise<void>): Promise<InteractionRecord> {
  checkInput(input)
  if (!callId || callId.length > 200) throw new Error('Invalid tool call identity')
  const owner = (await db.query<{ intent_id: string; installation_id: string; origin_thread_id:string|null }>('SELECT a.intent_id,i.installation_id,d.origin_thread_id FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id LEFT JOIN kipster.delegations d ON d.child_run_id=a.intent_id WHERE a.id=$1', [attemptId])).rows[0]
  if (!owner) throw new Error('Attempt not found')
  return db.transaction(async client => {
    await lockInstallation(client, owner.installation_id)
    if(owner.origin_thread_id)await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[owner.origin_thread_id])
    const row = await scope(client, owner.intent_id)
    if (!row) throw new Error('Run not found')
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
    const prior = (await client.query<{ id: string }>('SELECT id FROM kipster.interactions WHERE attempt_id=$1 AND call_id=$2', [attemptId, callId])).rows[0]
    if (prior) return interactionRecord(client, prior.id)
    if (row.state !== 'running' || row.current_attempt_id !== attemptId || row.stop_requested) throw new Error('Attempt cannot request interaction')
    const valid = await client.query('SELECT 1 FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id WHERE a.id=$1 AND a.state=$2 AND i.state=$2 AND i.generation=a.generation', [attemptId, 'issued'])
    if (!valid.rows.length) throw new Error('Attempt no longer owns interaction')
    const count = await client.query('SELECT 1 FROM kipster.interactions WHERE run_id=$1 AND state=$2', [owner.intent_id, 'pending'])
    if (count.rows.length) throw new Error('An interaction is already pending')
    const id = randomUUID()
    await client.query(`INSERT INTO kipster.interactions(id,run_id,attempt_id,call_id,kind,proposal_id,proposal,prompt,options,free_text,grant_offer,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,'pending')`, [id, owner.intent_id, attemptId, callId, input.kind, input.proposalId ?? null, input.proposal ?? null, input.prompt, JSON.stringify(input.options ?? []), !!input.freeText, input.grant ? JSON.stringify(input.grant) : null])
    await bind?.(client, id)
    await client.query('UPDATE kipster.text_runs SET state=$2,continuation_interaction_id=$3,revision=revision+1 WHERE id=$1', [owner.intent_id, 'waiting', id])
    const record = await interactionRecord(client, id)
    await event(client, { ...row, state: 'waiting' }, record)
    await createInteractionNotification(client,row.installation_id,row.caller_id,owner.origin_thread_id??row.thread_id,owner.intent_id,id)
    await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'work-changed', owner.intent_id, Number((await client.query<{revision:string}>('SELECT revision FROM kipster.text_runs WHERE id=$1',[owner.intent_id])).rows[0]!.revision), await workRecord(client, owner.intent_id), 'waiting', null)
    return record
  })
}
function validAnswer(record: InteractionRecord, answer: InteractionAnswer, proposalId?: string): boolean {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false
  if (record.kind === 'approval') return proposalId === record.proposalId && (answer.kind === 'approve' || answer.kind === 'decline') && (answer.comment === undefined || typeof answer.comment === 'string' && answer.comment.length <= 2000)
    && (answer.kind === 'decline' || answer.scope === undefined || !!record.grant?.scopes.includes(answer.scope))
  if (answer.kind === 'dismiss') return true
  if (answer.kind === 'text') return record.freeText && typeof answer.text === 'string' && !!answer.text.trim() && answer.text.length <= 8000
  if (answer.kind === 'choice') return typeof answer.optionId === 'string' && record.options.some(x => x.id === answer.optionId) && (answer.text === undefined || record.freeText && typeof answer.text === 'string' && answer.text.length <= 8000)
  return false
}
/** First accepted answer wins. Answer-before-provider-end waits without a second execution. */
export async function answerInteraction(db: Postgres, jobs: Jobs, actor: TrustedActor, request: { operationId:string; interactionId:string; threadId:string; runId:string; attemptId:string; proposalId?:string; answer:InteractionAnswer }, applyApproval?: (client: SqlClient, record: InteractionRecord) => Promise<void>): Promise<{ outcome:'accepted'|'rejected'; interaction:InteractionRecord }> {
  if (!request.operationId || request.operationId.length > 200) throw new Error('Invalid response operation ID')
  const owner = (await db.query<{ installation_id:string;origin_thread_id:string|null }>('SELECT i.installation_id,d.origin_thread_id FROM kipster.interactions x JOIN kipster.work_intents i ON i.id=x.run_id LEFT JOIN kipster.delegations d ON d.child_run_id=x.run_id WHERE x.id=$1',[request.interactionId])).rows[0]
  if (!owner) throw new Error('Interaction not found')
  return db.transaction(async client => {
    await lockInstallation(client, actor.installationId)
    const authorized=await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2',[actor.installationId,actor.personId])
    if(!authorized.rows.length)throw new Error('Owner access denied')
    const row = await scope(client, request.runId)
    if (!row || row.installation_id !== actor.installationId || row.caller_id !== actor.personId || owner.installation_id !== actor.installationId || (owner.origin_thread_id??row.thread_id) !== request.threadId) throw new Error('Interaction access denied')
    await presentThread(client, request.threadId)
    if(owner.origin_thread_id)await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[owner.origin_thread_id])
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[row.thread_id])
    const record = await interactionRecord(client, request.interactionId)
    if (record.runId !== request.runId || record.attemptId !== request.attemptId) throw new Error('Interaction target mismatch')
    const original = (await client.query<{receipt:{outcome:'accepted'|'rejected';interaction:InteractionRecord}}>('SELECT receipt FROM kipster.interaction_receipts WHERE installation_id=$1 AND caller_id=$2 AND operation_id=$3',[actor.installationId,actor.personId,request.operationId])).rows[0]
    if (original) return original.receipt
    const accepted = record.state === 'pending' && !row.stop_requested && validAnswer(record,request.answer,request.proposalId)
    if (!accepted) {
      const result={outcome:'rejected' as const,interaction:record}
      await client.query('INSERT INTO kipster.interaction_receipts(installation_id,caller_id,operation_id,interaction_id,outcome,receipt) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',[actor.installationId,actor.personId,request.operationId,request.interactionId,'rejected',JSON.stringify(result)])
      return result
    }
    await client.query('UPDATE kipster.interactions SET state=$2,answer=$3::jsonb,answer_operation_id=$4,answer_actor_id=$5,answered_at=now(),revision=revision+1 WHERE id=$1 AND state=$6',[record.id,'settled',JSON.stringify(request.answer),request.operationId,actor.personId,'pending'])
    if (request.answer.kind === 'approve') await applyApproval?.(client, record)
    if (request.answer.kind === 'approve' && request.answer.scope) {
      const offer = (await client.query<{ grant_offer: ApprovalGrantOffer }>('SELECT grant_offer FROM kipster.interactions WHERE id=$1', [record.id])).rows[0]!.grant_offer
      await saveApprovalGrant(client, actor.installationId, request.answer.scope === 'always' ? null : row.thread_id, offer.key, offer.label)
    }
    const updated = await interactionRecord(client,record.id)
    await event(client,row,updated)
    await interactionNotificationChanged(client,record.id)
    const attempt = (await client.query<{state:string}>('SELECT state FROM kipster.attempts WHERE id=$1',[record.attemptId])).rows[0]
    if (attempt?.state === 'settled' && row.state === 'waiting') {
      await client.query('UPDATE kipster.text_runs SET state=$2,revision=revision+1 WHERE id=$1',[request.runId,'queued'])
      await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1',[request.runId,'queued'])
      await publishThreadChange(client,row.installation_id,row.caller_id,row.thread_id,row.chat_id,'work-changed',request.runId,Number((await client.query<{revision:string}>('SELECT revision FROM kipster.text_runs WHERE id=$1',[request.runId])).rows[0]!.revision),await workRecord(client,request.runId),'queued',null)
      await jobs.send(client,request.runId)
    }
    const result={outcome:'accepted' as const,interaction:updated}
    await client.query('INSERT INTO kipster.interaction_receipts(installation_id,caller_id,operation_id,interaction_id,outcome,receipt) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',[actor.installationId,actor.personId,request.operationId,request.interactionId,'accepted',JSON.stringify(result)])
    return result
  })
}

export async function interactionReceipt(db: Postgres, actor: TrustedActor, request: {operationId:string;interactionId:string;threadId:string;runId:string;attemptId:string}): Promise<{outcome:'accepted'|'rejected';interaction:InteractionRecord}|{status:'unknown';operationId:string}> {
  return db.transaction(async client=>{
    const authorized=await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2',[actor.installationId,actor.personId])
    if(!authorized.rows.length)throw new Error('Owner access denied')
    const row=await scope(client,request.runId)
    const origin=(await client.query<{origin_thread_id:string}>('SELECT origin_thread_id FROM kipster.delegations WHERE child_run_id=$1',[request.runId])).rows[0]
    if(!row||row.installation_id!==actor.installationId||row.caller_id!==actor.personId||(origin?.origin_thread_id??row.thread_id)!==request.threadId)throw new Error('Interaction access denied')
    await presentThread(client,request.threadId)
    const card=await interactionRecord(client,request.interactionId)
    if(card.runId!==request.runId||card.attemptId!==request.attemptId)throw new Error('Interaction target mismatch')
    const found=(await client.query<{receipt:{outcome:'accepted'|'rejected';interaction:InteractionRecord}}>('SELECT receipt FROM kipster.interaction_receipts WHERE installation_id=$1 AND caller_id=$2 AND operation_id=$3',[actor.installationId,actor.personId,request.operationId])).rows[0]
    return found?.receipt??{status:'unknown' as const,operationId:request.operationId}
  })
}
