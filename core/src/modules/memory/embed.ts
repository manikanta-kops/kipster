import type { Postgres } from '../../platform/postgres/public.js'
import { boundedEmbed, vectorLiteral, type EmbeddingProfile } from '../vectors/public.js'
import { embeddingDocument } from '../../embedding/index.js'

/** Longest text sent for one embedding, in characters; the embedding model's context holds about this much. */
export const EMBEDDING_TEXT_MAX = 20000
const EMBED_TIMEOUT_MS = 30000
const EMBED_BATCH = 50

const diaryKey = `agent_id::text || '/' || day::text || '/' || COALESCE(organization_id::text, '')`
/** Embedding inputs of the rows saved without one. */
const pending: Record<'thread_chunks' | 'memories' | 'lessons' | 'diary', { key: string; select: string; where: string; ready?: string }> = {
  thread_chunks: { key: 'id', select: `id::text AS key, title, text, updated_at::text AS updated_at FROM kipster.thread_chunks`, where: 'id::text' },
  memories: { key: 'id', select: `id::text AS key, type || ': ' || subject AS title, statement || CASE WHEN details = '{}'::jsonb THEN '' ELSE E'\\n' || details::text END AS text, updated_at::text AS updated_at FROM kipster.memories`, where: 'id::text' },
  lessons: { key: 'id', select: `id::text AS key, 'lesson' AS title, statement AS text, updated_at::text AS updated_at FROM kipster.lessons`, where: 'id::text' },
  // A page owing a rebuild has no summary to embed yet.
  diary: { key: 'agent_id, day, organization_id', select: `${diaryKey} AS key, to_char(day, 'Dy DD Mon YYYY') AS title, summary AS text, updated_at::text AS updated_at FROM kipster.diary`, where: diaryKey, ready: 'summary IS NOT NULL' },
}

/**
 * Embeds every chunk, memory, lesson and diary page of the installation saved without an embedding, with the document
 * prompt format, and stores the model that made it. Without a provider it does nothing and the rows wait for a later
 * run. A row changed meanwhile is left for the next call. Stops at the first provider failure.
 */
export async function embedPending(db: Postgres, installationId: string, embedding: EmbeddingProfile | undefined, signal?: AbortSignal): Promise<{ embedded: number; failed: boolean }> {
  if (!embedding) return { embedded: 0, failed: false }
  let embedded = 0
  for (const [table, source] of Object.entries(pending)) {
    const skipped = new Set<string>()
    while (!signal?.aborted) {
      const rows = (await db.query<{ key: string; title: string; text: string; updated_at: string }>(
        `SELECT ${source.select} WHERE installation_id=$1 AND embedding IS NULL AND ${source.ready ?? 'true'} AND NOT (${source.where} = ANY($2::text[])) ORDER BY updated_at, ${source.key} LIMIT $3`,
        [installationId, [...skipped], EMBED_BATCH])).rows
      if (!rows.length) break
      for (const row of rows) {
        if (signal?.aborted) break
        const saved = await embedRow(db, installationId, embedding, table as keyof typeof pending, row, EMBED_TIMEOUT_MS)
        if (saved === 'failed') return { embedded, failed: true }
        if (saved === 'saved') embedded++
        else skipped.add(row.key)
      }
    }
  }
  return { embedded, failed: false }
}

/** Embeds the given memories or lessons now when they still lack an embedding, as `embedPending` does, waiting at most
 * `timeoutMs` for each. Returns how many were embedded, or `failed` at the first provider failure; the rest wait for the
 * nightly run. */
export async function embedNow(db: Postgres, installationId: string, embedding: EmbeddingProfile | undefined, table: 'memories' | 'lessons', ids: readonly string[], timeoutMs = EMBED_TIMEOUT_MS): Promise<{ embedded: number; failed: boolean }> {
  if (!embedding || !ids.length) return { embedded: 0, failed: false }
  const rows = (await db.query<{ key: string; title: string; text: string; updated_at: string }>(
    `SELECT ${pending[table].select} WHERE installation_id=$1 AND embedding IS NULL AND id = ANY($2::uuid[]) ORDER BY updated_at, id`, [installationId, ids])).rows
  let embedded = 0
  for (const row of rows) {
    const saved = await embedRow(db, installationId, embedding, table, row, timeoutMs)
    if (saved === 'failed') return { embedded, failed: true }
    if (saved === 'saved') embedded++
  }
  return { embedded, failed: false }
}

/** Embeds one row with the document prompt format unless it changed meanwhile. */
async function embedRow(db: Postgres, installationId: string, embedding: EmbeddingProfile, table: keyof typeof pending, row: { key: string; title: string; text: string; updated_at: string }, timeoutMs: number): Promise<'saved' | 'skipped' | 'failed'> {
  const { profile, embedder } = embedding.embeddingConfig()
  let values: readonly number[]
  try { values = await boundedEmbed(embedder, embeddingDocument(row.text.slice(0, EMBEDDING_TEXT_MAX), row.title), timeoutMs) }
  catch { return 'failed' }
  try {
    const saved = await db.query(`UPDATE kipster.${table} SET embedding=$3::vector, embedding_model=$4 WHERE installation_id=$1 AND ${pending[table].where}=$2 AND embedding IS NULL AND ${pending[table].ready ?? 'true'} AND updated_at=$5::timestamptz`,
      [installationId, row.key, vectorLiteral(values), profile.model, row.updated_at])
    return saved.rowCount ? 'saved' : 'skipped'
  } catch { return 'skipped' /* A vector of another dimension cannot be stored. */ }
}
