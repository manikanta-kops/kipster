import { randomUUID } from 'node:crypto'
import type { Postgres } from '../../platform/postgres/public.js'
import type { EmbeddingProfile } from '../vectors/public.js'
import { CardService, embedPending, type CardSource } from './cards.js'
import { memorySettings, learningCondition } from './settings.js'
import {
  CHUNK_WORDS, cardsPrompt, chunksPrompt, corePrompt, diaryPrompt, parseCards, parseChunks, parseCore, parseDiary, promptText, windows, wordCount,
  type CardChange, type MemoryStep, type PromptCard, type PromptMessage,
} from './prompts.js'

export interface MemoryModelRequest { agentId: string; threadId: string | null; step: MemoryStep; instructions: string; outputSchema: Record<string, unknown>; signal: AbortSignal }
/** Runs one nightly step on the nightly model and returns its parsed JSON answer, or throws. */
export type MemoryModel = (request: MemoryModelRequest) => Promise<unknown>
/** A model call that cannot run now, for example while user turns need the capacity. The run stops without failing and
 * continues on a later tick. */
export class NightlyDeferred extends Error {}

export const NIGHTLY = {
  /** A failed run is tried again after this many minutes times its failures, and given up for the night after `failures`. */
  retryMinutes: 30,
  failures: 3,
  /** Earlier messages shown to the cards step as context. */
  contextMessages: 6,
  /** Nearest existing cards per user message, and in total, offered to the cards step. */
  nearestPerMessage: 5,
  nearestTotal: 30,
  /** Most cards the core step ranks. */
  coreCandidates: 300,
} as const

