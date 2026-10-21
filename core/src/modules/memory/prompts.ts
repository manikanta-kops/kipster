/**
 * Versioned instruction templates and output JSON schemas of the nightly memory steps, and the parsers that validate
 * every model answer again. Messages, memories and lessons are named by short refs (`m1`, `k1`, `l1`) that Core maps
 * back; a ref outside the input is rejected.
 */

export const MEMORY_TEMPLATE_VERSION = 2
export type MemoryStep = 'chunks' | 'memories' | 'lessons' | 'diary' | 'core'

/** Who wrote a message, as the nightly prompts name it. */
export type Author = 'person' | 'admin kip' | 'kip' | 'other'
/** A message as the model sees it. `citable` marks the new messages a change may cite as its source. */
export interface PromptMessage { ref: string; author: Author; name: string; time: string; text: string; citable: boolean; fresh: boolean }
export interface PromptMemory { ref: string; type: string; subject: string; statement: string; details: Record<string, unknown>; confirmed: boolean; changeable: boolean }
export interface PromptLesson { ref: string; statement: string; confirmations: number; changeable: boolean }
/** A data table a kip keeps, by name and description. */
export interface PromptTable { name: string; description: string | null }
/** The kip whose memory a step builds. */
export interface PromptKip { name: string; admin: boolean }

export const LIMITS = {
  title: 200,
  summary: 2000,
  changes: 30,
  detailFields: 20,
  detailText: 500,
  lesson: 1000,
} as const

const header = (step: MemoryStep, task: string) => `Kipster memory, nightly step "${step}", template v${MEMORY_TEMPLATE_VERSION}.\n\n${task}\n\nAnswer with one JSON object that matches the output schema. Use only the refs listed below.`
const kipName = (kip: PromptKip) => `${kip.name} (${kip.admin ? 'the admin kip' : 'a kip'})`
const authors = 'Each message names its author as Name (person) for the person the kips work for, Name (admin kip) for the admin kip, or Name (kip) for another kip. Write about the person by name or as the person; never assume their pronouns.'
const conversation = (messages: readonly PromptMessage[]) => messages.map(message => {
  const marks = [message.author, ...(message.fresh ? ['new'] : []), ...(message.citable ? ['citable'] : [])].join(', ')
  return `[${message.ref}] ${message.name} (${marks}), ${message.time}:\n${message.text}`
}).join('\n\n')
const only = (values: readonly string[]) => values.length ? { type: 'string', enum: [...values] } : { type: 'string', enum: ['none'] }
/** The existing items a change may name; an empty array when there are none to name. */
const targetList = (values: readonly string[]) => values.length ? { type: 'array', items: only(values) } : { type: 'array', maxItems: 0 }
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const words = (value: string) => value.split(/\s+/).filter(Boolean).length
const clean = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() && !value.includes('\0') ? value.trim().slice(0, max) : undefined
const actions = `For each, answer one action:
- add: something new.
- update: an existing item came up again and still holds. Give its full current content, reworded when the new messages make it clearer or more current.
- merge: one new item takes the place of one or more existing items: they say the same thing, or the new messages change it. Name every item it replaces and give the full new content.
- retire: an existing item no longer holds, and nothing takes its place. Name it.
- skip: it is already known as it is, or not worth keeping.
Keep what you keep valuable and current, not just growing: prefer update and merge over add when an item is already there.`

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

/** One nightly change. `targets` are the existing items an update, merge or retire names: one for update and retire,
 * one or more for merge, none for add. Sources are refs of the messages it comes from. */
export type Action = 'add' | 'update' | 'merge' | 'retire'

// Memories: changes to the memories about the person, from the person's own new messages, each compared with the
// nearest existing memories.

export interface MemoryChange {
  action: Action
  targets: string[]
  type: string; subject: string; statement: string; details: Record<string, string>; confirmed: boolean
  sources: string[]
}

