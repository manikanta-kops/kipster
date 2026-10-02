import { AnimatePresence, motion } from 'motion/react'
import { Panel } from '../settings/Panel'
import type { WorkspaceSnapshot } from '../../data/directory'
import {
  inboxSections,
  tone,
  when,
  type InboxNotification,
} from '../../data/notifications'
import { Icon } from '../../components/Icon'
import { Avatar } from '../chat/Message'
import type { Agent } from '../chat/model'

const badges = {
  needs: 'question',
  failed: 'close',
  done: 'check',
} as const
const leave = { opacity: 0, x: -8, transition: { duration: 0.2 } }

/** The kip's name in bold, then what happened. */
export function NotificationTitle({ n }: { n: InboxNotification }) {
  return n.title.startsWith(n.agent) ? (
    <>
      <b>{n.agent}</b>
      {n.title.slice(n.agent.length)}
    </>
  ) : (
    <>{n.title}</>
  )
}

export function NotificationAvatar({
  n,
  actors,
  kipId,
}: {
  n: InboxNotification
  actors: WorkspaceSnapshot['actorsById']
  kipId?: string
}) {
  const agent = actors[n.agentId] as Agent | undefined
  return (
    <Avatar
      name={agent?.name ?? n.agent}
      color={agent?.color}
      kip={!!kipId && n.agentId === kipId}
    />
  )
}

export function Inbox({
  items,
  actors,
  kipId,
  canClear,
  read,
  clear,
  open,
  opener,
  close,
  availability,
}: {
  items: InboxNotification[]
  actors: WorkspaceSnapshot['actorsById']
  kipId?: string
  canClear: boolean
  read: (ids: string[]) => void
  clear: (ids: string[]) => void
  open: (n: InboxNotification) => void
  opener?: HTMLElement | null
  close: () => void
  availability: string
}) {
  const { needs, updates } = inboxSections(items)
  const unread = items.filter((n) => !n.read)
  const clearable = items.filter((n) => !n.pending)
  const row = (n: InboxNotification, ids: string[]) => {
    const kind = tone(n)
    return (
      <motion.li
        key={n.id}
        layout="position"
        exit={leave}
        className={`note ${n.read && !n.pending ? 'read' : 'unread'}`}
        data-kind={n.kind}
        data-notification-id={n.id}
      >
        <button className="note-open" onClick={() => open(n)}>
          <span className="note-avatar">
            <NotificationAvatar n={n} actors={actors} kipId={kipId} />
            <span className={`kind-badge ${kind}`} aria-hidden="true">
              <Icon
                name={n.kind === 'approval' ? 'hand' : badges[kind]}
                weight="bold"
              />
            </span>
          </span>
          <span className="note-text">
            <span className="note-title">
              <NotificationTitle n={n} />
            </span>
            {n.body && <span className="note-body">{n.body}</span>}
            <span className="note-meta">
              {[
                n.thread && `“${n.thread}”`,
                n.context,
                ids.length > 1 && `${ids.length} updates`,
              ]
                .filter(Boolean)
                .join(' · ')}
              {' · '}
              <time dateTime={n.createdAt}>{when(n.createdAt)}</time>
            </span>
            <span className="sr-only">{n.read ? 'Read' : 'Unread'}</span>
          </span>
        </button>
        {n.pending && (
          <button className="note-reply" onClick={() => open(n)}>
            {n.kind === 'approval' ? 'Review' : 'Answer'}
          </button>
        )}
        <span className="note-side">
          {!n.read && <i className="udot" aria-hidden="true" />}
          {canClear && !n.pending && (
            <button
              className="clear-x"
              aria-label={`Clear: ${n.title}`}
              onClick={() => clear(ids)}
            >
              <Icon name="close" weight="bold" />
            </button>
          )}
        </span>
      </motion.li>
    )
  }
  return (
    <Panel
      title="Notifications"
      subtitle={
        needs.length
          ? `${needs.length} need${needs.length === 1 ? 's' : ''} you`
          : unread.length
            ? `${unread.length} unread`
            : 'Nothing needs you'
      }
      variant="popover"
      className="inbox-panel"
      opener={opener}
      close={close}
    >
      {items.length > 0 && (
        <div className="inbox-toolbar">
          <button
            className="text-button"
            disabled={!unread.length}
            onClick={() => read(unread.map((n) => n.id))}
          >
            Mark all read
          </button>
          {canClear && (
            <button
              className="text-button"
              disabled={!clearable.length}
              onClick={() => {
                read(unread.filter((n) => n.pending).map((n) => n.id))
                clear(clearable.map((n) => n.id))
              }}
            >
              Clear all
            </button>
          )}
        </div>
      )}
      <div className="inbox-body">
        {availability && (
          <output className="settings-callout" data-tone="wait">
            {availability}
          </output>
        )}
        {needs.length > 0 && (
          <section aria-label="Needs you">
            <h3 className="inbox-section">Needs you</h3>
            <ol className="inbox-list">
              <AnimatePresence initial={false}>
                {needs.map((n) => row(n, [n.id]))}
              </AnimatePresence>
            </ol>
          </section>
        )}
        {updates.length > 0 && (
          <section aria-label="Updates">
            <h3 className="inbox-section">Updates</h3>
            <ol className="inbox-list">
              <AnimatePresence initial={false}>
                {updates.map(({ item, ids }) => row(item, ids))}
              </AnimatePresence>
            </ol>
          </section>
        )}
        {!items.length && !availability && (
          <div className="inbox-empty">
            <span className="inbox-empty-mark" aria-hidden="true">
              <Icon name="check" weight="bold" />
            </span>
            <h3>You’re all caught up</h3>
            <p>
              Questions, approvals, failures and replies from your kips appear
              here.
            </p>
          </div>
        )}
      </div>
    </Panel>
  )
}
