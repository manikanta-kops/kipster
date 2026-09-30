import { useEffect, useState } from 'react'
import type { Directory } from '../../data/directory'
import { Panel } from '../settings/Panel'

type Action = 'archive' | 'restore' | 'delete-agent' | 'delete-organization'
const actionLabels: Record<Action, string> = {
  archive: 'archive',
  restore: 'restore',
  'delete-agent': 'delete',
  'delete-organization': 'delete',
}
type Request = {
  operationId: string
  action: Action
  id: string
  name: string
  copy: boolean
  state: string
  detail: string
}
const terminal = (r: Request) =>
  ['succeeded', 'failed', 'rejected'].includes(r.state)

/** Receipts track progress only. Directory state always comes from Core's snapshot/stream. */
export function LifecyclePanel({
  endpoint,
  scope,
  directory,
  close,
  history,
  archiveAgentId,
}: {
  archiveAgentId?: string
  endpoint: string
  scope: string
  directory: Directory
  close: () => void
  history: (agentId: string, organizationId: string) => void
}) {
  const storageKey = `kipster-lifecycle:${scope}`
  const [requests, setRequests] = useState<Request[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '[]') as Request[]
    } catch {
      return []
    }
  })
  const [confirmation, setConfirmation] = useState<{
    action: Action
    id: string
    name: string
  } | null>(() => {
    const a = archiveAgentId ? directory.agents[archiveAgentId] : undefined
    return a && !a.admin && a.lifecycle === 'active'
      ? { action: 'archive', id: a.id, name: a.name }
      : null
  })
  const [typed, setTyped] = useState('')
  const [copy, setCopy] = useState(false)
  const [error, setError] = useState('')
  const update = (next: Request) =>
    setRequests((old) => {
      const current = old.find((r) => r.operationId === next.operationId)
      // An unchanged receipt must not restart the effect and bypass its delay.
      if (
        !current ||
        (current.state === next.state && current.detail === next.detail)
      )
        return old
      return old.map((r) => (r.operationId === next.operationId ? next : r))
    })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(requests))
    } catch {
      // Storage failure is an external-system error that must remain visible.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(
        'Operation progress could not be saved on this device. Keep this panel open to check the outcome.',
      )
    }
  }, [requests, storageKey])
  useEffect(() => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      for (const request of requests.filter((r) => !terminal(r))) {
        if (abort.signal.aborted) return
        try {
          // Repeating the same request recovers a lost acknowledgement without a second action.
          if (request.state === 'unconfirmed') {
            const agent = request.action !== 'delete-organization'
            const path = `/v1/${agent ? 'agents' : 'organizations'}/${encodeURIComponent(request.id)}${['archive', 'restore'].includes(request.action) ? '/' + request.action : ''}`
            const response = await fetch(endpoint + path, {
              method: ['archive', 'restore'].includes(request.action)
                ? 'POST'
                : 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                version: 1,
                operationId: request.operationId,
                ...(request.action === 'delete-agent'
                  ? { copyFilesToOrganizations: request.copy }
                  : {}),
              }),
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(15000),
              ]),
            })
            const result = await response.json()
            if (abort.signal.aborted) return
            if (!response.ok) {
              if (response.status >= 400 && response.status < 500)
                update({
                  ...request,
                  state: 'rejected',
                  detail:
                    result.message ?? result.code ?? 'Change not accepted.',
                })
              else throw new Error('Core has not confirmed the outcome.')
              continue
            }
            if (result.operationId !== request.operationId)
              throw new Error('Unexpected operation receipt.')
          }
          const response = await fetch(
            `${endpoint}/v1/operations/${encodeURIComponent(request.operationId)}`,
            {
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(15000),
              ]),
              cache: 'no-store',
            },
          )
          if (!response.ok)
            throw new Error(
              'Progress is unavailable. The saved request will be checked again.',
            )
          const status = await response.json()
          if (
            status.operationId !== request.operationId ||
            !['pending', 'running', 'waiting', 'succeeded', 'failed'].includes(
              status.state,
            )
          )
            throw new Error('Unexpected operation status.')
          if (!abort.signal.aborted)
            update({
              ...request,
              state: status.state,
              detail:
                status.error ??
                status.waitingFor ??
                (status.state === 'succeeded'
                  ? 'Complete.'
                  : (status.step ?? 'Waiting for Core.')),
            })
        } catch (cause) {
          if (!abort.signal.aborted)
            setError(
              cause instanceof Error
                ? cause.message
                : 'Outcome unconfirmed. Checking again.',
            )
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 1500)
    }
    void poll()
    return () => {
      abort.abort()
      clearTimeout(timer)
    }
  }, [endpoint, requests])
  function confirm(action: Action, id: string, name: string) {
    setConfirmation({ action, id, name })
    setTyped('')
    setCopy(false)
  }
  function submit() {
    if (!confirmation) return
    const request: Request = {
      ...confirmation,
      operationId: crypto.randomUUID(),
      copy,
      state: 'unconfirmed',
      detail: 'Checking outcome…',
    }
    const next = [...requests, request]
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      setError('Could not save this request. Nothing was sent.')
      return
    }
    setRequests(next)
    setConfirmation(null)
    setError('')
  }
  const busy = (id: string) => requests.some((r) => r.id === id && !terminal(r))
  return (
    <Panel
      className="settings-panel lifecycle-panel"
      title="Archive & deletion"
      subtitle="Manage kips and organizations"
      close={close}
    >
      <div className="settings-content lifecycle-content">
        {error && <p role="alert">{error}</p>}
        {confirmation && (
          <form
            className="management-form"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <h3>
              {confirmation.action === 'archive'
                ? 'Move to Archive'
                : confirmation.action === 'restore'
                  ? 'Restore kip'
                  : 'Delete permanently'}
              : {confirmation.name}
            </h3>
            <p>
              {confirmation.action === 'archive'
                ? 'Stops work and learning. Chats remain readable, and you can restore this kip.'
                : confirmation.action === 'restore'
                  ? 'Makes this kip available again. Stopped work stays stopped.'
                  : confirmation.action === 'delete-agent'
                    ? 'Removes this kip’s chats, memory and files permanently.'
                    : 'Removes this organization’s chats and owned data permanently. Global kips stay.'}
            </p>
            {confirmation.action.startsWith('delete') && (
              <label>
                Type {confirmation.name} to confirm
                <input
                  aria-label="Type name to confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
            {confirmation.action === 'delete-agent' && (
              <label>
                <input
                  type="checkbox"
                  checked={copy}
                  onChange={(e) => setCopy(e.target.checked)}
                />
                Copy files shared in organization chats into their organizations
              </label>
            )}
            <button
              className="secondary-button"
              disabled={
                confirmation.action.startsWith('delete') &&
                typed !== confirmation.name
              }
            >
              Confirm{' '}
              {confirmation.action === 'archive'
                ? 'archive'
                : confirmation.action === 'restore'
                  ? 'restore'
                  : 'permanent deletion'}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </button>
          </form>
        )}
        <h3>Archive</h3>
        {!Object.values(directory.agents).some(
          (a) => a.lifecycle === 'archived',
        ) && <p>No archived kips.</p>}
        {Object.values(directory.agents)
          .filter((a) => a.lifecycle === 'archived' && !a.admin)
          .map((a) => (
            <section className="management-row" key={a.id}>
              <div>
                <strong>{a.name}</strong>
                <p>Archived · History is read only</p>
                {Object.values(directory.organizations)
                  .filter((o) => o.lifecycle === 'active')
                  .map((o) => (
                    <button
                      key={o.id}
                      className="text-button"
                      onClick={() => history(a.id, o.id)}
                    >
                      History in {o.name}
                    </button>
                  ))}
              </div>
              <button
                disabled={busy(a.id)}
                className="secondary-button"
                onClick={() => confirm('restore', a.id, a.name)}
              >
                Restore {a.name}
              </button>
              <button
                disabled={busy(a.id)}
                className="text-button danger"
                onClick={() => confirm('delete-agent', a.id, a.name)}
              >
                Delete {a.name} permanently
              </button>
            </section>
          ))}
        <h3>Active kips</h3>
        {Object.values(directory.agents)
          .filter((a) => a.lifecycle === 'active' && !a.admin)
          .map((a) => (
            <div className="management-row" key={a.id}>
              <strong>{a.name}</strong>
              <button
                disabled={busy(a.id)}
                className="text-button danger"
                onClick={() => confirm('archive', a.id, a.name)}
              >
                Delete {a.name}
              </button>
            </div>
          ))}
        <p>Delete moves a kip to Archive. Your main kip is protected.</p>
        <h3>Organizations</h3>
        {Object.values(directory.organizations)
          .filter((o) => o.lifecycle === 'active')
          .map((o) => (
            <div className="management-row" key={o.id}>
              <strong>{o.name}</strong>
              <button
                disabled={busy(o.id)}
                className="text-button danger"
                onClick={() => confirm('delete-organization', o.id, o.name)}
              >
                Delete {o.name}
              </button>
            </div>
          ))}
        <section aria-label="Operation progress">
          <h3>Operation progress</h3>
          {requests.map((r) => (
            <div className="management-callout" key={r.operationId}>
              <strong>
                {r.name} · {actionLabels[r.action]} · {r.state}
              </strong>
              <p>{r.detail}</p>
              {r.state === 'waiting' && (
                <p>
                  Cleanup will continue when Core confirms the outstanding work
                  has ended.
                </p>
              )}
            </div>
          ))}
        </section>
      </div>
    </Panel>
  )
}
