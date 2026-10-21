import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { learnedSection, type IdentityFiles } from '../../platform/home/public.js'
import { boundedEmbed, vectorLiteral, type EmbeddingProfile } from '../vectors/public.js'
import { embeddingQuery } from '../../embedding/index.js'
import { EMBEDDING_TEXT_MAX } from './embed.js'
import type { MessageSource } from './memories.js'

/** A lesson: how one kip should do its work, kept for that kip in every workspace. */
export interface Lesson {
  id: string; agentId: string
  /** The workspace it was learned in, or null for an installation thread. */
  organizationId: string | null
  statement: string
  /** Nights it came up, at most one per night. */
  confirmations: number
  lastConfirmedNight: string
  validFrom: string; validTo: string | null; replacedBy: string | null; createdAt: string; updatedAt: string
  embedded: boolean
  sources: MessageSource[]
}

/** Lesson bounds (decision record 14). */
export const LESSONS = {
  /** Current lessons a kip keeps; past it the nightly run retires the least confirmed. */
  cap: 400,
  /** Lessons in the Learned section of identity.md, loaded on every turn. */
  learned: 10,
  /** Nearest lessons a turn's memory search adds. */
  search: 3,
  /** Nearest lessons per message, and in total, the lessons step compares. */
  nearestPerMessage: 5,
  nearestTotal: 10,
  statement: 1000,
  sources: 50,
  page: 200,
} as const

function statement(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > LESSONS.statement || value.includes('\0')) throw new Error('Invalid lesson statement')
  return value.trim().replace(/\s+/g, ' ')
}

type LessonRow = { id: string; agent_id: string; organization_id: string | null; statement: string; confirmations: number; last_confirmed_night: string; valid_from: Date; valid_to: Date | null; replaced_by: string | null; created_at: Date; updated_at: Date; embedded: boolean; sources: MessageSource[] }
const lessonColumns = `l.id, l.agent_id, l.organization_id, l.statement, l.confirmations, l.last_confirmed_night::text AS last_confirmed_night, l.valid_from, l.valid_to, l.replaced_by,
  l.created_at, l.updated_at, l.embedding IS NOT NULL AS embedded,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('threadId', s.thread_id, 'messageId', s.message_id) ORDER BY s.thread_id, s.message_id) FROM kipster.lesson_sources s WHERE s.lesson_id = l.id), '[]'::jsonb) AS sources`
function lesson(row: LessonRow): Lesson {
  return {
    id: row.id, agentId: row.agent_id, organizationId: row.organization_id, statement: row.statement, confirmations: row.confirmations, lastConfirmedNight: row.last_confirmed_night,
    validFrom: row.valid_from.toISOString(), validTo: row.valid_to?.toISOString() ?? null, replacedBy: row.replaced_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), embedded: row.embedded, sources: row.sources,
  }
}
/** The order of a kip's lessons by weight: most confirmed, then most recently confirmed. */
const ranked = 'l.confirmations DESC, l.last_confirmed_night DESC, l.created_at, l.id'

/**
 * Lessons of the kips of one installation. Writes take the caller's transaction, or open their own. Every write that
 * learns records its sources: messages in the kip's own threads written by a person or by another kip. `night` is the
 * sleep day of the run ("YYYY-MM-DD"); a lesson gains at most one confirmation per night. A statement change clears the
 * embedding, so the lesson is embedded again.
 */
export class LessonService {
  constructor(private readonly db: Postgres, readonly installationId: string, private readonly embedding?: EmbeddingProfile) {}

  private write<T>(client: SqlClient | undefined, work: (client: SqlClient) => Promise<T>): Promise<T> {
    return client ? work(client) : this.db.transaction(work)
  }

  /** Adds a current lesson of `agentId`, learned in `organizationId` (null for an installation thread). */
  async create(agentId: string, input: { statement: string; organizationId: string | null }, sources: readonly MessageSource[], night: string, client?: SqlClient): Promise<string> {
    const text = statement(input.statement)
    return this.write(client, async client => {
      const id = randomUUID()
      await client.query(`INSERT INTO kipster.lessons(id, installation_id, agent_id, organization_id, statement, last_confirmed_night) VALUES ($1,$2,$3,$4,$5,$6::date)`,
        [id, this.installationId, agentId, input.organizationId, text, night])
      await this.addSources(client, id, agentId, sources)
      return id
    })
  }

