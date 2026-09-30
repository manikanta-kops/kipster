import type { Notice, Summary, TextInteraction, TextMessage } from './text.js'

export function threadTitle(first: TextMessage | undefined): string {
  if (!first) return 'Loading thread'
  const text = first.parts.find((part) => part.kind === 'text')
  return text?.kind === 'text' && text.text.trim()
    ? text.text.slice(0, 55)
    : 'File attachment'
}

export function upsertRevision<T extends { revision: number }>(
  items: Record<string, T>,
  id: string,
  incoming: T,
): Record<string, T> {
  const previous = items[id]
  return previous && previous.revision >= incoming.revision
    ? items
    : { ...items, [id]: incoming }
}

export function mergeRevisions<T extends { revision: number }>(
  old: Record<string, T>,
  incoming: T[],
  id: (value: T) => string,
): Record<string, T> {
  return incoming.reduce(
    (items, value) => upsertRevision(items, id(value), value),
    old,
  )
}

export function mergeAppSummaries(
  old: Record<string, Summary>,
  snapshot: Summary[],
): Record<string, Summary> {
  const next: Record<string, Summary> = {}
  for (const row of snapshot)
    next[row.threadId] =
      old[row.threadId] && old[row.threadId].revision > row.revision
        ? old[row.threadId]
        : row
  return next
}

/**
 * Merges one notification. The newer revision wins; an older one never replaces it. Read is
 * kept once known, because Core never marks a notification unread again.
 */
export function mergeNotice(
  held: Notice | undefined,
  incoming: Notice,
): Notice {
  const newer = !held || incoming.revision >= held.revision ? incoming : held
  return held?.read && !newer.read ? { ...newer, read: true } : newer
}

/** A snapshot lists every present notification; anything it omits is gone. */
export function mergeAppNotices(
  old: Record<string, Notice>,
  snapshot: Notice[],
): Record<string, Notice> {
  return Object.fromEntries(
    snapshot.map((note) => [note.id, mergeNotice(old[note.id], note)]),
  )
}

/** Needs attention: unread, or a question or approval still waiting for an answer. */
export const outstanding = (note: Notice) =>
  !note.read || note.interactionState === 'pending'

/** Questions and approvals still waiting for an answer. */
export const waitingNotices = (notices: Record<string, Notice>) =>
  Object.values(notices).filter((n) => n.interactionState === 'pending')

/**
 * The application and thread streams both report an interaction's state, each with its own
 * revisions. An interaction only leaves `pending`, so a settled state from either stream wins.
 */
export function interactionState(
  interaction: TextInteraction,
  notices: Record<string, Notice>,
): TextInteraction['state'] {
  if (interaction.state !== 'pending') return interaction.state
  const note = Object.values(notices).find(
    (n) => n.interactionId === interaction.id,
  )
  return note?.interactionState ?? interaction.state
}
