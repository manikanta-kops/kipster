import type { Runtime } from '../runtime.js'
import { earliestRunAt, onRoutinesChanged, runDueRoutines } from '../modules/routines/public.js'

/** Timing of the routine timer. Tests may shorten them. */
export const ROUTINE_TIMER = {
  /** Longest sleep between checks of the clock, so a computer that slept is noticed soon after it wakes. */
  maxSleepMs: 60000,
  /** How often the earliest next run is read again, for changes made outside this process. */
  reloadMs: 10 * 60000,
  /** Wait before trying again after a failed check. */
  retryMs: 30000,
}

/**
 * Starts routine runs while this process coordinates. One timer serves every routine: it keeps the earliest next run
 * in memory and sleeps until then, at most `maxSleepMs` at a time. A wake-up with nothing due reads nothing; the
 * database is read when a run is due, when a routine changes and every `reloadMs`.
 */
export class RoutineDispatch {
  private timer: ReturnType<typeof setTimeout> | null = null
  private next: number | null = null
  private loadedAt = -Infinity
  private stale = true
  private running: Promise<void> | null = null
  private closed = false
  private unsubscribe: (() => void) | null = null

  constructor(private readonly runtime: Runtime, private readonly coordinating: () => boolean, private readonly onError?: (error: unknown) => void) {}

  start(): void {
    if (this.closed || this.unsubscribe) return
    this.unsubscribe = onRoutinesChanged(() => { this.stale = true; void this.tick() })
    void this.tick()
  }

  /** Starts what is due and sets the timer again; checks never overlap and never reject. */
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.running ??= this.check().then(() => this.arm(), error => { this.onError?.(error); this.arm(ROUTINE_TIMER.retryMs) }).finally(() => { this.running = null })
    return this.running
  }

  private async check(): Promise<void> {
    if (!this.coordinating()) return
    const now = this.runtime.clock().getTime()
    if (this.stale || now - this.loadedAt >= ROUTINE_TIMER.reloadMs) await this.load(now)
    if (this.next === null || this.next > now) return
    await runDueRoutines(this.runtime.db, this.runtime.jobs, this.runtime.bootstrap.installationId, new Date(now))
    await this.load(now)
  }

  private async load(now: number): Promise<void> {
    this.stale = false
    this.loadedAt = now
    this.next = (await earliestRunAt(this.runtime.db, this.runtime.bootstrap.installationId))?.getTime() ?? null
  }

  private arm(delay?: number): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    const until = this.next === null ? ROUTINE_TIMER.maxSleepMs : this.next - this.runtime.clock().getTime()
    // A change seen during a check is read at once. A routine still due right after a check, such as one locked by a
    // change in progress, is tried again shortly.
    const wait = delay ?? (!this.coordinating() ? ROUTINE_TIMER.maxSleepMs : this.stale ? 0 : until <= 0 ? 1000 : Math.min(until, ROUTINE_TIMER.maxSleepMs))
    this.timer = setTimeout(() => { void this.tick() }, wait)
    this.timer.unref?.()
  }

  async close(): Promise<void> {
    this.closed = true
    this.unsubscribe?.()
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    await this.running?.catch(() => undefined)
  }
}
