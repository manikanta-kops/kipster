import { sameWorkTarget } from '../../data/work-target'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { workJournal, type WorkIntent } from '../../data/work-journal'
import type { WorkClient, WorkOperation, WorkReceipt } from '../../data/work'
export function useWorkCommands(scope: string, client: WorkClient | undefined) {
  const [entries, setEntries] = useState<WorkIntent[]>([])
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
    const observer = liveQuery(() => workJournal.list(scope)).subscribe({
      next: (v) => {
        ready.current = true
        setEntries(v)
        setError('')
      },
      error: () => {
        ready.current = false
        setError(
          'Local work recovery is unavailable. Retry loading before sending controls.',
        )
      },
    })
    return () => {
      abort.abort()
      observer.unsubscribe()
    }
  }, [scope, restart])
  async function settle(
    item: WorkIntent,
    receipt: WorkReceipt,
    signal: AbortSignal,
  ) {
    if (signal.aborted || receipt.status === 'unknown') return
    if (
      receipt.operationId !== item.id ||
      !sameWorkTarget(receipt.target, item.operation.target)
    )
      throw new Error('Work receipt target changed.')
    await workJournal.transition(item, receipt.status, receipt)
  }
  function reconcile(
    item: WorkIntent,
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
          item = (await workJournal.transition(item, 'uncertain')) ?? item
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
    item: WorkIntent,
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
      const claimed = await workJournal.transition(item, 'sending')
      if (!claimed || signal.aborted) return
      try {
        const receipt = await client.command(claimed.operation, signal)
        if (receipt.status === 'unknown')
          await workJournal.transition(claimed, 'uncertain')
        else await settle(claimed, receipt, signal)
      } catch {
        await workJournal.transition(claimed, 'uncertain')
      }
    } catch {
      setError(
        'Work command state could not be saved. Check the original outcome before retrying.',
      )
    } finally {
      busy.current.delete(item.id)
    }
  }
  return {
    entries,
    error,
    reload: () => setRestart((v) => v + 1),
    async send(operation: WorkOperation) {
      if (!client || !ready.current || controller.current.signal.aborted)
        throw new Error('Work service is unavailable.')
      const signal = controller.current.signal
      const item = await workJournal.reserve(scope, operation)
      await dispatch(item, signal)
    },
    async retry(item: WorkIntent) {
      if (retries.current.has(item.id)) return
      retries.current.add(item.id)
      const signal = controller.current.signal
      try {
        await reconcile(item, signal, true)
        const current = (await workJournal.list(scope)).find(
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
          'Local work recovery could not be read. The original command is retained; retry loading recovery.',
        )
      } finally {
        retries.current.delete(item.id)
      }
    },
    check: (item: WorkIntent) => reconcile(item),
    dismiss: (item: WorkIntent) => workJournal.dismiss(item),
  }
}
