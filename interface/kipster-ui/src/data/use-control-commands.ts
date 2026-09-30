import { sameScope, sameControlIdentity } from './settings'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { controlJournal, type ControlIntent } from './control-journal'
import type {
  ControlClient,
  ControlOperation,
  ControlReceipt,
} from './settings'
export function useControlCommands(
  scope: string,
  client: ControlClient | undefined,
) {
  const [entries, setEntries] = useState<ControlIntent[]>([])
  const [error, setError] = useState('')
  const ready = useRef(false)
  const [restart, setRestart] = useState(0)
  const controller = useRef(new AbortController())
  const busy = useRef(new Set<string>())
  // Explicit retries await shared reads; polling cannot interleave another read
  // between that lookup and the retry's fresh journal claim.
  const lookups = useRef(new Map<string, Promise<void>>())
  const retries = useRef(new Set<string>())
  useEffect(() => {
    ready.current = false
    const abort = new AbortController()
    controller.current = abort
    const observer = liveQuery(() => controlJournal.list(scope)).subscribe({
      next: (v) => {
        ready.current = true
        setEntries(v)
        setError('')
      },
      error: () => {
        ready.current = false
        setError(
          'Local settings and inbox recovery is unavailable. Retry loading before sending controls.',
        )
      },
    })
    return () => {
      abort.abort()
      observer.unsubscribe()
    }
  }, [scope, restart])
  async function settle(
    item: ControlIntent,
    receipt: ControlReceipt,
    signal: AbortSignal,
  ) {
    if (signal.aborted || receipt.status === 'unknown') return
    if (
      receipt.operationId !== item.id ||
      !sameScope(receipt.target, item.operation.target) ||
      !sameControlIdentity(receipt.operation, item.operation)
    )
      throw new Error('Operation receipt target changed.')
    await controlJournal.transition(item, receipt.status, receipt)
  }
  function reconcile(
    item: ControlIntent,
    signal = controller.current.signal,
    explicit = false,
  ): Promise<void> {
    const existing = lookups.current.get(item.id)
    if (existing) return existing
    if (
      !client ||
      signal.aborted ||
      busy.current.has(item.id) ||
      (!explicit && retries.current.has(item.id))
    )
      return Promise.resolve()
    const lookup = (async () => {
      try {
        if (item.state === 'sending' && Date.now() - item.updatedAt >= 20000)
          item = (await controlJournal.transition(item, 'uncertain')) ?? item
        await settle(item, await client.receipt(item.operation, signal), signal)
      } catch {
        /* Absence and failed reads leave evidence unresolved. */
      }
    })()
    lookups.current.set(item.id, lookup)
    void lookup.finally(() => {
      if (lookups.current.get(item.id) === lookup)
        lookups.current.delete(item.id)
    })
    return lookup
  }
  useEffect(() => {
    const unresolved = entries.filter((e) =>
      ['sending', 'uncertain'].includes(e.state),
    )
    for (const entry of unresolved) void reconcile(entry)
    const timer = setInterval(() => {
      for (const entry of unresolved) void reconcile(entry)
    }, 5000)
    return () => clearInterval(timer)
    // Reconciliation only reads receipts. Writes require an explicit action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, client])
  async function dispatch(
    item: ControlIntent,
    signal = controller.current.signal,
  ) {
    if (
      !client ||
      signal.aborted ||
      busy.current.has(item.id) ||
      (item.state === 'sending' && Date.now() - item.updatedAt < 20000)
    )
      return
    busy.current.add(item.id)
    try {
      const claimed = await controlJournal.transition(item, 'sending')
      if (!claimed || signal.aborted) return
      try {
        const receipt = await client.command(claimed.operation, signal)
        if (receipt.status === 'unknown')
          await controlJournal.transition(claimed, 'uncertain')
        else await settle(claimed, receipt, signal)
      } catch {
        await controlJournal.transition(claimed, 'uncertain')
      }
    } catch {
      setError(
        'Settings or read operation state could not be saved. Check the original outcome before retrying.',
      )
    } finally {
      busy.current.delete(item.id)
    }
  }
  return {
    entries,
    error,
    reload: () => setRestart((v) => v + 1),
    async send(operation: ControlOperation) {
      if (!client || !ready.current || controller.current.signal.aborted)
        throw new Error('Settings and inbox service is unavailable.')
      const signal = controller.current.signal
      const item = await controlJournal.reserve(scope, operation)
      await dispatch(item, signal)
    },
    async retry(item: ControlIntent) {
      if (retries.current.has(item.id)) return
      retries.current.add(item.id)
      const signal = controller.current.signal
      try {
        await reconcile(item, signal, true)
        const current = (await controlJournal.list(scope)).find(
          (e) => e.id === item.id,
        )
        if (
          !signal.aborted &&
          current &&
          ['reserved', 'uncertain', 'sending'].includes(current.state)
        )
          await dispatch(current, signal)
      } catch {
        setError(
          'Local settings and inbox recovery could not be read. The original command is retained; retry loading recovery.',
        )
      } finally {
        retries.current.delete(item.id)
      }
    },
    check: (item: ControlIntent) => reconcile(item),
  }
}
