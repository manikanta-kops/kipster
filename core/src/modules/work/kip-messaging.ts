import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { chatPresent, publishThreadChange } from '../synchronization/public.js'
import { messageRecord, workRecord } from '../conversations/public.js'
import { isLive, refuseAgent } from '../identity/public.js'
import { MAX_FILES_PER_MESSAGE, requireMessageFileLimit } from '../artifacts/public.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AvailableAgent { id: string; name: string; workspaces?: { id: string; name: string }[] }
const isAdmin = async (client: SqlClient, agentId: string): Promise<boolean> => (await client.query("SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role='root-admin'", [agentId])).rows.length > 0
/** The live workspaces an agent works in, by name. */
const workspacesOf = async (client: SqlClient, agentId: string): Promise<{ id: string; name: string }[]> => (await client.query<{ id: string; name: string }>(`SELECT o.id,o.display_name AS name FROM kipster.agent_memberships m JOIN kipster.organizations o ON o.id=m.organization_id
  WHERE m.agent_id=$1 AND kipster.live_organization(o.id) ORDER BY o.display_name,o.id`, [agentId])).rows
const agentName = async (client: SqlClient, agentId: string): Promise<string> => (await client.query<{ display_name: string }>('SELECT display_name FROM kipster.agents WHERE id=$1', [agentId])).rows[0]?.display_name ?? 'A kip'

interface Scope {
  runId: string; threadId: string; chatId: string; installationId: string; agentId: string; contextKind: 'installation' | 'organization'; contextId: string
  chainRootId: string; chainDepth: number; personId: string
}
/** The run of a current, issued attempt that is not stopping. */
async function boundScope(client: SqlClient, attemptId: string, incarnation: string): Promise<Scope> {
  const row = uuid.test(attemptId) ? (await client.query<{ run_id: string; thread_id: string; chat_id: string; installation_id: string; agent_id: string; context_kind: 'installation' | 'organization'; context_id: string; chain_root_id: string; chain_depth: number; responsible_person_id: string; attempt_state: string; run_state: string; stop_requested: boolean }>(
    `SELECT r.id AS run_id,r.thread_id,t.chat_id,c.installation_id,c.agent_id,c.context_kind,c.context_id,r.chain_root_id,r.chain_depth,r.responsible_person_id,a.state AS attempt_state,r.state AS run_state,r.stop_requested
     FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
     WHERE a.id=$1 AND a.incarnation=$2 AND r.current_attempt_id=a.id`, [attemptId, incarnation])).rows[0] : undefined
  if (!row || row.attempt_state !== 'issued' || !['running', 'waiting'].includes(row.run_state) || row.stop_requested) throw new Error('Attempt no longer owns kip tools')
  return { runId: row.run_id, threadId: row.thread_id, chatId: row.chat_id, installationId: row.installation_id, agentId: row.agent_id, contextKind: row.context_kind, contextId: row.context_id, chainRootId: row.chain_root_id, chainDepth: row.chain_depth, personId: row.responsible_person_id }
}

/** The kips a run may message: the admin kip sees every other live kip with its workspaces; a workspace kip sees the other kips of its workspace and the admin kip. */
export async function listAgents(db: Postgres, attemptId: string, incarnation: string): Promise<AvailableAgent[]> {
  const scope = await boundScope(db, attemptId, incarnation)
  if (await isAdmin(db, scope.agentId)) {
    const rows = await db.query<{ id: string; display_name: string }>('SELECT a.id,a.display_name FROM kipster.agents a WHERE a.installation_id=$1 AND kipster.live_agent(a.id) AND a.id<>$2 ORDER BY a.display_name,a.id', [scope.installationId, scope.agentId])
    return Promise.all(rows.rows.map(async row => ({ id: row.id, name: row.display_name, workspaces: await workspacesOf(db, row.id) })))
  }
  const rows = await db.query<{ id: string; display_name: string }>(`SELECT a.id,a.display_name FROM kipster.agents a WHERE a.installation_id=$1 AND kipster.live_agent(a.id) AND a.id<>$3
      AND (EXISTS (SELECT 1 FROM kipster.agent_memberships m WHERE m.agent_id=a.id AND m.organization_id=$2) OR EXISTS (SELECT 1 FROM kipster.agent_roles r WHERE r.agent_id=a.id AND r.role='root-admin'))
    ORDER BY a.display_name,a.id`, [scope.installationId, scope.contextKind === 'organization' ? scope.contextId : null, scope.agentId])
  return rows.rows.map(row => ({ id: row.id, name: row.display_name }))
}
export async function getAgent(db: Postgres, attemptId: string, incarnation: string, agentId: string): Promise<AvailableAgent | null> {
  return (await listAgents(db, attemptId, incarnation)).find(x => x.id === agentId) ?? null
}

