import { check, incompatible, record } from './response.ts'
import {
  emptyWork,
  type Answer,
  type AvailableAction,
  type QueueEntry,
  type WorkClient,
  type WorkOperation,
  type WorkReceipt,
  type WorkRecords,
  type WorkTarget,
  type Workflow,
} from './work.js'
import type { InboxNotification } from './notifications.js'
import {
  TextHttpError,
  httpError,
  isRefusal,
  parseInteraction,
  type Notice,
  type Scope,
  type Summary,
  type TextDelegation,
  type TextInteraction,
  type TextMessage,
  type TextWork,
} from './text.js'
import { interactionState } from './state.js'

/** The work target of a thread, from its summary. */
export function summaryTarget(scope: Scope, summary: Summary): WorkTarget {
  return {
    installationId: scope.installationId,
    callerId: scope.callerId,
    context:
      summary.contextKind === 'organization'
        ? { kind: 'organization', organizationId: summary.contextId }
        : { kind: 'installation', installationId: summary.contextId },
    chatId: summary.chatId,
    threadId: summary.threadId,
  }
}

const active = new Set(['queued', 'preparing', 'running', 'waiting'])
const inFlight = new Set([
  'preparing',
  'running',
  'waiting',
  'cancellation-requested',
])
const allowed = (action: AvailableAction['action']): AvailableAction => ({
  action,
  allowed: true,
  reason: '',
})
const firstText = (message: TextMessage | undefined) =>
  message?.parts.find((p) => p.kind === 'text')?.text ??
  (message ? 'File attachment' : '')

/**
 * Projects one thread's Core work into the records the shared work panel renders. The current
 * work is the run in flight, else the latest one that started, else the first queued one; other
 * queued runs are the accepted follow-ups. Actions follow Core's own conditions; Core still
 * decides each command.
 */
export function threadWork(input: {
  target: WorkTarget
  agentId: string
  archived?: boolean
  works: TextWork[]
  interactions: TextInteraction[]
  delegations: TextDelegation[]
  messages: Record<string, TextMessage>
  notices: Record<string, Notice>
}): WorkRecords {
  const { target } = input
  const records = emptyWork()
  const runs = [...input.works].sort(
    (a, b) => a.queuePosition - b.queuePosition,
  )
  // A follow-up cancelled while queued never started, so it is not current work.
  const started = runs.filter(
    (w) => w.state !== 'queued' && !(w.state === 'cancelled' && !w.attemptId),
  )
  const current =
    runs.find((w) => inFlight.has(w.state)) ??
    started.at(-1) ??
    runs.find((w) => w.state === 'queued')
  if (current) {
    const actions: AvailableAction[] = []
    if (active.has(current.state)) actions.push(allowed('stop'))
    if (current.state === 'failed' && current.queueHold)
      actions.push(allowed('retry'))
    if (
      current.queueHold &&
      ['completed', 'failed', 'cancelled'].includes(current.state)
    )
      actions.push(allowed('resume'))
    const flow: Workflow = {
      id: current.runId,
      revision: current.revision,
      target,
      runId: current.runId,
      attemptId: current.attemptId ?? '',
      state: current.state,
      held: current.queueHold,
      reason:
        current.state === 'recovery-needed'
          ? (current.failure ?? 'This work needs a check before it continues.')
          : (current.failure ?? ''),
      actions: input.archived ? [] : actions,
    }
    records.workflows.push(flow)
  }
  records.queue = runs
    .filter((w) => w.state === 'queued' && w !== current)
    .map((w): QueueEntry => ({
      id: w.runId,
      revision: w.revision,
      target,
      messageId: w.messageId,
      text: firstText(input.messages[w.messageId]),
      acceptanceOrder: w.queuePosition,
      state: current?.queueHold ? 'held' : 'queued',
      actions: [
        allowed('cancel-queued'),
        {
          action: 'steer',
          allowed: false,
          reason: 'This kip can’t be redirected while it works.',
        },
      ],
    }))
  records.delegations = [...input.delegations]
    .sort((a, b) => a.depth - b.depth || a.ordinal - b.ordinal)
    .map((d) => ({
      id: d.id,
      revision: d.revision,
      target,
      runId: d.parentRunId ?? '',
      attemptId: '',
      fromAgentId: d.senderAgentId,
      toAgentId: d.recipientAgentId,
      childRunId: d.childRunId ?? '',
      request: { originMessageId: '', summary: d.request },
      state: d.state,
      createdAt: '',
    }))
  records.interactions = input.interactions
    .map((x) => {
      const state = interactionState(x, input.notices)
      return {
        id: x.id,
        revision: x.revision,
        target,
        version: x.version,
        kind: x.kind,
        runId: x.runId,
        attemptId: x.attemptId,
        // A delegated child's question names the child agent.
        sourceAgentId: x.sourceAgentId ?? input.agentId,
        delegationId: input.delegations.find((d) => d.childRunId === x.runId)
          ?.id,
        ...(x.proposalId ? { proposalId: x.proposalId } : {}),
        ...(x.proposal ? { proposal: x.proposal } : {}),
        prompt: x.prompt,
        options: x.options,
        freeText: x.freeText,
        state,
        ...(x.response ? { response: x.response } : {}),
        continuation:
          state === 'pending'
            ? ('waiting' as const)
            : state === 'settled'
              ? ('ready' as const)
              : ('cancelled' as const),
        reason: '',
      }
    })
    // Answered cards first, then the ones still waiting, closest to the reply box.
    .sort(
      (a, b) =>
        Number(a.state === 'pending') - Number(b.state === 'pending') ||
        a.id.localeCompare(b.id),
    )
  return records
}

