import { useContext, useEffect, useRef, useState } from 'react'
import { WorkspaceContext } from './workspace-context'
import {
  CommandError,
  type CommandResult,
  type WorkspaceOperation,
} from './management'
import { managementJournal, type PendingManagement } from './management-journal'
import type { WorkspaceSnapshot } from './directory'

export function useManagement(data: WorkspaceSnapshot) {
  const client = useContext(WorkspaceContext)!
  const scope = JSON.stringify([
    client.connectionKey,
    data.installationId,
    data.currentHumanId,
  ])
  const actorScope = {
    installationId: data.installationId,
    callerId: data.currentHumanId,
  }
  const [pending, setPending] = useState<PendingManagement | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const lock = useRef(false)
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    let cancelled = false
    void managementJournal.read(scope).then(
      (value) => {
        if (!cancelled) {
          setPending(value)
          setReady(true)
        }
      },
      () => {
        if (!cancelled)
          setError(
            'Recovery storage is unavailable. Management is disabled; navigation still works.',
          )
      },
    )
    return () => {
      cancelled = true
      alive.current = false
    }
  }, [scope])
  async function transition(
    expected: PendingManagement | null,
    next: PendingManagement | null,
  ) {
    const result = await managementJournal.transition(scope, expected, next)
    if (alive.current) setPending(result.current)
    return result
  }
  async function reconcile(result: CommandResult, entry: PendingManagement) {
    if (
      result.commandId !== entry.command.commandId ||
      result.installationId !== entry.command.installationId ||
      result.callerId !== entry.command.callerId
    )
      throw new CommandError(
        'The acknowledgement belongs to another context. The original outcome remains unknown.',
        'unknown',
        'scope-mismatch',
      )
    const operationType = entry.command.operation.type
    if (
      ['agent.create', 'organization.create'].includes(operationType) &&
      !result.resourceId
    )
      throw new CommandError(
        'The created identity was not acknowledged. Check the original request.',
        'unknown',
        'missing-identity',
      )
    const completion = await transition(entry, null)
    if (alive.current && completion.applied) {
      setNotice(
        result.alreadyApplied
          ? `${entry.label} was already saved by the earlier request.`
          : `${entry.label} saved.`,
      )
    }
  }

  async function perform(
    entry: PendingManagement,
    expected: PendingManagement | null = null,
  ) {
    if (!client.management || lock.current) return false
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const reserved = await transition(expected, entry)
      if (!reserved.applied || !reserved.current) {
        setError(
          'This recovery step changed in another tab. The current outcome is shown; no request was sent.',
        )
        lock.current = false
        setBusy(false)
        return false
      }
      entry = reserved.current // Dispatch only the exact atomically reserved revision.
    } catch {
      setError(
        'Could not save recovery information. No request was sent. Your input is retained. Storage may be unavailable, or another tab has a pending request; reload to recover it.',
      )
      lock.current = false
      setBusy(false)
      return false
    }
    try {
      const result = await client.management.execute(
        entry.command,
        new AbortController().signal,
      )
      await reconcile(result, entry)
      return true
    } catch (cause) {
      const rejected =
        cause instanceof CommandError && cause.outcome === 'rejected'
      const message =
        cause instanceof Error
          ? cause.message
          : 'The request outcome is unknown.'
      await transition(entry, {
        ...entry,
        state: rejected ? 'rejected' : 'unknown',
        message,
      }).catch(() => {
        if (alive.current)
          setError(
            'Recovery update failed. The original request remains saved as unresolved.',
          )
      })
      return false
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }
  return {
    pending,
    busy,
    ready,
    error,
    notice,
    available: !!client.management,
    async submit(operation: WorkspaceOperation, label: string) {
      if (!ready || pending || lock.current) return false
      return perform({
        scope,
        journalId: crypto.randomUUID(),
        command: { ...actorScope, commandId: crypto.randomUUID(), operation },
        label,
        state: 'unknown',
        message:
          'Waiting for acknowledgement. Closing this dialog does not cancel the request.',
      })
    },
    check: () =>
      pending && pending.state === 'unknown' && perform(pending, pending),
    async dismissRejected() {
      if (!pending || pending.state !== 'rejected' || busy) return
      try {
        await transition(pending, null)
      } catch {
        setError(
          'Recovery storage could not be updated. The saved request is retained.',
        )
      }
    },
  }
}
