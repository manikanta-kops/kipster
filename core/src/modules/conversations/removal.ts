import type { SqlClient } from '../../platform/postgres/public.js'
import { notifyThread, publishAppEvent, publishThreadSummary } from '../synchronization/public.js'

export interface RemovedThread { id: string; chatId: string }

const ids = async (client: SqlClient, sql: string, params: unknown[]): Promise<string[]> => (await client.query<{ id: string }>(sql, params)).rows.map(row => row.id)

/**
 * Removes threads with their messages and runs, and everything that points into them: events,
 * summaries, notifications, interactions, controls, submission receipts, attempts and the tool
 * receipts of those attempts, and their kip links. A thread that stays and was linked to a removed
 * thread publishes its summary again without that link. Every application client is told with one
 * `thread-removed` event per thread.
 *
 * `beforeRemove` runs for each thread once every lock is held, before any row goes; use it to remove
 * what is derived from the thread, such as its memory. Caller holds the capacity lock. The work in the threads must have ended:
 * a permit still held by one of their attempts makes the removal fail.
 */
export async function removeThreads(client: SqlClient, installationId: string, threadIds: readonly string[], beforeRemove: (threadId: string, messageIds: string[]) => Promise<void>): Promise<RemovedThread[]> {
  if (!threadIds.length) return []
  // Every thread this touches is locked first, in one order, and nothing is published before that.
  const linked = await ids(client, `SELECT source_thread_id AS id FROM kipster.kip_links WHERE linked_thread_id = ANY($1::uuid[]) AND NOT source_thread_id = ANY($1::uuid[])
    UNION SELECT linked_thread_id FROM kipster.kip_links WHERE source_thread_id = ANY($1::uuid[]) AND NOT linked_thread_id = ANY($1::uuid[])`, [threadIds])
  await client.query('SELECT 1 FROM kipster.threads WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[...threadIds, ...linked]])
  const threads = (await client.query<{ id: string; chat_id: string; revision: string }>(
    'SELECT id, chat_id, revision FROM kipster.threads WHERE id = ANY($1::uuid[]) ORDER BY id', [threadIds])).rows
  const present = threads.map(thread => thread.id)
  const runs = await ids(client, 'SELECT id FROM kipster.text_runs WHERE thread_id = ANY($1::uuid[])', [present])
  const attempts = await ids(client, 'SELECT id FROM kipster.attempts WHERE intent_id = ANY($1::uuid[])', [runs])
  const messages = await ids(client, 'SELECT id FROM kipster.messages WHERE thread_id = ANY($1::uuid[]) ORDER BY thread_id, position', [present])
  for (const thread of present) {
    await beforeRemove(thread, (await client.query<{ id: string }>('SELECT id FROM kipster.messages WHERE thread_id=$1 ORDER BY position', [thread])).rows.map(row => row.id))
  }

  // Links from and to these threads go with them. A message from a removed thread no longer gets an answer.
  await client.query('DELETE FROM kipster.kip_links WHERE source_thread_id = ANY($1::uuid[]) OR linked_thread_id = ANY($1::uuid[])', [present])

  const notifications = (await client.query<{id:string;thread_id:string;revision:string}>(
    'SELECT id,thread_id,revision FROM kipster.notifications WHERE thread_id=ANY($1::uuid[]) OR run_id=ANY($2::uuid[])', [present,runs])).rows
  await client.query('DELETE FROM kipster.notifications WHERE thread_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])', [present, runs])
  const interactions = await ids(client, 'SELECT id FROM kipster.interactions WHERE run_id = ANY($1::uuid[]) OR attempt_id = ANY($2::uuid[])', [runs, attempts])
  await client.query('DELETE FROM kipster.notifications WHERE interaction_id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.interaction_receipts WHERE interaction_id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.interactions WHERE id = ANY($1::uuid[])', [interactions])
  await client.query('DELETE FROM kipster.work_controls WHERE thread_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])', [present, runs])
  await client.query('DELETE FROM kipster.receipts WHERE installation_id=$1 AND receipt->>\'intentId\' = ANY($2::text[])', [installationId, runs])

  // Tool receipts and staged outputs of the attempts.
  for (const table of ['kipster.vector_tool_receipts', 'task_data.receipts', 'kipster.artifact_output_writes',
    'kipster.artifact_publications', 'kipster.artifact_organization_copies', 'kipster.artifact_file_attachments', 'kipster.kip_message_calls', 'kipster.voice_tool_calls']) {
    await client.query(`DELETE FROM ${table} WHERE attempt_id = ANY($1::uuid[])`, [attempts])
  }
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
  for (const thread of linked) {
    const chat = (await client.query<{ id: string; caller_id: string }>('SELECT c.id, c.caller_id FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE t.id=$1', [thread])).rows[0]!
    await publishThreadSummary(client, installationId, chat.caller_id, thread, chat.id)
  }
  for (const thread of threads) {
    await notifyThread(client, thread.id)
    await publishAppEvent(client, installationId, 'thread-removed', thread.id, Number(thread.revision) + 1, { threadId: thread.id, chatId: thread.chat_id })
  }
  return threads.map(thread => ({ id: thread.id, chatId: thread.chat_id }))
}
