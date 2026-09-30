import { PgBoss } from 'pg-boss'
import type { SqlClient } from '../postgres/public.js'

type Boss = Pick<PgBoss, 'start' | 'stop' | 'createQueue' | 'send' | 'work' | 'offWork' | 'on'>
/** `dispatch` wakes text and maintenance work; `administration` wakes administration operations, with at most one
 * waiting wake-up per operation. */
export type Queue = 'dispatch' | 'administration'

/** Wakeups carry only Core intent or operation IDs. Core state decides whether work may run.
 * Background queue errors are reported to `onError` and kept in `error` until the worker next receives
 * jobs. They do not fail sends, which run on the caller's transaction and fail only on their own errors. */
export class Jobs {
  private readonly boss: Boss
  private started = false
  private failure: Error | null = null
  constructor(connectionString: string, onError?: (error: Error) => void, boss?: Boss) {
    this.boss = boss ?? new PgBoss({ connectionString, schema: 'kipster_jobs', supervise: false, schedule: false })
    this.boss.on('error', (error: Error) => {
      this.failure = error
      onError?.(error)
    })
  }
  get error(): Error | null { return this.failure }
  async start(): Promise<void> {
    if (this.started) return
    this.failure = null
    this.started = true // stop() must clean up even when queue creation fails after boss.start().
    try {
      await this.boss.start()
      await this.boss.createQueue('dispatch', { retryLimit: 1 })
      await this.boss.createQueue('administration', { retryLimit: 1, policy: 'short' })
      if (this.failure) throw this.failure
    } catch (error) {
      try { await this.stop() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Job startup and cleanup failed', { cause: error })
      }
      throw error
    }
  }
  /** Returns the job ID, or null when an administration wake-up for the same operation is already waiting. */
  async send(client: SqlClient, intentId: string, delaySeconds = 0, queue: Queue = 'dispatch'): Promise<string | null> {
    if (!this.started) throw new Error('Jobs not started')
    const jobId = await this.boss.send(queue, { intentId }, {
      ...(delaySeconds ? { startAfter: delaySeconds } : {}),
      ...(queue === 'administration' ? { singletonKey: intentId } : {}),
      db: { executeSql: async (sql, values) => {
        const result = await client.query(sql, values)
        return { rows: result.rows }
      } },
    })
    if (!jobId && queue !== 'administration') throw new Error('Job enqueue returned no identity')
    return jobId
  }
  async work(handler: (intentId: string) => Promise<void>, concurrency = 20, queue: Queue = 'dispatch'): Promise<void> {
    if (!this.started) throw new Error('Jobs not started')
    await this.boss.work<{ intentId: string }>(queue, { localConcurrency: concurrency, pollingIntervalSeconds: 0.5 }, async jobs => {
      this.failure = null
      for (const job of jobs) await handler(job.data.intentId)
    })
  }
  async stopWork(queue: Queue = 'dispatch'): Promise<void> {
    if (this.started) await this.boss.offWork(queue, { wait: false })
  }
  async stop(): Promise<void> {
    if (!this.started) return
    await this.boss.stop({ graceful: false, timeout: 5000 })
    this.started = false
  }
}