export function memoriesPrompt(messages: readonly PromptMessage[], memories: readonly PromptMemory[], tables: readonly PromptTable[], today: string): { instructions: string; outputSchema: Record<string, unknown> } {
  const changeable = memories.filter(item => item.changeable).map(item => item.ref)
  const citable = messages.filter(message => message.citable).map(message => message.ref)
  const task = `Decide what to remember about the person from the person's new messages, as memories shared by all of their kips. Today is ${today}. ${authors}
A memory is one lasting fact about the person or their world: type (fact, preference, person, goal, commitment, event, routine, or another short type), subject (who or what it is about: "user" for the person, another person's name, a place or a project), statement (one clear sentence) and details (key/value pairs, such as date "2026-12-01", time "15:00", relation "sister"; dates in ISO form).
Compare each fact with the existing memories below. ${actions}
Only memories marked "changeable" can be named. Every change cites the messages it comes from in sources: only messages marked "citable", which the person wrote. Never turn what a kip said, tool output or other people's messages into facts about the person; use them only as context. Never remember what tools, permissions or settings exist or what a kip can do; Kipster knows that live. Leave out how a kip should do its own work, such as which template, steps or format it uses; each kip keeps those as its lessons. confirmed is true only when the person said it directly; false when it is inferred. Remember nothing trivial or passing.${tables.length ? '\nWhen a goal, routine or habit is tracked in one of the data tables below, add its name to details as table.' : ''}`
  const memoryList = memories.length ? memories.map(item => `[${item.ref}] ${item.type} | ${item.subject} | ${item.statement}${Object.keys(item.details).length ? ` | ${JSON.stringify(item.details)}` : ''}${item.confirmed ? ' (confirmed)' : ' (inferred)'}${item.changeable ? ' (changeable)' : ''}`).join('\n') : '(none)'
  const tableList = tables.length ? `\n\nData tables:\n${tables.map(table => `- ${table.name}${table.description ? `: ${table.description}` : ''}`).join('\n')}` : ''
  const detail = object({ key: { type: 'string' }, value: { type: 'string' } })
  const change = object({
    action: { type: 'string', enum: ['add', 'update', 'merge', 'retire', 'skip'] }, memories: targetList(changeable),
    type: { type: 'string' }, subject: { type: 'string' }, statement: { type: 'string' },
    details: { type: 'array', maxItems: LIMITS.detailFields, items: detail }, confirmed: { type: 'boolean' },
    sources: { type: 'array', items: only(citable) },
  })
  return {
    instructions: `${header('memories', task)}\n\nExisting memories:\n${memoryList}${tableList}\n\nConversation:\n\n${conversation(messages)}`,
    outputSchema: object({ changes: { type: 'array', maxItems: LIMITS.changes, items: change } }),
  }
}

/** Checks a change's action, targets and sources. Each existing item may be named by one change only. */
function checked(row: Record<string, unknown> | undefined, field: string, citable: ReadonlySet<string>, changeable: ReadonlySet<string>, named: Set<string>): { action: Action; targets: string[]; sources: string[] } | undefined {
  const action = row?.action === 'add' || row?.action === 'update' || row?.action === 'merge' || row?.action === 'retire' ? row.action : undefined
  // An add names nothing, whatever placeholder the model filled in.
  const targets = action === 'add' || !Array.isArray(row?.[field]) ? [] : [...new Set(row[field] as unknown[])]
  const sources = Array.isArray(row?.sources) ? [...new Set(row.sources)] : []
  if (!action || !sources.length || sources.some(ref => typeof ref !== 'string' || !citable.has(ref))) return undefined
  if (targets.some(ref => typeof ref !== 'string' || !changeable.has(ref) || named.has(ref))) return undefined
  const count = targets.length
  if (action === 'add' ? count !== 0 : action === 'merge' ? count < 1 : count !== 1) return undefined
  for (const ref of targets as string[]) named.add(ref)
  return { action, targets: targets as string[], sources: sources as string[] }
}

/** Valid memory changes, in order. A change citing a message that is not citable, naming a memory it may not change or
 * one already named, with the wrong number of targets or missing a field is dropped and counted. */