/** Files the sender attached by path: already stored, and made ready by `settle` in the message's transaction. They follow `artifactIds`. */
export interface KipMessageFiles { files: readonly { artifactId: string }[]; settle(client: SqlClient): Promise<void> }
export interface KipMessageInput { recipientId: string; text: string; artifactIds: readonly string[]; workspaceId?: string; requestHash: string }
export interface KipMessageResult { status: 'sent'; recipientId: string; threadId: string; chatId: string; messageId: string }
type Target = { kind: 'installation' | 'organization'; id: string }

/**
 * Where a new linked thread goes. A workspace kip messages the kips of its workspace and the admin kip; the admin kip
 * messages any kip, in the workspace it names, the one it is working in, or the recipient's only one.
 */
async function messageTarget(client: SqlClient, scope: Scope, recipientId: string, name: string, workspaceId: string | undefined): Promise<Target> {
  const installation: Target = { kind: 'installation', id: scope.installationId }
  if (await isAdmin(client, recipientId)) {
    if (workspaceId !== undefined) throw new Error(`${name} is the admin kip and works outside every workspace; leave out workspaceId`)
    return installation
  }
  const workspaces = await workspacesOf(client, recipientId)
  if (!await isAdmin(client, scope.agentId)) {
    if (workspaceId !== undefined) throw new Error('Only the admin kip can name a workspace')
    if (scope.contextKind === 'organization' && workspaces.some(item => item.id === scope.contextId)) return { kind: 'organization', id: scope.contextId }
    throw new Error(`${name} works in another workspace. Kips in different workspaces cannot message each other; ask the admin kip to pass the message on.`)
  }
  if (workspaceId !== undefined) {
    if (!workspaces.some(item => item.id === workspaceId)) throw new Error(`${name} does not work in that workspace`)
    return { kind: 'organization', id: workspaceId }
  }
  if (scope.contextKind === 'organization' && workspaces.some(item => item.id === scope.contextId)) return { kind: 'organization', id: scope.contextId }
  if (workspaces.length === 1) return { kind: 'organization', id: workspaces[0]!.id }
  if (!workspaces.length) throw new Error(`${name} is not in any workspace`)
  throw new Error(`${name} works in ${workspaces.map(item => `${item.name} (${item.id})`).join(', ')}; pass workspaceId`)
}

/**
 * Sends a kip's message to another kip (decision record 11). The message is posted in the sender's thread with a
 * `kip-message` part and, as an ordinary message from the sender, in the linked thread, which is created in the
 * recipient's chat with the responsible person when needed. The recipient's turn is queued there; the sender's turn
 * goes on. The same attempt and call ID returns the first result.
 */
