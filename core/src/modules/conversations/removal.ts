import type { SqlClient } from '../../platform/postgres/public.js'
import { notifyThread, publishAppEvent, publishThreadChange } from '../synchronization/public.js'
import { delegationActivity, delegationRecord } from '../work/public.js'

export interface RemovedThread { id: string; chatId: string; internal: boolean }

const ids = async (client: SqlClient, sql: string, params: unknown[]): Promise<string[]> => (await client.query<{ id: string }>(sql, params)).rows.map(row => row.id)

/**
 * Removes threads with their messages and runs, and everything that points into them: events,
 * summaries, notifications, interactions, controls, submission receipts, attempts and the tool
 * receipts of those attempts. A delegation made from a thread that stays keeps its record there:
 * its links to removed runs are cleared, and the record is published to that thread. Every
 * application client is told with one `thread-removed` event per visible thread.
 *
 * `beforeRemove` runs for each thread once every lock is held, before any row goes; use it for the
 * memory deletion hooks. Caller holds the capacity lock. The work in the threads must have ended:
 * a permit still held by one of their attempts makes the removal fail.
 */
export async function removeThreads(client: SqlClient, installationId: string, threadIds: readonly string[], beforeRemove: (threadId: string, messageIds: string[]) => Promise<void>): Promise<RemovedThread[]> {
  if (!threadIds.length) return []
  // Every thread this touches is locked first, in one order, and nothing is published before that.
  const origins = await ids(client, `SELECT DISTINCT d.origin_thread_id AS id FROM kipster.delegations d
    WHERE NOT d.origin_thread_id = ANY($1::uuid[]) AND (d.child_run_id IN (SELECT id FROM kipster.text_runs WHERE thread_id = ANY($1::uuid[]))
      OR d.parent_run_id IN (SELECT id FROM kipster.text_runs WHERE thread_id = ANY($1::uuid[])))`, [threadIds])
  await client.query('SELECT 1 FROM kipster.threads WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...threadIds, ...origins]])
  const threads = (await client.query<{ id: string; chat_id: string; internal: boolean; revision: string }>(
    'SELECT id, chat_id, internal, revision FROM kipster.threads WHERE id = ANY($1::uuid[]) ORDER BY id', [threadIds])).rows
  const present = threads.map(thread => thread.id)
  const runs = await ids(client, 'SELECT id FROM kipster.text_runs WHERE thread_id = ANY($1::uuid[])', [present])
  const attempts = await ids(client, 'SELECT id FROM kipster.attempts WHERE intent_id = ANY($1::uuid[])', [runs])
  const messages = await ids(client, 'SELECT id FROM kipster.messages WHERE thread_id = ANY($1::uuid[]) ORDER BY thread_id, position', [present])
  for (const thread of present) {
    await beforeRemove(thread, (await client.query<{ id: string }>('SELECT id FROM kipster.messages WHERE thread_id=$1 ORDER BY position', [thread])).rows.map(row => row.id))
  }

  // Delegations made in these threads go with them; those made elsewhere keep their record.
  await client.query('DELETE FROM kipster.delegations WHERE origin_thread_id = ANY($1::uuid[]) OR root_run_id = ANY($2::uuid[])', [present, runs])
  const detached = await ids(client, `UPDATE kipster.delegations SET
      child_run_id = CASE WHEN child_run_id = ANY($1::uuid[]) THEN NULL ELSE child_run_id END,
      parent_run_id = CASE WHEN parent_run_id = ANY($1::uuid[]) THEN NULL ELSE parent_run_id END,
      parent_attempt_id = CASE WHEN parent_attempt_id = ANY($2::uuid[]) THEN NULL ELSE parent_attempt_id END,
      revision = revision + 1
    WHERE child_run_id = ANY($1::uuid[]) OR parent_run_id = ANY($1::uuid[]) OR parent_attempt_id = ANY($2::uuid[])
    RETURNING id`, [runs, attempts])

  const notifications = (await client.query<{id:string;thread_id:string;revision:string}>(
    'SELECT id,thread_id,revision FROM kipster.notifications WHERE thread_id=ANY($1::uuid[]) OR run_id=ANY($2::uuid[])', [present,runs])).rows
  await client.query('DELETE FROM kipster.notifications WHERE thread_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])', [present, runs])
  const interactions = await ids(client, 'SELECT id FROM kipster.interactions WHERE run_id = ANY($1::uuid[]) OR attempt_id = ANY($2::uuid[])', [runs, attempts])
  await client.query('DELETE FROM kipster.notifications WHERE interaction_id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.interaction_receipts WHERE interaction_id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.interactions WHERE id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.work_controls WHERE thread_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])', [present, runs])
  await client.query('DELETE FROM kipster.receipts WHERE installation_id=$1 AND receipt->>\'intentId\' = ANY($2::text[])', [installationId, runs])

  // Tool receipts and staged outputs of the attempts. A relationship change another owner keeps
  // loses only its link to the attempt.
  for (const table of ['kipster.memory_tool_receipts', 'kipster.vector_tool_receipts', 'task_data.receipts', 'kipster.artifact_output_writes',
    'kipster.artifact_publications', 'kipster.artifact_organization_copies', 'kipster.voice_tool_calls']) {
    await client.query(`DELETE FROM ${table} WHERE attempt_id = ANY($1::uuid[])`, [attempts])
  }
  await client.query('UPDATE kipster.memory_relationship_changes SET attempt_id=NULL WHERE attempt_id = ANY($1::uuid[])', [attempts])
  await client.query('UPDATE kipster.voice_preparations SET attempt_id=NULL WHERE attempt_id = ANY($1::uuid[])', [attempts])

  await client.query('DELETE FROM kipster.attempts WHERE id = ANY($1::uuid[])', [attempts])
  await client.query('DELETE FROM kipster.text_runs WHERE id = ANY($1::uuid[])', [runs])
  await client.query('DELETE FROM kipster.work_intents WHERE id = ANY($1::uuid[])', [runs])
  await client.query('DELETE FROM kipster.message_artifacts WHERE message_id = ANY($1::uuid[])', [messages])
  await client.query('DELETE FROM kipster.messages WHERE id = ANY($1::uuid[])', [messages])
  for (const table of ['kipster.thread_events', 'kipster.app_thread_summaries', 'kipster.app_projection_intents']) {
    await client.query(`DELETE FROM ${table} WHERE thread_id = ANY($1::uuid[])`, [present])
  }
  await client.query('DELETE FROM kipster.threads WHERE id = ANY($1::uuid[])', [present])

  for (const notification of notifications) await publishAppEvent(client, installationId, 'notification-removed', notification.id, Number(notification.revision) + 1, { id: notification.id, threadId: notification.thread_id })
  for (const id of detached) {
    const record = await delegationRecord(client, id)
    const origin = (await client.query<{ chat_id: string; responsible_human_id: string }>(
      'SELECT t.chat_id, d.responsible_human_id FROM kipster.delegations d JOIN kipster.threads t ON t.id=d.origin_thread_id WHERE d.id=$1', [id])).rows[0]!
    await publishThreadChange(client, installationId, origin.responsible_human_id, record.originThreadId, origin.chat_id, 'delegation-changed', id, record.revision, delegationActivity(record), record.state, null)
  }
  for (const thread of threads) {
    await notifyThread(client, thread.id)
    if (!thread.internal) await publishAppEvent(client, installationId, 'thread-removed', thread.id, Number(thread.revision) + 1, { threadId: thread.id, chatId: thread.chat_id })
  }
  return threads.map(thread => ({ id: thread.id, chatId: thread.chat_id, internal: thread.internal }))
}
