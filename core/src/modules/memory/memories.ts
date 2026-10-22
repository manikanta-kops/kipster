import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { boundedEmbed, vectorLiteral, type EmbeddingProfile } from '../vectors/public.js'
import { embeddingQuery } from '../../embedding/index.js'
import { EMBEDDING_TEXT_MAX } from './embed.js'

/** A memory: a fact about the person, shared by every agent of the installation. */
export interface Memory {
  id: string; type: string; subject: string; statement: string; details: Record<string, unknown>
  /** The person said it directly; otherwise it was inferred. */
  confirmed: boolean
  /** Loaded on every turn. */
  core: boolean
  /** Null for an installation memory; otherwise the organization it was learned in, and the only one it is shown in. */
  organizationId: string | null
  validFrom: string; validTo: string | null; replacedBy: string | null; createdAt: string; updatedAt: string
  embedded: boolean
  sources: MessageSource[]
}
/** A message a memory or lesson was learned from. */
export interface MessageSource { threadId: string; messageId: string }
export interface MemoryInput { type: string; subject: string; statement: string; details?: Record<string, unknown> | undefined; confirmed?: boolean | undefined }
export interface MemoryEdit { type?: string | undefined; subject?: string | undefined; statement?: string | undefined; details?: Record<string, unknown> | undefined; confirmed?: boolean | undefined }
/** The memories a caller may see: installation memories plus one organization's, or every memory (the admin kip's tools only). */
export type MemoryScope = { organizationId: string | null } | 'all'

