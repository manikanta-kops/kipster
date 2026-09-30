import { pathToFileURL } from 'node:url'
import type { AdapterHost, AdapterReadiness, MaintenanceCapableAdapter, TextExecutionAdapter, AdapterExecutionContext as ExecutionContext, RecoveryReference } from '../adapter-api/index.js'

type Message = { config?: Readonly<Record<string, unknown>>; dataDirectory?: string; kind: string; requestId?: number | undefined; attemptId?: string; value?: unknown; error?: string; context?: ExecutionContext; recoveryRef?: RecoveryReference; entry?: string; callId?: string; name?: string; arguments?: unknown; threadIds?: string[] }
let adapter: TextExecutionAdapter | undefined
let creating: Promise<TextExecutionAdapter> | undefined
let closing = false
let closed: Promise<void> | undefined
function closeAdapter(): Promise<void> {
  closing = true
  return closed ??= (async () => {
    // Own the candidate before readiness starts, including a factory still resolving.
    if (creating) adapter ??= await creating.catch(() => undefined)
    await adapter?.close()
  })()
}
let nextId = 0
const pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void }>()
const handles = new Map<string, Awaited<ReturnType<TextExecutionAdapter['execute']>>>()
function send(message: Message): Promise<void> {
  if (!process.connected || !process.send) return Promise.reject(new Error('Core IPC is disconnected'))
  return new Promise((resolve, reject) => {
    try { process.send!(message, error => error ? reject(error) : resolve()) }
    catch (error) { reject(error) }
  })
}
process.on('disconnect', () => {
  for (const waiting of pending.values()) waiting.reject(new Error('Core IPC disconnected before tool acknowledgement'))
  pending.clear()
  void closeAdapter().catch(() => undefined)
})
function host(dataDirectory?: string): AdapterHost {
  return {
    ...(dataDirectory ? { dataDirectory } : {}),
    now: () => new Date().toISOString(),
    invokeTool(request) {
      return new Promise((resolve, reject) => {
        const requestId = ++nextId
        pending.set(requestId, { resolve, reject })
        void send({ kind: 'tool', requestId, ...request }).catch(error => {
          if (pending.delete(requestId)) reject(error)
        })
      })
    },
  }
}
process.on('message', (raw: Message) => {
  if (raw.kind === 'tool-result' && raw.requestId !== undefined) {
    const waiting = pending.get(raw.requestId)
    pending.delete(raw.requestId)
    if (raw.error) waiting?.reject(new Error(raw.error))
    else waiting?.resolve(raw.value)
    return
  }
  void (async () => {
    const requestId = raw.requestId
    try {
      if (raw.kind === 'initialize') {
        if (!raw.entry) throw new Error('Adapter entry is required')
        const module: unknown = await import(pathToFileURL(raw.entry).href)
        if (closing) throw new Error('Adapter initialization cancelled')
        const factory = (module as { createAdapter?: (host: AdapterHost, config?: Readonly<Record<string, unknown>>) => Promise<TextExecutionAdapter> | TextExecutionAdapter }).createAdapter
        if (typeof factory !== 'function') throw new Error('Missing createAdapter factory')
        creating = Promise.resolve(factory(host(raw.dataDirectory), raw.config))
        const candidate = await creating
        adapter = candidate
        if (closing) { await closeAdapter(); throw new Error('Adapter initialization cancelled') }
        let readiness: AdapterReadiness
        try {
          if (candidate.contractMajor !== 1 || !candidate.id || !candidate.version) throw new Error('Adapter contract mismatch')
          if (typeof candidate.readiness !== 'function') throw new Error('Adapter readiness is required')
          readiness = await candidate.readiness()
          if (closing) throw new Error('Adapter initialization cancelled')
          if (!readiness.ready) throw new Error(readiness.reason ?? 'Adapter is not ready')
        } catch (error) { await closeAdapter().catch(() => undefined); throw error }
        adapter = candidate
        await send({ kind: 'reply', requestId, value: { id: candidate.id, version: candidate.version, contractMajor: candidate.contractMajor, readiness } })
      } else if (raw.kind === 'execute') {
        if (!adapter || !raw.context) throw new Error('Adapter not ready')
        const handle = await (raw.context.kind === 'maintenance' ? (adapter as MaintenanceCapableAdapter).execute(raw.context) : adapter.execute(raw.context))
        handles.set(raw.context.attemptId, handle)
        await send({ kind: 'reply', requestId, value: true })
        void (async () => {
          try {
            for await (const event of handle.events) await send({ kind: 'event', attemptId: raw.context!.attemptId, value: event })
            await send({ kind: 'stream-end', attemptId: raw.context!.attemptId })
          } catch (error) { await send({ kind: 'stream-error', attemptId: raw.context!.attemptId, error: String(error) }).catch(() => undefined) }
          finally { handles.delete(raw.context!.attemptId) }
        })()
      } else if (raw.kind === 'cancel' || raw.kind === 'reconcile') {
        const handle = raw.attemptId ? handles.get(raw.attemptId) : undefined
        if (!handle) throw new Error('Attempt is not owned by this runner')
        await send({ kind: 'reply', requestId, value: raw.kind === 'cancel' ? await handle.cancel() : await handle.reconcile() })
      } else if (raw.kind === 'readiness') {
        if (!adapter || typeof adapter.readiness !== 'function') throw new Error('Adapter not ready')
        let readiness: unknown
        try { readiness = await adapter.readiness() } catch (error) { readiness = { ready: false, reason: error instanceof Error ? error.message : String(error) } }
        await send({ kind: 'reply', requestId, value: readiness })
      } else if (raw.kind === 'durable-reconcile') {
        if (!adapter || !raw.recoveryRef) throw new Error('Adapter not ready')
        if (typeof adapter.durableReconcile !== 'function') throw new Error('durable reconcile unsupported')
        await send({ kind: 'reply', requestId, value: await adapter.durableReconcile({ recoveryRef: raw.recoveryRef }) })
      } else if (raw.kind === 'forget-provider-state') {
        if (!adapter || !Array.isArray(raw.threadIds)) throw new Error('Adapter not ready')
        if (typeof adapter.forgetProviderState !== 'function') { await send({ kind: 'reply', requestId, value: 'unsupported' }); return }
        await adapter.forgetProviderState({ threadIds: raw.threadIds })
        await send({ kind: 'reply', requestId, value: 'forgotten' })
      } else if (raw.kind === 'close') {
        await closeAdapter()
        await send({ kind: 'reply', requestId, value: true })
        process.exitCode = 0
        process.disconnect?.()
      }
    } catch (error) { await send({ kind: 'reply', requestId, error: String(error) }).catch(() => undefined) }
  })()
})
