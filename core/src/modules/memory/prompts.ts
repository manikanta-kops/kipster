/**
 * Versioned instruction templates and output JSON schemas of the nightly memory steps, and the parsers that validate
 * every model answer again. Messages and cards are named by short refs (`m1`, `k1`) that Core maps back; a ref outside
 * the input is rejected.
 */

export const MEMORY_TEMPLATE_VERSION = 1
export type MemoryStep = 'chunks' | 'cards' | 'diary' | 'core'

/** A message as the model sees it. `citable` marks the user's own new messages, the only ones a card may cite. */
export interface PromptMessage { ref: string; author: 'user' | 'kip' | 'other'; name: string; time: string; text: string; citable: boolean; fresh: boolean }
export interface PromptCard { ref: string; type: string; subject: string; statement: string; details: Record<string, unknown>; confirmed: boolean; changeable: boolean }

export const LIMITS = {
  title: 200,
  summary: 2000,
  changes: 30,
  detailFields: 20,
  detailText: 500,
} as const

const header = (step: MemoryStep, task: string) => `Kipster memory, nightly step "${step}", template v${MEMORY_TEMPLATE_VERSION}.\n\n${task}\n\nAnswer with one JSON object that matches the output schema. Use only the refs listed below.`
const conversation = (messages: readonly PromptMessage[]) => messages.map(message => {
  const marks = [message.author, ...(message.fresh ? ['new'] : []), ...(message.citable ? ['citable'] : [])].join(', ')
  return `[${message.ref}] ${message.name} (${marks}), ${message.time}:\n${message.text}`
}).join('\n\n')
const only = (values: readonly string[]) => values.length ? { type: 'string', enum: [...values] } : { type: 'string', enum: ['none'] }
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const words = (value: string) => value.split(/\s+/).filter(Boolean).length
const clean = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && !value.includes('\0') ? value.trim().slice(0, max) : undefined

/** Thrown for an answer that is not the requested structure at all. Single items that break the rules are dropped. */
export class MalformedAnswer extends Error {}

// Chunks: the model proposes topic boundaries and titles; Core builds the chunks from the messages in full.

export function chunksPrompt(messages: readonly PromptMessage[]): { instructions: string; outputSchema: Record<string, unknown> } {
  const task = `Split this conversation into topics. For each topic, give the ref of the message where it starts and a short title (a few words, in the conversation's language).
The first topic starts at ${messages[0]?.ref ?? 'm1'}. Start a new topic only where the subject changes; keep a question with its answer. A topic is about ${CHUNK_WORDS} words or fewer when it can be; longer topics are split further at message boundaries.`
  return {
    instructions: `${header('chunks', task)}\n\nConversation:\n\n${conversation(messages)}`,
    outputSchema: object({ topics: { type: 'array', minItems: 1, maxItems: messages.length, items: object({ start: only(messages.map(message => message.ref)), title: { type: 'string' } }) } }),
  }
}

/** Topic starts by message index, ascending; the first starts at index 0. Unknown, repeated or out-of-order refs are dropped. */
export function parseChunks(raw: unknown, messages: readonly PromptMessage[]): { start: number; title: string | null }[] {
  const topics = record(raw)?.topics
  if (!Array.isArray(topics)) throw new MalformedAnswer('Malformed topics')
  const index = new Map(messages.map((message, position) => [message.ref, position]))
  const result: { start: number; title: string | null }[] = []
  for (const item of topics) {
    const row = record(item)
    const start = typeof row?.start === 'string' ? index.get(row.start) : undefined
    if (start === undefined || (result.length && start <= result.at(-1)!.start)) continue
    result.push({ start, title: clean(row?.title, LIMITS.title) ?? null })
  }
  if (!result.length || result[0]!.start !== 0) result.unshift({ start: 0, title: null })
  return result
}

/** Most words in one chunk; Core enforces it by splitting at message boundaries. */
export const CHUNK_WORDS = 600
/** Most words of conversation sent in one model call; longer input goes in windows. */
export const WINDOW_WORDS = 6000
/** Most words of one message shown to the model; the chunk text itself keeps the message in full. */
export const MESSAGE_WORDS = 1500

