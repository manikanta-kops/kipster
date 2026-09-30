/** Pure execution rules. Storage must commit these decisions atomically with their intents. */
export type RunState =
  | 'queued' | 'preparing' | 'running' | 'waiting'
  | 'completed' | 'failed' | 'cancelled' | 'recovery-needed'
export type AttemptState =
  | 'preparing' | 'issued' | 'running'
  | 'cancellation-requested' | 'ended' | 'uncertain'
export type QueueState = 'preparing' | 'queued' | 'held' | 'consumed' | 'cancelled'
export type PermitState = 'none' | 'owned'
export interface WorkState {
  readonly runId: string
  readonly run: RunState
  readonly attemptId: string | null
  readonly usedAttemptIds: readonly string[]
  readonly attempt: AttemptState | null
  readonly permit: PermitState
  readonly retrySafety: 'safe' | 'unresolved'
  readonly pending: 'none' | 'question' | 'child'
  readonly continuationDue: boolean
  readonly queueHold: boolean
  readonly stopRequested: boolean
  readonly queueGeneration: number
  readonly retryContinue: {
    readonly attemptId: string
    readonly currentAttemptId: string
    readonly queueGeneration: number
  } | null
  readonly output: readonly {
    readonly messageId: string
    readonly text: string
    readonly final: boolean
  }[]
}
export type Transition =
  | { kind: 'admit'; attemptId: string }
  | { kind: 'prepared'; attemptId: string }
  | { kind: 'dispatch-issued'; attemptId: string }
  | { kind: 'started'; attemptId: string }
  | { kind: 'text'; attemptId: string; messageId: string; text: string; final: boolean }
  | { kind: 'await'; attemptId: string; pending: 'question' | 'child' }
  | { kind: 'provider-ended'; attemptId: string; confirmed: boolean }
  | {
      kind: 'failed'
      attemptId: string
      phase: 'preparation' | 'issued'
      confirmedEnded: boolean
      effectsResolved: boolean
    }
  | { kind: 'cancel-requested'; attemptId: string }
  | { kind: 'cancel-confirmed'; attemptId: string }
  | { kind: 'reconciled-safe'; attemptId: string }
  | { kind: 'retry'; attemptId: string; continueAfterSuccess: boolean }
  | { kind: 'stop' }
  | { kind: 'resume' }
  | { kind: 'continuation-ready'; attemptId: string }

const deny = (reason: string): never => { throw new Error(reason) }
const activeAttempt = (state: AttemptState | null): boolean =>
  state === 'issued' || state === 'running' || state === 'cancellation-requested'