export async function messageKip(db: Postgres, jobs: Jobs, attemptId: string, incarnation: string, callId: string, input: KipMessageInput, attached?: KipMessageFiles): Promise<KipMessageResult> {
  const { recipientId, text, artifactIds, workspaceId, requestHash } = input
  const allIds = [...artifactIds, ...attached?.files.map(file => file.artifactId) ?? []]
  if (!callId || callId.length > 200 || !uuid.test(recipientId) || !text.trim() || text.length > 16000 || allIds.length > MAX_FILES_PER_MESSAGE || new Set(artifactIds).size !== artifactIds.length || artifactIds.some(id => !uuid.test(id)) || workspaceId !== undefined && !uuid.test(workspaceId)) {
    throw new Error(allIds.length > MAX_FILES_PER_MESSAGE ? `Cannot attach more than ${MAX_FILES_PER_MESSAGE} files to one message` : 'Invalid message_kip arguments')
  }
  const first = await boundScope(db, attemptId, incarnation)
  return db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [first.installationId])
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [first.threadId])
    const scope = await boundScope(client, attemptId, incarnation)
    const prior = (await client.query<{ request_hash: string; result: KipMessageResult }>('SELECT request_hash,result FROM kipster.kip_message_calls WHERE attempt_id=$1 AND call_id=$2', [attemptId, callId])).rows[0]
    if (prior) {
      if (prior.request_hash !== requestHash) throw new Error('This call ID already sent a different message')
      return prior.result
    }
    if (scope.agentId === recipientId) throw new Error('You cannot message yourself')
    const name = (await client.query<{ display_name: string }>('SELECT display_name FROM kipster.agents WHERE id=$1 AND installation_id=$2', [recipientId, scope.installationId])).rows[0]?.display_name
    if (name === undefined) throw new Error('No kip has that ID; find kips with list_kips')
    const limits = (await client.query<{ delegation_depth_limit: number; delegation_root_budget: number; delegation_fanout_limit: number }>('SELECT delegation_depth_limit,delegation_root_budget,delegation_fanout_limit FROM kipster.execution_permits WHERE installation_id=$1', [scope.installationId])).rows[0]!
    if (scope.chainDepth + 1 > limits.delegation_depth_limit) throw new Error(`Cannot message another kip: this message would pass through more than ${limits.delegation_depth_limit} kips. Answer with what you have.`)
    const sent = Number((await client.query<{ n: string }>(`SELECT (SELECT count(*) FROM kipster.kip_message_calls WHERE chain_root_id=$1) + (SELECT count(*) FROM kipster.text_runs WHERE chain_root_id=$1 AND trigger_kind='answer') AS n`, [scope.chainRootId])).rows[0]!.n)
    if (sent >= limits.delegation_root_budget) throw new Error(`Cannot message another kip: this conversation already passed ${limits.delegation_root_budget} kip messages and answers. Answer with what you have.`)
    const turn = Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM kipster.kip_message_calls WHERE sender_run_id=$1', [scope.runId])).rows[0]!.n)
    if (turn >= limits.delegation_fanout_limit) throw new Error(`Cannot message another kip: one turn sends at most ${limits.delegation_fanout_limit} kip messages`)

    // The same source thread and recipient always use the same linked thread.
    const link = (await client.query<{ linked_thread_id: string; chat_id: string; context_kind: 'installation' | 'organization'; context_id: string }>(`SELECT l.linked_thread_id,t.chat_id,c.context_kind,c.context_id FROM kipster.kip_links l
      JOIN kipster.threads t ON t.id=l.linked_thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE l.installation_id=$1 AND l.source_thread_id=$2 AND l.recipient_agent_id=$3`, [scope.installationId, scope.threadId, recipientId])).rows[0]
    let target: Target
    if (link) {
      target = { kind: link.context_kind, id: link.context_id }
      if (workspaceId !== undefined && (target.kind !== 'organization' || target.id !== workspaceId)) throw new Error(`${name} already has a thread for this conversation in another workspace; leave out workspaceId`)
      if (!await isAdmin(client, scope.agentId) && !await isAdmin(client, recipientId) && !(scope.contextKind === 'organization' && target.id === scope.contextId)) throw new Error(`${name} works in another workspace; ask the admin kip to pass the message on`)
    } else target = await messageTarget(client, scope, recipientId, name, workspaceId)
    // The recipient, its membership and the workspace stay locked until the message commits.
    if (target.kind === 'organization' && !(await client.query('SELECT 1 FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2 FOR KEY SHARE', [target.id, recipientId])).rows.length) throw new Error(`${name} no longer works in that workspace`)
    if (!await isLive(client, scope.installationId, 'agent', recipientId)) await refuseAgent(client, scope.installationId, recipientId, `${name} is not available`)
    if (target.kind === 'organization' && !await isLive(client, scope.installationId, 'organization', target.id)) throw new Error('That workspace is not available')
    if (link) {
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [link.linked_thread_id])
      if ((await client.query("SELECT 1 FROM kipster.text_runs WHERE thread_id=$1 AND state='recovery-needed' AND queue_hold LIMIT 1", [link.linked_thread_id])).rows.length) throw new Error(`${name}'s thread has a turn the person must check first; tell the person`)
    }
    // A sender removed from its workspace finishes its turn without starting new work.
    if (scope.contextKind === 'organization' && !(await client.query('SELECT 1 FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2 FOR KEY SHARE', [scope.contextId, scope.agentId])).rows.length) throw new Error('You no longer work in this workspace')
    for (const id of artifactIds) {
      const file = (await client.query('SELECT 1 FROM kipster.message_artifacts ma JOIN kipster.messages m ON m.id=ma.message_id WHERE ma.artifact_id=$1 AND m.thread_id=$2 LIMIT 1', [id, scope.threadId])).rows[0]
      if (!file) throw new Error('Attach only files from this conversation, or attach your own files by path')
    }
    await requireMessageFileLimit(client, allIds)
    await attached?.settle(client)

    const chatId = link?.chat_id ?? (await client.query<{ id: string }>(`INSERT INTO kipster.direct_chats(id,installation_id,caller_id,context_kind,context_id,agent_id) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (installation_id,caller_id,context_kind,context_id,agent_id) DO UPDATE SET id=kipster.direct_chats.id RETURNING id`, [randomUUID(), scope.installationId, scope.personId, target.kind, target.id, recipientId])).rows[0]!.id
    const threadId = link?.linked_thread_id ?? randomUUID()
    // A failed or stopped kip turn holds the thread's queue for the person. The sender was told and writes again, so
    // the queue goes on, as Resume would. A hold on the person's own turn stays until the person resumes.
    const released = link ? (await client.query<{ id: string }>(`UPDATE kipster.text_runs r SET queue_hold=false,queue_generation=queue_generation+1,retry_continue_generation=NULL,revision=revision+1
      WHERE r.thread_id=$1 AND r.queue_hold AND r.trigger_kind='kip' AND r.state IN ('completed','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM kipster.owned_permits o WHERE o.attempt_id=r.current_attempt_id) RETURNING r.id`, [threadId])).rows.map(row => row.id) : []
    if (!link) {
      await client.query('INSERT INTO kipster.threads(id,chat_id) VALUES ($1,$2)', [threadId, chatId])
      await client.query('INSERT INTO kipster.kip_links(installation_id,source_thread_id,recipient_agent_id,linked_thread_id,sender_agent_id) VALUES ($1,$2,$3,$4,$5)', [scope.installationId, scope.threadId, recipientId, threadId, scope.agentId])
    }
    const files = allIds.map(artifactId => ({ kind: 'file' as const, artifactId, purpose: 'attachment' as const }))
    // The sender's copy belongs to its turn, so it stays in the thread's history.
    const sentId = await insertMessage(client, scope.threadId, scope.agentId, [{ kind: 'text', text }, ...files, { kind: 'kip-message', recipientId, threadId, chatId }], allIds, { attemptId, publicationId: `kip:${callId}` })
    const incomingId = await insertMessage(client, threadId, scope.agentId, [{ kind: 'text', text }, ...files], allIds)
    const runId = await queueRun(client, jobs, threadId, incomingId, scope.installationId, { trigger: 'kip', chainRootId: scope.chainRootId, chainDepth: scope.chainDepth + 1, personId: scope.personId })
    const result: KipMessageResult = { status: 'sent', recipientId, threadId, chatId, messageId: sentId }
    await client.query('INSERT INTO kipster.kip_message_calls(attempt_id,call_id,sender_run_id,chain_root_id,request_hash,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [attemptId, callId, scope.runId, scope.chainRootId, requestHash, JSON.stringify(result)])
    for (const id of released) { const record = await workRecord(client, id); await publishThreadChange(client, scope.installationId, scope.personId, threadId, chatId, 'work-changed', id, record.revision, record, record.state, null) }
    // Turns already queued behind a released one may start now.
    if (released.length) for (const { id } of (await client.query<{ id: string }>("SELECT id FROM kipster.text_runs WHERE thread_id=$1 AND state='queued' AND id<>$2", [threadId, runId])).rows) await jobs.send(client, id)
    await publishThreadChange(client, scope.installationId, scope.personId, threadId, chatId, 'message-final', incomingId, 1, await messageRecord(client, incomingId), 'queued', incomingId)
    await publishThreadChange(client, scope.installationId, scope.personId, threadId, chatId, 'work-changed', runId, 1, await workRecord(client, runId), 'queued', null)
    // Published after the recipient's run exists, so the sender's thread summary shows it waiting.
    await publishThreadChange(client, scope.installationId, scope.personId, scope.threadId, scope.chatId, 'message-final', sentId, 1, await messageRecord(client, sentId), 'running', sentId)
    return result
  })
}

