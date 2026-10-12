import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { boundedEmbed, vectorLiteral, type EmbeddingProfile } from '../vectors/public.js'
import { embeddingDocument, embeddingQuery } from '../../embedding/index.js'

/** A card: a fact about the user, shared by every agent of the installation. */
export interface Card {
  id: string; type: string; subject: string; statement: string; details: Record<string, unknown>
  /** The user said it directly; otherwise it was inferred. */
  confirmed: boolean
  /** Loaded on every turn. */
  core: boolean
  /** Null for an installation card; otherwise the organization it was learned in, and the only one it is shown in. */
  organizationId: string | null
  validFrom: string; validTo: string | null; replacedBy: string | null; createdAt: string; updatedAt: string
  embedded: boolean
  sources: CardSource[]
}
/** A user message a card was learned from. */
export interface CardSource { threadId: string; messageId: string }
export interface CardInput { type: string; subject: string; statement: string; details?: Record<string, unknown> | undefined; confirmed?: boolean | undefined }
export interface CardEdit { type?: string | undefined; subject?: string | undefined; statement?: string | undefined; details?: Record<string, unknown> | undefined; confirmed?: boolean | undefined }
/** The cards a caller may see: installation cards plus one organization's, or every card (Kip's tools only). */
export type CardScope = { organizationId: string | null } | 'all'

