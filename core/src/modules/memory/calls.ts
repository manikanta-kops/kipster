import { randomUUID } from 'node:crypto'
import type { SqlClient } from '../../platform/postgres/public.js'
import { claimPreparation, issueAttempt, type Attempt } from '../work/public.js'
import type { MemoryStep } from './prompts.js'

/** Finished nightly calls are kept this long, for diagnosis. */
const KEEP_FINISHED_DAYS = 14

/**
 * Opens one nightly model call as work, in the caller's transaction, which holds the installation's capacity lock and
 * may coordinate: a work intent with its `memory_calls` row and an issued attempt that holds an execution permit.
 * Nightly work never takes the capacity user turns need: it runs one call at a time per installation, and takes the
 * last free permit only while no text run waits for one. Returns `busy` when it cannot run now.
 */
export async function openMemoryCall(client: SqlClient, input: { installationId: string; ceiling: number; agentId: string; threadId: string | null; step: MemoryStep; incarnation: string }): Promise<Attempt | 'busy'> {
  const running = await client.query(`SELECT 1 FROM kipster.memory_calls WHERE installation_id=$1 AND state='running' LIMIT 1`, [input.installationId])
  if (running.rows.length) return 'busy'
  const held = Number((await client.query<{ count: string }>('SELECT count(*) FROM kipster.owned_permits WHERE installation_id=$1', [input.installationId])).rows[0]!.count)
  const free = input.ceiling - held
  const waiting = free === 1 && (await client.query(`SELECT 1 FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
    WHERE c.installation_id=$1 AND r.state IN ('queued','preparing') LIMIT 1`, [input.installationId])).rows.length > 0
  if (free < 1 || waiting) return 'busy'
  const id = randomUUID()
  await client.query(`INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,'queued')`, [id, input.installationId])
  await client.query('INSERT INTO kipster.memory_calls(id, installation_id, agent_id, thread_id, step) VALUES ($1,$2,$3,$4,$5)', [id, input.installationId, input.agentId, input.threadId, input.step])
  const attempt = await claimPreparation(client, id, input.incarnation)
  if (!attempt || !await issueAttempt(client, attempt)) throw new Error('Nightly call could not be issued')
  await client.query('INSERT INTO kipster.owned_permits(attempt_id, installation_id) VALUES ($1,$2)', [attempt.id, input.installationId])
  return { ...attempt, state: 'issued' }
}

/** Records the adapter generation an issued nightly attempt runs on. */
export async function recordMemoryRoute(client: SqlClient, attemptId: string, route: { adapterId: string; generationId?: string | undefined; incarnation?: string | undefined; installationDigest?: string | undefined; installationRoot?: string | undefined }): Promise<void> {
  await client.query('UPDATE kipster.attempts SET adapter_id=$2, adapter_generation_id=$3, runner_incarnation=$4, adapter_installation_digest=$5, adapter_installation_root=$6 WHERE id=$1',
    [attemptId, route.adapterId, route.generationId ?? null, route.incarnation ?? null, route.installationDigest ?? null, route.installationRoot ?? null])
}

/** Settles a nightly attempt and releases its permit. A failure is recorded on the call. Returns false when the attempt
 * was already settled, for example by recovery after this process lost the coordinator lock. */
export async function settleMemoryCall(client: SqlClient, attempt: Attempt, failure: string | null): Promise<boolean> {
  const settled = await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND generation=$2 AND incarnation=$3 AND state='issued'`, [attempt.id, attempt.generation, attempt.incarnation])
  if (!settled.rowCount) return false
  await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [attempt.intentId])
  await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
  await client.query(`UPDATE kipster.memory_calls SET state=$2, failure=$3, updated_at=now() WHERE id=$1`, [attempt.intentId, failure === null ? 'completed' : 'failed', failure?.slice(0, 1000) ?? null])
  return true
}

/**
 * Fails the nightly calls left running by a lost process, except the attempts in `keep` that this process still
 * drives, and releases their permits. A nightly call has no side effects beyond its answer, which nothing saves once
 * the call is settled, so it is failed rather than reconciled; the night's run is tried again. Also forgets finished
 * calls older than two weeks, and frees the agents other incarnations were running (`incarnation` keeps this
 * process's own). Caller holds the capacity lock and the coordinator lock.
 */
export async function settleInterruptedMemoryCalls(client: SqlClient, installationId: string, keep: readonly string[], incarnation: string | null): Promise<number> {
  const rows = (await client.query<{ id: string }>(`UPDATE kipster.attempts a SET state='settled' FROM kipster.memory_calls m
    WHERE m.id=a.intent_id AND m.installation_id=$1 AND a.state IN ('preparing','issued','uncertain') AND a.id <> ALL($2::uuid[]) RETURNING a.id`, [installationId, keep])).rows
  if (rows.length) {
    const ids = rows.map(row => row.id)
    await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id = ANY($1::uuid[])', [ids])
    await client.query(`UPDATE kipster.work_intents i SET state='settled' FROM kipster.attempts a WHERE a.intent_id=i.id AND a.id = ANY($1::uuid[])`, [ids])
    await client.query(`UPDATE kipster.memory_calls m SET state='failed', failure='Interrupted', updated_at=now() FROM kipster.attempts a WHERE a.intent_id=m.id AND a.id = ANY($1::uuid[]) AND m.state='running'`, [ids])
  }
  // A call row whose attempt never committed is not running.
  await client.query(`UPDATE kipster.memory_calls m SET state='failed', failure='Interrupted', updated_at=now() WHERE m.installation_id=$1 AND m.state='running'
    AND NOT EXISTS (SELECT 1 FROM kipster.attempts a WHERE a.intent_id=m.id AND a.state IN ('preparing','issued'))`, [installationId])
  await client.query(`UPDATE kipster.memory_nights SET owner=NULL WHERE installation_id=$1 AND owner IS DISTINCT FROM $2::uuid`, [installationId, incarnation])
  const old = (await client.query<{ id: string }>(`DELETE FROM kipster.memory_calls WHERE installation_id=$1 AND state<>'running' AND updated_at < now() - make_interval(days => $2) RETURNING id`, [installationId, KEEP_FINISHED_DAYS])).rows.map(row => row.id)
  if (old.length) {
    await client.query('DELETE FROM kipster.attempts WHERE intent_id = ANY($1::uuid[])', [old])
    await client.query('DELETE FROM kipster.work_intents WHERE id = ANY($1::uuid[])', [old])
  }
  return rows.length
}