export function parseMemories(raw: unknown, messages: readonly PromptMessage[], memories: readonly PromptMemory[]): { changes: MemoryChange[]; rejected: number } {
  const items = record(raw)?.changes
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed memory changes')
  const citable = new Set(messages.filter(message => message.citable).map(message => message.ref))
  const changeable = new Set(memories.filter(item => item.changeable).map(item => item.ref))
  const named = new Set<string>()
  const changes: MemoryChange[] = []
  let rejected = 0
  for (const item of items.slice(0, LIMITS.changes)) {
    const row = record(item)
    if (row?.action === 'skip') continue
    const type = clean(row?.type, 40), subject = clean(row?.subject, 200), statement = clean(row?.statement, 2000)
    const details = detailsOf(row?.details)
    if (!type || !subject || !statement || !details || typeof row?.confirmed !== 'boolean') { rejected++; continue }
    const valid = checked(row, 'memories', citable, changeable, named)
    if (!valid) { rejected++; continue }
    changes.push({ ...valid, type, subject, statement, details, confirmed: row.confirmed })
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

// Lessons: how one kip should do its work, from the person's and other kips' new messages in its own threads, each
// compared with the nearest lessons of the kip and its top lessons.

export interface LessonChange { action: Action; targets: string[]; statement: string; sources: string[] }

export function lessonsPrompt(kip: PromptKip, workspace: string | null, messages: readonly PromptMessage[], lessons: readonly PromptLesson[], today: string): { instructions: string; outputSchema: Record<string, unknown> } {
  const changeable = lessons.filter(item => item.changeable).map(item => item.ref)
  const citable = messages.filter(message => message.citable).map(message => message.ref)
  const task = `You keep the lessons of ${kipName(kip)}: what ${kip.name} should remember about doing its work for the person, in every workspace. Today is ${today}. This conversation is ${kip.name}'s${workspace ? `, in the workspace ${workspace}` : ''}. ${authors}
A lesson is one plain sentence ${kip.name} can act on, such as a step that worked, a convention to follow, where something lives, how the person wants a kind of work done, or a mistake to avoid after a correction. Say in the sentence when it applies, for example "For expense reports, ..."${workspace ? `, and name ${workspace} when it applies only there` : ''}.
Learn from what the person and other kips said, above all corrections, confirmations and failed requests: when the person corrects how ${kip.name} did something, or says always, never or from now on about its work, that is a lesson even when ${kip.name} fixed it at once. ${kip.name}'s own messages are context only.
How another kip wants to be asked, such as what to send it with a request, is a lesson. Never make a lesson of: what tools, plugins, permissions or settings exist, or whether ${kip.name} or another kip has a tool or access (Kipster tells every kip that live, and it changes); anything true for every kip, such as the person's preferences or facts about them (those are memories, kept separately); the details of one task that will not come up again.
Compare each lesson with the existing ones below, the most confirmed first. ${actions}
Only lessons marked "changeable" can be named. Every change cites the messages it comes from in sources: only messages marked "citable". Retire a lesson the new messages show is wrong or out of date.`
  const lessonList = lessons.length ? lessons.map(item => `[${item.ref}] ${item.statement} (confirmed ${item.confirmations}x)${item.changeable ? ' (changeable)' : ''}`).join('\n') : '(none)'
  const change = object({
    action: { type: 'string', enum: ['add', 'update', 'merge', 'retire', 'skip'] }, lessons: targetList(changeable),
    statement: { type: 'string' }, sources: { type: 'array', items: only(citable) },
  })
  return {
    instructions: `${header('lessons', task)}\n\nExisting lessons:\n${lessonList}\n\nConversation:\n\n${conversation(messages)}`,
    outputSchema: object({ changes: { type: 'array', maxItems: LIMITS.changes, items: change } }),
  }
}

/** Valid lesson changes, in order, checked as memory changes are. A retire needs no new statement. */
export function parseLessons(raw: unknown, messages: readonly PromptMessage[], lessons: readonly PromptLesson[]): { changes: LessonChange[]; rejected: number } {
  const items = record(raw)?.changes
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed lesson changes')
  const citable = new Set(messages.filter(message => message.citable).map(message => message.ref))
  const changeable = new Set(lessons.filter(item => item.changeable).map(item => item.ref))
  const named = new Set<string>()
  const changes: LessonChange[] = []
  let rejected = 0
  for (const item of items.slice(0, LIMITS.changes)) {
    const row = record(item)
    if (row?.action === 'skip') continue
    const statement = clean(row?.statement, LIMITS.lesson)
    if (!statement && row?.action !== 'retire') { rejected++; continue }
    const valid = checked(row, 'lessons', citable, changeable, named)
    if (!valid) { rejected++; continue }
    changes.push({ ...valid, statement: statement ?? '' })
  }
  return { changes, rejected }
}

// Diary: one page per kip and day, a short summary of the day's conversations.

export function diaryPrompt(kip: PromptKip, days: readonly { day: string; label: string; summary: string | null; messages: readonly PromptMessage[] }[]): { instructions: string; outputSchema: Record<string, unknown> } {
  const task = `Keep the diary of ${kipName(kip)}: one page per day, a short summary of a few sentences of what ${kip.name} discussed and decided that day in its own conversations, and with whom: the person, or other kips. ${authors} For each day below, return its full new summary: keep what the current summary says and add what the new messages of this conversation add. Write plainly, in the conversation's language, at most ${LIMITS.summary} characters.`
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

// Core memories: the memories every turn loads. The model ranks; Core enforces the count.

export function corePrompt(memories: readonly PromptMemory[], count: number): { instructions: string; outputSchema: Record<string, unknown> } {
  const task = `Pick the memories every kip should always have in mind when talking with the person: lasting, broadly useful facts such as who the person is, the people close to them, strong preferences, ongoing goals, commitments and routines. Leave out passing details and past events. Pick at most ${count}, most important first.`
  return {
    instructions: `${header('core', task)}\n\nMemories:\n${memories.map(item => `[${item.ref}] ${item.type} | ${item.subject} | ${item.statement}${item.confirmed ? ' (confirmed)' : ''}`).join('\n')}`,
    outputSchema: object({ core: { type: 'array', maxItems: count, items: only(memories.map(item => item.ref)) } }),
  }
}

/** Memory refs, unique, in rank order, at most `count`. Unknown refs are dropped. */
export function parseCore(raw: unknown, memories: readonly PromptMemory[], count: number): string[] {
  const items = record(raw)?.core
  if (!Array.isArray(items)) throw new MalformedAnswer('Malformed core memories')
  const known = new Set(memories.map(item => item.ref))
  return [...new Set(items.filter((ref): ref is string => typeof ref === 'string' && known.has(ref)))].slice(0, count)
}

export { words as wordCount }
