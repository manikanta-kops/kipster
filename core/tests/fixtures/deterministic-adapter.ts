import type { AdapterHost, AdapterReadiness, DurableReconcileResult, AdapterExecutionContext as ExecutionContext, ExecutionEvent, ExecutionHandle, RecoveryReference, TextExecutionAdapter } from '../../src/adapter-api/index.js'

export interface FixtureHandle extends ExecutionHandle {
  release(event: ExecutionEvent): void
  abortUnknown(): void
  callTool(callId: string, name: string, args: unknown): Promise<unknown>
}
export interface FixtureAdapter extends TextExecutionAdapter {
  execute(context: ExecutionContext): Promise<FixtureHandle>
  readonly activeCount: number
  readonly contexts: ExecutionContext[]
  readonly recoveryVersions: readonly number[]
  readonly recoveryStateScopes: readonly string[]
  durableReconcile(request: { recoveryRef: RecoveryReference }): Promise<DurableReconcileResult>
  /** Scripted durable-reconcile answers; default is unknown. Calls are recorded. 'hang' never resolves. */
  readonly reconcileScript: ('active' | 'ended' | 'unknown' | 'hang' | Error)[]
  readonly reconcileCalls: { recoveryRef: RecoveryReference }[]
}

/** Test-only execution fixture. Each observation is released explicitly. */
export function fixtureAdapter(host: AdapterHost): FixtureAdapter {
  const active = new Set<FixtureHandle>()
  const contexts: ExecutionContext[] = []
  const reconcileScript: ('active' | 'ended' | 'unknown' | 'hang' | Error)[] = []
  const reconcileCalls: { recoveryRef: RecoveryReference }[] = []
  let closed = false
  const readiness: AdapterReadiness = {
    ready: true,
    catalog: {
      models: [{ id: 'fixture-model' }],
      capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false, maintenance: true },
    },
    recoveryVersions: [1],
    recoveryStateScopes: ['shared-codex-home'],
  }
  return {
    id: 'deterministic-fixture', version: '1', contractMajor: 1,
    recoveryVersions: [1],
    recoveryStateScopes: ['shared-codex-home'],
    contexts, reconcileScript, reconcileCalls,
    async readiness() { return readiness },
    async durableReconcile(request): Promise<DurableReconcileResult> {
      reconcileCalls.push(request)
      const scripted = reconcileScript.length ? reconcileScript.shift()! : 'unknown'
      if (scripted instanceof Error) throw scripted
      if (scripted === 'hang') return new Promise<DurableReconcileResult>(() => {})
      return { outcome: scripted, evidence: `fixture ${scripted}`, generationMismatch: false }
    },
    async execute(context) {
      if (closed) throw new Error('fixture closed')
      contexts.push(context)
      let resolveNext: ((event: ExecutionEvent | undefined) => void) | undefined
      const queue: ExecutionEvent[] = []
      let ended = false
      let confirmed = false
      const handle: FixtureHandle = {
        events: { async *[Symbol.asyncIterator]() {
          while (!ended || queue.length) {
            const event: ExecutionEvent | undefined = queue.shift() ?? await new Promise(resolve => { resolveNext = resolve })
            if (event) yield event
          }
        } },
        async cancel() { return { acknowledged: true, confirmedEnded: confirmed } },
        async reconcile() { return confirmed ? 'ended' : 'unknown' },
        async callTool(callId, name, args) { return host.invokeTool({ attemptId: context.attemptId, callId, name, arguments: args }) },
        release(event) {
          if (event.attemptId !== context.attemptId) throw new Error('wrong attempt')
          if (ended) throw new Error('fixture ended')
          if (event.kind === 'ended' || event.kind === 'failed') { ended = true; confirmed = event.kind === 'ended' || event.confirmedEnded }
          if (resolveNext) { const resolve = resolveNext; resolveNext = undefined; resolve(event) }
          else queue.push(event)
          if (ended) active.delete(handle)
        },
        abortUnknown() { ended = true; active.delete(handle); resolveNext?.(undefined) },
      }
      active.add(handle)
      return handle
    },
    async close() { closed = true; for (const handle of active) handle.abortUnknown(); active.clear() },
    get activeCount() { return active.size },
  }
}