/** A message's text for a prompt, cut to `MESSAGE_WORDS`. */
export function promptText(text: string): string {
  if (words(text) <= MESSAGE_WORDS) return text
  return `${text.split(/(\s+)/).slice(0, MESSAGE_WORDS * 2).join('')} […]`
}

/** Splits items into consecutive windows of at most `max` words each; an item longer than `max` is a window alone. */
export function windows<T>(items: readonly T[], size: (item: T) => number, max = WINDOW_WORDS): T[][] {
  const result: T[][] = []
  let current: T[] = [], total = 0
  for (const item of items) {
    const count = size(item)
    if (current.length && total + count > max) { result.push(current); current = []; total = 0 }
    current.push(item)
    total += count
  }
  if (current.length) result.push(current)
  return result
}

// Cards: changes to the shared cards, from the user's own new messages, each compared with the nearest existing cards.

export interface CardChange {
  action: 'add' | 'update' | 'replace'
  /** The card an update or replace changes. */
  card: string | null
  type: string; subject: string; statement: string; details: Record<string, string>; confirmed: boolean
  /** Refs of the user messages it comes from. */
  sources: string[]
}

export function cardsPrompt(messages: readonly PromptMessage[], cards: readonly PromptCard[], today: string): { instructions: string; outputSchema: Record<string, unknown> } {
  const changeable = cards.filter(card => card.changeable).map(card => card.ref)
  const citable = messages.filter(message => message.citable).map(message => message.ref)
  const task = `Decide what to remember about the user from the user's new messages, as cards shared by all of the user's kips. Today is ${today}.
A card is one lasting fact about the user or their world: type (fact, preference, person, goal, commitment, event, routine, or another short type), subject (who or what it is about: "user", a person's name, a place or a project), statement (one clear sentence) and details (key/value pairs, such as date "2026-12-01", time "15:00", relation "sister"; dates in ISO form).
Compare each fact with the existing cards below. For each, answer one change:
- add: a new card.
- update: an existing card stays true but changes, for example with more detail. Give its full new content.
- replace: an existing card is no longer true and the new card takes its place, for example a changed preference or a moved date.
- skip: it is already known, or not worth remembering.
Only cards marked "changeable" can be updated or replaced; others are shown for comparison. Every add, update and replace cites the messages it comes from in sources: only messages marked "citable", which the user wrote. Never turn what a kip said, tool output or other people's messages into facts about the user; use them only as context. confirmed is true only when the user said it directly; false when it is inferred. Remember nothing trivial or passing.`
  const cardList = cards.length ? cards.map(card => `[${card.ref}] ${card.type} | ${card.subject} | ${card.statement}${Object.keys(card.details).length ? ` | ${JSON.stringify(card.details)}` : ''}${card.confirmed ? ' (confirmed)' : ' (inferred)'}${card.changeable ? ' (changeable)' : ''}`).join('\n') : '(none)'
  const detail = object({ key: { type: 'string' }, value: { type: 'string' } })
  const target = changeable.length ? { type: ['string', 'null'], enum: [...changeable, null] } : { type: 'null' }
  const change = object({
    action: { type: 'string', enum: ['add', 'update', 'replace', 'skip'] }, card: target,
    type: { type: 'string' }, subject: { type: 'string' }, statement: { type: 'string' },
    details: { type: 'array', maxItems: LIMITS.detailFields, items: detail }, confirmed: { type: 'boolean' },
    sources: { type: 'array', items: only(citable) },
  })
  return {
    instructions: `${header('cards', task)}\n\nExisting cards:\n${cardList}\n\nConversation:\n\n${conversation(messages)}`,
    outputSchema: object({ changes: { type: 'array', maxItems: LIMITS.changes, items: change } }),
  }
}

/** Valid changes, in order. A change citing a message that is not citable (another author's, or unknown), naming a card
 * it may not change, changing a card twice or missing a field is dropped and counted. */
