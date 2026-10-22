import type { SqlClient } from '../../platform/postgres/public.js'

/**
 * Removes the memory derived from threads that are being deleted: their chunks, processing state, memory and lesson
 * sources, every memory and lesson left with no source, and their diary contributions. A page left with no thread is deleted. A page that
 * covers other threads too loses the threads' IDs, its summary and its embedding: it owes a rebuild, which the next
 * nightly run writes from the remaining threads' messages. Call it while the threads are locked, before their rows go.
 */
export async function removeThreadMemory(client: SqlClient, threadIds: readonly string[]): Promise<void> {
  if (!threadIds.length) return
  await client.query('DELETE FROM kipster.thread_chunks WHERE thread_id = ANY($1::uuid[])', [threadIds])
  await client.query('DELETE FROM kipster.memory_thread_state WHERE thread_id = ANY($1::uuid[])', [threadIds])
  const memories = (await client.query<{ memory_id: string }>('DELETE FROM kipster.memory_sources WHERE thread_id = ANY($1::uuid[]) RETURNING memory_id', [threadIds])).rows.map(row => row.memory_id)
  await client.query('DELETE FROM kipster.memories c WHERE c.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM kipster.memory_sources s WHERE s.memory_id = c.id)', [[...new Set(memories)]])
  const lessons = (await client.query<{ lesson_id: string }>('DELETE FROM kipster.lesson_sources WHERE thread_id = ANY($1::uuid[]) RETURNING lesson_id', [threadIds])).rows.map(row => row.lesson_id)
  await client.query('DELETE FROM kipster.lessons l WHERE l.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM kipster.lesson_sources s WHERE s.lesson_id = l.id)', [[...new Set(lessons)]])
  await client.query('DELETE FROM kipster.diary WHERE thread_ids && $1::uuid[] AND thread_ids <@ $1::uuid[]', [threadIds])
  await client.query(`UPDATE kipster.diary SET thread_ids = ARRAY(SELECT id FROM unnest(thread_ids) WITH ORDINALITY AS t(id, n) WHERE id <> ALL($1::uuid[]) ORDER BY n),
      summary = NULL, embedding = NULL, embedding_model = NULL, updated_at = now()
    WHERE thread_ids && $1::uuid[]`, [threadIds])
}

/** Deletes up to `limit` of an agent's thread chunks, lessons and diary pages; returns how many rows went. */
export async function deleteAgentMemory(client: SqlClient, agentId: string, limit: number): Promise<number> {
  const chunks = await client.query('DELETE FROM kipster.thread_chunks WHERE id IN (SELECT id FROM kipster.thread_chunks WHERE agent_id = $1 LIMIT $2)', [agentId, limit])
  const lessons = await client.query('DELETE FROM kipster.lessons WHERE id IN (SELECT id FROM kipster.lessons WHERE agent_id = $1 LIMIT $2)', [agentId, limit])
  const pages = await client.query('DELETE FROM kipster.diary WHERE ctid IN (SELECT ctid FROM kipster.diary WHERE agent_id = $1 LIMIT $2)', [agentId, limit])
  return Math.max(chunks.rowCount ?? 0, lessons.rowCount ?? 0, pages.rowCount ?? 0)
}

/** Deletes up to `limit` of an organization's memories, lessons learned in it, thread chunks and diary pages; returns how many rows went. */
export async function deleteOrganizationMemory(client: SqlClient, organizationId: string, limit: number): Promise<number> {
  const memories = await client.query('DELETE FROM kipster.memories WHERE id IN (SELECT id FROM kipster.memories WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  const lessons = await client.query('DELETE FROM kipster.lessons WHERE id IN (SELECT id FROM kipster.lessons WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  const chunks = await client.query('DELETE FROM kipster.thread_chunks WHERE id IN (SELECT id FROM kipster.thread_chunks WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  const pages = await client.query('DELETE FROM kipster.diary WHERE ctid IN (SELECT ctid FROM kipster.diary WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  return Math.max(memories.rowCount ?? 0, lessons.rowCount ?? 0, chunks.rowCount ?? 0, pages.rowCount ?? 0)
}
