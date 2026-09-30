import type { SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { publishThreadChange, interactionNotificationChanged } from '../synchronization/public.js'
import { sealAttemptMessages, messageRecord, workRecord } from '../conversations/public.js'
import { fenceMaintenance } from '../memory/public.js'
import { interactionRecord } from './interactions.js'
import { cancelDelegationTree, finishDelegation } from './delegation.js'

export interface StopTarget { id: string; state: string; current_attempt_id: string | null; input_message_id: string; installation_id: string; caller_id: string; thread_id: string; chat_id: string }

/**
 * Stops a run the way the owner's Stop does. Queued and preparing work is cancelled at once; work whose
 * provider may still run keeps its state as `cancellation-requested` until the provider ends. Pending
 * interactions are cancelled and the run's delegation tree is stopped. Caller holds the capacity lock
 * and the run's thread lock. Returns the new state and the attempts whose adapter should cancel.
 */
export async function stopRun(client: SqlClient, run: StopTarget): Promise<{ state: string; cancelAttempts: string[] }> {
  const active = run.state === 'running' || run.state === 'waiting' && !!(await client.query('SELECT 1 FROM kipster.owned_permits WHERE attempt_id=$1', [run.current_attempt_id])).rows.length
  const next = active ? 'cancellation-requested' : 'cancelled'
  await client.query('UPDATE kipster.text_runs SET state=$2,stop_requested=true,queue_hold=true,cancel_delivery=$3,queue_generation=queue_generation+1,retry_continue_generation=NULL,revision=revision+1 WHERE id=$1', [run.id, next, active ? 'requested' : 'not-needed'])
  if (run.current_attempt_id) await sealAttemptMessages(client, run.current_attempt_id, next)
  const pending = await client.query<{ id: string }>('UPDATE kipster.interactions SET state=$2,revision=revision+1 WHERE run_id=$1 AND state=$3 RETURNING id', [run.id, 'cancelled', 'pending'])
  for (const item of pending.rows) {
    const card = await interactionRecord(client, item.id)
    await publishThreadChange(client, run.installation_id, run.caller_id, run.thread_id, run.chat_id, 'interaction-changed', card.id, card.revision, card, next, null)
    await interactionNotificationChanged(client, card.id)
  }
  const cancelAttempts = active && run.current_attempt_id ? [run.current_attempt_id] : []
  cancelAttempts.push(...await cancelDelegationTree(client, run.id))
  if (run.state === 'preparing' && run.current_attempt_id) {
    const changed = await client.query("UPDATE kipster.voice_preparations SET status='unavailable',failure='cancelled',revision=revision+1 WHERE message_id=$1 AND status IN ('pending','preparing')", [run.input_message_id])
    if (changed.rowCount) {
      const revision = Number((await client.query<{ revision: string }>('UPDATE kipster.messages SET revision=revision+1 WHERE id=$1 RETURNING revision', [run.input_message_id])).rows[0]!.revision)
      await publishThreadChange(client, run.installation_id, run.caller_id, run.thread_id, run.chat_id, 'message-final', run.input_message_id, revision, await messageRecord(client, run.input_message_id), 'cancelled', null)
    }
    await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [run.current_attempt_id, 'settled', 'preparing'])
    await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1', [run.id, 'settled'])
  } else if (!active) await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1', [run.id, 'settled'])
  return { state: next, cancelAttempts }
}

/** The work of one agent, wherever it runs, or all work in one organization's chats. */
export type AffectedWork = { agentId: string } | { organizationId: string }

/**
 * Stops the affected work as Stop does: queued runs are cancelled and stay visible, pending interactions
 * are cancelled, and running work is asked to stop; the returned attempts need adapter cancellation.
 * A stopped delegated child whose parent is not affected delivers `failure` to that parent. Queued
 * maintenance runs are cancelled too. Call it in the transaction that changes the owner's lifecycle,
 * after the capacity lock and the owner row lock, so later writers see the stop or the new lifecycle.
 */
export async function fenceAffectedWork(client: SqlClient, jobs: Jobs, installationId: string, affected: AffectedWork, failure: string): Promise<{ runs: string[]; cancelAttempts: string[]; maintenanceRuns: number }> {
  const byAgent = 'agentId' in affected
  const rows = (await client.query<{ id: string; parent_run_id: string | null }>(
    `SELECT r.id, d.parent_run_id FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id
       JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
     WHERE c.installation_id=$1 AND r.state IN ('queued','preparing','running','waiting')
       AND ${byAgent ? 'COALESCE(d.recipient_agent_id, c.agent_id) = $2' : `c.context_kind='organization' AND c.context_id = $2`}
     ORDER BY COALESCE(d.depth, 0), r.thread_id, r.queue_position`,
    [installationId, byAgent ? affected.agentId : affected.organizationId])).rows
  const affectedRuns = new Set(rows.map(row => row.id))
  // Every thread the fence touches is locked first, in one sorted pass: the runs' own threads, their
  // origin threads and those of their delegation trees. Only then does it stop runs and publish, so it
  // never holds the application stream while it waits for a thread.
  await client.query(`WITH RECURSIVE tree AS (
      SELECT id FROM kipster.text_runs WHERE id = ANY($1::uuid[])
      UNION SELECT d.child_run_id FROM kipster.delegations d JOIN tree ON d.parent_run_id = tree.id)
    SELECT t.id FROM kipster.threads t WHERE t.id IN (
      SELECT r.thread_id FROM kipster.text_runs r JOIN tree ON r.id = tree.id
      UNION SELECT d.origin_thread_id FROM kipster.delegations d JOIN tree ON d.child_run_id = tree.id)
    ORDER BY t.id FOR UPDATE`, [[...affectedRuns]])
  const runs: string[] = []
  const cancelAttempts: string[] = []
  for (const row of rows) {
    const run = (await client.query<StopTarget & { stop_requested: boolean }>(
      `SELECT r.id,r.state,r.current_attempt_id,r.input_message_id,r.thread_id,r.stop_requested,t.chat_id,c.installation_id,c.caller_id
       FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE r.id=$1`, [row.id])).rows[0]!
    // A parent stopped earlier in this loop may already have stopped this run.
    if (run.stop_requested || !['queued', 'preparing', 'running', 'waiting'].includes(run.state)) continue
    const stopped = await stopRun(client, run)
    runs.push(run.id)
    cancelAttempts.push(...stopped.cancelAttempts)
    const record = await workRecord(client, run.id)
    await publishThreadChange(client, run.installation_id, run.caller_id, run.thread_id, run.chat_id, 'work-changed', run.id, record.revision, record, stopped.state, null)
    if (row.parent_run_id && !affectedRuns.has(row.parent_run_id)) await finishDelegation(client, jobs, run.id, 'failed', failure)
  }
  const maintenanceRuns = await fenceMaintenance(client, installationId, affected, failure)
  return { runs, cancelAttempts, maintenanceRuns }
}