export function parseCards(raw: unknown, messages: readonly PromptMessage[], cards: readonly PromptCard[]): { changes: CardChange[]; rejected: number } {
  const items = record(raw)?.changes
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed card changes')
  const citable = new Set(messages.filter(message => message.citable).map(message => message.ref))
  const changeable = new Set(cards.filter(card => card.changeable).map(card => card.ref))
  const changed = new Set<string>()
  const changes: CardChange[] = []
  let rejected = 0
  for (const item of items.slice(0, LIMITS.changes)) {
    const row = record(item)
    if (row?.action === 'skip') continue
    const action = row?.action === 'add' || row?.action === 'update' || row?.action === 'replace' ? row.action : undefined
    const sources = Array.isArray(row?.sources) ? [...new Set(row.sources)] : []
    const type = clean(row?.type, 40), subject = clean(row?.subject, 200), statement = clean(row?.statement, 2000)
    const card = action === 'add' ? null : typeof row?.card === 'string' ? row.card : undefined
    const details = detailsOf(row?.details)
    if (!action || !type || !subject || !statement || !details || typeof row?.confirmed !== 'boolean' || !sources.length || sources.some(ref => typeof ref !== 'string' || !citable.has(ref))
      || (action !== 'add' && (!card || !changeable.has(card) || changed.has(card)))) { rejected++; continue }
    if (card) changed.add(card)
    changes.push({ action, card: card ?? null, type, subject, statement, details, confirmed: row.confirmed, sources: sources as string[] })
  }
  return { changes, rejected }
}

function detailsOf(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length > LIMITS.detailFields) return undefined
  const result: Record<string, string> = {}
  for (const item of value) {
    const row = record(item), key = clean(row?.key, 60), text = clean(row?.value, LIMITS.detailText)
    if (!key || !text) return undefined
    result[key] = text
  }
  return result
}

// Diary: one page per kip and day, a short summary of the day's conversations.

export function diaryPrompt(kip: string, days: readonly { day: string; label: string; summary: string | null; messages: readonly PromptMessage[] }[]): { instructions: string; outputSchema: Record<string, unknown> } {
  const task = `Keep the diary of ${kip}, a kip (an AI assistant) of the user: one page per day, a short summary of a few sentences of what the user and ${kip} talked about and decided that day. For each day below, return its full new summary: keep what the current summary says and add what the new messages of this conversation add. Write plainly, in the conversation's language, at most ${LIMITS.summary} characters.`
  const listed = days.map(day => `Day ${day.day} (${day.label})\nCurrent summary: ${day.summary ?? '(none)'}\nNew messages:\n\n${conversation(day.messages)}`).join('\n\n---\n\n')
  return {
    instructions: `${header('diary', task)}\n\n${listed}`,
    outputSchema: object({ days: { type: 'array', maxItems: days.length, items: object({ day: only(days.map(day => day.day)), summary: { type: 'string' } }) } }),
  }
}

/** New summaries by day. Unknown or repeated days and empty summaries are dropped. */
export function parseDiary(raw: unknown, days: readonly string[]): Map<string, string> {
  const items = record(raw)?.days
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed diary')
  const known = new Set(days)
  const result = new Map<string, string>()
  for (const item of items) {
    const row = record(item), day = typeof row?.day === 'string' ? row.day : '', summary = clean(row?.summary, LIMITS.summary)
    if (known.has(day) && summary && !result.has(day)) result.set(day, summary)
  }
  return result
}

// Core cards: the cards every turn loads. The model ranks; Core enforces the count.

export function corePrompt(cards: readonly PromptCard[], count: number): { instructions: string; outputSchema: Record<string, unknown> } {
  const task = `Pick the cards every kip should always have in mind when talking with the user: lasting, broadly useful facts such as who the user is, the people close to them, strong preferences, ongoing goals, commitments and routines. Leave out passing details and past events. Pick at most ${count}, most important first.`
  return {
    instructions: `${header('core', task)}\n\nCards:\n${cards.map(card => `[${card.ref}] ${card.type} | ${card.subject} | ${card.statement}${card.confirmed ? ' (confirmed)' : ''}`).join('\n')}`,
    outputSchema: object({ core: { type: 'array', maxItems: count, items: only(cards.map(card => card.ref)) } }),
  }
}

/** Card refs, unique, in rank order, at most `count`. Unknown refs are dropped. */
export function parseCore(raw: unknown, cards: readonly PromptCard[], count: number): string[] {
  const items = record(raw)?.core
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed core cards')
  const known = new Set(cards.map(card => card.ref))
  return [...new Set(items.filter((ref): ref is string => typeof ref === 'string' && known.has(ref)))].slice(0, count)
}

export { words as wordCount }
