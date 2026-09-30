import { targetIdentity } from '../../data/media'
import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import {
  conversationStorage,
  type PendingSubmission,
  type Draft,
} from '../../data/conversation-storage'
import type { ConversationClient, Submission } from '../../data/conversations'

export function useOutbox(
  scope: string,
  client: ConversationClient | undefined,
) {
  const [entries, setEntries] = useState<PendingSubmission[]>([])
  const [error, setError] = useState('')
  const active = useRef(new Map<string, Promise<void>>())
  const controller = useRef(new AbortController())
  useEffect(() => {
    const abort = new AbortController()
    controller.current = abort
    const sub = liveQuery(() => conversationStorage.list(scope)).subscribe({
      next: setEntries,
      error: () =>
        setError(
          'Local send history is unavailable. Messages cannot be sent safely.',
        ),
    })
    return () => {
      abort.abort()
      sub.unsubscribe()
    }
  }, [scope])
  async function settle(
    entry: PendingSubmission,
    receipt: Awaited<ReturnType<ConversationClient['receipt']>>,
  ) {
    if (receipt.status === 'unknown' || controller.current.signal.aborted)
      return
    if (
      receipt.status === 'accepted' &&
      targetIdentity(receipt.target) !== targetIdentity(entry.submission.target)
    )
      throw new Error('Receipt target does not match original submission.')
    await conversationStorage.transition(entry, receipt.status, receipt)
  }
  async function reconcile(entry: PendingSubmission) {
    if (!client || controller.current.signal.aborted) return
    const existing = active.current.get(entry.id)
    if (existing) return existing
    const task = (async () => {
      try {
        if (
          entry.state === 'sending' &&
          Date.now() - entry.updatedAt >= 20_000
        ) {
          const updated = await conversationStorage.transition(
            entry,
            'uncertain',
          )
          if (!updated.applied || !updated.current) return
          entry = updated.current
        }
        const receipt = await client.receipt(
          entry.submission.target,
          entry.id,
          controller.current.signal,
          entry.submission.target,
        )
        await settle(entry, receipt)
      } catch {
        /* Failed lookup is not evidence of rejection. */
      }
    })()
    active.current.set(entry.id, task)
    await task
    if (active.current.get(entry.id) === task) active.current.delete(entry.id)
  }
  useEffect(() => {
    const unresolved = entries.filter(
      (e) => e.state === 'uncertain' || e.state === 'sending',
    )
    for (const entry of unresolved) void reconcile(entry)
    const timer = setInterval(() => {
      for (const entry of unresolved) void reconcile(entry)
    }, 5000)
    return () => clearInterval(timer)
    // Read-only reconciliation is safe on reconnect; dispatch is always explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, client])
  async function dispatch(entry: PendingSubmission) {
    if (
      !client ||
      controller.current.signal.aborted ||
      active.current.has(entry.id)
    )
      return
    if (entry.state === 'sending' && Date.now() - entry.updatedAt < 20_000)
      return
    const task = (async () => {
      try {
        // Claiming is atomic across tabs and cannot resurrect settled records.
        const claim = await conversationStorage.transition(entry, 'sending')
        if (!claim.applied || !claim.current) return
        const current = claim.current
        try {
          const receipt = await client.submit(
            current.submission,
            controller.current.signal,
          )
          if (receipt.status === 'unknown')
            await conversationStorage.transition(current, 'uncertain')
          else await settle(current, receipt)
        } catch {
          await conversationStorage.transition(current, 'uncertain')
        }
      } catch {
        setError(
          'Send state could not be saved. Check the original outcome before retrying.',
        )
      }
    })()
    active.current.set(entry.id, task)
    await task
    if (active.current.get(entry.id) === task) active.current.delete(entry.id)
  }
  return {
    entries,
    error,
    async send(submission: Submission, draft: Draft | undefined) {
      const reservation = await conversationStorage.reserve(
        scope,
        submission,
        draft,
      )
      void dispatch(reservation.value)
      return reservation
    },
    async retry(entry: PendingSubmission) {
      if (
        entry.state === 'accepted' ||
        entry.state === 'rejected' ||
        entry.state === 'discarded'
      )
        return
      await reconcile(entry)
      const current = (await conversationStorage.list(scope)).find(
        (e) => e.id === entry.id,
      )
      if (current && ['unsent', 'uncertain', 'sending'].includes(current.state))
        await dispatch(current)
    },
    async discard(entry: PendingSubmission) {
      if (entry.state === 'unsent' || entry.state === 'rejected')
        await conversationStorage.transition(entry, 'discarded')
    },
  }
}
