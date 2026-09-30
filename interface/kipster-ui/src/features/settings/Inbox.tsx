import { useRef, useState } from 'react'
import { Panel } from './Panel'
import type { useControlCommands } from '../../data/use-control-commands'
import type { WorkspaceSnapshot } from '../../data/directory'
type Controls = ReturnType<typeof useControlCommands>
import type { InboxNotification } from '../../data/settings'
import type { CallerScope } from '../../data/conversations'
import { Icon } from '../../components/Icon'

const kinds: Record<
  InboxNotification['kind'],
  { label: string; icon: 'chat' | 'hand' | 'check' | 'close' | 'refresh' }
> = {
  question: { label: 'Question', icon: 'chat' },
  approval: { label: 'Approval', icon: 'hand' },
  completion: { label: 'Completed', icon: 'check' },
  failure: { label: 'Failed', icon: 'close' },
  'recovery-needed': { label: 'Needs recovery', icon: 'refresh' },
}

function formatWhen(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const today = new Date().toDateString() === date.toDateString()
  return date.toLocaleString(
    undefined,
    today
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  )
}
export function Inbox({
  data,
  notifications,
  scope,
  commands,
  open,
  opener,
  close,
  routeStatus,
  availability,
}: {
  data: WorkspaceSnapshot
  notifications: InboxNotification[]
  scope: CallerScope
  commands: Controls
  open: (n: InboxNotification) => void
  opener?: HTMLElement | null
  close: () => void
  availability: string
  routeStatus: string
}) {
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [clearing, setClearing] = useState(false)
  const unread = notifications.filter((n) => !n.read).length
  const sending = useRef(new Set<string>())
  async function markRead(n: InboxNotification) {
    if (sending.current.has(n.id)) return
    sending.current.add(n.id)
    try {
      await commands.send({
        operationId: crypto.randomUUID(),
        target: { ...scope },
        action: 'read',
        notificationId: n.id,
      })
      setFailures((previous) => ({ ...previous, [n.id]: '' }))
      return true
    } catch {
      setFailures((previous) => ({
        ...previous,
        [n.id]:
          'Read update could not be saved locally. Nothing was sent. Retry Mark read after local storage is available.',
      }))
      return false
    } finally {
      sending.current.delete(n.id)
    }
  }
  return (
    <Panel
      title="Notifications"
      subtitle={unread ? `${unread} unread` : 'Nothing unread'}
      variant="popover"
      className="inbox-panel"
      opener={opener}
      close={close}
    >
      <div className="inbox-body">
        <div className="inbox-toolbar">
          <button
            className="text-button"
            disabled={!unread || clearing}
            onClick={async () => {
              setClearing(true)
              try {
                for (const notification of notifications.filter(
                  (n) => !n.read,
                )) {
                  const pending = commands.entries.find(
                    (e) =>
                      e.operation.notificationId === notification.id &&
                      !['accepted', 'rejected'].includes(e.state),
                  )
                  if (pending) await commands.retry(pending)
                  else await markRead(notification)
                }
              } finally {
                setClearing(false)
              }
            }}
          >
            {clearing ? 'Clearing…' : 'Clear all'}
          </button>
        </div>
        {routeStatus && (
          <output className="settings-callout" data-tone="wait">
            {routeStatus}
          </output>
        )}
        {availability && (
          <output className="settings-callout" data-tone="wait">
            {availability}
          </output>
        )}
        {!notifications.length && !availability && (
          <div className="inbox-empty">
            <span className="inbox-empty-mark" aria-hidden="true">
              <Icon name="check" weight="bold" />
            </span>
            <h3>You’re all caught up</h3>
            <p>
              Completions, questions, approvals and work that needs attention
              appear here.
            </p>
          </div>
        )}
        <ol className="inbox-list">
          {[...notifications]
            .sort(
              (a, b) =>
                b.createdAt.localeCompare(a.createdAt) ||
                a.id.localeCompare(b.id),
            )
            .map((n) => {
              const entry = commands.entries.find(
                (e) =>
                  e.operation.action === 'read' &&
                  e.operation.notificationId === n.id &&
                  !['accepted', 'rejected'].includes(e.state),
              )
              const rejected = commands.entries.find(
                (e) =>
                  e.operation.action === 'read' &&
                  e.operation.notificationId === n.id &&
                  e.state === 'rejected',
              )
              const context =
                n.context ??
                (n.target.context.kind === 'organization'
                  ? (data?.organizations.find(
                      (o) =>
                        n.target.context.kind === 'organization' &&
                        o.id === n.target.context.organizationId,
                    )?.name ?? n.target.context.organizationId)
                  : 'Installation')
              const kind = kinds[n.kind] ?? {
                label: n.kind.replaceAll('-', ' '),
                icon: 'chat' as const,
              }
              return (
                <li
                  key={n.id}
                  className={`inbox-item ${n.read ? 'read' : 'unread'}`}
                  data-kind={n.kind}
                  data-notification-id={n.id}
                >
                  <span className="inbox-glyph" aria-hidden="true">
                    <Icon name={kind.icon} weight="bold" />
                  </span>
                  <div className="inbox-main">
                    <div className="inbox-meta">
                      <span className="inbox-kind">{kind.label}</span>
                      <span>{context}</span>
                      <time dateTime={n.createdAt}>
                        {formatWhen(n.createdAt)}
                      </time>
                      <span className="sr-only">
                        {n.read ? 'Read' : 'Unread'}
                      </span>
                      {!n.read && (
                        <span className="unread-dot" aria-hidden="true" />
                      )}
                    </div>
                    <h3>{n.title}</h3>
                    {n.detail && <p className="inbox-detail">{n.detail}</p>}
                    <div className="inbox-actions">
                      <button
                        className="secondary-button"
                        aria-label="Open original context"
                        onClick={async () => {
                          if (n.read || (await markRead(n))) open(n)
                        }}
                      >
                        Open
                      </button>
                      {!n.read && (
                        <button
                          className="text-button"
                          disabled={!!entry}
                          onClick={() => void markRead(n)}
                        >
                          {failures[n.id] ? 'Retry Mark read' : 'Mark read'}
                        </button>
                      )}
                    </div>
                    {!n.read && failures[n.id] && (
                      <p role="alert">{failures[n.id]}</p>
                    )}
                    {rejected?.receipt &&
                      rejected.receipt.status !== 'unknown' && (
                        <p role="alert">{rejected.receipt.message}</p>
                      )}
                    {entry && (
                      <output className="settings-callout" data-tone="wait">
                        Read update {entry.state}.{' '}
                        <button
                          className="text-button"
                          onClick={() => void commands.retry(entry)}
                        >
                          Retry original read update
                        </button>
                      </output>
                    )}
                  </div>
                </li>
              )
            })}
        </ol>
        {commands.error && (
          <p role="alert">
            {commands.error}{' '}
            <button className="text-button" onClick={commands.reload}>
              Retry recovery storage
            </button>
          </p>
        )}
      </div>
    </Panel>
  )
}
