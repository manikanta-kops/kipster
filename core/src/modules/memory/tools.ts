import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { EmbeddingProfile } from '../vectors/public.js'
import { CardService, embedCards, scopeSql, scopeValue, type CardScope } from './cards.js'
import { memorySettings } from './settings.js'
import { MEMORY_READ, memoryAccess, readThread, recentThreads, searchMemory, type MemoryRange, type ThreadScope } from './search.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Most cards `forget_memory` deletes for one query, and candidates it returns instead when more match. */
export const FORGET_LIMITS = { matches: 20, candidates: 50, query: 200 } as const

/** The run a memory tool call belongs to: its agent, context, thread and trigger message. */
interface MemoryRun { installationId: string; agentId: string; organizationId: string | null; threadId: string; triggerMessageId: string; admin: boolean }

/** The current, issued attempt of a running run, not stopping, whose agent has memory on. */
async function boundRun(client: Postgres | SqlClient, attemptId: string, incarnation: string): Promise<MemoryRun> {
  const row = uuid.test(attemptId) ? (await client.query<{ installation_id: string; agent_id: string; context_kind: string; context_id: string; thread_id: string; input_message_id: string; attempt_state: string; run_state: string; stop_requested: boolean; current_attempt_id: string }>(
    `SELECT c.installation_id, c.agent_id, c.context_kind, c.context_id, r.thread_id, r.input_message_id,
       a.state AS attempt_state, r.state AS run_state, r.stop_requested, r.current_attempt_id
     FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
     WHERE a.id=$1 AND a.incarnation=$2`, [attemptId, incarnation])).rows[0] : undefined
  if (!row || row.attempt_state !== 'issued' || row.current_attempt_id !== attemptId || !['running', 'waiting'].includes(row.run_state) || row.stop_requested) throw new Error('Attempt no longer owns memory tools')
  const access = await memoryAccess(client, row.agent_id)
  if (!access.enabled) throw new Error('Memory is off for this kip')
  return { installationId: row.installation_id, agentId: row.agent_id, organizationId: row.context_kind === 'organization' ? row.context_id : null, threadId: row.thread_id, triggerMessageId: row.input_message_id, admin: access.admin }
}

