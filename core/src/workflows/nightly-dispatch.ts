import type { ExecutionEvent, ExecutionHandle, MaintenanceCapableAdapter, MaintenanceExecutionContext, TextExecutionAdapter } from '../adapter-api/index.js'
import { AdapterRegistry } from './adapter-registry.js'
import type { Runtime } from '../runtime.js'
import type { SqlClient } from '../platform/postgres/public.js'
import { checkCatalog, memorySettings, NightlyDeferred, NightlyMemory, openMemoryCall, recordMemoryRoute, settleMemoryCall, type MemoryModelRequest } from '../modules/memory/public.js'
import { resolveAgentSettings, type Catalog } from '../modules/settings/public.js'
import type { Attempt } from '../modules/work/public.js'

/** Limits of nightly calls. Tests may shorten them. */
export const NIGHTLY_CALLS: { tickMs: number; deadlineMs: number; admissionMs: number; admissionPollMs: number; outputBytes: number } = {
  /** How often the dispatcher looks for due nightly runs. */
  tickMs: 60000,
  /** Longest one nightly model call may run before it is cancelled and fails. */
  deadlineMs: 15 * 60000,
  /** How long a call waits for free capacity before the run is deferred to a later tick. */
  admissionMs: 60000,
  admissionPollMs: 2000,
  /** Largest answer accepted, in bytes. */
  outputBytes: 1024 * 1024,
}

type Route = { adapter: TextExecutionAdapter; generationId?: string; incarnation?: string; installationDigest?: string; installationRoot?: string; supportedOptions?: readonly string[]; release(attemptId: string): void }

/** What the nightly run needs from the dispatcher that coordinates this installation. */
export interface NightlyHost {
  readonly runtime: Runtime
  readonly adapter: TextExecutionAdapter | AdapterRegistry
  readonly incarnation: string
  /** Attempts this process drives; recovery leaves them alone. */
  readonly live: Set<string>
  catalog(): Catalog | null
  /** Whether a direct adapter declares maintenance. */
  directMaintenance(): boolean
  coordinating(): boolean
  /** The coordinator fence, checked inside the caller's capacity-locked transaction. */
  mayCoordinate(client: SqlClient): Promise<boolean>
  /** Capacity lock of the installation: returns the ceiling, or 0 while an update pauses work. */
  lockCapacity(client: SqlClient): Promise<number>
  onError?(error: unknown): void
}

/**
 * Drives memory's nightly run for the dispatcher. A timer tick runs the due agents one after another while this
 * process coordinates. Each model call is a work intent with an issued attempt and an execution permit, run through the
 * adapter registry's maintenance route with the admin kip's model, or the nightly model when one is set, a deadline and
 * cancellation on shutdown.
 */
export class NightlyDispatch {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private readonly handles = new Map<string, ExecutionHandle>()
  readonly memory: NightlyMemory

  constructor(private readonly host: NightlyHost) {
    const { runtime } = host
    this.memory = new NightlyMemory({ db: runtime.db, installationId: runtime.bootstrap.installationId, embedding: runtime.embedding, identity: runtime.home.identity, clock: runtime.clock, incarnation: host.incarnation, model: request => this.call(request) })
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return
    this.timer = setInterval(() => { void this.tick() }, NIGHTLY_CALLS.tickMs)
    this.timer.unref?.()
  }

  /** Runs the due agents once; ticks never overlap and never reject. */
  tick(): Promise<void> {
    if (this.controller.signal.aborted || !this.host.coordinating()) return Promise.resolve()
    this.running ??= this.memory.run(this.controller.signal).then(() => undefined, error => this.host.onError?.(error)).finally(() => { this.running = null })
    return this.running
  }