export type AgentOutcome = 'finished' | 'failed' | 'deferred' | 'busy'
export interface NightlyReport { agents: { agentId: string; outcome: AgentOutcome; failure?: string }[] }

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (value: number) => String(value).padStart(2, '0')
/** Host local date, "YYYY-MM-DD". */
export function localDay(date: Date): string { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
const dayLabel = (date: Date) => `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
/** The sleep day at `now`: a sleep day starts at the sleep time ("HH:MM", host local time). */
export function sleepDay(now: Date, sleepTime: string): string {
  const [hours, minutes] = sleepTime.split(':').map(Number) as [number, number]
  const shifted = new Date(now)
  shifted.setHours(shifted.getHours() - hours, shifted.getMinutes() - minutes)
  return localDay(shifted)
}

/** SQL condition: the thread in `threadColumn`, of chat `chatColumn`, has final messages the nightly run has not
 * processed. Internal threads (delegated work) and threads of organizations that are going away are left out. */
export function unprocessedThreadCondition(threadColumn: string, chatColumn: string): string {
  return `(NOT (SELECT internal FROM kipster.threads ut WHERE ut.id = ${threadColumn})
    AND (${chatColumn}.context_kind = 'installation' OR kipster.live_organization(${chatColumn}.context_id))
    AND EXISTS (SELECT 1 FROM kipster.messages um WHERE um.thread_id = ${threadColumn} AND um.final
      AND um.position > COALESCE((SELECT us.processed_position FROM kipster.memory_thread_state us WHERE us.thread_id = ${threadColumn}), 0)))`
}

interface Message { id: string; position: number; author: 'user' | 'kip' | 'other'; name: string; at: Date; text: string; progress: boolean }
interface Thread { id: string; organizationId: string | null; organizationName: string | null; processed: number }
/** A diary page that owes a rebuild: a thread it covered was deleted. */
interface OwedPage { day: string; organizationId: string | null; threadIds: string[] }
type MessageRow = { id: string; position: string; final: boolean; progress: boolean; created_at: Date; parts: unknown[]; person: string | null; agent: string | null; transcripts: Record<string, string> | null }
/** Columns of a `MessageRow`, with the message table as `m`. */
const messageColumns = `m.id, m.position, m.final, m.progress, m.created_at, m.parts, p.display_name AS person, a.display_name AS agent,
  (SELECT jsonb_object_agg(v.ordinal::text, v.transcript) FROM kipster.voice_preparations v WHERE v.message_id=m.id AND v.transcript IS NOT NULL) AS transcripts`
const messageAuthors = 'LEFT JOIN kipster.people p ON p.id=m.author_id LEFT JOIN kipster.agents a ON a.id=m.author_id'
function message(row: MessageRow): Message {
  const author = row.person !== null ? 'user' : row.agent !== null ? 'kip' : 'other'
  return { id: row.id, position: Number(row.position), author, name: row.person ?? row.agent ?? 'Unknown', at: row.created_at, text: render(row.parts, row.transcripts ?? {}), progress: row.progress }
}
interface ChunkRow { from: number; to: number; startedAt: Date; endedAt: Date; title: string; text: string }
type CardOperation = { change: CardChange; sources: CardSource[] }

/**
 * The nightly memory run of one installation (decision record 10, section 4). At each kip's sleep time, for every kip
 * with memory on and new messages, it writes thread chunks, changes the shared cards, writes diary pages, re-picks the
 * core cards and embeds what changed. A thread's results and its processed position are saved in one transaction, so a
 * failure leaves the thread for the next run. Only one Core incarnation runs an agent at a time.
 */
export class NightlyMemory {
  readonly cards: CardService
  constructor(private readonly options: { db: Postgres; installationId: string; embedding?: EmbeddingProfile | undefined; clock: () => Date; incarnation: string; model: MemoryModel }) {
    this.cards = new CardService(options.db, options.installationId, options.embedding)
  }
  private get db(): Postgres { return this.options.db }
  private get installationId(): string { return this.options.installationId }

  /** Agents whose sleep day began after their last run, with memory on and work: unprocessed threads, diary pages owing a
   * rebuild, a failed run to retry, a core re-pick still owed or, with an embedding provider, rows waiting for an
   * embedding, oldest night first. The agent's own chunks and diary pages wait for it. Cards, shared by the
   * installation, wait for any agent whose sleep time arrives: a due run embeds them, and with none due, one agent whose
   * night begins, the admin kip first, runs for them alone. Agents due with nothing to do have their night recorded, so a message
   * later that day waits for the next sleep time. */
  async due(): Promise<string[]> {
    const now = this.options.clock()
    const embedding = this.options.embedding !== undefined
    const rows = (await this.db.query<{ id: string; sleep_time: string; night: string | null; retry_at: Date | null; failure: string | null; repick: boolean | null; pending: boolean; owed: boolean; unembedded: boolean; admin: boolean }>(
      `SELECT a.id, left(COALESCE(a.sleep_time, i.sleep_time)::text, 5) AS sleep_time, n.night::text AS night, n.retry_at, n.failure, n.repick,
         EXISTS (SELECT 1 FROM kipster.direct_chats c JOIN kipster.threads t ON t.chat_id=c.id WHERE c.agent_id=a.id AND ${unprocessedThreadCondition('t.id', 'c')}) AS pending,
         EXISTS (SELECT 1 FROM kipster.diary d WHERE d.agent_id=a.id AND d.summary IS NULL) AS owed,
         $2::boolean AND (EXISTS (SELECT 1 FROM kipster.thread_chunks ch WHERE ch.agent_id=a.id AND ch.embedding IS NULL)
           OR EXISTS (SELECT 1 FROM kipster.diary d WHERE d.agent_id=a.id AND d.embedding IS NULL AND d.summary IS NOT NULL)) AS unembedded,
         EXISTS (SELECT 1 FROM kipster.agent_roles r WHERE r.agent_id=a.id AND r.role='root-admin') AS admin
       FROM kipster.agents a JOIN kipster.installations i ON i.id=a.installation_id LEFT JOIN kipster.memory_nights n ON n.agent_id=a.id
       WHERE a.installation_id=$1 AND ${learningCondition('a.id')} ORDER BY n.night NULLS FIRST, a.id`, [this.installationId, embedding])).rows
    const cards = embedding && (await this.db.query('SELECT 1 FROM kipster.cards WHERE installation_id=$1 AND embedding IS NULL LIMIT 1', [this.installationId])).rows.length > 0
    const due: string[] = []
    const idle: { id: string; night: string; admin: boolean }[] = []
    for (const row of rows) {
      const night = sleepDay(now, row.sleep_time)
      if (row.night !== null && row.night >= night) continue
      if (!row.pending && !row.owed && !row.unembedded && row.failure === null && !row.repick) { idle.push({ id: row.id, night, admin: row.admin }); continue }
      if (row.retry_at && row.retry_at > now) continue
      due.push(row.id)
    }
    const cardAgent = cards && due.length === 0 ? (idle.find(row => row.admin) ?? idle[0]) : undefined
    if (cardAgent) due.push(cardAgent.id)
    for (const row of idle) if (row !== cardAgent) await this.finish(row.id, row.night, null, true)
    return due
  }

  /** Runs every due agent, one after another. Stops at a deferral: the capacity is needed elsewhere. */
  async run(signal: AbortSignal): Promise<NightlyReport> {
    const report: NightlyReport = { agents: [] }
    for (const agentId of await this.due()) {
      if (signal.aborted) break
      const result = await this.runAgent(agentId, signal)
      report.agents.push({ agentId, ...result })
      if (result.outcome === 'deferred') break
    }
    return report
  }

  /** One agent's run. */
  async runAgent(agentId: string, signal: AbortSignal): Promise<{ outcome: AgentOutcome; failure?: string }> {
    const now = this.options.clock()
    const sleep = (await this.db.query<{ sleep_time: string }>(`SELECT left(COALESCE(a.sleep_time, i.sleep_time)::text, 5) AS sleep_time FROM kipster.agents a
      JOIN kipster.installations i ON i.id=a.installation_id WHERE a.id=$1 AND a.installation_id=$2`, [agentId, this.installationId])).rows[0]
    if (!sleep) return { outcome: 'busy' }
    const night = sleepDay(now, sleep.sleep_time)
    const claimed = await this.db.query<{ repick: boolean }>(`INSERT INTO kipster.memory_nights(agent_id, installation_id, owner, started_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (agent_id) DO UPDATE SET owner=EXCLUDED.owner, started_at=now(), updated_at=now()
      WHERE kipster.memory_nights.owner IS NULL OR kipster.memory_nights.owner=EXCLUDED.owner RETURNING repick`, [agentId, this.installationId, this.options.incarnation])
    if (!claimed.rowCount) return { outcome: 'busy' }
    // A re-pick an earlier run owed, after changing cards, is done in this one.
    let changed = claimed.rows[0]!.repick
    try {
      // Pages owing a rebuild first, so the threads' new messages build on them.
      for (const page of await this.owedPages(agentId)) {
        signal.throwIfAborted()
        if (await this.rebuild(agentId, page, signal) === 'stopped') break
      }
      for (const thread of await this.threads(agentId)) {
        signal.throwIfAborted()
        const saved = await this.thread(agentId, thread, signal)
        if (saved === 'stopped') break
        changed ||= saved === 'cards'
      }
      signal.throwIfAborted()
      await this.repickCore(agentId, changed, signal)
      // A provider that fails leaves rows waiting for the next night; the saved work stands and the night is finished.
      await embedPending(this.db, this.installationId, this.options.embedding, signal)
      await this.finish(agentId, night, null)
      return { outcome: 'finished' }
    } catch (error) {
      await embedPending(this.db, this.installationId, this.options.embedding, signal).catch(() => undefined)
      if (error instanceof NightlyDeferred || signal.aborted) {
        await this.release(agentId)
        return { outcome: 'deferred' }
      }
      const failure = error instanceof Error ? error.message : String(error)
      await this.finish(agentId, night, failure)
      return { outcome: 'failed', failure }
    }
  }

  /** Records a finished run, or a failure that is tried again later and given up for the night after a few. A run's
   * outcome is recorded only while this incarnation still owns the agent, so a former owner never changes a later one's
   * claim or retries; an idle night only while no one runs the agent. */
  private async finish(agentId: string, night: string, failure: string | null, idle = false): Promise<void> {
    if (idle) {
      await this.db.query(`INSERT INTO kipster.memory_nights(agent_id, installation_id, night, finished_at) VALUES ($1,$2,$3::date,now())
        ON CONFLICT (agent_id) DO UPDATE SET night=EXCLUDED.night, failures=0, failure=NULL, retry_at=NULL, finished_at=now(), updated_at=now()
        WHERE kipster.memory_nights.owner IS NULL`, [agentId, this.installationId, night])
    } else if (failure === null) {
      await this.db.query(`UPDATE kipster.memory_nights SET night=$2::date, failures=0, failure=NULL, retry_at=NULL, repick=false, owner=NULL, finished_at=now(), updated_at=now()
        WHERE agent_id=$1 AND owner=$3`, [agentId, night, this.options.incarnation])
    } else {
      // Retries follow Core's clock, as the schedule does.
      await this.db.query(`UPDATE kipster.memory_nights SET failures=CASE WHEN failures+1 >= $4 THEN 0 ELSE failures+1 END,
          night=CASE WHEN failures+1 >= $4 THEN $3::date ELSE night END,
          retry_at=CASE WHEN failures+1 >= $4 THEN NULL ELSE $6::timestamptz + make_interval(mins => $5 * (failures+1)) END,
          failure=$2, owner=NULL, finished_at=now(), updated_at=now() WHERE agent_id=$1 AND owner=$7`,
        [agentId, failure.slice(0, 1000), night, NIGHTLY.failures, NIGHTLY.retryMinutes, this.options.clock(), this.options.incarnation])
    }
  }

  private async release(agentId: string): Promise<void> {
    await this.db.query('UPDATE kipster.memory_nights SET owner=NULL, updated_at=now() WHERE agent_id=$1 AND owner=$2', [agentId, this.options.incarnation])
  }

  /** The agent's threads with unprocessed messages, the one waiting longest first. */
  private async threads(agentId: string): Promise<Thread[]> {
    const rows = (await this.db.query<{ id: string; context_kind: string; context_id: string; organization: string | null; processed: string }>(
      `SELECT t.id, c.context_kind, c.context_id, o.display_name AS organization, COALESCE(s.processed_position, 0) AS processed
       FROM kipster.direct_chats c JOIN kipster.threads t ON t.chat_id=c.id LEFT JOIN kipster.memory_thread_state s ON s.thread_id=t.id
       LEFT JOIN kipster.organizations o ON c.context_kind='organization' AND o.id=c.context_id
       WHERE c.installation_id=$1 AND c.agent_id=$2 AND ${unprocessedThreadCondition('t.id', 'c')}
       ORDER BY (SELECT min(m.created_at) FROM kipster.messages m WHERE m.thread_id=t.id AND m.position > COALESCE(s.processed_position, 0)), t.id`,
      [this.installationId, agentId])).rows
    return rows.map(row => ({ id: row.id, organizationId: row.context_kind === 'organization' ? row.context_id : null, organizationName: row.organization, processed: Number(row.processed) }))
  }

  /** Processes one thread: model calls first, then one transaction saves its chunks, card changes, diary contribution
   * and processed position. `stopped` means the agent stopped having memory; `gone` that the thread went away. */
  private async thread(agentId: string, thread: Thread, signal: AbortSignal): Promise<'saved' | 'cards' | 'gone' | 'stopped' | 'empty'> {
    const loaded = await this.load(agentId, thread)
    if (!loaded) return 'gone'
    const { kip, messages, last } = loaded
    const fresh = messages.filter(message => message.position > thread.processed)
    if (!fresh.length) return 'empty'
    const upTo = fresh.at(-1)!.position
    const rewriteFrom = last?.from ?? thread.processed + 1
    const segment = messages.filter(message => message.position >= rewriteFrom && !message.progress && message.text)
    const chunks = await this.chunks(agentId, thread, kip, segment, last, signal)
    const spoken = fresh.filter(message => !message.progress && message.text)
    const context = messages.filter(message => message.position <= thread.processed && !message.progress && message.text).slice(-NIGHTLY.contextMessages)
    const operations = await this.cardChanges(agentId, thread, context, spoken, signal)
    const days = await this.diary(agentId, thread, kip, spoken, chunks, signal)
    return this.save(agentId, thread, { rewriteFrom, upTo, chunks, operations, days })
  }

  /** The thread's messages from its last chunk, or from just before its unprocessed ones, up to the first draft. */
  private async load(agentId: string, thread: Thread): Promise<{ kip: string; messages: Message[]; last: { from: number; title: string } | null } | null> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const kip = (await client.query<{ display_name: string }>('SELECT display_name FROM kipster.agents WHERE id=$1', [agentId])).rows[0]?.display_name
      const exists = (await client.query('SELECT 1 FROM kipster.threads WHERE id=$1', [thread.id])).rows.length
      if (!kip || !exists) return null
      const last = (await client.query<{ from_position: string; title: string }>('SELECT from_position, title FROM kipster.thread_chunks WHERE thread_id=$1 ORDER BY from_position DESC LIMIT 1', [thread.id])).rows[0]
      const from = Math.max(1, Math.min(last ? Number(last.from_position) : thread.processed + 1, thread.processed + 1) - NIGHTLY.contextMessages * 2)
      const rows = (await client.query<MessageRow>(`SELECT ${messageColumns} FROM kipster.messages m ${messageAuthors}
         WHERE m.thread_id=$1 AND m.position >= $2 ORDER BY m.position`, [thread.id, from])).rows
      const messages: Message[] = []
      for (const row of rows) {
        // Processing stops before a message still being written.
        if (!row.final) break
        messages.push(message(row))
      }
      return { kip, messages, last: last ? { from: Number(last.from_position), title: last.title } : null }
    })
  }

  /** Full-text chunks of `segment`, at most about `CHUNK_WORDS` words each. A short segment is one chunk without a model
   * call; a longer one is split at the topic starts the model proposes, window by window, then at message boundaries. */
  private async chunks(agentId: string, thread: Thread, kip: string, segment: Message[], last: { from: number; title: string } | null, signal: AbortSignal): Promise<ChunkRow[]> {
    if (!segment.length) return []
    const total = segment.reduce((sum, message) => sum + wordCount(message.text), 0)
    let groups: { messages: Message[]; title: string }[]
    if (total <= CHUNK_WORDS) groups = [{ messages: segment, title: last && last.from === segment[0]!.position ? last.title : derivedTitle(segment) }]
    else {
      groups = []
      for (const window of windows(segment, message => wordCount(promptText(message.text)))) {
        const prompt = promptMessages(window, () => false)
        const topics = parseChunks(await this.ask(agentId, thread.id, 'chunks', chunksPrompt(prompt), signal), prompt)
        topics.forEach((topic, index) => {
          const members = window.slice(topic.start, topics[index + 1]?.start ?? window.length)
          groups.push({ messages: members, title: topic.title ?? derivedTitle(members) })
        })
      }
    }
    const chunks: ChunkRow[] = []
    for (const group of groups) {
      const pieces = windows(group.messages, message => wordCount(message.text), CHUNK_WORDS)
      pieces.forEach((piece, index) => chunks.push(this.chunk(kip, thread, piece, pieces.length > 1 && index > 0 ? `${group.title} (${index + 1})` : group.title)))
    }
    return chunks
  }

  private chunk(kip: string, thread: Thread, messages: Message[], title: string): ChunkRow {
    const first = messages[0]!, final = messages.at(-1)!
    const day = localDay(first.at)
    const lines = messages.map(message => `${message.name}, ${localDay(message.at) === day ? clock(message.at) : `${dayLabel(message.at)} ${clock(message.at)}`}:\n${message.text}`)
    const header = `${dayLabel(first.at)}, with ${kip}${thread.organizationName ? ` in ${thread.organizationName}` : ''}`
    return { from: first.position, to: final.position, startedAt: first.at, endedAt: final.at < first.at ? first.at : final.at, title, text: `${header}\n\n${lines.join('\n\n')}` }
  }

  /** Card changes proposed from the user's own new messages, each window compared with the nearest existing cards. */
  private async cardChanges(agentId: string, thread: Thread, context: Message[], spoken: Message[], signal: AbortSignal): Promise<CardOperation[]> {
    const operations: CardOperation[] = []
    const added: PromptCard[] = []
    let earlier = context
    for (const window of windows(spoken, message => wordCount(promptText(message.text)))) {
      const citable = window.filter(message => message.author === 'user')
      if (citable.length) {
        const shown = [...earlier, ...window]
        const prompt = promptMessages(shown, message => message.author === 'user' && window.includes(message), message => window.includes(message))
        const nearest = new Map<string, Awaited<ReturnType<CardService['nearest']>>[number]>()
        for (const message of citable) {
          for (const card of await this.cards.nearest({ text: message.text }, { organizationId: thread.organizationId }, NIGHTLY.nearestPerMessage)) {
            if (nearest.size >= NIGHTLY.nearestTotal) break
            nearest.set(card.id, card)
          }
        }
        const known = [...nearest.values()]
        const cards: PromptCard[] = [
          ...known.map((card, index) => ({ ref: `k${index + 1}`, type: card.type, subject: card.subject, statement: card.statement, details: card.details, confirmed: card.confirmed, changeable: card.organizationId === thread.organizationId })),
          ...added.map((card, index) => ({ ...card, ref: `k${known.length + index + 1}`, changeable: false })),
        ]
        const ids = new Map(cards.slice(0, known.length).map((card, index) => [card.ref, known[index]!.id]))
        const answer = parseCards(await this.ask(agentId, thread.id, 'cards', cardsPrompt(prompt, cards, dayLabel(window.at(-1)!.at)), signal), prompt, cards)
        const byRef = new Map(prompt.map((message, index) => [message.ref, shown[index]!]))
        for (const change of answer.changes) {
          operations.push({ change: { ...change, card: change.card ? ids.get(change.card)! : null }, sources: change.sources.map(ref => ({ threadId: thread.id, messageId: byRef.get(ref)!.id })) })
          if (change.action !== 'update') added.push({ ref: '', type: change.type, subject: change.subject, statement: change.statement, details: change.details, confirmed: change.confirmed, changeable: false })
        }
      }
      earlier = window.slice(-NIGHTLY.contextMessages)
    }
    return operations
  }

  /** New diary summaries for each day the thread's new messages cover, built on each day's current page in the thread's
   * own context. A day whose page owes a rebuild gets no summary (null): the rebuild covers this thread too. */
  private async diary(agentId: string, thread: Thread, kip: string, spoken: Message[], chunks: ChunkRow[], signal: AbortSignal): Promise<Map<string, string | null>> {
    const byDay = new Map<string, Message[]>()
    for (const message of spoken) byDay.set(localDay(message.at), [...byDay.get(localDay(message.at)) ?? [], message])
    if (!byDay.size) return new Map()
    const pages = (await this.db.query<{ day: string; summary: string | null }>(`SELECT day::text AS day, summary FROM kipster.diary
      WHERE agent_id=$1 AND organization_id IS NOT DISTINCT FROM $2::uuid AND day = ANY($3::date[])`, [agentId, thread.organizationId, [...byDay.keys()]])).rows
    const owed = new Set(pages.filter(page => page.summary === null).map(page => page.day))
    const summaries = new Map(pages.filter(page => page.summary !== null).map(page => [page.day, page.summary!]))
    // A long thread goes in windows; each window builds on the summaries so far.
    for (const window of windows(spoken.filter(message => !owed.has(localDay(message.at))), message => wordCount(promptText(message.text)))) {
      const grouped = new Map<string, Message[]>()
      for (const message of window) grouped.set(localDay(message.at), [...grouped.get(localDay(message.at)) ?? [], message])
      const days = [...grouped.entries()].map(([day, messages]) => ({ day, label: dayLabel(messages[0]!.at), summary: summaries.get(day) ?? null, messages: promptMessages(messages, () => false) }))
      const answer = parseDiary(await this.ask(agentId, thread.id, 'diary', diaryPrompt(kip, days), signal), days.map(day => day.day))
      for (const day of days) {
        summaries.set(day.day, answer.get(day.day) ?? summaries.get(day.day) ?? `${kip}: ${chunks.find(chunk => localDay(chunk.startedAt) === day.day)?.title ?? derivedTitle(grouped.get(day.day)!)}`)
      }
    }
    return new Map([...byDay.keys()].map(day => [day, owed.has(day) ? null : summaries.get(day)!]))
  }

  /** The agent's diary pages owing a rebuild. */
  private async owedPages(agentId: string): Promise<OwedPage[]> {
    return (await this.db.query<{ day: string; organization_id: string | null; thread_ids: string[] }>(`SELECT day::text AS day, organization_id, thread_ids FROM kipster.diary
      WHERE agent_id=$1 AND installation_id=$2 AND summary IS NULL ORDER BY day, organization_id NULLS FIRST`, [agentId, this.installationId])).rows
      .map(row => ({ day: row.day, organizationId: row.organization_id, threadIds: row.thread_ids }))
  }

  /**
   * Writes an owed diary page again from scratch, never from its old summary: from the processed messages of that day
   * of its remaining threads, in the page's own context, thread by thread and window by window with the diary prompt.
   * A page with nothing left is deleted. Saved only while this incarnation runs the agent, the agent has memory and the
   * page is unchanged; a page changed meanwhile stays owed for a later run.
   */
  private async rebuild(agentId: string, page: OwedPage, signal: AbortSignal): Promise<'saved' | 'stopped' | 'gone'> {
    const [year, month, date] = page.day.split('-').map(Number) as [number, number, number]
    const kip = (await this.db.query<{ display_name: string }>('SELECT display_name FROM kipster.agents WHERE id=$1', [agentId])).rows[0]?.display_name
    if (!kip) return 'gone'
    const rows = (await this.db.query<MessageRow & { thread_id: string }>(`SELECT m.thread_id, ${messageColumns}
       FROM kipster.messages m JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
         JOIN kipster.memory_thread_state s ON s.thread_id=m.thread_id ${messageAuthors}
       WHERE m.thread_id = ANY($1::uuid[]) AND c.agent_id=$2 AND c.installation_id=$3 AND NOT t.internal
         AND CASE WHEN c.context_kind='organization' THEN c.context_id IS NOT DISTINCT FROM $4::uuid ELSE $4::uuid IS NULL END
         AND m.final AND NOT m.progress AND m.position <= s.processed_position AND m.created_at >= $5 AND m.created_at < $6
       ORDER BY array_position($1::uuid[], m.thread_id), m.position`,
    [page.threadIds, agentId, this.installationId, page.organizationId, new Date(year, month - 1, date), new Date(year, month - 1, date + 1)])).rows
    const byThread = new Map<string, Message[]>()
    for (const row of rows) {
      const item = message(row)
      if (item.text) byThread.set(row.thread_id, [...byThread.get(row.thread_id) ?? [], item])
    }
    let summary: string | null = null
    for (const [threadId, messages] of byThread) {
      for (const window of windows(messages, item => wordCount(promptText(item.text)))) {
        const days = [{ day: page.day, label: dayLabel(window[0]!.at), summary, messages: promptMessages(window, () => false) }]
        const answer = parseDiary(await this.ask(agentId, threadId, 'diary', diaryPrompt(kip, days), signal), [page.day])
        summary = answer.get(page.day) ?? summary ?? `${kip}: ${derivedTitle(window)}`
      }
    }
    return this.db.transaction(async client => {
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR SHARE', [this.installationId])
      const owned = await client.query('SELECT 1 FROM kipster.memory_nights WHERE agent_id=$1 AND owner=$2 FOR UPDATE', [agentId, this.options.incarnation])
      if (!owned.rows.length) throw new NightlyDeferred('Another process runs this agent now')
      if (!(await client.query(`SELECT 1 WHERE ${learningCondition('$1::uuid')}`, [agentId])).rows.length) return 'stopped'
      const where = 'agent_id=$1 AND day=$2::date AND organization_id IS NOT DISTINCT FROM $3::uuid AND summary IS NULL AND thread_ids=$4::uuid[]'
      const values = [agentId, page.day, page.organizationId, page.threadIds]
      const saved = summary === null
        ? await client.query(`DELETE FROM kipster.diary WHERE ${where}`, values)
        : await client.query(`UPDATE kipster.diary SET summary=$5, embedding=NULL, embedding_model=NULL, updated_at=now() WHERE ${where}`, [...values, summary])
      return saved.rowCount ? 'saved' : 'gone'
    })
  }

  private async ask(agentId: string, threadId: string | null, step: MemoryStep, prompt: { instructions: string; outputSchema: Record<string, unknown> }, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    return this.options.model({ agentId, threadId, step, ...prompt, signal })
  }

  /** Saves a thread's results and advances its processed position in one transaction, while this incarnation still runs
   * the agent, the agent has memory, the thread exists and no one processed it meanwhile. */
  private async save(agentId: string, thread: Thread, result: { rewriteFrom: number; upTo: number; chunks: ChunkRow[]; operations: CardOperation[]; days: Map<string, string | null> }): Promise<'saved' | 'cards' | 'gone' | 'stopped'> {
    return this.db.transaction(async client => {
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR SHARE', [this.installationId])
      const owned = await client.query('SELECT 1 FROM kipster.memory_nights WHERE agent_id=$1 AND owner=$2 FOR UPDATE', [agentId, this.options.incarnation])
      if (!owned.rows.length) throw new NightlyDeferred('Another process runs this agent now')
      if (!(await client.query(`SELECT 1 WHERE ${learningCondition('$1::uuid')}`, [agentId])).rows.length) return 'stopped'
      const live = await client.query(`SELECT 1 FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE t.id=$1
        AND (c.context_kind='installation' OR kipster.live_organization(c.context_id)) FOR UPDATE OF t`, [thread.id])
      if (!live.rows.length) return 'gone'
      const processed = Number((await client.query<{ processed_position: string }>('SELECT processed_position FROM kipster.memory_thread_state WHERE thread_id=$1', [thread.id])).rows[0]?.processed_position ?? 0)
      if (processed !== thread.processed) return 'gone'
      await client.query('DELETE FROM kipster.thread_chunks WHERE thread_id=$1 AND from_position >= $2', [thread.id, result.rewriteFrom])
      for (const chunk of result.chunks) {
        await client.query(`INSERT INTO kipster.thread_chunks(id, installation_id, thread_id, agent_id, organization_id, from_position, to_position, started_at, ended_at, title, text)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), this.installationId, thread.id, agentId, thread.organizationId, chunk.from, chunk.to, chunk.startedAt, chunk.endedAt, chunk.title, chunk.text])
      }
      let cards = false
      for (const { change, sources } of result.operations) {
        const input = { type: change.type, subject: change.subject, statement: change.statement, details: change.details, confirmed: change.confirmed }
        if (change.action === 'add') { await this.cards.create({ ...input, organizationId: thread.organizationId }, sources, client); cards = true }
        else if (change.action === 'update') cards = await this.cards.update(change.card!, input, sources, client) || cards
        else cards = await this.cards.replace(change.card!, input, sources, client) !== null || cards
      }
      // The page of the thread's own context. A page owing a rebuild stays owed and gains the thread, which the rebuild covers.
      for (const [day, summary] of result.days) {
        await client.query(`INSERT INTO kipster.diary(agent_id, day, organization_id, installation_id, summary, thread_ids) VALUES ($1,$2::date,$6,$3,$4,ARRAY[$5::uuid])
          ON CONFLICT ON CONSTRAINT diary_page DO UPDATE SET summary=CASE WHEN kipster.diary.summary IS NULL THEN NULL ELSE EXCLUDED.summary END,
            thread_ids=CASE WHEN $5::uuid = ANY(kipster.diary.thread_ids) THEN kipster.diary.thread_ids ELSE kipster.diary.thread_ids || $5::uuid END,
            embedding=NULL, embedding_model=NULL, updated_at=now()`, [agentId, day, this.installationId, summary, thread.id, thread.organizationId])
      }
      await client.query(`INSERT INTO kipster.memory_thread_state(thread_id, installation_id, processed_position) VALUES ($1,$2,$3)
        ON CONFLICT (thread_id) DO UPDATE SET processed_position=EXCLUDED.processed_position, updated_at=now()`, [thread.id, this.installationId, result.upTo])
      // The core cards are re-picked after changed cards, by this run or, when it fails, a later one.
      if (cards) await client.query('UPDATE kipster.memory_nights SET repick=true, updated_at=now() WHERE agent_id=$1', [agentId])
      return cards ? 'cards' : 'saved'
    })
  }

  /** Ends core marks on replaced and organization cards, then re-picks the core cards among current installation cards:
   * every one while they fit the core card count, otherwise the model ranks them and Core keeps the count. */
  private async repickCore(agentId: string, changed: boolean, signal: AbortSignal): Promise<void> {
    const { coreCardCount: count } = await memorySettings(this.db, this.installationId)
    const cleared = await this.db.query('UPDATE kipster.cards SET core=false WHERE installation_id=$1 AND core AND (valid_to IS NOT NULL OR organization_id IS NOT NULL)', [this.installationId])
    const state = (await this.db.query<{ core: string; room: boolean }>(`SELECT count(*) FILTER (WHERE core) AS core,
        bool_or(NOT core AND valid_to IS NULL AND organization_id IS NULL) AS room FROM kipster.cards WHERE installation_id=$1`, [this.installationId])).rows[0]!
    const core = Number(state.core)
    // Re-pick after card changes, or when the core set no longer fits the count.
    if (!changed && !cleared.rowCount && core <= count && !(core < count && state.room)) return
    const candidates = (await this.db.query<{ id: string; type: string; subject: string; statement: string; details: Record<string, unknown>; confirmed: boolean }>(
      `SELECT id, type, subject, statement, details, confirmed FROM kipster.cards WHERE installation_id=$1 AND valid_to IS NULL AND organization_id IS NULL
       ORDER BY core DESC, confirmed DESC, updated_at DESC, id LIMIT $2`, [this.installationId, NIGHTLY.coreCandidates])).rows
    let chosen: string[]
    if (candidates.length <= count) chosen = candidates.map(card => card.id)
    else {
      const cards: PromptCard[] = candidates.map((card, index) => ({ ref: `k${index + 1}`, type: card.type, subject: card.subject, statement: card.statement, details: card.details, confirmed: card.confirmed, changeable: true }))
      const refs = parseCore(await this.ask(agentId, null, 'core', corePrompt(cards, count), signal), cards, count)
      chosen = refs.map(ref => candidates[Number(ref.slice(1)) - 1]!.id)
    }
    await this.db.transaction(async client => {
      const owned = await client.query('SELECT 1 FROM kipster.memory_nights WHERE agent_id=$1 AND owner=$2 FOR UPDATE', [agentId, this.options.incarnation])
      if (!owned.rows.length) throw new NightlyDeferred('Another process runs this agent now')
      // Cards may change while the model ranks them. A chosen card replaced meanwhile passes its place to its current
      // replacement; ended, deleted and organization cards are never core.
      await client.query('SELECT 1 FROM kipster.cards WHERE installation_id=$1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [this.installationId, chosen])
      const current = (await client.query<{ id: string }>(`WITH RECURSIVE chain(id) AS (SELECT id FROM kipster.cards WHERE installation_id=$1 AND id = ANY($2::uuid[])
          UNION SELECT c.replaced_by FROM chain JOIN kipster.cards c ON c.id=chain.id WHERE c.replaced_by IS NOT NULL)
        SELECT c.id FROM chain JOIN kipster.cards c ON c.id=chain.id WHERE c.installation_id=$1 AND c.valid_to IS NULL AND c.organization_id IS NULL`,
      [this.installationId, chosen])).rows.map(row => row.id)
      await client.query(`UPDATE kipster.cards SET core = (id = ANY($2::uuid[]) AND valid_to IS NULL AND organization_id IS NULL)
        WHERE installation_id=$1 AND (core OR id = ANY($2::uuid[]))`, [this.installationId, current])
    })
  }
}

