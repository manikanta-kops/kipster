import type { SqlClient } from '../../platform/postgres/public.js'

/**
 * Removes the memory derived from threads that are being deleted: their chunks, processing state and card sources,
 * every card left with no source, and the threads' IDs on diary pages. A page left with no thread is deleted. Call it
 * while the threads are locked, before their rows go.
 */
export async function removeThreadMemory(client: SqlClient, threadIds: readonly string[]): Promise<void> {
  if (!threadIds.length) return
  await client.query('DELETE FROM kipster.thread_chunks WHERE thread_id = ANY($1::uuid[])', [threadIds])
  await client.query('DELETE FROM kipster.memory_thread_state WHERE thread_id = ANY($1::uuid[])', [threadIds])
  const cards = (await client.query<{ card_id: string }>('DELETE FROM kipster.card_sources WHERE thread_id = ANY($1::uuid[]) RETURNING card_id', [threadIds])).rows.map(row => row.card_id)
  await client.query('DELETE FROM kipster.cards c WHERE c.id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM kipster.card_sources s WHERE s.card_id = c.id)', [[...new Set(cards)]])
  await client.query('DELETE FROM kipster.diary WHERE thread_ids && $1::uuid[] AND thread_ids <@ $1::uuid[]', [threadIds])
  await client.query(`UPDATE kipster.diary SET thread_ids = ARRAY(SELECT id FROM unnest(thread_ids) WITH ORDINALITY AS t(id, n) WHERE id <> ALL($1::uuid[]) ORDER BY n), updated_at = now()
    WHERE thread_ids && $1::uuid[]`, [threadIds])
}

/** Deletes up to `limit` of an agent's thread chunks and diary pages; returns how many rows went. */
export async function deleteAgentMemory(client: SqlClient, agentId: string, limit: number): Promise<number> {
  const chunks = await client.query('DELETE FROM kipster.thread_chunks WHERE id IN (SELECT id FROM kipster.thread_chunks WHERE agent_id = $1 LIMIT $2)', [agentId, limit])
  const pages = await client.query('DELETE FROM kipster.diary WHERE agent_id = $1 AND day IN (SELECT day FROM kipster.diary WHERE agent_id = $1 LIMIT $2)', [agentId, limit])
  return Math.max(chunks.rowCount ?? 0, pages.rowCount ?? 0)
}

/** Deletes up to `limit` of an organization's cards and thread chunks; returns how many rows went. */
export async function deleteOrganizationMemory(client: SqlClient, organizationId: string, limit: number): Promise<number> {
  const cards = await client.query('DELETE FROM kipster.cards WHERE id IN (SELECT id FROM kipster.cards WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  const chunks = await client.query('DELETE FROM kipster.thread_chunks WHERE id IN (SELECT id FROM kipster.thread_chunks WHERE organization_id = $1 LIMIT $2)', [organizationId, limit])
  return Math.max(cards.rowCount ?? 0, chunks.rowCount ?? 0)
}
