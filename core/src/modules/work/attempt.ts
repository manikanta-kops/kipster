import { randomUUID } from 'node:crypto'
import type { SqlClient } from '../../platform/postgres/public.js'

export interface Attempt { id: string; intentId: string; generation: number; incarnation: string; state: 'preparing' | 'issued' | 'settled' | 'uncertain' }
/** A preparation claim is safe to replace until issue has committed. Caller owns transaction. */
export async function claimPreparation(client: SqlClient, intentId: string, incarnation: string): Promise<Attempt | null> {
  const row = (await client.query<{ state: string; generation: string }>('SELECT state, generation FROM kipster.work_intents WHERE id=$1 FOR UPDATE', [intentId])).rows[0]
  if (!row || !['queued', 'preparing'].includes(row.state)) return null
  const generation = Number(row.generation) + 1
  const id = randomUUID()
  await client.query('UPDATE kipster.work_intents SET state=$2, generation=$3 WHERE id=$1', [intentId, 'preparing', generation])
  await client.query('INSERT INTO kipster.attempts(id,intent_id,generation,incarnation,state) VALUES ($1,$2,$3,$4,$5)', [id, intentId, generation, incarnation, 'preparing'])
  return { id, intentId, generation, incarnation, state: 'preparing' }
}
/** Commit this fence before any effectful adapter initialization or dispatch. */
export async function issueAttempt(client: SqlClient, attempt: Attempt): Promise<boolean> {
  const changed = await client.query('UPDATE kipster.work_intents SET state=$4 WHERE id=$1 AND generation=$2 AND state=$3', [attempt.intentId, attempt.generation, 'preparing', 'issued'])
  if (!changed.rowCount) return false
  const updated = await client.query('UPDATE kipster.attempts SET state=$5 WHERE id=$1 AND intent_id=$2 AND generation=$3 AND incarnation=$4 AND state=$6', [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation, 'issued', 'preparing'])
  if (!updated.rowCount) throw new Error('Attempt fence mismatch')
  return true
}
/** Process loss yields uncertainty, never automatic release or retry. */
export async function markUncertain(client: SqlClient, attempt: Attempt): Promise<boolean> {
  const updated = await client.query('UPDATE kipster.attempts SET state=$5 WHERE id=$1 AND intent_id=$2 AND generation=$3 AND incarnation=$4 AND state=$6', [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation, 'uncertain', 'issued'])
  if (!updated.rowCount) return false
  const intent = await client.query('UPDATE kipster.work_intents SET state=$3 WHERE id=$1 AND generation=$2 AND state=$4', [attempt.intentId, attempt.generation, 'uncertain', 'issued'])
  if (!intent.rowCount) throw new Error('Intent fence mismatch')
  return true
}