  /** A current lesson came up again: one more confirmation unless it was confirmed this night, the new wording when
   * given, and the sources. Returns false when it is gone, not current or another kip's. */
  async update(agentId: string, id: string, input: { statement?: string | undefined }, sources: readonly MessageSource[], night: string, client?: SqlClient): Promise<boolean> {
    const text = input.statement === undefined ? null : statement(input.statement)
    return this.write(client, async client => {
      const [current] = await this.current(client, agentId, [id])
      if (!current) return false
      await client.query(`UPDATE kipster.lessons SET confirmations = confirmations + CASE WHEN last_confirmed_night < $2::date THEN 1 ELSE 0 END,
          last_confirmed_night = GREATEST(last_confirmed_night, $2::date), statement = COALESCE($3, statement),
          embedding = CASE WHEN $3::text IS NOT NULL AND $3 <> statement THEN NULL ELSE embedding END,
          embedding_model = CASE WHEN $3::text IS NOT NULL AND $3 <> statement THEN NULL ELSE embedding_model END, updated_at = now()
        WHERE id = $1`, [id, night, text])
      await this.addSources(client, id, agentId, sources)
      return true
    })
  }

  /**
   * Ends current lessons of `agentId` and adds the one that takes their place, combined or changed. It starts from the
   * sum of their confirmations, plus one unless one was confirmed this night, keeps their sources and adds `sources`.
   * It is learned in their workspace when they share one. Returns the new lesson's ID, or null when one is gone or not current.
   */
  async merge(agentId: string, ids: readonly string[], input: { statement: string }, sources: readonly MessageSource[], night: string, client?: SqlClient): Promise<string | null> {
    const text = statement(input.statement)
    const unique = [...new Set(ids)]
    if (!unique.length) throw new Error('A merge names at least one lesson')
    return this.write(client, async client => {
      const current = await this.current(client, agentId, unique)
      if (current.length !== unique.length) return null
      const organizations = new Set(current.map(row => row.organization_id))
      const total = current.reduce((sum, row) => sum + row.confirmations, 0) + (current.some(row => row.last_confirmed_night >= night) ? 0 : 1)
      const id = randomUUID()
      await client.query(`INSERT INTO kipster.lessons(id, installation_id, agent_id, organization_id, statement, confirmations, last_confirmed_night) VALUES ($1,$2,$3,$4,$5,$6,$7::date)`,
        [id, this.installationId, agentId, organizations.size === 1 ? current[0]!.organization_id : null, text, total, night])
      await client.query(`INSERT INTO kipster.lesson_sources(lesson_id, installation_id, thread_id, message_id)
        SELECT $1, installation_id, thread_id, message_id FROM kipster.lesson_sources WHERE lesson_id = ANY($2::uuid[]) ON CONFLICT DO NOTHING`, [id, unique])
      await this.addSources(client, id, agentId, sources)
      await client.query('UPDATE kipster.lessons SET valid_to=now(), replaced_by=$2, updated_at=now() WHERE id = ANY($1::uuid[])', [unique, id])
      return id
    })
  }

  /** Ends a current lesson that no longer holds, with nothing in its place, and records why. */
  async retire(agentId: string, id: string, sources: readonly MessageSource[], client?: SqlClient): Promise<boolean> {
    return this.write(client, async client => {
      const [current] = await this.current(client, agentId, [id])
      if (!current) return false
      await this.addSources(client, id, agentId, sources)
      await client.query('UPDATE kipster.lessons SET valid_to=now(), updated_at=now() WHERE id=$1', [id])
      return true
    })
  }

  /** A person's correction of a current lesson's wording. Returns false when it is gone or not current. */
  async edit(id: string, text: string, client?: SqlClient): Promise<boolean> {
    const value = statement(text)
    return this.write(client, async client => {
      const changed = await client.query(`UPDATE kipster.lessons SET statement=$3, embedding=CASE WHEN statement=$3 THEN embedding END,
          embedding_model=CASE WHEN statement=$3 THEN embedding_model END, updated_at=now()
        WHERE id=$1 AND installation_id=$2 AND valid_to IS NULL`, [id, this.installationId, value])
      return (changed.rowCount ?? 0) > 0
    })
  }

  /** Retires a kip's least confirmed current lessons beyond `LESSONS.cap`. Returns how many it retired. */
  async enforceCap(agentId: string, client?: SqlClient): Promise<number> {
    return this.write(client, async client => (await client.query(`UPDATE kipster.lessons SET valid_to=now(), updated_at=now() WHERE id IN (
        SELECT l.id FROM kipster.lessons l WHERE l.agent_id=$1 AND l.installation_id=$2 AND l.valid_to IS NULL ORDER BY ${ranked} OFFSET $3)`,
      [agentId, this.installationId, LESSONS.cap])).rowCount ?? 0)
  }