/** Final refusals (4xx with a stable code) end a command; other failures leave it uncertain. */
async function post(
  endpoint: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await httpError(response)
  const value: unknown = await response.json().catch(() => incompatible())
  check(record(value))
  return value
}
const final = (error: unknown): error is TextHttpError =>
  error instanceof TextHttpError &&
  (isRefusal(error.code) ||
    ['invalid', 'forbidden', 'not-found', 'conflict'].includes(error.code))

/**
 * Work controls and answers over Core's routes. Each command carries its operation ID; a receipt
 * lookup sends the same body and returns what Core recorded, or `unknown`.
 */
export function createCoreWorkClient(
  endpoint: string,
  events: {
    interaction: (threadId: string, interaction: TextInteraction) => void
    gone: (threadId: string) => void
  },
): WorkClient {
  const body = (op: WorkOperation) =>
    op.action === 'respond'
      ? {
          version: 1,
          operationId: op.operationId,
          interactionId: op.interactionId,
          threadId: op.target.threadId,
          runId: op.runId,
          attemptId: op.attemptId,
          ...(op.proposalId ? { proposalId: op.proposalId } : {}),
          answer: coreAnswer(op.answer!),
        }
      : {
          version: 1,
          operationId: op.operationId,
          context: op.target.context,
          chatId: op.target.chatId,
          threadId: op.target.threadId,
          // A queued follow-up is its own run, not yet attempted.
          runId: op.queueId ?? op.runId,
          attemptId: op.queueId ? null : op.attemptId || null,
          action: op.action,
        }
  async function send(
    op: WorkOperation,
    receipt: boolean,
    signal: AbortSignal,
  ): Promise<WorkReceipt> {
    const path =
      op.action === 'respond'
        ? '/v1/work/interactions/answer'
        : '/v1/work/controls'
    let value: Record<string, unknown>
    try {
      value = await post(
        endpoint,
        receipt
          ? op.action === 'respond'
            ? '/v1/work/interactions/receipt'
            : `${path}/receipt`
          : path,
        body(op),
        signal,
      )
    } catch (error) {
      if (!final(error)) throw error
      if (error.code === 'gone') events.gone(op.target.threadId)
      return rejected(op, error.message)
    }
    if (value.status === 'unknown')
      return { operationId: op.operationId, status: 'unknown' }
    if (op.action === 'respond') {
      const interaction = parseInteraction(value.interaction)
      check(typeof value.outcome === 'string')
      events.interaction(op.target.threadId, interaction)
      if (value.outcome !== 'accepted' && value.outcome !== 'rejected')
        return { operationId: op.operationId, status: 'unknown' }
      return value.outcome === 'accepted'
        ? accepted(op, 'Answer recorded.', interaction.response)
        : rejected(op, 'This was already answered or is no longer waiting.')
    }
    check(typeof value.outcome === 'string')
    const outcome = value.outcome
    const reason = typeof value.reason === 'string' ? value.reason : ''
    if (outcome === 'accepted' || outcome === 'uncertain')
      return accepted(op, reason || 'Done.')
    if (['rejected', 'unsupported', 'failed'].includes(outcome))
      return rejected(op, reason || 'This can’t be done right now.')
    return { operationId: op.operationId, status: 'unknown' }
  }
  return {
    command: (op, signal) => send(op, false, signal),
    receipt: (op, signal) => send(op, true, signal),
  }
}
const accepted = (
  op: WorkOperation,
  message: string,
  response?: TextInteraction['response'],
): WorkReceipt => ({
  operationId: op.operationId,
  status: 'accepted',
  target: op.target,
  message,
  ...(response ? { response } : {}),
})
const rejected = (op: WorkOperation, message: string): WorkReceipt => ({
  operationId: op.operationId,
  status: 'rejected',
  target: op.target,
  message,
})
/** Core takes comments only when given; an empty one is left out. */
function coreAnswer(answer: Answer): Answer {
  if (
    (answer.kind === 'approve' || answer.kind === 'decline') &&
    !answer.comment?.trim()
  )
    return { kind: answer.kind }
  if (answer.kind === 'choice' && !answer.text?.trim())
    return { kind: 'choice', optionId: answer.optionId }
  return answer
}

