import type { Postgres, SqlClient } from '../../platform/postgres/public.js'

type Json = Record<string, unknown>
/** One plugin tool as Core keeps it: the plugin server's schema without the account argument it adds. */
export interface PluginTool { name: string; pluginId: string; pluginName: string; title: string | null; description: string; inputSchema: Json }
/** One plugin's tools from a listing, with the fingerprint of each tool's content. */
export interface PluginListing { pluginId: string; pluginName: string; tools: (Omit<PluginTool, 'pluginId' | 'pluginName'> & { hash: string })[] }

interface Row { name: string; plugin_id: string; plugin_name: string; title: string | null; description: string; input_schema: Json }
const tool = (row: Row): PluginTool => ({ name: row.name, pluginId: row.plugin_id, pluginName: row.plugin_name, title: row.title, description: row.description, inputSchema: row.input_schema })
const columns = 'name,plugin_id,plugin_name,title,description,input_schema'

/**
 * Applies a sync: plugins outside `connected` lose their tools; each listed plugin's tools become exactly the listed
 * ones. A tool whose fingerprint changed loses its embedding. Connected plugins that were not listed, such as one
 * whose account needs reconnecting, keep what they had.
 */
export async function applyPluginListings(db: Postgres, installationId: string, connected: readonly string[], listings: readonly PluginListing[]): Promise<void> {
  await db.transaction(async client => {
    await client.query('DELETE FROM kipster.plugin_tools WHERE installation_id=$1 AND NOT (plugin_id = ANY($2::text[]))', [installationId, connected])
    for (const listing of listings) {
      for (const item of listing.tools) {
        await client.query(`INSERT INTO kipster.plugin_tools(installation_id,name,plugin_id,plugin_name,title,description,input_schema,content_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
          ON CONFLICT (installation_id,name) DO UPDATE SET plugin_id=EXCLUDED.plugin_id,plugin_name=EXCLUDED.plugin_name,title=EXCLUDED.title,description=EXCLUDED.description,input_schema=EXCLUDED.input_schema,content_hash=EXCLUDED.content_hash,synced_at=now(),
            embedding=CASE WHEN kipster.plugin_tools.content_hash=EXCLUDED.content_hash THEN kipster.plugin_tools.embedding END,
            embedding_model=CASE WHEN kipster.plugin_tools.content_hash=EXCLUDED.content_hash THEN kipster.plugin_tools.embedding_model END`,
        [installationId, item.name, listing.pluginId, listing.pluginName, item.title, item.description, JSON.stringify(item.inputSchema), item.hash])
      }
      await client.query('DELETE FROM kipster.plugin_tools WHERE installation_id=$1 AND plugin_id=$2 AND NOT (name = ANY($3::text[]))', [installationId, listing.pluginId, listing.tools.map(item => item.name)])
    }
  })
}

/** Tools without an embedding from `model`, with the fingerprint their embedding must match when saved. */
export async function pluginToolsToEmbed(db: Postgres, installationId: string, model: string): Promise<(PluginTool & { hash: string })[]> {
  const rows = await db.query<Row & { content_hash: string }>(`SELECT ${columns},content_hash FROM kipster.plugin_tools WHERE installation_id=$1 AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2) ORDER BY name`, [installationId, model])
  return rows.rows.map(row => ({ ...tool(row), hash: row.content_hash }))
}

/** Saves an embedding unless the tool changed since it was read. */
export async function savePluginToolEmbedding(db: Postgres, installationId: string, name: string, hash: string, model: string, vector: readonly number[]): Promise<void> {
  await db.query('UPDATE kipster.plugin_tools SET embedding=$4::vector, embedding_model=$5 WHERE installation_id=$1 AND name=$2 AND content_hash=$3', [installationId, name, hash, `[${vector.join(',')}]`, model])
}

export async function pluginToolByName(db: Postgres, installationId: string, name: string): Promise<PluginTool | undefined> {
  const row = (await db.query<Row>(`SELECT ${columns} FROM kipster.plugin_tools WHERE installation_id=$1 AND name=$2`, [installationId, name])).rows[0]
  return row ? tool(row) : undefined
}

export async function pluginToolsOf(db: Postgres, installationId: string, pluginId: string): Promise<PluginTool[]> {
  return (await db.query<Row>(`SELECT ${columns} FROM kipster.plugin_tools WHERE installation_id=$1 AND plugin_id=$2 ORDER BY name`, [installationId, pluginId])).rows.map(tool)
}

/**
 * The best `limit` tools for a request, of one plugin when `pluginId` is given: exact names first, then meaning matches. Meaning search needs `embedding` from
 * the model the tools were embedded with; without one, keywords of three or more letters rank the tools instead.
 */
export async function searchPluginTools(db: Postgres, installationId: string, input: { query: string; embedding?: { model: string; vector: readonly number[] }; pluginId?: string; limit: number }): Promise<PluginTool[]> {
  const query = input.query.trim()
  const plugin = input.pluginId ?? null
  const exact = await db.query<Row>(`SELECT ${columns} FROM kipster.plugin_tools WHERE installation_id=$1 AND ($3::text IS NULL OR plugin_id=$3) AND (lower(name)=lower($2) OR lower(split_part(name,'__',2))=lower($2) OR lower(title)=lower($2)) ORDER BY name`, [installationId, query, plugin])
  let ranked: Row[] = []
  if (input.embedding) {
    ranked = (await db.query<Row>(`SELECT ${columns} FROM kipster.plugin_tools WHERE installation_id=$1 AND ($5::text IS NULL OR plugin_id=$5) AND embedding_model=$2 ORDER BY embedding <=> $3::vector LIMIT $4`,
      [installationId, input.embedding.model, `[${input.embedding.vector.join(',')}]`, input.limit, plugin])).rows
  } else {
    // Short words such as "to" or "a" would match nearly every description.
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 32)
    if (words.length) ranked = (await db.query<Row>(`SELECT ${columns} FROM kipster.plugin_tools WHERE installation_id=$1 AND ($4::text IS NULL OR plugin_id=$4) AND search_text @@ to_tsquery('simple',$2)
      ORDER BY ts_rank(search_text, to_tsquery('simple',$2)) DESC, name LIMIT $3`, [installationId, words.map(word => `${word}:*`).join(' | '), input.limit, plugin])).rows
  }
  const seen = new Set<string>()
  return [...exact.rows, ...ranked].filter(row => !seen.has(row.name) && !!seen.add(row.name)).slice(0, input.limit).map(tool)
}

/** Binds an approval card to the exact call it asks about, in the card's transaction. */
export async function bindPluginApproval(client: SqlClient, interactionId: string, runId: string, callKey: string): Promise<void> {
  await client.query('INSERT INTO kipster.plugin_tool_approvals(interaction_id,run_id,call_key) VALUES ($1,$2,$3)', [interactionId, runId, callKey])
}

/** Uses one approved, unused card of this run for this exact call. */
export async function takePluginApproval(db: Postgres, runId: string, callKey: string): Promise<boolean> {
  const taken = await db.query(`UPDATE kipster.plugin_tool_approvals SET used_at=now() WHERE interaction_id=(
    SELECT p.interaction_id FROM kipster.plugin_tool_approvals p JOIN kipster.interactions i ON i.id=p.interaction_id
    WHERE p.run_id=$1 AND p.call_key=$2 AND p.used_at IS NULL AND i.state='settled' AND i.answer->>'kind'='approve'
    ORDER BY i.answered_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED)`, [runId, callKey])
  return !!taken.rowCount
}
