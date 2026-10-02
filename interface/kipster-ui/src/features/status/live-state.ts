import type { WorkRecords } from '../../data/work.js'

/**
 * What an agent or thread is doing right now, as shown by the status island.
 * Adding a state: a member here, a row in `liveStates`, and a scene in
 * `pixel-scenes.ts`.
 */
export type LiveState =
  | 'ready'
  | 'queued'
  | 'preparing'
  | 'thinking'
  | 'writing'
  | 'delegating'
  | 'question'
  | 'approval'
  | 'held'
  | 'stopping'
  | 'done'
  | 'failed'
  | 'recovery'
  | 'unknown'
  | 'offline'

export type LiveTone =
  'calm' | 'neutral' | 'run' | 'wait' | 'soft' | 'success' | 'danger' | 'muted'

/** Lower priority wins when several threads compete for the agent's island. */
export const liveStates: Record<
  LiveState,
  { label: string; description: string; tone: LiveTone; priority: number }
> = {
  question: {
    label: 'Needs you',
    description: 'Needs your answer',
    tone: 'wait',
    priority: 0,
  },
  approval: {
    label: 'Approve?',
    description: 'Needs your approval',
    tone: 'wait',
    priority: 0,
  },
  failed: {
    label: 'Failed',
    description: 'Failed',
    tone: 'danger',
    priority: 1,
  },
  recovery: {
    label: 'Check',
    description: 'Needs a check',
    tone: 'danger',
    priority: 1,
  },
  writing: {
    label: 'Writing',
    description: 'Writing',
    tone: 'run',
    priority: 2,
  },
  thinking: {
    label: 'Thinking',
    description: 'Thinking',
    tone: 'run',
    priority: 2,
  },
  delegating: {
    label: 'Delegating',
    description: 'Waiting on a delegated kip',
    tone: 'run',
    priority: 2,
  },
  preparing: {
    label: 'Preparing',
    description: 'Preparing',
    tone: 'neutral',
    priority: 3,
  },
  queued: {
    label: 'Queued',
    description: 'Queued',
    tone: 'neutral',
    priority: 3,
  },
  held: {
    label: 'Paused',
    description: 'Follow-ups paused',
    tone: 'soft',
    priority: 4,
  },
  stopping: {
    label: 'Stopping',
    description: 'Stopping',
    tone: 'neutral',
    priority: 4,
  },
  done: { label: 'Done', description: 'Done', tone: 'success', priority: 5 },
  unknown: {
    label: 'Unknown',
    description: 'Status not recognized by this app',
    tone: 'muted',
    priority: 5,
  },
  ready: { label: 'Ready', description: 'Ready', tone: 'calm', priority: 6 },
  offline: {
    label: 'Offline',
    description: 'Offline',
    tone: 'muted',
    priority: 7,
  },
}

export function deriveThreadState(
  work: WorkRecords,
  threadId: string,
  drafting: boolean,
): LiveState {
  const pending = work.interactions.find(
    (i) => i.target.threadId === threadId && i.state === 'pending',
  )
  if (pending?.kind === 'question' || pending?.kind === 'approval')
    return pending.kind
  const queue = work.queue.filter((q) => q.target.threadId === threadId)
  const flow = work.workflows.find((w) => w.target.threadId === threadId)
  const delegating = work.delegations.some(
    (d) =>
      d.target.threadId === threadId &&
      !d.result &&
      (d.state === 'running' || d.state === 'waiting'),
  )
  const queued = queue.some((q) => q.state === 'queued')
  switch (flow?.state) {
    case undefined:
      return queue.some((q) => q.readiness === 'preparing')
        ? 'preparing'
        : queued
          ? 'queued'
          : 'ready'
    case 'running':
      return delegating ? 'delegating' : drafting ? 'writing' : 'thinking'
    case 'waiting':
      return delegating ? 'delegating' : 'question'
    case 'preparing':
      return 'preparing'
    case 'queued':
      return 'queued'
    case 'held':
      return 'held'
    case 'cancellation-requested':
      return 'stopping'
    case 'cancelled':
      return flow.held ? 'held' : queued ? 'queued' : 'ready'
    case 'completed':
      return queued ? 'queued' : 'done'
    case 'failed':
      return 'failed'
    case 'recovery-needed':
      return 'recovery'
    default:
      return 'unknown'
  }
}

export const isRunning = (state: LiveState) => liveStates[state].tone === 'run'

/**
 * The most important state, and whether several threads are running at once.
 * `attention` is a question or approval known from notifications before its
 * thread's work records have loaded.
 */
export function summarize(states: LiveState[], attention?: LiveState) {
  const sorted = [...states].sort(
    (a, b) => liveStates[a].priority - liveStates[b].priority,
  )
  const top = sorted[0] ?? 'ready'
  const state =
    attention && liveStates[attention].priority < liveStates[top].priority
      ? attention
      : top
  return {
    state,
    several: isRunning(state) && states.filter(isRunning).length > 1,
  }
}