type Part = Record<string, unknown> & { kind: string }
/** A finished message at the end of the thread. Caller holds the thread lock. */
async function insertMessage(client: SqlClient, threadId: string, authorId: string, parts: Part[], artifactIds: readonly string[], publication?: { attemptId: string; publicationId: string }): Promise<string> {
  const id = randomUUID()
  const position = Number((await client.query<{ position: string }>('UPDATE kipster.threads SET next_message_position=next_message_position+1,revision=revision+1 WHERE id=$1 RETURNING next_message_position-1 AS position', [threadId])).rows[0]!.position)
  await client.query(`INSERT INTO kipster.messages(id,thread_id,position,author_id,parts,finished_at,source_attempt_id,publication_source,publication_id) VALUES ($1,$2,$3,$4,$5::jsonb,now(),$6,$7,$8)`,
    [id, threadId, position, authorId, JSON.stringify(parts), publication?.attemptId ?? null, publication ? 'tool' : null, publication?.publicationId ?? null])
  const ordinals = parts.flatMap((part, index) => part.kind === 'file' ? [index] : [])
  for (const [index, artifactId] of artifactIds.entries()) await client.query('INSERT INTO kipster.message_artifacts(message_id,ordinal,artifact_id,purpose) VALUES ($1,$2,$3,$4)', [id, ordinals[index], artifactId, 'attachment'])
  return id
}
/** Queues a run behind the thread's earlier work. Caller holds the thread lock. */
async function queueRun(client: SqlClient, jobs: Jobs, threadId: string, messageId: string, installationId: string, chain: { trigger: 'kip' | 'answer'; chainRootId: string; chainDepth: number; personId: string }): Promise<string> {
  const id = randomUUID()
  const position = Number((await client.query<{ position: string }>('UPDATE kipster.threads SET next_queue_position=next_queue_position+1 WHERE id=$1 RETURNING next_queue_position-1 AS position', [threadId])).rows[0]!.position)
  await client.query("INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,'queued')", [id, installationId])
  await client.query(`INSERT INTO kipster.text_runs(id,thread_id,input_message_id,state,queue_position,trigger_kind,chain_root_id,chain_depth,responsible_person_id) VALUES ($1,$2,$3,'queued',$4,$5,$6,$7,$8)`,
    [id, threadId, messageId, position, chain.trigger, chain.chainRootId, chain.chainDepth, chain.personId])
  await jobs.send(client, id)
  return id
}

