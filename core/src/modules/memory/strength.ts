import type { SqlClient } from '../../platform/postgres/public.js'

/** Memory strength rules. Strength is `importance × (1 − 0.5^evidence) × 0.5^(age / (30 × evidence))`, computed in
 * SQL by `kipster.memory_strength`. Evidence counts distinct supporting conversations, with the agent's own words
 * counting once; age counts the agent's active days since the memory was last supported or recalled. */
export const MEMORY_STRENGTH = {
  forgetBelow: 0.05,
  learnedImportance: 0.5,
  minImportance: 0.2,
  forgetBatch: 50,
} as const

/** Strength of memory rows aliased `m` for the agent whose day counter is `activeDays`. Organization memories do not age. */
export function strengthSql(activeDays: string): string {
  return `kipster.memory_strength(m.importance, m.evidence, CASE WHEN m.scope='agent' THEN ${activeDays} - m.refreshed_day ELSE 0 END)`
}

/** Recounts evidence from provenance and resets age for agent memories that just gained support. */
export async function reinforce(client: SqlClient, memoryIds: readonly string[]): Promise<void> {
  if (!memoryIds.length) return
  await client.query(`UPDATE kipster.memory_records m SET
      evidence=GREATEST(1, (SELECT count(DISTINCT CASE WHEN p.author_id=m.owner_id THEN 'self' ELSE COALESCE(p.source_thread_id::text,'none') END)
        FROM kipster.memory_provenance p WHERE p.memory_id=m.id)),
      refreshed_day=COALESCE((SELECT a.active_days FROM kipster.memory_activity a WHERE a.agent_id=m.owner_id), 0)
    WHERE m.id=ANY($1::uuid[]) AND m.scope='agent'`, [memoryIds])
}

/** Recall keeps memories alive without strengthening them: age resets, evidence is unchanged. */
export async function refreshRecalled(client: SqlClient, agentId: string, memoryIds: readonly string[]): Promise<void> {
  if (!memoryIds.length) return
  await client.query(`UPDATE kipster.memory_records m SET refreshed_day=a.active_days FROM kipster.memory_activity a
    WHERE a.agent_id=$1 AND m.id=ANY($2::uuid[]) AND m.scope='agent' AND m.owner_id=$1 AND m.refreshed_day<a.active_days`, [agentId, memoryIds])
}

/** Removes memories with every derived row: sources, provenance, index entries and vectors, extraction claims,
 * tool receipts holding their text, and every link with a forgotten endpoint. A surviving link keeps its history
 * minus the citations of forgotten memories. Callers lock the rows. */
export async function deleteMemories(client: SqlClient, memoryIds: readonly string[]): Promise<void> {
  if (!memoryIds.length) return
  const links = (await client.query<{ id: string; installation_id: string; owner_kind: string; owner_id: string; removed: boolean }>(
    `SELECT id, installation_id, owner_kind, owner_id, (from_id=ANY($1::uuid[]) OR to_id=ANY($1::uuid[])) AS removed
     FROM kipster.memory_relationships
     WHERE from_id=ANY($1::uuid[]) OR to_id=ANY($1::uuid[])
       OR id IN (SELECT relationship_id FROM kipster.memory_relationship_evidence WHERE memory_id=ANY($1::uuid[]))
     ORDER BY id`, [memoryIds])).rows
  if (links.length) {
    const removed = links.filter(link => link.removed).map(link => link.id)
    await client.query('DELETE FROM kipster.memory_relationship_evidence WHERE relationship_id=ANY($1::uuid[]) OR memory_id=ANY($2::uuid[])', [removed, memoryIds])
    await client.query('DELETE FROM kipster.memory_relationship_changes WHERE relationship_id=ANY($1::uuid[])', [removed])
    await client.query('DELETE FROM kipster.memory_relationships WHERE id=ANY($1::uuid[])', [removed])
    const owners = new Map<string, { installationId: string; kind: string; ownerId: string; removed: number }>()
    for (const link of links) {
      const key = `${link.installation_id}:${link.owner_kind}:${link.owner_id}`
      const owner = owners.get(key) ?? { installationId: link.installation_id, kind: link.owner_kind, ownerId: link.owner_id, removed: 0 }
      if (link.removed) owner.removed++
      owners.set(key, owner)
    }
    for (const owner of [...owners.values()].sort((a, b) => `${a.kind}:${a.ownerId}`.localeCompare(`${b.kind}:${b.ownerId}`))) {
      await client.query(`UPDATE kipster.memory_relationship_owner_versions SET revision=revision+1, relationship_count=GREATEST(0, relationship_count-$4)
        WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3`, [owner.installationId, owner.kind, owner.ownerId, owner.removed])
    }
  }
  await client.query('DELETE FROM kipster.maintenance_candidate_claims WHERE memory_id=ANY($1::uuid[])', [memoryIds])
  await client.query(`DELETE FROM kipster.memory_tool_receipts WHERE operation IN ('memory.save','memory.correct')
    AND (result->'record'->>'id')=ANY($1::text[])`, [memoryIds])
  await client.query('DELETE FROM kipster.memory_index_intents WHERE memory_id=ANY($1::uuid[])', [memoryIds])
  await client.query('DELETE FROM kipster.memory_provenance WHERE memory_id=ANY($1::uuid[])', [memoryIds])
  await client.query('DELETE FROM kipster.memory_sources WHERE memory_id=ANY($1::uuid[])', [memoryIds])
  await client.query('DELETE FROM kipster.memory_records WHERE id=ANY($1::uuid[])', [memoryIds])
}
