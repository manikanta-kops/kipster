import { randomUUID } from 'node:crypto'
import type { SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import type { TrustedActor } from '../identity/public.js'

export interface IntentReceipt { submissionId: string; intentId: string; alreadyAccepted: boolean; [key: string]: unknown }
/** Caller owns the transaction, so canonical records, receipt, intent and wakeup commit together. */
export async function acceptIntent(
  client: SqlClient,
  jobs: Jobs,
  actor: TrustedActor,
  submissionId: string,
  authorize: (client: SqlClient) => Promise<void>,
  createCanonical?: (client: SqlClient, intentId: string) => Promise<Record<string, unknown>>,
): Promise<IntentReceipt> {
  if (!submissionId.trim()) throw new Error('Submission ID required')
  await authorize(client) // Scope authorization precedes even a duplicate receipt lookup.
  const caller = await client.query('SELECT 1 FROM kipster.bootstrap WHERE owner_id=$1 AND installation_id=$2', [actor.personId, actor.installationId])
  if (!caller.rows.length) throw new Error('Caller not authorized')
  const key = [actor.installationId, actor.personId, submissionId]
  const previous = await client.query<{ receipt: IntentReceipt }>('SELECT receipt FROM kipster.receipts WHERE installation_id=$1 AND caller_id=$2 AND submission_id=$3', key)
  if (previous.rows[0]) return { ...previous.rows[0].receipt, alreadyAccepted: true }
  const intentId = randomUUID()
  const base = { submissionId, intentId }
  const claimed = await client.query('INSERT INTO kipster.receipts VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING 1', [...key, JSON.stringify(base)])
  if (!claimed.rows.length) {
    const winner = await client.query<{ receipt: IntentReceipt }>('SELECT receipt FROM kipster.receipts WHERE installation_id=$1 AND caller_id=$2 AND submission_id=$3', key)
    if (!winner.rows[0]) throw new Error('Receipt conflict without winner')
    return { ...winner.rows[0].receipt, alreadyAccepted: true }
  }
  await client.query('INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,$3)', [intentId, actor.installationId, 'queued'])
  const extra = await createCanonical?.(client, intentId) ?? {}
  const receipt = { ...extra, ...base }
  await client.query('UPDATE kipster.receipts SET receipt=$4::jsonb WHERE installation_id=$1 AND caller_id=$2 AND submission_id=$3', [...key, JSON.stringify(receipt)])
  await jobs.send(client, intentId)
  return { ...receipt, alreadyAccepted: false }
}