const chunks = (ids: string[]) =>
  Array.from({ length: Math.ceil(ids.length / 200) }, (_, i) =>
    ids.slice(i * 200, i * 200 + 200),
  )

/**
 * Reads and clears notifications. Core skips IDs it no longer has, so a refusal ends the
 * attempt; other failures throw and the caller sends the same IDs again. Without batch
 * actions, reads go one by one and nothing can be cleared.
 */
export function createNotificationClient(endpoint: string, batch: boolean) {
  const send = async (path: string, body: unknown, signal: AbortSignal) => {
    try {
      return await post(endpoint, path, body, signal)
    } catch (error) {
      if (!final(error)) throw error
    }
  }
  return {
    canClear: batch,
    async read(ids: string[], signal: AbortSignal) {
      if (batch)
        for (const notificationIds of chunks(ids))
          await send(
            '/v1/notifications/read',
            { version: 1, notificationIds },
            signal,
          )
      else
        for (const id of ids)
          await send(
            `/v1/notifications/${encodeURIComponent(id)}/read`,
            { version: 1 },
            signal,
          )
    },
    async clear(ids: string[], signal: AbortSignal) {
      if (!batch) return
      for (const notificationIds of chunks(ids))
        await send(
          '/v1/notifications/clear',
          { version: 1, notificationIds },
          signal,
        )
    },
  }
}
export type NotificationClient = ReturnType<typeof createNotificationClient>

const short = (text: string) =>
  text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text

/** Inbox entries for Core notifications: who did what, its excerpt, and where. */
export function inboxItems(input: {
  scope: Scope
  notices: Notice[]
  summaries: Record<string, Summary>
  interactions: Record<string, Record<string, TextInteraction>>
  firstMessage: (threadId: string) => TextMessage | undefined
  agentName: (agentId: string) => string
  organizationName: (organizationId: string) => string | undefined
}): InboxNotification[] {
  return input.notices.map((n) => {
    const summary = input.summaries[n.threadId]
    const interaction = n.interactionId
      ? input.interactions[n.threadId]?.[n.interactionId]
      : undefined
    const agentId = interaction?.sourceAgentId ?? summary?.agentId ?? ''
    const agent = agentId ? input.agentName(agentId) : 'A kip'
    const text = firstText(input.firstMessage(n.threadId))
    const kind =
      n.kind === 'interaction'
        ? (interaction?.kind ?? 'question')
        : n.kind === 'completed'
          ? 'completion'
          : n.kind === 'failed'
            ? 'failure'
            : n.kind
    const pending = n.interactionState === 'pending'
    const title =
      kind === 'question'
        ? pending
          ? `${agent} needs your answer`
          : `${agent} asked a question`
        : kind === 'approval'
          ? pending
            ? `${agent} needs your approval`
            : `${agent} asked for approval`
          : kind === 'completion'
            ? `${agent} replied`
            : kind === 'failure'
              ? `${agent} couldn’t finish`
              : kind === 'recovery-needed'
                ? `${agent}’s work was interrupted`
                : `${agent} has an update`
    return {
      id: n.id,
      revision: n.revision,
      target: summary
        ? summaryTarget(input.scope, summary)
        : {
            installationId: input.scope.installationId,
            callerId: input.scope.callerId,
            context: {
              kind: 'installation',
              installationId: input.scope.installationId,
            },
            chatId: '',
            threadId: n.threadId,
          },
      agentId,
      agent,
      kind,
      title,
      body: n.preview ?? interaction?.prompt ?? '',
      thread: short(text),
      context:
        summary?.contextKind === 'organization'
          ? (input.organizationName(summary.contextId) ?? 'Organization')
          : 'Kipster',
      pending,
      createdAt: n.createdAt,
      read: n.read,
    }
  })
}