export const MEMORY_FIELD_LIMITS = { type: 40, subject: 200, statement: 2000, detailsBytes: 4096, sources: 50, page: 200 } as const

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid memory ${name}`)
  return value.trim()
}
function details(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > MEMORY_FIELD_LIMITS.detailsBytes) throw new Error('Invalid memory details')
  return value as Record<string, unknown>
}
function memoryInput(input: MemoryInput): Required<MemoryInput> {
  if (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') throw new Error('Invalid memory confirmation')
  return { type: text(input.type, 'type', MEMORY_FIELD_LIMITS.type).toLowerCase(), subject: text(input.subject, 'subject', MEMORY_FIELD_LIMITS.subject), statement: text(input.statement, 'statement', MEMORY_FIELD_LIMITS.statement), details: details(input.details), confirmed: input.confirmed ?? false }
}
export const scopeSql = (scope: MemoryScope, parameter: string): string => scope === 'all' ? `${parameter}::uuid IS NULL` : `(c.organization_id IS NULL OR c.organization_id = ${parameter}::uuid)`
export const scopeValue = (scope: MemoryScope): string | null => scope === 'all' ? null : scope.organizationId

export type MemoryRow = { id: string; type: string; subject: string; statement: string; details: Record<string, unknown>; confirmed: boolean; core: boolean; organization_id: string | null; valid_from: Date; valid_to: Date | null; replaced_by: string | null; created_at: Date; updated_at: Date; embedded: boolean; sources: MessageSource[] }
/** Columns of a `MemoryRow`, with the memory table as `c`. */
export const memoryColumns = `c.id, c.type, c.subject, c.statement, c.details, c.confirmed, c.core, c.organization_id, c.valid_from, c.valid_to, c.replaced_by, c.created_at, c.updated_at,
  c.embedding IS NOT NULL AS embedded,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('threadId', s.thread_id, 'messageId', s.message_id) ORDER BY s.thread_id, s.message_id) FROM kipster.memory_sources s WHERE s.memory_id = c.id), '[]'::jsonb) AS sources`
export function memory(row: MemoryRow): Memory {
  return {
    id: row.id, type: row.type, subject: row.subject, statement: row.statement, details: row.details, confirmed: row.confirmed, core: row.core,
    organizationId: row.organization_id, validFrom: row.valid_from.toISOString(), validTo: row.valid_to?.toISOString() ?? null, replacedBy: row.replaced_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), embedded: row.embedded, sources: row.sources,
  }
}

/**
 * Memories of one installation. Writes take the caller's transaction, or open their own. Every write records its
 * sources: messages a person wrote, in threads of the memory's own context, an installation thread for an installation
 * memory and a thread of its organization for an organization memory. A content change clears the embedding, so the
 * memory is embedded again. Messages are never changed.
 */
export class MemoryService {
  constructor(private readonly db: Postgres, readonly installationId: string, private readonly embedding?: EmbeddingProfile) {}

  private write<T>(client: SqlClient | undefined, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return client ? work(client) : this.db.transaction(work)
  }

  /** Adds a current memory. `organizationId` is the organization it was learned in, or null for an installation memory. */
  async create(input: MemoryInput & { organizationId: string | null }, sources: readonly MessageSource[], client?: SqlClient): Promise<string> {
    const value = memoryInput(input)
    return this.write(client, async client => {
      const id = randomUUID()
      await client.query(`INSERT INTO kipster.memories(id, installation_id, type, subject, statement, details, confirmed, organization_id)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [id, this.installationId, value.type, value.subject, value.statement, JSON.stringify(value.details), value.confirmed, input.organizationId])
      await this.addSources(client, id, input.organizationId, sources)
      return id
    })
  }

  /** Changes a current memory in place and adds sources. Returns false when the memory is gone or no longer current. */
  async update(id: string, edit: MemoryEdit, sources: readonly MessageSource[], client?: SqlClient): Promise<boolean> {
    const fields: [string, unknown][] = []
    if (edit.type !== undefined) fields.push(['type', text(edit.type, 'type', MEMORY_FIELD_LIMITS.type).toLowerCase()])
    if (edit.subject !== undefined) fields.push(['subject', text(edit.subject, 'subject', MEMORY_FIELD_LIMITS.subject)])
    if (edit.statement !== undefined) fields.push(['statement', text(edit.statement, 'statement', MEMORY_FIELD_LIMITS.statement)])
    if (edit.details !== undefined) fields.push(['details', JSON.stringify(details(edit.details))])
    if (edit.confirmed !== undefined) { if (typeof edit.confirmed !== 'boolean') throw new Error('Invalid memory confirmation'); fields.push(['confirmed', edit.confirmed]) }
    return this.write(client, async client => {
      const [current] = await this.current(client, [id])
      if (!current) return false
      if (fields.length) {
        const parameter = (index: number, name: string) => `$${index + 3}${name === 'details' ? '::jsonb' : ''}`
        const set = fields.map(([name], index) => `${name}=${parameter(index, name)}`).join(', ')
        // Only changed content is embedded again.
        const changed = fields.flatMap(([name], index) => name === 'confirmed' ? [] : [`${name} IS DISTINCT FROM ${parameter(index, name)}`]).join(' OR ')
        const reembed = changed ? `, embedding=CASE WHEN ${changed} THEN NULL ELSE embedding END, embedding_model=CASE WHEN ${changed} THEN NULL ELSE embedding_model END` : ''
        await client.query(`UPDATE kipster.memories SET ${set}${reembed}, updated_at=now() WHERE id=$1 AND installation_id=$2`, [id, this.installationId, ...fields.map(([, value]) => value)])
      } else if (sources.length) await client.query('UPDATE kipster.memories SET updated_at=now() WHERE id=$1', [id])
      await this.addSources(client, id, current.organization_id, sources)
      return true
    })
  }

  /**
   * Ends current memories of one context and adds the memory that takes their place: a combined or changed one. The new
   * memory keeps the old ones' sources and adds `sources`; the old ones keep their rows with `valid_to` and
   * `replaced_by`, and stop being core. Returns the new memory's ID, or null when a memory is gone, not current, or
   * of another context than the others.
   */
  async merge(ids: readonly string[], input: MemoryInput, sources: readonly MessageSource[], client?: SqlClient): Promise<string | null> {
    const value = memoryInput(input)
    const unique = [...new Set(ids)]
    if (!unique.length) throw new Error('A merge names at least one memory')
    return this.write(client, async client => {
      const current = await this.current(client, unique)
      if (current.length !== unique.length || new Set(current.map(row => row.organization_id)).size !== 1) return null
      const organizationId = current[0]!.organization_id
      const next = await this.create({ ...value, organizationId }, sources, client)
      await client.query(`INSERT INTO kipster.memory_sources(memory_id, installation_id, thread_id, message_id)
        SELECT $1, installation_id, thread_id, message_id FROM kipster.memory_sources WHERE memory_id = ANY($2::uuid[]) ON CONFLICT DO NOTHING`, [next, unique])
      await client.query('UPDATE kipster.memories SET valid_to=now(), replaced_by=$2, core=false, updated_at=now() WHERE id = ANY($1::uuid[])', [unique, next])
      return next
    })
  }

  /** Ends a current memory that is no longer true, with nothing in its place, and records why. Returns false when it is gone or not current. */
  async retire(id: string, sources: readonly MessageSource[], client?: SqlClient): Promise<boolean> {
    return this.write(client, async client => {
      const [current] = await this.current(client, [id])
      if (!current) return false
      await this.addSources(client, id, current.organization_id, sources)
      await client.query('UPDATE kipster.memories SET valid_to=now(), core=false, updated_at=now() WHERE id=$1', [id])
      return true
    })
  }

  /** Deletes memories with their sources and embeddings. Messages stay. Returns how many went. */
  async delete(ids: readonly string[], client?: SqlClient): Promise<number> {
    if (!ids.length) return 0
    return this.write(client, async client => (await client.query('DELETE FROM kipster.memories WHERE id = ANY($1::uuid[]) AND installation_id=$2', [ids, this.installationId])).rowCount ?? 0)
  }

  async get(id: string, client: Postgres | SqlClient = this.db): Promise<Memory | null> {
    const row = (await client.query<MemoryRow>(`SELECT ${memoryColumns} FROM kipster.memories c WHERE c.id=$1 AND c.installation_id=$2`, [id, this.installationId])).rows[0]
    return row ? memory(row) : null
  }

  /** Memories newest first, current ones only unless `ended`. `cursor` is the last memory of the previous page. */
  async list(options: { scope?: MemoryScope; ended?: boolean; limit?: number; cursor?: string | null } = {}, client: Postgres | SqlClient = this.db): Promise<{ memories: Memory[]; nextCursor: string | null }> {
    const scope = options.scope ?? 'all'
    const limit = Math.min(Math.max(1, options.limit ?? 50), MEMORY_FIELD_LIMITS.page)
    // As text, so the cursor keeps the microseconds a Date would drop and memories saved in one transaction are not skipped.
    const after = options.cursor ? (await client.query<{ updated_at: string; id: string }>('SELECT updated_at::text AS updated_at, id FROM kipster.memories WHERE id=$1 AND installation_id=$2', [options.cursor, this.installationId])).rows[0] : undefined
    if (options.cursor && !after) throw new Error('Invalid memory cursor')
    const rows = (await client.query<MemoryRow>(`SELECT ${memoryColumns} FROM kipster.memories c WHERE c.installation_id=$1 AND ${scopeSql(scope, '$2')}
      AND ($3 OR c.valid_to IS NULL) AND ($4::timestamptz IS NULL OR (c.updated_at, c.id) < ($4, $5::uuid))
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $6`, [this.installationId, scopeValue(scope), options.ended === true, after?.updated_at ?? null, after?.id ?? null, limit + 1])).rows
    return { memories: rows.slice(0, limit).map(memory), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }
  }

  /**
   * The current memories in `scope` nearest to `query`: by cosine distance of their embeddings when an embedding provider
   * answers, then filled with unembedded memories. Without a provider or an answer, memories about `subject` come first,
   * then the most recently changed.
   */
  async nearest(query: { text: string; subject?: string | undefined }, scope: MemoryScope, limit: number, client: Postgres | SqlClient = this.db): Promise<Memory[]> {
    if (limit <= 0) return []
    let vector: string | undefined, model: string | undefined
    if (this.embedding && query.text.trim()) {
      const { profile, embedder } = this.embedding.embeddingConfig()
      try { vector = vectorLiteral(await boundedEmbed(embedder, embeddingQuery(query.text.slice(0, EMBEDDING_TEXT_MAX)), 10000)); model = profile.model } catch { vector = undefined }
    }
    const found: MemoryRow[] = []
    if (vector) {
      try {
        found.push(...(await client.query<MemoryRow>(`SELECT ${memoryColumns} FROM kipster.memories c WHERE c.installation_id=$1 AND c.valid_to IS NULL AND ${scopeSql(scope, '$2')}
          AND c.embedding IS NOT NULL AND c.embedding_model=$3 ORDER BY c.embedding <=> $4::vector, c.id LIMIT $5`, [this.installationId, scopeValue(scope), model, vector, limit])).rows)
      } catch { /* A vector of another dimension finds nothing; the fallback below still answers. */ }
    }
    if (found.length < limit) {
      found.push(...(await client.query<MemoryRow>(`SELECT ${memoryColumns} FROM kipster.memories c WHERE c.installation_id=$1 AND c.valid_to IS NULL AND ${scopeSql(scope, '$2')}
        AND c.id <> ALL($3::uuid[]) AND ($4::text IS NULL OR c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $4)
        ORDER BY lower(c.subject) = lower(COALESCE($5, '')) DESC, c.updated_at DESC, c.id LIMIT $6`,
        [this.installationId, scopeValue(scope), found.map(row => row.id), vector ? model : null, query.subject ?? null, limit - found.length])).rows)
    }
    return found.map(memory)
  }

  /** Current memories, locked, in ID order. */
  private async current(client: SqlClient, ids: readonly string[]): Promise<{ id: string; organization_id: string | null }[]> {
    return (await client.query<{ id: string; organization_id: string | null }>('SELECT id, organization_id FROM kipster.memories WHERE id = ANY($1::uuid[]) AND installation_id=$2 AND valid_to IS NULL ORDER BY id FOR UPDATE', [ids, this.installationId])).rows
  }

  private async addSources(client: SqlClient, memoryId: string, organizationId: string | null, sources: readonly MessageSource[]): Promise<void> {
    if (sources.length > MEMORY_FIELD_LIMITS.sources) throw new Error('Too many memory sources')
    for (const source of sources) {
      const valid = await client.query(`SELECT 1 FROM kipster.messages m JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
        JOIN kipster.people p ON p.id=m.author_id AND p.installation_id=c.installation_id
        WHERE m.id=$1 AND m.thread_id=$2 AND c.installation_id=$3
          AND CASE WHEN c.context_kind='organization' THEN c.context_id IS NOT DISTINCT FROM $4::uuid ELSE $4::uuid IS NULL END`, [source.messageId, source.threadId, this.installationId, organizationId])
      if (!valid.rows.length) throw new Error('Memory source must be a person\'s message in the memory\'s context')
      await client.query('INSERT INTO kipster.memory_sources(memory_id, installation_id, thread_id, message_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [memoryId, this.installationId, source.threadId, source.messageId])
    }
  }
}
