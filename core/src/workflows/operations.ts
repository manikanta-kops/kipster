import type { Runtime } from '../runtime.js'
import type { SqlClient } from '../platform/postgres/public.js'
import { lockOperation, openOperations, recordStep, recordStepError, type Operation, type StepOutcome } from '../modules/administration/public.js'

export type { StepOutcome } from '../modules/administration/public.js'

/**
 * One step of an administration operation. `run` does one bounded batch in the given transaction,
 * which also holds the operation row and records the outcome, so a batch commits exactly once with
 * its progress. Steps must be safe to repeat: work outside the database, such as moving files, has to
 * tolerate having been done already. A step that depends on a provider that could still write waits
 * for it; it never forces.
 */
export interface OperationStep {
  readonly name: string
  run(client: SqlClient, operation: Operation): Promise<StepOutcome>
}

/** Seconds before a waiting operation is looked at again, and before a failed batch is retried. */
export const OPERATION_DELAYS = { waitSeconds: 5, retrySeconds: 30 } as const

/**
 * Runs administration operations from the `administration` queue while its owner coordinates. A service
 * records an operation with `claimOperation` and sends its ID to the queue in the same transaction; an
 * operation has at most one waiting wake-up. On start, every operation of a registered kind that has not
 * finished is queued again, so a restart continues where it stopped. `afterCommit` runs after every
 * committed batch, for example to deliver the adapter cancellations a step requested.
 */
export class OperationEngine {
  private readonly kinds = new Map<string, readonly OperationStep[]>()
  private working = false
  constructor(private readonly runtime: Runtime, private readonly hooks: { afterOperationStep?(operationId: string, step: string, outcome: StepOutcome): Promise<void> } = {}, private readonly afterCommit: () => Promise<void> = async () => undefined) {}

  register(kind: string, steps: readonly OperationStep[]): void {
    if (!steps.length || new Set(steps.map(step => step.name)).size !== steps.length) throw new Error('An operation needs distinct steps')
    this.kinds.set(kind, steps)
  }

  async start(): Promise<void> {
    if (!this.working) {
      this.working = true
      await this.runtime.jobs.work(id => this.process(id), 4, 'administration').catch(error => { this.working = false; throw error })
    }
    await this.runtime.db.transaction(async client => {
      for (const id of await openOperations(client, this.runtime.bootstrap.installationId, [...this.kinds.keys()])) await this.runtime.jobs.send(client, id, 0, 'administration')
    })
  }

  async stop(): Promise<void> {
    if (!this.working) return
    this.working = false
    await this.runtime.jobs.stopWork('administration')
  }

  /** Runs the operation's steps until it finishes, waits or fails, or until this engine stops. A batch that throws
   * is retried later; if even recording that fails, the job fails and the queue retries it. */
  async process(operationId: string): Promise<void> {
    while (this.working) {
      let ran: { step: string; outcome: StepOutcome; last: boolean } | null
      try {
        ran = await this.runtime.db.transaction(async client => {
          const operation = await lockOperation(client, operationId)
          const steps = this.kinds.get(operation.kind)
          if (!steps || !['pending', 'running', 'waiting'].includes(operation.state)) return null
          const index = operation.step === null ? 0 : steps.findIndex(step => step.name === operation.step)
          if (index < 0) {
            await recordStep(client, operationId, operation.step!, null, { status: 'failed', error: `Unknown step ${operation.step}` })
            return null
          }
          const step = steps[index]!
          const outcome = await step.run(client, operation)
          const next = steps[index + 1]?.name ?? null
          await recordStep(client, operationId, step.name, next, outcome)
          // The follow-up wake-up commits with the batch, so it cannot be lost.
          if (outcome.status === 'wait') await this.runtime.jobs.send(client, operationId, OPERATION_DELAYS.waitSeconds, 'administration')
          return { step: step.name, outcome, last: next === null }
        })
      } catch (error) {
        if ((error as Error).message === 'Operation not found') return
        await this.runtime.db.transaction(async client => {
          await recordStepError(client, operationId, error instanceof Error ? error.message : 'Operation step failed')
          await this.runtime.jobs.send(client, operationId, OPERATION_DELAYS.retrySeconds, 'administration')
        })
        return
      }
      if (!ran) return
      await this.afterCommit().catch(() => undefined)
      await this.hooks.afterOperationStep?.(operationId, ran.step, ran.outcome)
      if (ran.outcome.status !== 'done' && ran.outcome.status !== 'more' || ran.last && ran.outcome.status === 'done') return
    }
  }
}
