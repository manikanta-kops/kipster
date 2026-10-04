import { useEffect, useState } from 'react'
import type { Directory } from '../../data/directory'
import { Icon } from '../../components/Icon'
import { KipAvatar, type KipLook } from '../settings/KipAvatar'
import { Block, Callout, Confirm, Glyph, Row } from '../settings/ui'

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

/**
 * Archive, restore and permanent deletion, as a Settings page. Receipts track progress only;
 * directory state always comes from Core's snapshot and stream.
 */
export function ArchiveSettings({
  endpoint,
  scope,
  directory,
  history,
  look,
}: {
  endpoint: string
  scope: string
  directory: Directory
  history: (agentId: string, organizationId: string) => void
  look: (agentId: string) => KipLook
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
  } | null>(null)
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
          // An unknown state is shown as reported and checked again, like any unfinished one.
          if (
            status.operationId !== request.operationId ||
            typeof status.state !== 'string'
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
  const agents = Object.values(directory.agents)
  const organizations = Object.values(directory.organizations).filter(
    (o) => o.lifecycle === 'active',
  )
  const archived = agents.filter((a) => a.lifecycle === 'archived' && !a.admin)
  const active = agents
    .filter((a) => a.lifecycle === 'active')
    .sort((a, b) => Number(b.admin) - Number(a.admin))
  const deleting = confirmation?.action.startsWith('delete')
  return (
    <>
      {error && (
        <Callout tone="danger" alert>
          {error}
        </Callout>
      )}
      <Block
        label="Archived kips"
        foot="Archived kips stop working and learning. Their chats stay readable."
      >
        {!archived.length ? (
          <Row label={<span className="set-muted">No archived kips</span>} />
        ) : (
          archived.map((a) => (
            <Row
              key={a.id}
              lead={<KipAvatar look={look(a.id)} />}
              label={a.name}
              sub={
                <>
                  <span className="set-line">
                    Archived · History is read only
                  </span>
                  {organizations.length > 0 && (
                    <span className="set-line set-links">
                      {organizations.map((o) => (
                        <button
                          key={o.id}
                          className="set-link"
                          onClick={() => history(a.id, o.id)}
                        >
                          History in {o.name}
                        </button>
                      ))}
                    </span>
                  )}
                </>
              }
              control={
                <>
                  <button
                    className="set-button"
                    aria-label={`Restore ${a.name}`}
                    disabled={busy(a.id)}
                    onClick={() => confirm('restore', a.id, a.name)}
                  >
                    Restore
                  </button>
                  <button
                    className="set-button danger"
                    aria-label={`Delete ${a.name} permanently`}
                    disabled={busy(a.id)}
                    onClick={() => confirm('delete-agent', a.id, a.name)}
                  >
                    Delete…
                  </button>
                </>
              }
            />
          ))
        )}
      </Block>
      <Block
        label="Active kips"
        foot="Archive first, then delete from the archive if you need to."
      >
        {active.map((a) => (
          <Row
            key={a.id}
            lead={<KipAvatar look={look(a.id)} />}
            label={a.name}
            sub={
              a.admin ? 'Your main kip is protected' : look(a.id).description
            }
            control={
              a.admin ? (
                <span className="set-protected" title="Protected">
                  <Icon name="shield" />
                </span>
              ) : (
                <button
                  className="set-button"
                  aria-label={`Archive ${a.name}`}
                  disabled={busy(a.id)}
                  onClick={() => confirm('archive', a.id, a.name)}
                >
                  Archive…
                </button>
              )
            }
          />
        ))}
      </Block>
      {organizations.length > 0 && (
        <Block label="Organizations">
          {organizations.map((o) => (
            <Row
              key={o.id}
              lead={
                <Glyph icon="organization" hue="var(--hue-ocean)" size={30} />
              }
              label={o.name}
              sub="Removes its chats and owned data. Global kips stay."
              control={
                <button
                  className="set-button danger"
                  aria-label={`Delete ${o.name}`}
                  disabled={busy(o.id)}
                  onClick={() => confirm('delete-organization', o.id, o.name)}
                >
                  Delete…
                </button>
              }
            />
          ))}
        </Block>
      )}
      {requests.length > 0 && (
        <Block label="Progress" region="Operation progress">
          {requests.map((r) => (
            <Row
              key={r.operationId}
              label={`${r.name} · ${actionLabels[r.action]} · ${r.state}`}
              sub={
                <>
                  <span className="set-line">{r.detail}</span>
                  {r.state === 'waiting' && (
                    <span className="set-line">
                      Cleanup will continue when Core confirms the outstanding
                      work has ended.
                    </span>
                  )}
                </>
              }
            />
          ))}
        </Block>
      )}
      {confirmation && (
        <Confirm
          title={
            confirmation.action === 'archive'
              ? `Archive ${confirmation.name}?`
              : confirmation.action === 'restore'
                ? `Restore ${confirmation.name}?`
                : `Delete ${confirmation.name} permanently?`
          }
          cancel={() => setConfirmation(null)}
        >
          <form
            className="set-confirm-form"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <p>
              {confirmation.action === 'archive'
                ? 'Stops work and learning. Chats remain readable, and you can restore this kip.'
                : confirmation.action === 'restore'
                  ? 'Makes this kip available again. Stopped work stays stopped.'
                  : confirmation.action === 'delete-agent'
                    ? 'Removes this kip’s chats, memory and files permanently.'
                    : 'Removes this organization’s chats and owned data permanently. Global kips stay.'}
            </p>
            {deleting && (
              <label className="set-type-name">
                <span>
                  Type <b>{confirmation.name}</b> to confirm
                </span>
                <input
                  aria-label="Type name to confirm"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                />
              </label>
            )}
            {confirmation.action === 'delete-agent' && (
              <label className="set-check">
                <input
                  type="checkbox"
                  checked={copy}
                  onChange={(e) => setCopy(e.target.checked)}
                />
                Copy files shared in organization chats into their organizations
              </label>
            )}
            <div className="set-confirm-actions">
              <button
                type="button"
                className="set-button"
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
              <button
                className={`set-button ${deleting ? 'danger solid' : 'primary'}`}
                disabled={deleting && typed !== confirmation.name}
              >
                Confirm{' '}
                {confirmation.action === 'archive'
                  ? 'archive'
                  : confirmation.action === 'restore'
                    ? 'restore'
                    : 'permanent deletion'}
              </button>
            </div>
          </form>
        </Confirm>
      )}
    </>
  )
}