  /** Deletes lessons with their sources and embeddings; returns their agents. Messages stay. */
  async delete(ids: readonly string[], client?: SqlClient): Promise<string[]> {
    if (!ids.length) return []
    return this.write(client, async client => (await client.query<{ agent_id: string }>('DELETE FROM kipster.lessons WHERE id = ANY($1::uuid[]) AND installation_id=$2 RETURNING agent_id', [ids, this.installationId])).rows.map(row => row.agent_id))
  }

  async get(id: string, client: Postgres | SqlClient = this.db): Promise<Lesson | null> {
    const row = (await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.id=$1 AND l.installation_id=$2`, [id, this.installationId])).rows[0]
    return row ? lesson(row) : null
  }

  /** A kip's current lessons by weight, at most `limit`: its top lessons. */
  async top(agentId: string, limit: number, client: Postgres | SqlClient = this.db): Promise<Lesson[]> {
    if (limit <= 0) return []
    return (await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.agent_id=$1 AND l.installation_id=$2 AND l.valid_to IS NULL
      ORDER BY ${ranked} LIMIT $3`, [agentId, this.installationId, limit])).rows.map(lesson)
  }

  /** Lessons newest first, of one kip or every kip, current ones only unless `ended`. `cursor` is the last lesson of the previous page. */
  async list(options: { agentId?: string | null; ended?: boolean; limit?: number; cursor?: string | null } = {}, client: Postgres | SqlClient = this.db): Promise<{ lessons: Lesson[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, options.limit ?? 50), LESSONS.page)
    const after = options.cursor ? (await client.query<{ updated_at: string; id: string }>('SELECT updated_at::text AS updated_at, id FROM kipster.lessons WHERE id=$1 AND installation_id=$2', [options.cursor, this.installationId])).rows[0] : undefined
    if (options.cursor && !after) throw new Error('Invalid lesson cursor')
    const rows = (await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.installation_id=$1 AND ($2::uuid IS NULL OR l.agent_id=$2)
      AND ($3 OR l.valid_to IS NULL) AND ($4::timestamptz IS NULL OR (l.updated_at, l.id) < ($4, $5::uuid))
      ORDER BY l.updated_at DESC, l.id DESC LIMIT $6`, [this.installationId, options.agentId ?? null, options.ended === true, after?.updated_at ?? null, after?.id ?? null, limit + 1])).rows
    return { lessons: rows.slice(0, limit).map(lesson), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null }
  }

  /** The current lessons of `agents` (null: every kip) nearest to `query` by embedding, at most `limit`. Without an
   * embedding provider or an answer, the kips' top lessons instead. */
  async nearest(query: string, agents: readonly string[] | null, limit: number, client: Postgres | SqlClient = this.db): Promise<Lesson[]> {
    if (limit <= 0) return []
    const vector = await this.vector(query)
    const found: LessonRow[] = []
    if (vector) {
      try {
        found.push(...(await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.installation_id=$1 AND l.valid_to IS NULL AND ($2::uuid[] IS NULL OR l.agent_id = ANY($2::uuid[]))
          AND l.embedding IS NOT NULL AND l.embedding_model=$3 ORDER BY l.embedding <=> $4::vector, l.id LIMIT $5`, [this.installationId, agents, vector.model, vector.literal, limit])).rows)
      } catch { /* A vector of another dimension finds nothing; the fallback below still answers. */ }
    }
    if (found.length < limit) {
      found.push(...(await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.installation_id=$1 AND l.valid_to IS NULL AND ($2::uuid[] IS NULL OR l.agent_id = ANY($2::uuid[]))
        AND l.id <> ALL($3::uuid[]) AND ($4::text IS NULL OR l.embedding IS NULL OR l.embedding_model IS DISTINCT FROM $4)
        ORDER BY ${ranked} LIMIT $5`, [this.installationId, agents, found.map(row => row.id), vector?.model ?? null, limit - found.length])).rows)
    }
    return found.map(lesson)
  }

  /** The nearest current lessons by embedding only, for a turn's search; empty without an embedding answer. */
  async searched(agents: readonly string[] | null, limit: number, vector: { literal: string; model: string }, client: Postgres | SqlClient = this.db): Promise<Lesson[]> {
    if (limit <= 0) return []
    return (await client.query<LessonRow>(`SELECT ${lessonColumns} FROM kipster.lessons l WHERE l.installation_id=$1 AND l.valid_to IS NULL AND ($2::uuid[] IS NULL OR l.agent_id = ANY($2::uuid[]))
      AND l.embedding IS NOT NULL AND l.embedding_model=$3 ORDER BY l.embedding <=> $4::vector, l.id LIMIT $5`, [this.installationId, agents, vector.model, vector.literal, limit])).rows.map(lesson)
  }

  private async vector(query: string): Promise<{ literal: string; model: string } | undefined> {
    if (!this.embedding || !query.trim()) return undefined
    const { profile, embedder } = this.embedding.embeddingConfig()
    try { return { literal: vectorLiteral(await boundedEmbed(embedder, embeddingQuery(query.slice(0, EMBEDDING_TEXT_MAX)), 10000)), model: profile.model } } catch { return undefined }
  }

  /** Current lessons of the kip, locked, in ID order. */
  private async current(client: SqlClient, agentId: string, ids: readonly string[]): Promise<{ id: string; organization_id: string | null; confirmations: number; last_confirmed_night: string }[]> {
    return (await client.query<{ id: string; organization_id: string | null; confirmations: number; last_confirmed_night: string }>(`SELECT id, organization_id, confirmations, last_confirmed_night::text AS last_confirmed_night
      FROM kipster.lessons WHERE id = ANY($1::uuid[]) AND agent_id=$2 AND installation_id=$3 AND valid_to IS NULL ORDER BY id FOR UPDATE`, [ids, agentId, this.installationId])).rows
  }

  private async addSources(client: SqlClient, lessonId: string, agentId: string, sources: readonly MessageSource[]): Promise<void> {
    if (sources.length > LESSONS.sources) throw new Error('Too many lesson sources')
    for (const source of sources) {
      const valid = await client.query(`SELECT 1 FROM kipster.messages m JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
        WHERE m.id=$1 AND m.thread_id=$2 AND c.installation_id=$3 AND c.agent_id=$4 AND m.author_id <> $4
          AND (EXISTS (SELECT 1 FROM kipster.people p WHERE p.id=m.author_id AND p.installation_id=c.installation_id)
            OR EXISTS (SELECT 1 FROM kipster.agents a WHERE a.id=m.author_id AND a.installation_id=c.installation_id))`, [source.messageId, source.threadId, this.installationId, agentId])
      if (!valid.rows.length) throw new Error('Lesson source must be a message of the person or another kip in the kip\'s own thread')
      await client.query('INSERT INTO kipster.lesson_sources(lesson_id, installation_id, thread_id, message_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [lessonId, this.installationId, source.threadId, source.messageId])
    }
  }
}

/** The Learned section of a kip's identity.md for its top lessons: one line each, with the workspace it came from. */
export function learnedText(lessons: readonly Lesson[], workspaces: ReadonlyMap<string, string>): string {
  if (!lessons.length) return ''
  const lines = lessons.map(item => `- ${item.statement}${item.organizationId && workspaces.has(item.organizationId) ? ` (learned in ${workspaces.get(item.organizationId)})` : ''}`)
  return ['## Learned', '', 'Kipster writes this section each night from your lessons that came up most often. If one conflicts with the current conversation, the conversation wins.', '', ...lines].join('\n')
}

/**
 * Writes a kip's top lessons into the Learned section of its identity.md when they differ from what the section says.
 * The rest of the file is never changed. A kip without identity.md, or without lessons and without a section, is left
 * alone. Returns whether the file changed.
 */
export async function rebuildLearned(db: Postgres, identity: IdentityFiles, installationId: string, agentId: string): Promise<boolean> {
  const top = await new LessonService(db, installationId).top(agentId, LESSONS.learned)
  const workspaces = new Map((await db.query<{ id: string; display_name: string }>('SELECT id, display_name FROM kipster.organizations WHERE id = ANY($1::uuid[])',
    [[...new Set(top.flatMap(item => item.organizationId ? [item.organizationId] : []))]])).rows.map(row => [row.id, row.display_name]))
  const section = learnedText(top, workspaces)
  let file
  try { file = await identity.read(agentId, 'identity.md') } catch { return false }
  const existing = learnedSection(file.content)
  if (existing === null ? section === '' : existing.trimEnd() === section.trimEnd()) return false
  await identity.replaceLearned(agentId, section, file.sha256)
  return true
}