export function initialWork(runId: string): WorkState {
  return {
    runId,
    run: 'queued',
    attemptId: null,
    usedAttemptIds: [],
    attempt: null,
    permit: 'none',
    retrySafety: 'safe',
    pending: 'none',
    continuationDue: false,
    queueHold: false,
    stopRequested: false,
    queueGeneration: 0,
    retryContinue: null,
    output: [],
  }
}
/** Throws on invalid or stale transitions. Rejected provider events have no state effect. */
export function transition(s: WorkState, event: Transition): WorkState {
  if (
    'attemptId' in event &&
    event.kind !== 'admit' &&
    event.kind !== 'retry' &&
    event.attemptId !== s.attemptId
  ) deny('obsolete attempt')
  switch (event.kind) {
    case 'admit': {
      const authorizedContinuation =
        s.continuationDue && s.retryContinue?.queueGeneration === s.queueGeneration
      if (
        s.run !== 'queued' || s.attemptId !== null || s.permit !== 'none' ||
        s.stopRequested || (s.queueHold && !authorizedContinuation)
      ) deny('run not admissible')
      if (s.usedAttemptIds.includes(event.attemptId)) deny('attempt ID already used')
      return {
        ...s,
        run: 'preparing',
        attemptId: event.attemptId,
        usedAttemptIds: [...s.usedAttemptIds, event.attemptId],
        attempt: 'preparing',
        continuationDue: false,
        retryContinue: s.retryContinue && s.continuationDue
          ? { ...s.retryContinue, currentAttemptId: event.attemptId }
          : s.retryContinue,
      }
    }
    case 'prepared':
      if (s.attempt !== 'preparing') deny('not preparing')
      return s // Prepared has no external effect; issue must be recorded before adapter call.
    case 'dispatch-issued':
      if (s.attempt !== 'preparing' || s.stopRequested) deny('dispatch already issued or stopped')
      return { ...s, attempt: 'issued', permit: 'owned' }
    case 'started':
      if (s.attempt !== 'issued' || s.stopRequested) deny('start without issued intent or stopped')
      return { ...s, run: 'running', attempt: 'running' }
    case 'text': {
      if (s.attempt !== 'running' || s.stopRequested) deny('attempt cannot publish')
      const prior = s.output.find(x => x.messageId === event.messageId)
      if (prior?.final) deny('message already final')
      const replacement = { messageId: event.messageId, text: event.text, final: event.final }
      const output = prior
        ? s.output.map(x => x.messageId === event.messageId ? replacement : x)
        : [...s.output, replacement]
      return { ...s, output }
    }
    case 'await':
      if (s.attempt !== 'running' || s.pending !== 'none' || s.stopRequested) deny('cannot await')
      return { ...s, pending: event.pending, run: 'waiting' }
    case 'provider-ended': {
      if (s.attempt !== 'running' && s.attempt !== 'cancellation-requested') {
        deny('attempt not running')
      }
      if (!event.confirmed) {
        return { ...s, attempt: 'uncertain', run: 'recovery-needed', retrySafety: 'unresolved' }
      }
      const run = s.stopRequested ? 'cancelled' : s.pending === 'none' ? 'completed' : 'waiting'
      return {
        ...s,
        run,
        attempt: 'ended',
        permit: 'none',
        pending: s.stopRequested ? 'none' : s.pending,
      }
    }
    case 'failed': {
      if (event.phase === 'preparation' && s.attempt === 'preparing') {
        return {
          ...s,
          run: s.stopRequested ? 'cancelled' : 'failed',
          attempt: 'ended',
          retrySafety: 'safe',
          pending: 'none',
          continuationDue: false,
          queueHold: true,
          retryContinue: null,
          queueGeneration: s.queueGeneration + 1,
        }
      }
      if (event.phase !== 'issued' || !activeAttempt(s.attempt)) {
        deny('invalid failure phase')
      }
      const settled = event.confirmedEnded && event.effectsResolved
      const run = settled ? s.stopRequested ? 'cancelled' : 'failed' : 'recovery-needed'
      return {
        ...s,
        run,
        attempt: event.confirmedEnded ? 'ended' : 'uncertain',
        permit: event.confirmedEnded ? 'none' : 'owned',
        retrySafety: settled ? 'safe' : 'unresolved',
        pending: settled ? 'none' : s.pending,
        continuationDue: false,
        queueHold: true,
        retryContinue: null,
        queueGeneration: s.queueGeneration + 1,
      }
    }
    case 'cancel-requested':
      if (s.attempt !== 'issued' && s.attempt !== 'running') {
        deny('cannot request cancellation')
      }
      return {
        ...s,
        attempt: 'cancellation-requested',
        stopRequested: true,
        queueHold: true,
        queueGeneration: s.queueGeneration + 1,
        retryContinue: null,
      }
    case 'cancel-confirmed':
      if (s.attempt !== 'cancellation-requested') deny('cancellation not requested')
      return {
        ...s,
        run: 'cancelled',
        attempt: 'ended',
        permit: 'none',
        pending: 'none',
        continuationDue: false,
        stopRequested: true,
      }
    case 'reconciled-safe':
      if (
        (s.attempt !== 'uncertain' && s.attempt !== 'ended') ||
        s.run !== 'recovery-needed'
      ) deny('nothing uncertain to reconcile')
      return {
        ...s,
        run: s.stopRequested ? 'cancelled' : s.run,
        attempt: 'ended',
        permit: 'none',
        retrySafety: 'safe',
        pending: s.stopRequested ? 'none' : s.pending,
        continuationDue: false,
      }
    case 'retry': {
      const settledFailure = s.run === 'failed' || s.run === 'recovery-needed'
      if (
        !settledFailure || !s.queueHold || s.permit !== 'none' || s.retrySafety !== 'safe' ||
        (s.stopRequested && s.queueHold)
      ) deny('reconcile before retry or stopped')
      if (s.usedAttemptIds.includes(event.attemptId)) deny('attempt ID already used')
      const retryContinue = event.continueAfterSuccess
        ? {
            attemptId: event.attemptId,
            currentAttemptId: event.attemptId,
            queueGeneration: s.queueGeneration,
          }
        : null
      return {
        ...s,
        run: 'preparing',
        attempt: 'preparing',
        attemptId: event.attemptId,
        usedAttemptIds: [...s.usedAttemptIds, event.attemptId],
        pending: 'none',
        continuationDue: false,
        stopRequested: false,
        retryContinue,
      }
    }
    case 'stop': {
      const hold = {
        pending: 'none' as const,
        continuationDue: false,
        stopRequested: true,
        queueHold: true,
        queueGeneration: s.queueGeneration + 1,
        retryContinue: null,
      }
      if (s.run === 'preparing' && s.attempt === 'preparing') {
        return { ...s, ...hold, run: 'cancelled', attempt: 'ended' }
      }
      if (s.run === 'queued' || (s.run === 'waiting' && s.attempt === 'ended')) {
        return { ...s, ...hold, run: 'cancelled' }
      }
      const attempt = s.attempt === 'issued' || s.attempt === 'running'
        ? 'cancellation-requested'
        : s.attempt
      // An unsettled provider still owns its permit and needs reconciliation.
      return { ...s, ...hold, attempt, pending: s.pending }
    }
    case 'resume':
      return { ...s, queueHold: false, queueGeneration: s.queueGeneration + 1, retryContinue: null }
    case 'continuation-ready':
      if (
        s.run !== 'waiting' || s.pending === 'none' ||
        s.attempt !== 'ended' || s.stopRequested
      ) deny('no settled wait')
      return {
        ...s,
        run: 'queued',
        pending: 'none',
        continuationDue: true,
        attemptId: null,
        attempt: null,
      }
  }
}
export function mayAdvanceQueue(s: WorkState): boolean {
  if (s.permit !== 'none' || s.pending !== 'none') return false
  const safeTerminal = s.run === 'completed' || s.run === 'cancelled' ||
    (s.run === 'failed' && s.retrySafety === 'safe')
  if (safeTerminal && !s.queueHold) return true
  const authorizedRetry = s.retryContinue?.currentAttemptId === s.attemptId &&
    s.retryContinue.queueGeneration === s.queueGeneration
  return s.run === 'completed' && authorizedRetry
}
export interface QueueEntry {
  readonly id: string
  readonly state: QueueState
  readonly acceptanceOrder: number
}
export function nextReady(queue: readonly QueueEntry[], work: WorkState): QueueEntry | null {
  if (!mayAdvanceQueue(work)) return null
  const head = [...queue]
    .filter(x => x.state !== 'consumed' && x.state !== 'cancelled')
    .sort((a, b) => a.acceptanceOrder - b.acceptanceOrder)[0]
  return head?.state === 'queued' ? head : null
}
export { acceptIntent, type IntentReceipt } from './receipt.js'
export { claimPreparation, issueAttempt, markUncertain, type Attempt } from './attempt.js'
export { askInteraction, answerInteraction, interactionReceipt, interactionRecord, lockInstallation, type InteractionInput, type InteractionAnswer, type InteractionRecord } from './interactions.js'
export { cancelDelegationTree, childDelegation, delegate, delegationActivity, delegationRecord, delegationStatus, finishDelegation, getAgent, listAgents, reconcileInterruptedDelegations, type DelegationRecord } from './delegation.js'
export { fenceAffectedWork, stopRun, type AffectedWork, type StopTarget } from './fence.js'
