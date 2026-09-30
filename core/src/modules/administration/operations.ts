import type { SqlClient } from '../../platform/postgres/public.js'

/**
 * Administration operations are recorded under the caller's key, so a repeated request returns the
 * recorded outcome instead of acting twice. A person supplies its own operation ID; an agent tool
 * call supplies an explicit stable operation ID.
 */
export interface OperationKey { installationId: string; actorKind: 'person' | 'agent'; actorId: string; operationId: string; attemptId?: string }
export interface Operation {
  id: string
  installationId: string
  kind: string
  targetId: string
  options: Record<string, unknown>
  state: 'pending' | 'running' | 'waiting' | 'succeeded' | 'failed'
  step: string | null
  result: unknown
}

export class OperationConflictError extends Error {
  constructor() { super('Operation ID was already used for a different request') }
}

const columns = 'id, installation_id, kind, target_id, options, state, step, result'
type Row = { id: string; installation_id: string; kind: string; target_id: string; options: Record<string, unknown>; state: Operation['state']; step: string | null; result: unknown }
const operation = (row: Row): Operation => ({ id: row.id, installationId: row.installation_id, kind: row.kind, targetId: row.target_id, options: row.options, state: row.state, step: row.step, result: row.result })

/**
 * Records a pending operation in the caller's transaction, together with the IDs it plans to
 * create, or returns the operation already recorded under the key. One key names one validated logical request.
 */
export async function claimOperation(client: SqlClient, key: OperationKey, kind: string, target: { kind: string; id: string }, options: Record<string, unknown>, request: Record<string, unknown> = { kind, target, options }): Promise<{ operation: Operation; claimed: boolean }> {
  const inserted = await client.query<Row>(
    `INSERT INTO kipster.admin_operations(id, installation_id, actor_kind, actor_id, operation_id, kind, target_kind, target_id, options, request, origin_run_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, (SELECT intent_id FROM kipster.attempts WHERE id=$10::uuid))
     ON CONFLICT (installation_id, actor_kind, actor_id, operation_id) DO NOTHING RETURNING ${columns}`,
    [key.installationId, key.actorKind, key.actorId, key.operationId, kind, target.kind, target.id, JSON.stringify(options), JSON.stringify(request), key.attemptId ?? null])
  if (inserted.rows[0]) return { operation: operation(inserted.rows[0]), claimed: true }
  const existing = (await client.query<Row>(`SELECT ${columns} FROM kipster.admin_operations WHERE installation_id=$1 AND actor_kind=$2 AND actor_id=$3 AND operation_id=$4 AND request=$5::jsonb`,
    [key.installationId, key.actorKind, key.actorId, key.operationId, JSON.stringify(request)])).rows[0]
  if (!existing || existing.kind !== kind) throw new OperationConflictError()
  return { operation: operation(existing), claimed: false }
}

/** Locks an operation for its next step; concurrent finishers wait here and then see the outcome. */
export async function lockOperation(client: SqlClient, id: string): Promise<Operation> {
  const row = (await client.query<Row>(`SELECT ${columns} FROM kipster.admin_operations WHERE id=$1 FOR UPDATE`, [id])).rows[0]
  if (!row) throw new Error('Operation not found')
  return operation(row)
}

export async function completeOperation(client: SqlClient, id: string, result: unknown): Promise<void> {
  await client.query(`UPDATE kipster.admin_operations SET state='succeeded', result=$2::jsonb, revision=revision+1, updated_at=now() WHERE id=$1`, [id, JSON.stringify(result)])
}

/** Operations of the given kinds that have not finished, oldest first. */
export async function pendingOperations(client: SqlClient, installationId: string, kinds: readonly string[]): Promise<string[]> {
  const rows = await client.query<{ id: string }>(`SELECT id FROM kipster.admin_operations WHERE installation_id=$1 AND state='pending' AND kind = ANY($2::text[]) ORDER BY created_at, id`, [installationId, kinds])
  return rows.rows.map(row => row.id)
}

export interface OperationStatus {
  operationId: string
  kind: string
  target: { kind: string | null; id: string | null }
  state: Operation['state']
  step: string | null
  waitingFor: string | null
  result: unknown
  error: string | null
  createdAt: string
  updatedAt: string
}

/** The operation recorded under the key, or null. */
export async function operationStatus(client: SqlClient, key: OperationKey): Promise<OperationStatus | null> {
  const row = (await client.query<{ operation_id: string; kind: string; target_kind: string | null; target_id: string | null; state: Operation['state']; step: string | null; waiting_for: string | null; result: unknown; error: string | null; created_at: Date; updated_at: Date }>(
    `SELECT operation_id, kind, target_kind, target_id, state, step, waiting_for, result, error, created_at, updated_at FROM kipster.admin_operations
     WHERE installation_id=$1 AND actor_kind=$2 AND actor_id=$3 AND operation_id=$4`, [key.installationId, key.actorKind, key.actorId, key.operationId])).rows[0]
  if (!row) return null
  return { operationId: row.operation_id, kind: row.kind, target: { kind: row.target_kind, id: row.target_id }, state: row.state, step: row.step, waitingFor: row.waiting_for, result: row.result, error: row.error, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }
}

/** Operations of the given kinds that have not finished, oldest first. */
export async function openOperations(client: SqlClient, installationId: string, kinds: readonly string[]): Promise<string[]> {
  const rows = await client.query<{ id: string }>(`SELECT id FROM kipster.admin_operations WHERE installation_id=$1 AND state IN ('pending','running','waiting') AND kind = ANY($2::text[]) ORDER BY created_at, id`, [installationId, kinds])
  return rows.rows.map(row => row.id)
}

/**
 * The outcome of one step batch. `done` moves to the next step, or finishes the operation after the
 * last one, and merges `result` into the operation's result. `more` runs another batch of the same
 * step. `wait` pauses the operation with its reason, for example while a provider could still write.
 * `failed` ends it.
 */
export type StepOutcome = { status: 'done'; result?: Record<string, unknown> } | { status: 'more' } | { status: 'wait'; reason: string } | { status: 'failed'; error: string }

/** Records a step outcome in the step's own transaction, so the batch and its progress commit together. */
export async function recordStep(client: SqlClient, id: string, step: string, next: string | null, outcome: StepOutcome): Promise<void> {
  const [state, nextStep, waitingFor, error] =
    outcome.status === 'done' ? [next ? 'running' : 'succeeded', next ?? step, null, null]
      : outcome.status === 'more' ? ['running', step, null, null]
        : outcome.status === 'wait' ? ['waiting', step, outcome.reason.slice(0, 500), null]
          : ['failed', step, null, outcome.error]
  const result = outcome.status === 'done' && outcome.result ? JSON.stringify(outcome.result) : null
  await client.query(`UPDATE kipster.admin_operations SET state=$2, step=$3, waiting_for=$4, error=$5,
      result=CASE WHEN $6::jsonb IS NULL THEN result ELSE COALESCE(result, '{}'::jsonb) || $6::jsonb END, revision=revision+1, updated_at=now()
    WHERE id=$1`, [id, state, nextStep, waitingFor, error, result])
}

/** Records a step failure that will be retried; the operation stays open. */
export async function recordStepError(client: SqlClient, id: string, error: string): Promise<void> {
  await client.query(`UPDATE kipster.admin_operations SET error=$2, revision=revision+1, updated_at=now() WHERE id=$1 AND state IN ('pending','running','waiting')`, [id, error.slice(0, 2000)])
}