/** Locks the thread a linked thread's messages come from, if any. Lock it before the linked thread. */
export async function lockKipSource(client: SqlClient, threadId: string): Promise<void> {
  await client.query('SELECT 1 FROM kipster.threads WHERE id=(SELECT source_thread_id FROM kipster.kip_links WHERE linked_thread_id=$1) FOR UPDATE', [threadId])
}

/** How a kip-started run ended: with its final reply, a failure, or stopped. A stopped run whose kip or workspace is gone was removed. */
export type KipRunEnd = { kind: 'completed' } | { kind: 'failed'; reason: string | null } | { kind: 'cancelled' }

/**
 * Sends the answer of a run a kip's message started back into the thread the message came from, authored by the
 * recipient with a `kip-answer` part, and queues the sender's turn on it. A run started by a person or by an answer
 * sends nothing back, and an answer goes back once. The answer is dropped when its thread, or the sender, is gone.
 * Caller holds the capacity lock; lock the source thread (`lockKipSource`) before the run's thread.
 */
export async function answerKipRun(client: SqlClient, jobs: Jobs, runId: string, end: KipRunEnd): Promise<void> {
  const run = (await client.query<{ thread_id: string; chat_id: string; trigger_kind: string; answered_at: Date | null; chain_root_id: string; chain_depth: number; responsible_person_id: string; agent_id: string; context_kind: string; context_id: string; installation_id: string }>(
    `SELECT r.thread_id,t.chat_id,r.trigger_kind,r.answered_at,r.chain_root_id,r.chain_depth,r.responsible_person_id,c.agent_id,c.context_kind,c.context_id,c.installation_id
     FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE r.id=$1`, [runId])).rows[0]
  if (!run || run.trigger_kind !== 'kip' || run.answered_at) return
  await client.query('UPDATE kipster.text_runs SET answered_at=now() WHERE id=$1', [runId])
  const source = (await client.query<{ source_thread_id: string; sender_agent_id: string; chat_id: string; caller_id: string; context_kind: string; context_id: string }>(
    `SELECT l.source_thread_id,l.sender_agent_id,t.chat_id,c.caller_id,c.context_kind,c.context_id FROM kipster.kip_links l
     JOIN kipster.threads t ON t.id=l.source_thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE l.linked_thread_id=$1`, [run.thread_id])).rows[0]
  if (!source || !await chatPresent(client, source.chat_id) || !await isLive(client, run.installation_id, 'agent', source.sender_agent_id)
    || source.context_kind === 'organization' && !await isLive(client, run.installation_id, 'organization', source.context_id)) return
  await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [source.source_thread_id])
  const name = await agentName(client, run.agent_id)
  let parts: Part[] = [], artifactIds: string[] = []
  if (end.kind === 'completed') {
    const replies = (await client.query<{ parts: Part[] }>(`SELECT m.parts FROM kipster.messages m JOIN kipster.attempts a ON a.id=m.source_attempt_id
      WHERE a.intent_id=$1 AND m.final AND NOT m.progress AND NOT m.parts @> '[{"kind":"kip-message"}]' ORDER BY m.position`, [runId])).rows
    const texts = replies.flatMap(row => row.parts.filter(part => part.kind === 'text' && typeof part.text === 'string' && part.text))
    artifactIds = [...new Set(replies.flatMap(row => row.parts.flatMap(part => part.kind === 'file' && typeof part.artifactId === 'string' ? [part.artifactId] : [])))].slice(0, MAX_FILES_PER_MESSAGE)
    parts = [...texts.map(part => ({ kind: 'text', text: part.text })), ...artifactIds.map(artifactId => ({ kind: 'file', artifactId, purpose: 'attachment' }))]
    if (!parts.length) parts = [{ kind: 'text', text: `${name} finished without a reply.` }]
  } else if (end.kind === 'failed') parts = [{ kind: 'text', text: `${name} couldn't finish: ${end.reason || 'the turn failed'}` }]
  else {
    const removed = !await isLive(client, run.installation_id, 'agent', run.agent_id) || run.context_kind === 'organization' && (!await isLive(client, run.installation_id, 'organization', run.context_id)
      || !(await client.query('SELECT 1 FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2', [run.context_id, run.agent_id])).rows.length)
    parts = [{ kind: 'text', text: removed ? `${name} was removed before answering.` : `${name} stopped before answering.` }]
  }
  const messageId = await insertMessage(client, source.source_thread_id, run.agent_id, [...parts, { kind: 'kip-answer', agentId: run.agent_id, threadId: run.thread_id, chatId: run.chat_id }], artifactIds)
  // The woken sender keeps its depth in the chain.
  const answerRunId = await queueRun(client, jobs, source.source_thread_id, messageId, run.installation_id, { trigger: 'answer', chainRootId: run.chain_root_id, chainDepth: Math.max(run.chain_depth - 1, 0), personId: run.responsible_person_id })
  await publishThreadChange(client, run.installation_id, source.caller_id, source.source_thread_id, source.chat_id, 'message-final', messageId, 1, await messageRecord(client, messageId), 'queued', messageId)
  await publishThreadChange(client, run.installation_id, source.caller_id, source.source_thread_id, source.chat_id, 'work-changed', answerRunId, 1, await workRecord(client, answerRunId), 'queued', null)
}
