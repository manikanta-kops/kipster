import type { TextWork } from '../../data/text.js'
import type {
  Delegation,
  Interaction,
  WorkRecords,
  WorkState,
  Workflow,
} from '../../data/work.js'

/** One run of a kip's work, as told inside its reply. */
export interface RunWork {
  runId: string
  state: WorkState
  held: boolean
  failure: string
  /** Controls exist only for the thread's current work. */
  current?: Workflow
  interactions: Interaction[]
  delegations: Delegation[]
}

/**
 * Groups a thread's questions, approvals and delegations by the run that
 * produced them, keyed by the message that started the run. A delegated
 * kip's question belongs to the run that asked that kip. Anything whose run
 * is not loaded stays with the current run, so nothing waiting on you is
 * hidden. Runs that finished without steps get no block.
 */
export function runsByOrigin(
  works: TextWork[],
  records: WorkRecords,
  noted: ReadonlySet<string> = new Set(),
): Map<string, RunWork> {
  const current = records.workflows[0]
  const started = works.filter(
    (w) => w.state !== 'queued' && !(w.state === 'cancelled' && !w.attemptId),
  )
  const known = new Set(started.map((w) => w.runId))
  const home = (runId: string) =>
    known.has(runId) ? runId : (current?.runId ?? runId)
  const delegationRun = new Map(records.delegations.map((d) => [d.id, d.runId]))
  const blocks = new Map<string, RunWork>()
  for (const w of started) {
    const flow = current?.runId === w.runId ? current : undefined
    const interactions = records.interactions.filter(
      (i) =>
        home(
          (i.delegationId && delegationRun.get(i.delegationId)) || i.runId,
        ) === w.runId,
    )
    const delegations = records.delegations.filter(
      (d) => home(d.runId) === w.runId,
    )
    const steps =
      interactions.length + delegations.length + (noted.has(w.runId) ? 1 : 0)
    const state = flow?.state ?? w.state
    const held = flow?.held ?? w.queueHold
    if (!steps && (!flow || (state === 'completed' && !held))) continue
    blocks.set(w.messageId, {
      runId: w.runId,
      state,
      held,
      failure: flow?.reason || w.failure || '',
      current: flow,
      interactions,
      delegations,
    })
  }
  return blocks
}