function fields(input: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Invalid ${tool} arguments: unknown field ${key}`)
}
function text(input: Record<string, unknown>, key: string, tool: string, max: number, required = true): string | undefined {
  const value = input[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${tool} arguments: ${key} must be text of at most ${max} characters`)
  return value
}
function position(input: Record<string, unknown>, key: string, tool: string): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${tool} arguments: ${key} must be a positive integer`)
  return value as number
}
/** An ISO date ("YYYY-MM-DD", a whole host local day) or date and time. `to` is inclusive of its whole day. */
function instant(value: unknown, key: string, tool: string, end: boolean): Date | null {
  if (value === undefined) return null
  const day = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  const parsed = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + (end ? 1 : 0)) : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null
  if (!parsed || Number.isNaN(parsed.getTime())) throw new Error(`Invalid ${tool} arguments: ${key} must be an ISO date or date and time`)
  return parsed
}

/**
 * The agent another kip's memory is read for. Only the admin kip may name one; any other kip reads its own memory. The
 * admin kip without `agent` reads every kip's.
 */
async function agentArgument(client: Postgres | SqlClient, run: MemoryRun, value: unknown, tool: string): Promise<string[] | null> {
  if (value === undefined) return run.admin ? null : [run.agentId]
  if (!run.admin) throw new Error(`Invalid ${tool} arguments: only the admin kip may name an agent`)
  if (typeof value !== 'string' || !uuid.test(value) || !(await client.query('SELECT 1 FROM kipster.agents WHERE id=$1 AND installation_id=$2', [value, run.installationId])).rows.length) throw new Error(`Invalid ${tool} arguments: agent not found`)
  return [value]
}

/** Threads a run's tools may read: the admin kip's cover every kip and organization; another kip's cover its own installation
 * threads and the current organization's. */
const threadScope = (run: MemoryRun, agents: string[] | null, exclude: string | null = null): ThreadScope =>
  run.admin ? { agents, organizations: 'all', exclude } : { agents: [run.agentId], organizations: { organizationId: run.organizationId }, exclude }
/** Cards a run's tools may see: every card for the admin kip; installation cards plus the current organization's for another kip. */
const cardScope = (run: MemoryRun): CardScope => run.admin ? 'all' : { organizationId: run.organizationId }

/**
 * The memory tools of an execution (decision record 10, section 6), bound to its current attempt: `search_memory`,
 * `list_recent_threads`, `read_thread`, `save_memory` and `forget_memory`. Refused while the agent has
 * memory off.
 */
export async function memoryTool(db: Postgres, embedding: EmbeddingProfile | undefined, attemptId: string, incarnation: string, name: string, input: Record<string, unknown>): Promise<unknown> {
  const run = await boundRun(db, attemptId, incarnation)
  if (name === 'search_memory') {
    fields(input, ['query', 'from', 'to', 'agent'], name)
    const query = text(input, 'query', name, MEMORY_READ.queryChars)!
    const range: MemoryRange = { from: instant(input.from, 'from', name, false), to: instant(input.to, 'to', name, true) }
    if (range.from && range.to && range.from >= range.to) throw new Error(`Invalid ${name} arguments: from must be before to`)
    const agents = await agentArgument(db, run, input.agent, name)
    const settings = await memorySettings(db, run.installationId)
    return searchMemory(db, run.installationId, embedding, { query, range, cards: cardScope(run), threads: threadScope(run, agents, run.threadId), cardCount: settings.searchCardCount, itemCount: settings.searchChunkCount, timeoutMs: MEMORY_READ.toolEmbedMs })
  }
  if (name === 'list_recent_threads') {
    fields(input, ['agent'], name)
    return recentThreads(db, run.installationId, threadScope(run, await agentArgument(db, run, input.agent, name), run.threadId))
  }
  if (name === 'read_thread') {
    fields(input, ['threadId', 'fromPosition', 'toPosition'], name)
    const threadId = text(input, 'threadId', name, 36)!
    const from = position(input, 'fromPosition', name) ?? 1, to = position(input, 'toPosition', name) ?? null
    if (to !== null && to < from) throw new Error(`Invalid ${name} arguments: toPosition must not be before fromPosition`)
    // A kip may also read the thread the messages of its linked thread come from, and only that one.
    const source = !run.admin && uuid.test(threadId) && (await db.query('SELECT 1 FROM kipster.kip_links WHERE linked_thread_id=$1 AND source_thread_id=$2', [run.threadId, threadId])).rows.length > 0
    const page = uuid.test(threadId) ? await readThread(db, run.installationId, source ? { agents: null, organizations: 'all' } : threadScope(run, run.admin ? null : [run.agentId]), threadId, from, to) : null
    if (!page) throw new Error('Thread not found')
    return page
  }
  if (name === 'save_memory') {
    fields(input, ['statement', 'type', 'subject', 'details'], name)
    const cards = new CardService(db, run.installationId, embedding)
    // The card is confirmed: the user said it in the message this run answers. CardService checks the fields, and that
    // the source is a person's message in the card's context.
    const cardId = await cards.create({ type: input.type as string, subject: input.subject as string, statement: input.statement as string, details: input.details as Record<string, unknown> | undefined, confirmed: true, organizationId: run.organizationId },
      [{ threadId: run.threadId, messageId: run.triggerMessageId }])
    // Best effort: a card left unembedded is embedded by the next nightly run.
    const embedded = await embedCards(db, run.installationId, embedding, [cardId], MEMORY_READ.toolEmbedMs).catch(() => ({ embedded: 0, failed: true }))
    return { card: await cards.get(cardId), embedded: embedded.embedded > 0 }
  }
  if (name === 'forget_memory') {
    fields(input, ['cardId', 'query'], name)
    if ((input.cardId === undefined) === (input.query === undefined)) throw new Error(`Invalid ${name} arguments: give cardId or query`)
    const scope = cardScope(run)
    return db.transaction(async client => {
      if (input.cardId !== undefined) {
        const id = text(input, 'cardId', name, 36)!
        const found = uuid.test(id) ? (await client.query<Forgotten>(`SELECT c.id, c.type, c.subject, c.statement, c.valid_to IS NULL AS current FROM kipster.cards c
          WHERE c.id=$1 AND c.installation_id=$2 AND ${scopeSql(scope, '$3')} FOR UPDATE`, [id, run.installationId, scopeValue(scope)])).rows : []
        if (!found.length) throw new Error('Card not found')
        await new CardService(db, run.installationId).delete([id], client)
        return { deleted: found }
      }
      const query = text(input, 'query', name, FORGET_LIMITS.query)!.trim()
      const matches = (await client.query<Forgotten>(`SELECT c.id, c.type, c.subject, c.statement, c.valid_to IS NULL AS current FROM kipster.cards c
        WHERE c.installation_id=$1 AND ${scopeSql(scope, '$2')} AND (strpos(lower(c.statement), lower($3)) > 0 OR strpos(lower(c.subject), lower($3)) > 0)
        ORDER BY c.updated_at DESC, c.id LIMIT $4 FOR UPDATE`, [run.installationId, scopeValue(scope), query, FORGET_LIMITS.candidates + 1])).rows
      if (matches.length > FORGET_LIMITS.matches) {
        return { deleted: [], refused: `More than ${FORGET_LIMITS.matches} cards match; none were deleted. Forget the ones you mean by cardId.`, candidates: matches.slice(0, FORGET_LIMITS.candidates), hasMore: matches.length > FORGET_LIMITS.candidates }
      }
      await new CardService(db, run.installationId).delete(matches.map(row => row.id), client)
      return { deleted: matches }
    })
  }
  throw new Error('Unsupported memory tool')
}

type Forgotten = { id: string; type: string; subject: string; statement: string; current: boolean }
