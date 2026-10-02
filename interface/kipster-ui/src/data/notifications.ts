import type { WorkTarget } from './work.js'

/** A Core notification as the inbox, banners and the system show it. */
export interface InboxNotification {
  id: string
  revision: number
  target: WorkTarget
  /** The kip it is about: the asker of a question, else the thread's kip. */
  agentId: string
  agent: string
  kind: string
  title: string
  body: string
  /** The thread's name, from its first message, when known. */
  thread: string
  context: string
  /** A question or approval still waiting for an answer. */
  pending: boolean
  createdAt: string
  read: boolean
}

export const isAsk = (n: InboxNotification) =>
  n.kind === 'question' || n.kind === 'approval'
export const isFailure = (n: InboxNotification) =>
  n.kind === 'failure' || n.kind === 'recovery-needed'

/** Waiting on the person: an unanswered question or approval, or unread failed work. */
export const needsYou = (n: InboxNotification) =>
  n.pending || (isFailure(n) && !n.read)

export type Tone = 'needs' | 'failed' | 'done'
export const tone = (n: InboxNotification): Tone =>
  isAsk(n) ? 'needs' : isFailure(n) ? 'failed' : 'done'

/** Which delivery switch covers a notification. */
export const deliveryKind = (n: InboxNotification) =>
  isAsk(n) ? 'needs' : isFailure(n) ? 'failures' : 'replies'

/** A short, relative time for a list. */
export function when(iso: string, now = Date.now()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const seconds = (now - date.getTime()) / 1000
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  const day = (offset: number) =>
    new Date(now - offset * 86400000).toDateString() === date.toDateString()
  if (day(0))
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    })
  if (day(1)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const newest = (a: InboxNotification, b: InboxNotification) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)

/** Needs-you items one by one; everything else as one row per thread, led by its latest. */
export function inboxSections(items: InboxNotification[]) {
  const sorted = [...items].sort(newest)
  const updates = new Map<string, { item: InboxNotification; ids: string[] }>()
  for (const item of sorted.filter((n) => !needsYou(n))) {
    const group = updates.get(item.target.threadId)
    if (group) group.ids.push(item.id)
    else updates.set(item.target.threadId, { item, ids: [item.id] })
  }
  return {
    needs: sorted.filter(needsYou),
    updates: [...updates.values()],
  }
}

/** Each chat's sidebar mark, by summary key; needs outranks failed, working and unread. */
export type Mark = 'needs' | 'failed' | 'working' | 'unread'
export const markLabel: Record<Mark, string> = {
  needs: 'needs you',
  failed: 'couldn’t finish',
  working: 'working',
  unread: 'unread reply',
}
const rank: Record<Mark, number> = {
  needs: 4,
  failed: 3,
  working: 2,
  unread: 1,
}
export function chatMarks(
  items: InboxNotification[],
  working: string[],
  chatOf: (threadId: string) => string | undefined,
): Record<string, Mark> {
  const marks: Record<string, Mark> = {}
  const raise = (threadId: string, mark: Mark) => {
    const key = chatOf(threadId)
    if (key && (!marks[key] || rank[mark] > rank[marks[key]])) marks[key] = mark
  }
  for (const id of working) raise(id, 'working')
  for (const n of items)
    if (n.pending) raise(n.target.threadId, 'needs')
    else if (!n.read)
      raise(n.target.threadId, isFailure(n) ? 'failed' : 'unread')
  return marks
}
