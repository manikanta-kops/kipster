import { fork, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoveryCompatible } from '../adapter-api/index.js'
import type { AdapterHost, AdapterReadiness, DurableReconcileResult, AdapterExecutionContext as ExecutionContext, ExecutionEvent, ExecutionHandle, RecoveryReference, TextExecutionAdapter } from '../adapter-api/index.js'
import type { Catalog } from '../modules/settings/public.js'
import type { ExecutionAdapter } from '../protocol/admin.js'

interface Descriptor { id: string; version: string; contractMajor: number; readiness: AdapterReadiness }
interface WireMessage { kind: string; requestId?: number; attemptId?: string; value?: unknown; error?: string; callId?: string; name?: string; arguments?: unknown }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
/** A ready readiness report with a well-formed catalog. */
export function validReadiness(value: unknown): value is AdapterReadiness {
  if (!value || typeof value !== 'object') return false
  const ready = value as Partial<AdapterReadiness>
  const catalog = ready.catalog
  if (ready.ready !== true || (ready.reason !== undefined && typeof ready.reason !== 'string') || !catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return false
  const ids = new Set<string>()
  for (const model of catalog.models) {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id)) return false
    ids.add(model.id)
    if (model.efforts !== undefined && (!Array.isArray(model.efforts) || model.efforts.length === 0 || model.efforts.some((effort: unknown) => typeof effort !== 'string' || !effort.trim()) || new Set(model.efforts).size !== model.efforts.length)) return false
  }
  const fallback = catalog.defaultModel
  if (fallback !== undefined) {
    const model = fallback && typeof fallback.id === 'string' ? catalog.models.find(item => item.id === fallback.id) : undefined
    if (!model || (fallback.effort !== undefined && !model.efforts?.includes(fallback.effort))) return false
  }
  const options = catalog.supportedOptions ?? []
  if (!Array.isArray(options) || options.some(option => typeof option !== 'string' || !option.trim()) || new Set(options).size !== options.length) return false
  const capability = catalog.capabilities
  if (!capability || capability.text !== true || typeof capability.publication !== 'boolean' || typeof capability.cancellation !== 'boolean' || capability.steering !== false || typeof capability.nativeResume !== 'boolean') return false
  if (capability.maintenance !== undefined && typeof capability.maintenance !== 'boolean') return false
  const versions = ready.recoveryVersions
  if (versions !== undefined && (!Array.isArray(versions) || !versions.length || versions.some(version => !Number.isSafeInteger(version) || version < 1))) return false
  const scopes = ready.recoveryStateScopes
  if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => typeof scope !== 'string' || !scope.trim()))) return false
  if (capability.maintenance === true && (!versions?.length || !scopes?.length)) return false
  return true
}
/** Adapter-supplied text shown to clients, bounded. */
export function boundedReason(reason: string): string { return reason.trim().slice(0, 500) || 'Adapter is not ready' }
/** The reason a readiness report that is not a valid ready report gives. */
export function notReadyReason(value: unknown): string {
  const report = value && typeof value === 'object' ? value as { ready?: unknown; reason?: unknown } : {}
  if (report.ready === false) return boundedReason(typeof report.reason === 'string' ? report.reason : '')
  return 'Adapter readiness is invalid'
}
/** The client-facing record of an adapter: availability, reason and last known catalog. */
export function adapterRecord(id: string, version: string, readiness: AdapterReadiness | undefined, reason: string | null): ExecutionAdapter {
  const catalog = readiness?.catalog
  return {
    id, version, available: reason === null, reason,
    models: (catalog?.models ?? []).map(model => ({ id: model.id, efforts: [...(model.efforts ?? [])] })),
    defaultModel: catalog?.defaultModel ? { id: catalog.defaultModel.id, effort: catalog.defaultModel.effort ?? null } : null,
    supportedOptions: [...(catalog?.supportedOptions ?? [])],
    capabilities: catalog ? { text: catalog.capabilities.text, publication: catalog.capabilities.publication, cancellation: catalog.capabilities.cancellation, steering: catalog.capabilities.steering, nativeResume: catalog.capabilities.nativeResume, maintenance: catalog.capabilities.maintenance === true } : null,
  }
}
class EventQueue implements AsyncIterable<ExecutionEvent> {
  private values: ExecutionEvent[] = []
  private waiter: ((value: IteratorResult<ExecutionEvent>) => void) | undefined
  private terminal = false
  private failure: Error | undefined
  push(value: ExecutionEvent): void {
    if (this.terminal) return
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value, done: false }) }
    else this.values.push(value)
  }
  end(error?: Error): void {
    this.terminal = true
    this.failure = error
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter({ value: undefined, done: true }) }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    while (true) {
      const next = this.values.length ? { value: this.values.shift()!, done: false as const } : this.terminal ? { value: undefined, done: true as const } : await new Promise<IteratorResult<ExecutionEvent>>(resolve => { this.waiter = resolve })
      if (next.done) { if (this.failure) throw this.failure; return }
      yield next.value
    }
  }
}
class Generation implements TextExecutionAdapter {
  readonly contractMajor = 1 as const
  readonly incarnation = randomUUID()
  readonly generationId = randomUUID()
  readonly active = new Set<string>()
  readonly queues = new Map<string, EventQueue>()
  readonly pending = new Map<number, Pending>()
  private sequence = 0
  private dead = false
  private closing: Promise<void> | undefined
  retired = false
  /** Why the latest readiness probe did not report ready; the generation takes no new work meanwhile. */
  notReady: string | undefined
  get available(): boolean { return !this.dead && !this.retired && this.notReady === undefined }
  get reason(): string | null { return this.dead ? 'Adapter runner exited' : this.notReady ?? null }
  get exited(): boolean { return this.dead }
  id = ''
  version = ''
  readyState!: AdapterReadiness
  constructor(readonly entry: string, readonly snapshotRoot: string, readonly digest: string, readonly child: ChildProcess, private readonly host: AdapterHost, private readonly executeAckTimeoutMs: number, private readonly onDeath: () => void) {
    child.on('message', raw => { void this.receive(raw as WireMessage).catch(error => this.fail(error)) })
    child.on('disconnect', () => this.fail(new Error('Adapter runner disconnected before confirmed drain')))
    child.on('exit', () => this.fail(new Error('Adapter runner exited before confirmed drain')))
    child.on('error', error => this.fail(error))
  }
  private fail(error: Error): void {
    if (this.dead) return
    this.dead = true
    this.onDeath()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const queue of this.queues.values()) queue.end(error)
  }
  private send(message: object): Promise<void> {
    if (!this.child.connected) return Promise.reject(new Error('Adapter runner IPC is disconnected'))
    return new Promise((resolve, reject) => {
      try { this.child.send(message, error => error ? reject(error) : resolve()) }
      catch (error) { reject(error) }
    })
  }
  private async receive(message: WireMessage): Promise<void> {
    if (message.kind === 'reply' && message.requestId !== undefined) {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.value)
    } else if (message.kind === 'tool' && message.requestId !== undefined) {
      try {
        if (!message.attemptId || !this.active.has(message.attemptId)) throw new Error('Stale tool owner')
        const value = await this.host.invokeTool({ attemptId: message.attemptId, callId: message.callId ?? '', name: message.name ?? '', arguments: message.arguments })
        await this.send({ kind: 'tool-result', requestId: message.requestId, value }).catch(() => undefined)
      } catch (error) { await this.send({ kind: 'tool-result', requestId: message.requestId, error: String(error) }).catch(() => undefined) }
    } else if (message.attemptId) {
      const queue = this.queues.get(message.attemptId)
      if (!queue) return
      if (message.kind === 'event') queue.push(message.value as ExecutionEvent)
      else if (message.kind === 'stream-end' || message.kind === 'stream-error') {
        queue.end(message.error ? new Error(message.error) : undefined)
        this.queues.delete(message.attemptId)
      }
    }
  }
  request(kind: string, payload: object = {}, timeoutMs = 15000): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('Adapter runner is unavailable'))
    const requestId = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Adapter ${kind} timed out`)) }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })
      void this.send({ kind, requestId, ...payload }).catch(error => {
        if (this.pending.get(requestId)) { clearTimeout(timer); this.pending.delete(requestId); reject(error) }
      })
    })
  }
  async initialize(expectedId: string, config?: Readonly<Record<string, unknown>>, dataDirectory?: string): Promise<void> {
    const value = await this.request('initialize', { entry: this.entry, config, dataDirectory }, 60000) as Descriptor
    if (value.contractMajor !== 1 || value.id !== expectedId || typeof value.version !== 'string' || !value.version.trim() || !validReadiness(value.readiness)) throw new Error('Adapter identity or readiness mismatch')
    this.id = value.id
    this.version = value.version
    this.readyState = value.readiness
  }
  /** Asks the adapter for readiness again. A ready, valid report replaces the catalog; anything else marks the generation not ready. */
  async probe(): Promise<void> {
    if (this.dead) return
    try {
      const value = await this.request('readiness', {}, 30000)
      if (validReadiness(value)) { this.readyState = value; this.notReady = undefined }
      else this.notReady = notReadyReason(value)
    } catch (error) { this.notReady = boundedReason(error instanceof Error ? error.message : 'Adapter readiness failed') }
  }
  async execute(context: ExecutionContext): Promise<ExecutionHandle> {
    if (this.dead || !this.active.has(context.attemptId)) throw new Error('Adapter generation is unavailable')
    const kind = (context as { kind?: unknown }).kind
    if (kind === 'maintenance') {
      if (this.readyState.catalog.capabilities.maintenance !== true) throw new Error('Selected adapter unavailable for maintenance')
    }
    const queue = new EventQueue()
    this.queues.set(context.attemptId, queue)
    try { await this.request('execute', { context }, this.executeAckTimeoutMs) }
    catch (error) {
      // Dispatch may have reached the runner/provider even when its acknowledgement is lost.
      // Only a confirmed settlement may release this reservation and its snapshot.
      this.queues.delete(context.attemptId)
      queue.end(error as Error)
      throw error
    }
    return {
      events: queue,
      cancel: async () => await this.request('cancel', { attemptId: context.attemptId }) as Awaited<ReturnType<ExecutionHandle['cancel']>>,
      reconcile: async () => await this.request('reconcile', { attemptId: context.attemptId }) as Awaited<ReturnType<ExecutionHandle['reconcile']>>,
    }
  }
  release(attemptId: string): void {
    this.active.delete(attemptId)
    if (this.retired && this.active.size === 0) {
      if (this.closing) void this.closing.then(() => rm(this.snapshotRoot, { recursive: true, force: true }))
      else void this.close()
    }
  }
  async close(): Promise<void> {
    if (this.active.size) return
    await this.shutdown()
  }
  async shutdown(): Promise<void> {
    if (this.closing) return this.closing
    this.retired = true
    this.closing = (async () => {
      if (!this.dead) {
        try { await this.request('close', {}, 5000) } catch { this.child.kill('SIGTERM') }
      }
      if (this.active.size === 0) await rm(this.snapshotRoot, { recursive: true, force: true })
    })()
    return this.closing
  }
}

async function snapshot(root: string, entryRelative: string, generationRoot: string): Promise<{ root: string; entry: string; digest: string }> {
  // Pin the release selected by current once. Updates can switch the symlink
  // without changing the bytes this generation snapshots and verifies.
  const source = await realpath(root)
  const selected = resolve(source, entryRelative)
  const distance = relative(source, selected)
  if (!distance || distance.startsWith('..' + sep) || distance === '..' || distance.startsWith(sep)) throw new Error('Adapter entry must be inside its installation root')
  if (!(await lstat(selected)).isFile()) throw new Error('Adapter entry is not a file')
  await mkdir(generationRoot, { recursive: true })
  const target = await mkdtemp(join(generationRoot, 'kipster-adapter-generation-'))
  try {
    async function digestTree(base: string): Promise<string> {
      const hash = createHash('sha256')
      async function visit(directory: string): Promise<void> {
      for (const name of (await readdir(directory)).sort()) {
        if (name === '.bin') continue
        const path = join(directory, name)
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) throw new Error('Adapter installation contains a symlink')
        if (stat.isDirectory()) await visit(path)
        else if (stat.isFile()) { hash.update(relative(base, path)); hash.update(await readFile(path)) }
      }
      }
      await visit(base)
      return hash.digest('hex')
    }
    const before = await digestTree(source)
    await cp(source, target, { recursive: true, force: true, filter: path => !path.split(sep).includes('.bin') })
    const copied = await digestTree(target)
    const after = await digestTree(source)
    if (before !== copied || after !== copied) throw new Error('Adapter installation changed while snapshotting')
    return { root: target, entry: join(target, distance), digest: copied }
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error }
}

export class AdapterRegistry {
  private readonly current = new Map<string, Generation>()
  private readonly all = new Map<string, Generation>()
  /** Adapter IDs in the order they were first registered; the first is the installation's default adapter. */
  private readonly order: string[] = []
  private readonly listeners = new Set<() => void>()
  constructor(private readonly host: AdapterHost, private readonly generationRoot = tmpdir(), private readonly executeAckTimeoutMs = 30000) {}
  /** Calls `listener` after the adapter list or an adapter's availability changes. Returns the unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { for (const listener of this.listeners) listener() }
  /** Current adapters by ID, including unavailable ones with their reason and last known catalog. */
  adapters(): ExecutionAdapter[] {
    return [...this.current.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(g => adapterRecord(g.id, g.version, g.readyState, g.reason))
  }
  /** Whether the current adapter is running but its latest readiness probe did not report ready. */
  notReady(id: string): boolean {
    const generation = this.current.get(id)
    return !!generation && !generation.exited && !generation.retired && generation.notReady !== undefined
  }
  /** Probes the readiness of every current adapter, or of `id` only, again. An adapter whose runner exited stays unavailable until it is registered again. */
  async refresh(id?: string): Promise<void> {
    await Promise.all([...this.current.values()].filter(generation => id === undefined || generation.id === id).map(generation => generation.probe()))
    this.changed()
  }
  catalog(): Catalog {
    const adapters = [...this.current.values()].filter(g => g.available).map(g => ({ id: g.id, models: g.readyState.catalog.models, ...(g.readyState.catalog.defaultModel ? { defaultModel: g.readyState.catalog.defaultModel } : {}) }))
    return { complete: true, defaultAdapterId: this.order[0] ?? null, adapters }
  }
  selected(id: string, attemptId: string, kind: 'text' | 'maintenance' = 'text'): { adapter: TextExecutionAdapter; generationId: string; incarnation: string; installationDigest: string; installationRoot: string; supportedOptions: readonly string[]; release(attemptId: string): void } | undefined {
    const generation = this.current.get(id)
    if (!generation?.available) return undefined
    if (kind === 'maintenance' && generation.readyState.catalog.capabilities.maintenance !== true) return undefined
    generation.active.add(attemptId)
    return { adapter: generation, generationId: generation.generationId, incarnation: generation.incarnation, installationDigest: generation.digest, installationRoot: generation.snapshotRoot, supportedOptions: generation.readyState.catalog.supportedOptions ?? [], release: attemptId => generation.release(attemptId) }
  }
  /** Whether any current generation can run maintenance. This is registry-wide: it does not check
   * which adapter a source's agent is configured to use. */
  maintenanceCapable(): boolean { return [...this.current.values()].some(g => g.available && g.readyState.catalog.capabilities.maintenance === true) }
  /** Declared durable-recovery versions of the current generation, if any. */
  recoveryVersions(id: string): readonly number[] | undefined {
    const generation = this.current.get(id)
    if (!generation?.available || generation.readyState.catalog.capabilities.maintenance !== true) return undefined
    return generation.readyState.recoveryVersions
  }
  /** Durable provider reconciliation on the current generation. Transport and
   * adapter failures throw; the caller retains the reservation on any throw. */
  async durableReconcile(adapterId: string, recoveryRef: RecoveryReference): Promise<DurableReconcileResult> {
    const incompatible: DurableReconcileResult = { outcome: 'unknown', evidence: 'incompatible recovery identity', generationMismatch: false }
    if (recoveryRef.adapterId !== adapterId || recoveryRef.contractMajor !== 1) return incompatible
    const generation = this.current.get(adapterId)
    if (!generation?.available || generation.readyState.catalog.capabilities.maintenance !== true) return { outcome: 'unknown', evidence: 'adapter unavailable', generationMismatch: false }
    if (!recoveryCompatible(generation.readyState.recoveryVersions, generation.readyState.recoveryStateScopes, recoveryRef)) return incompatible
    const mismatch = (recoveryRef.generationId !== undefined && recoveryRef.generationId !== generation.generationId) ||
      (recoveryRef.digest !== undefined && recoveryRef.digest !== generation.digest)
    const value = await generation.request('durable-reconcile', { recoveryRef }, 15000) as Partial<DurableReconcileResult>
    if (!value || (value.outcome !== 'active' && value.outcome !== 'ended' && value.outcome !== 'unknown') || typeof value.evidence !== 'string' || !value.evidence) throw new Error('Invalid durable reconcile result')
    return { outcome: value.outcome, evidence: value.evidence.slice(0, 500), generationMismatch: mismatch || value.generationMismatch === true }
  }
  /**
   * Asks the adapter's current generation to forget provider state for the thread IDs. `unavailable`
   * when no running generation has the ID, `unsupported` when the adapter lacks the capability.
   * Transport and adapter failures throw.
   */
  async forgetProviderState(adapterId: string, threadIds: readonly string[]): Promise<'forgotten' | 'unsupported' | 'unavailable'> {
    const generation = this.current.get(adapterId)
    if (!generation || generation.exited) return 'unavailable'
    const value = await generation.request('forget-provider-state', { threadIds: [...threadIds] }, 60000)
    if (value !== 'forgotten' && value !== 'unsupported') throw new Error('Invalid forget provider state result')
    return value
  }
  /** Copies the complete dependency installation into an isolated immutable generation. */
  async register(id: string, installationRoot: string, entryRelative: string, signal?: AbortSignal, config?: Readonly<Record<string, unknown>>, dataDirectory?: string): Promise<{ generationId: string; incarnation: string; installationDigest: string; readiness: AdapterReadiness }> {
    if (!id || !installationRoot || !entryRelative) throw new Error('Adapter ID, installation root and entry are required')
    if (!this.order.includes(id)) this.order.push(id)
    signal?.throwIfAborted()
    const installed = await snapshot(installationRoot, entryRelative, this.generationRoot)
    if (signal?.aborted) { await rm(installed.root, { recursive: true, force: true }); signal.throwIfAborted() }
    const runner = fileURLToPath(new URL('./adapter-runner.js', import.meta.url))
    const child = fork(runner, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
    const candidate = new Generation(installed.entry, installed.root, installed.digest, child, this.host, this.executeAckTimeoutMs, () => { if (this.current.get(candidate.id) === candidate) this.changed() })
    const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    // Give the initializing candidate time to close readiness-owned subprocesses.
    // Only this unpublished runner is force-terminated if cooperative cleanup stalls.
    let stopping: Promise<void> | undefined
    const stopInitializing = () => stopping ??= (async () => {
      const fallback = setTimeout(() => { child.kill('SIGKILL') }, 6000)
      try {
        await candidate.request('close', {}, 5000).catch(() => undefined)
        await exited
      } finally { clearTimeout(fallback) }
    })()
    const cancel = () => { void stopInitializing() }
    signal?.addEventListener('abort', cancel, { once: true })
    try { await candidate.initialize(id, config, dataDirectory); signal?.throwIfAborted() }
    catch (error) { await stopInitializing(); await rm(installed.root, { recursive: true, force: true }); throw error }
    finally { signal?.removeEventListener('abort', cancel) }
    const old = this.current.get(id)
    this.current.set(id, candidate)
    this.all.set(candidate.generationId, candidate)
    if (old) { old.retired = true; if (!old.active.size) await old.close() }
    this.changed()
    return { generationId: candidate.generationId, incarnation: candidate.incarnation, installationDigest: candidate.digest, readiness: candidate.readyState }
  }
  async remove(id: string): Promise<void> {
    const generation = this.current.get(id)
    if (!generation) return
    this.current.delete(id)
    this.order.splice(this.order.indexOf(id), 1)
    generation.retired = true
    this.changed()
    if (!generation.active.size) await generation.close()
  }
  async close(): Promise<void> {
    this.current.clear()
    await Promise.all([...this.all.values()].map(generation => generation.shutdown()))
    this.all.clear()
  }
}