export const CARD_LIMITS = { type: 40, subject: 200, statement: 2000, detailsBytes: 4096, sources: 50, page: 200 } as const
/** Longest text sent for one embedding, in characters; the embedding model's context holds about this much. */
const EMBEDDING_TEXT_MAX = 20000
const EMBED_TIMEOUT_MS = 30000
const EMBED_BATCH = 50

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid card ${name}`)
  return value.trim()
}
function details(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > CARD_LIMITS.detailsBytes) throw new Error('Invalid card details')
  return value as Record<string, unknown>
}
function cardInput(input: CardInput): Required<CardInput> {
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('Invalid card confirmation')
  return { type: text(input.type, 'type', CARD_LIMITS.type).toLowerCase(), subject: text(input.subject, 'subject', CARD_LIMITS.subject), statement: text(input.statement, 'statement', CARD_LIMITS.statement), details: details(input.details), confirmed: input.confirmed ?? false }
}
export const scopeSql = (scope: CardScope, parameter: string): string => scope === 'all' ? `${parameter}::uuid IS NULL` : `(c.organization_id IS NULL OR c.organization_id = ${parameter}::uuid)`
export const scopeValue = (scope: CardScope): string | null => scope === 'all' ? null : scope.organizationId

export type CardRow = { id: string; type: string; subject: string; statement: string; details: Record<string, unknown>; confirmed: boolean; core: boolean; organization_id: string | null; valid_from: Date; valid_to: Date | null; replaced_by: string | null; created_at: Date; updated_at: Date; embedded: boolean; sources: CardSource[] }
/** Columns of a `CardRow`, with the card table as `c`. */
export const cardColumns = `c.id, c.type, c.subject, c.statement, c.details, c.confirmed, c.core, c.organization_id, c.valid_from, c.valid_to, c.replaced_by, c.created_at, c.updated_at,
  c.embedding IS NOT NULL AS embedded,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('threadId', s.thread_id, 'messageId', s.message_id) ORDER BY s.thread_id, s.message_id) FROM kipster.card_sources s WHERE s.card_id = c.id), '[]'::jsonb) AS sources`
export function card(row: CardRow): Card {
  return {
    id: row.id, type: row.type, subject: row.subject, statement: row.statement, details: row.details, confirmed: row.confirmed, core: row.core,
    organizationId: row.organization_id, validFrom: row.valid_from.toISOString(), validTo: row.valid_to?.toISOString() ?? null, replacedBy: row.replaced_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), embedded: row.embedded, sources: row.sources,
  }
}

/**
 * Cards of one installation. Writes take the caller's transaction, or open their own. Every write records its sources:
 * user messages (a person wrote them) of threads in the card's own context, an installation thread for an installation
 * card and a thread of its organization for an organization card. A content change clears the embedding, so the card is
 * embedded again. Messages are never changed.
 */
export class CardService {
  constructor(private readonly db: Postgres, readonly installationId: string, private readonly embedding?: EmbeddingProfile) {}

  private write<T>(client: SqlClient | undefined, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return client ? work(client) : this.db.transaction(work)
  }

  /** Adds a current card. `organizationId` is the organization it was learned in, or null for an installation card. */
  async create(input: CardInput & { organizationId: string | null }, sources: readonly CardSource[], client?: SqlClient): Promise<string> {
    const value = cardInput(input)
    return this.write(client, async client => {
      const id = randomUUID()
      await client.query(`INSERT INTO kipster.cards(id, installation_id, type, subject, statement, details, confirmed, organization_id)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [id, this.installationId, value.type, value.subject, value.statement, JSON.stringify(value.details), value.confirmed, input.organizationId])
      await this.addSources(client, id, input.organizationId, sources)
      return id
    })
  }

  /** Changes a current card in place and adds sources. Returns false when the card is gone or no longer current. */
  async update(id: string, edit: CardEdit, sources: readonly CardSource[], client?: SqlClient): Promise<boolean> {
    const fields: [string, unknown][] = []
    if (edit.type !== undefined) fields.push(['type', text(edit.type, 'type', CARD_LIMITS.type).toLowerCase()])
    if (edit.subject !== undefined) fields.push(['subject', text(edit.subject, 'subject', CARD_LIMITS.subject)])
    if (edit.statement !== undefined) fields.push(['statement', text(edit.statement, 'statement', CARD_LIMITS.statement)])
    if (edit.details !== undefined) fields.push(['details', JSON.stringify(details(edit.details))])
    if (edit.confirmed !== undefined) { if (typeof edit.confirmed !== 'boolean') throw new Error('Invalid card confirmation'); fields.push(['confirmed', edit.confirmed]) }
    return this.write(client, async client => {
      const current = await this.current(client, id)
      if (!current) return false
      if (fields.length) {
        const parameter = (index: number, name: string) => `$${index + 3}${name === 'details' ? '::jsonb' : ''}`
        const set = fields.map(([name], index) => `${name}=${parameter(index, name)}`).join(', ')
        // Only changed content is embedded again.
        const changed = fields.flatMap(([name], index) => name === 'confirmed' ? [] : [`${name} IS DISTINCT FROM ${parameter(index, name)}`]).join(' OR ')
        const reembed = changed ? `, embedding=CASE WHEN ${changed} THEN NULL ELSE embedding END, embedding_model=CASE WHEN ${changed} THEN NULL ELSE embedding_model END` : ''
        await client.query(`UPDATE kipster.cards SET ${set}${reembed}, updated_at=now() WHERE id=$1 AND installation_id=$2`, [id, this.installationId, ...fields.map(([, value]) => value)])
      } else if (sources.length) await client.query('UPDATE kipster.cards SET updated_at=now() WHERE id=$1', [id])
      await this.addSources(client, id, current.organization_id, sources)
      return true
    })
  }

  /** Ends a current card and adds its replacement in the same context. The old card keeps its row with `valid_to` and
   * `replaced_by`, and stops being core. Returns the new card's ID, or null when the old card is gone or not current. */
  async replace(id: string, input: CardInput, sources: readonly CardSource[], client?: SqlClient): Promise<string | null> {
    const value = cardInput(input)
    return this.write(client, async client => {
      const current = await this.current(client, id)
      if (!current) return null
      const next = await this.create({ ...value, organizationId: current.organization_id }, sources, client)
      await client.query('UPDATE kipster.cards SET valid_to=now(), replaced_by=$2, core=false, updated_at=now() WHERE id=$1', [id, next])
      return next
    })
  }

  /** Deletes cards with their sources and embeddings. Messages stay. Returns how many went. */
  async delete(ids: readonly string[], client?: SqlClient): Promise<number> {
    if (!ids.length) return 0
    return this.write(client, async client => (await client.query('DELETE FROM kipster.cards WHERE id = ANY($1::uuid[]) AND installation_id=$2', [ids, this.installationId])).rowCount ?? 0)
  }

  async get(id: string, client: Postgres | SqlClient = this.db): Promise<Card | null> {
    const row = (await client.query<CardRow>(`SELECT ${cardColumns} FROM kipster.cards c WHERE c.id=$1 AND c.installation_id=$2`, [id, this.installationId])).rows[0]
    return row ? card(row) : null
  }

  /** Cards newest first, current ones only unless `ended`. `cursor` is the last card of the previous page. */
  async list(options: { scope?: CardScope; ended?: boolean; limit?: number; cursor?: string | null } = {}, client: Postgres | SqlClient = this.db): Promise<{ cards: Card[]; nextCursor: string | null }> {
    const scope = options.scope ?? 'all'
    const limit = Math.min(Math.max(1, options.limit ?? 50), CARD_LIMITS.page)
    const after = options.cursor ? (await client.query<{ updated_at: Date; id: string }>('SELECT updated_at, id FROM kipster.cards WHERE id=$1 AND installation_id=$2', [options.cursor, this.installationId])).rows[0] : undefined
    if (options.cursor && !after) throw new Error('Invalid card cursor')
    const rows = (await client.query<CardRow>(`SELECT ${cardColumns} FROM kipster.cards c WHERE c.installation_id=$1 AND ${scopeSql(scope, '$2')}
      AND ($3 OR c.valid_to IS NULL) AND ($4::timestamptz IS NULL OR (c.updated_at, c.id) < ($4, $5::uuid))
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $6`, [this.installationId, scopeValue(scope), options.ended === true, after?.updated_at ?? null, after?.id ?? null, limit + 1])).rows
    return { cards: rows.slice(0, limit).map(card), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }
  }

  /**
   * The current cards in `scope` nearest to `query`: by cosine distance of their embeddings when an embedding provider
   * answers, then filled with unembedded cards. Without a provider or an answer, cards about `subject` come first, then
   * the most recently changed.
   */
  async nearest(query: { text: string; subject?: string | undefined }, scope: CardScope, limit: number, client: Postgres | SqlClient = this.db): Promise<Card[]> {
    if (limit <= 0) return []
    let vector: string | undefined, model: string | undefined
    if (this.embedding && query.text.trim()) {
      const { profile, embedder } = this.embedding.embeddingConfig()
      try { vector = vectorLiteral(await boundedEmbed(embedder, embeddingQuery(query.text.slice(0, EMBEDDING_TEXT_MAX)), 10000)); model = profile.model } catch { vector = undefined }
    }
    const found: CardRow[] = []
    if (vector) {
      try {
        found.push(...(await client.query<CardRow>(`SELECT ${cardColumns} FROM kipster.cards c WHERE c.installation_id=$1 AND c.valid_to IS NULL AND ${scopeSql(scope, '$2')}
          AND c.embedding IS NOT NULL AND c.embedding_model=$3 ORDER BY c.embedding <=> $4::vector, c.id LIMIT $5`, [this.installationId, scopeValue(scope), model, vector, limit])).rows)
      } catch { /* A vector of another dimension finds nothing; the fallback below still answers. */ }
    }
    if (found.length < limit) {
      found.push(...(await client.query<CardRow>(`SELECT ${cardColumns} FROM kipster.cards c WHERE c.installation_id=$1 AND c.valid_to IS NULL AND ${scopeSql(scope, '$2')}
        AND c.id <> ALL($3::uuid[]) AND ($4::text IS NULL OR c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $4)
        ORDER BY lower(c.subject) = lower(COALESCE($5, '')) DESC, c.updated_at DESC, c.id LIMIT $6`,
        [this.installationId, scopeValue(scope), found.map(row => row.id), vector ? model : null, query.subject ?? null, limit - found.length])).rows)
    }
    return found.map(card)
  }

  /** A current card, locked. */
  private async current(client: SqlClient, id: string): Promise<{ organization_id: string | null } | undefined> {
    return (await client.query<{ organization_id: string | null }>('SELECT organization_id FROM kipster.cards WHERE id=$1 AND installation_id=$2 AND valid_to IS NULL FOR UPDATE', [id, this.installationId])).rows[0]
  }

  private async addSources(client: SqlClient, cardId: string, organizationId: string | null, sources: readonly CardSource[]): Promise<void> {
    if (sources.length > CARD_LIMITS.sources) throw new Error('Too many card sources')
    for (const source of sources) {
      const valid = await client.query(`SELECT 1 FROM kipster.messages m JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
        JOIN kipster.people p ON p.id=m.author_id AND p.installation_id=c.installation_id
        WHERE m.id=$1 AND m.thread_id=$2 AND c.installation_id=$3
          AND CASE WHEN c.context_kind='organization' THEN c.context_id IS NOT DISTINCT FROM $4::uuid ELSE $4::uuid IS NULL END`, [source.messageId, source.threadId, this.installationId, organizationId])
      if (!valid.rows.length) throw new Error('Card source must be a user message in the card\'s context')
      await client.query('INSERT INTO kipster.card_sources(card_id, installation_id, thread_id, message_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [cardId, this.installationId, source.threadId, source.messageId])
    }
  }
}