/** The messages as the model sees them, with refs `m1`, `m2`… in order. */
function promptMessages(messages: readonly Message[], citable: (message: Message) => boolean, fresh: (message: Message) => boolean = () => true): PromptMessage[] {
  return messages.map((message, index) => ({ ref: `m${index + 1}`, author: message.author, name: message.name, time: `${dayLabel(message.at)} ${clock(message.at)}`, text: promptText(message.text), citable: citable(message), fresh: fresh(message) }))
}

/** A title from the first user line of the messages, for a chunk the model did not name. */
function derivedTitle(messages: readonly Message[]): string {
  const first = (messages.find(message => message.author === 'user') ?? messages[0])?.text.split('\n').find(line => line.trim())?.trim() ?? 'Conversation'
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first
}

/** A message's text: its text parts, with voice notes as their transcripts and other files and documents named by kind. */
function render(parts: unknown[], transcripts: Record<string, string>): string {
  return parts.map((part, index) => {
    const row = part && typeof part === 'object' ? part as Record<string, unknown> : {}
    if (row.kind === 'text') return typeof row.text === 'string' ? row.text : ''
    if (row.kind === 'file') return row.purpose === 'voice_note' ? `[voice note]${transcripts[String(index)] ? ` ${transcripts[String(index)]}` : ''}` : '[file]'
    if (row.kind === 'document') return '[document]'
    return ''
  }).filter(Boolean).join('\n').trim()
}