  /** Stops ticking, cancels the call in flight and waits for the run to stop. */
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.controller.abort()
    for (const handle of this.handles.values()) void handle.cancel().catch(() => undefined)
    await this.running?.catch(() => undefined)
  }

  /** The adapter settings of the nightly run: the nightly model when set, otherwise the admin kip's resolved execution settings. */
  private async settings(): Promise<{ adapterId: string; modelId: string; effort?: string; options?: Record<string, unknown> }> {
    const { runtime } = this.host
    const installationId = runtime.bootstrap.installationId
    const { nightlyModel } = await memorySettings(runtime.db, installationId)
    if (nightlyModel) {
      checkCatalog(nightlyModel, this.host.catalog())
      return nightlyModel
    }
    const resolved = await resolveAgentSettings(runtime.db, runtime.home, installationId, runtime.bootstrap.rootAgentId, null, this.host.catalog())
    if ('reason' in resolved) throw new Error(`The admin kip's model: ${resolved.reason}`)
    const { adapterId, modelId, effort, options } = resolved.settings
    return { adapterId: adapterId!, modelId: modelId!, ...(effort ? { effort } : {}), ...(options ? { options } : {}) }
  }

  private route(adapterId: string, attemptId: string): Route | undefined {
    const adapter = this.host.adapter
    if (adapter instanceof AdapterRegistry) return adapter.selected(adapterId, attemptId, 'maintenance')
    if (adapterId === adapter.id && this.host.directMaintenance()) return { adapter, release() {} }
    return undefined
  }

  /** One nightly model call. Throws `NightlyDeferred` while it cannot run now, and an error when it fails. */
  private async call(request: MemoryModelRequest): Promise<unknown> {
    const { runtime } = this.host
    const settings = await this.settings()
    const opened = await this.admit(request)
    const route = this.route(settings.adapterId, opened.id)
    let failure: string | null = null
    let output: string | undefined
    let settled = false
    try {
      if (!route) throw new Error('The nightly model\'s adapter is unavailable for memory')
      const unsupported = Object.keys(settings.options ?? {}).filter(key => !(route.supportedOptions ?? []).includes(key))
      if (unsupported.length) throw new Error(`Unsupported execution option: ${unsupported.join(', ')}`)
      await runtime.db.transaction(client => recordMemoryRoute(client, opened.id, { adapterId: settings.adapterId, generationId: route.generationId, incarnation: route.incarnation, installationDigest: route.installationDigest, installationRoot: route.installationRoot }))
      const context: MaintenanceExecutionContext = {
        kind: 'maintenance', runId: opened.intentId, attemptId: opened.id, attemptGeneration: opened.generation, incarnation: opened.incarnation, organizationId: null, agentId: request.agentId,
        maintenance: { task: 'memory', step: request.step, instructions: request.instructions, outputSchema: request.outputSchema, settings },
      }
      output = await this.execute(route, context, request.signal)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.host.live.delete(opened.id)
      try { settled = await runtime.db.transaction(client => settleMemoryCall(client, opened, failure)) }
      finally { route?.release(opened.id) }
    }
    // Recovery settled the call after this process lost the coordinator: its answer or failure is no longer this run's.
    if (!settled) throw new NightlyDeferred('The call was settled by another process')
    if (failure !== null) throw request.signal.aborted ? new NightlyDeferred(failure) : new Error(`Nightly ${request.step} step failed: ${failure}`)
    try { return JSON.parse(output!) } catch { throw new Error(`Nightly ${request.step} step failed: the answer is not JSON`) }
  }

  /** Opens the call once capacity is free, waiting a little; otherwise defers the run. */
  private async admit(request: MemoryModelRequest): Promise<Attempt> {
    const { runtime } = this.host
    const installationId = runtime.bootstrap.installationId
    const until = Date.now() + NIGHTLY_CALLS.admissionMs
    while (true) {
      request.signal.throwIfAborted()
      const opened = await runtime.db.transaction(async client => {
        const ceiling = await this.host.lockCapacity(client)
        if (ceiling === 0 || !await this.host.mayCoordinate(client)) return 'busy' as const
        const attempt = await openMemoryCall(client, { installationId, ceiling, agentId: request.agentId, threadId: request.threadId, step: request.step, incarnation: this.host.incarnation })
        if (attempt !== 'busy') this.host.live.add(attempt.id)
        return attempt
      })
      if (opened !== 'busy') return opened
      if (Date.now() >= until || !this.host.coordinating()) throw new NightlyDeferred('Capacity is in use')
      await new Promise(resolve => setTimeout(resolve, NIGHTLY_CALLS.admissionPollMs))
    }
  }

  /** Runs the context and returns its one final answer. Times out, stops on cancellation and rejects any other output. */
  private async execute(route: Route, context: MaintenanceExecutionContext, signal: AbortSignal): Promise<string> {
    const handle = await (route.adapter as MaintenanceCapableAdapter).execute(context)
    this.handles.set(context.attemptId, handle)
    let ended = false
    const iterator = handle.events[Symbol.asyncIterator]()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    const stopped = new Promise<'stopped'>(resolve => {
      stop = () => resolve('stopped')
      timer = setTimeout(stop, NIGHTLY_CALLS.deadlineMs)
      signal.addEventListener('abort', stop, { once: true })
    })
    let answer: string | undefined
    try {
      while (true) {
        const next = await Promise.race([iterator.next(), stopped])
        if (next === 'stopped') throw new Error(signal.aborted ? 'Cancelled at shutdown' : 'Timed out')
        if (next.done) { ended = true; throw new Error('The adapter ended without a result') }
        const event: ExecutionEvent = next.value
        if (event.attemptId !== context.attemptId) continue
        if (event.kind === 'text') {
          if (!event.final) continue
          if (answer !== undefined) throw new Error('The adapter sent more than one result')
          if (Buffer.byteLength(event.text) > NIGHTLY_CALLS.outputBytes) throw new Error('The answer is too large')
          answer = event.text
        } else if (event.kind === 'ended') {
          ended = true
          if (answer === undefined) throw new Error('The adapter ended without a result')
          return answer
        } else if (event.kind === 'failed') { ended = event.confirmedEnded; throw new Error(event.message || 'The adapter failed') }
        else if (event.kind === 'waiting') throw new Error('The adapter waited for input')
      }
    } finally {
      // A call that stops early asks the provider to stop too; its answer is not used either way.
      if (!ended) await Promise.race([handle.cancel().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 10000).unref?.())])
      if (timer) clearTimeout(timer)
      if (stop) signal.removeEventListener('abort', stop)
      this.handles.delete(context.attemptId)
    }
  }
}