/** Embedding inputs of the rows saved without one. */
const pending = {
  thread_chunks: { key: 'id', select: `id::text AS key, title, text, updated_at::text AS updated_at FROM kipster.thread_chunks`, where: 'id::text' },
  cards: { key: 'id', select: `id::text AS key, type || ': ' || subject AS title, statement || CASE WHEN details = '{}'::jsonb THEN '' ELSE E'\\n' || details::text END AS text, updated_at::text AS updated_at FROM kipster.cards`, where: 'id::text' },
  diary: { key: 'agent_id, day', select: `agent_id::text || '/' || day::text AS key, to_char(day, 'Dy DD Mon YYYY') AS title, summary AS text, updated_at::text AS updated_at FROM kipster.diary`, where: `agent_id::text || '/' || day::text` },
} as const

/**
 * Embeds every chunk, card and diary page of the installation saved without an embedding, with the document prompt
 * format, and stores the model that made it. Without a provider it does nothing and the rows wait for a later run. A
 * row changed meanwhile is left for the next call. Stops at the first provider failure.
 */
export async function embedPending(db: Postgres, installationId: string, embedding: EmbeddingProfile | undefined, signal?: AbortSignal): Promise<{ embedded: number; failed: boolean }> {
  if (!embedding) return { embedded: 0, failed: false }
  let embedded = 0
  for (const [table, source] of Object.entries(pending)) {
    const skipped = new Set<string>()
    while (!signal?.aborted) {
      const rows = (await db.query<{ key: string; title: string; text: string; updated_at: string }>(
        `SELECT ${source.select} WHERE installation_id=$1 AND embedding IS NULL AND NOT (${source.where} = ANY($2::text[])) ORDER BY updated_at, ${source.key} LIMIT $3`,
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

/** Embeds the given cards now when they still lack an embedding, as `embedPending` does, waiting at most `timeoutMs` for
 * each. Returns how many were embedded, or `failed` at the first provider failure; the rest wait for the nightly run. */
export async function embedCards(db: Postgres, installationId: string, embedding: EmbeddingProfile | undefined, ids: readonly string[], timeoutMs: number): Promise<{ embedded: number; failed: boolean }> {
  if (!embedding || !ids.length) return { embedded: 0, failed: false }
  const rows = (await db.query<{ key: string; title: string; text: string; updated_at: string }>(
    `SELECT ${pending.cards.select} WHERE installation_id=$1 AND embedding IS NULL AND id = ANY($2::uuid[]) ORDER BY updated_at, id`, [installationId, ids])).rows
  let embedded = 0
  for (const row of rows) {
    const saved = await embedRow(db, installationId, embedding, 'cards', row, timeoutMs)
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
    const saved = await db.query(`UPDATE kipster.${table} SET embedding=$3::vector, embedding_model=$4 WHERE installation_id=$1 AND ${pending[table].where}=$2 AND embedding IS NULL AND updated_at=$5::timestamptz`,
      [installationId, row.key, vectorLiteral(values), profile.model, row.updated_at])
    return saved.rowCount ? 'saved' : 'skipped'
  } catch { return 'skipped' /* A vector of another dimension cannot be stored. */ }
}
