import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Icon } from '../../components/Icon'
import type { WorkspaceSnapshot } from '../../data/directory'
import { tone, type InboxNotification } from '../../data/notifications'
import { NotificationAvatar } from './Inbox'

const ease = [0.22, 1, 0.36, 1] as const
const labels = {
  needs: 'Needs your answer',
  failed: 'Couldn’t finish',
  done: 'Replied',
}

/** In-app banners for other threads, top right. Replies hide on their own. */
export function Banners({
  banners,
  actors,
  kipId,
  open,
  dismiss,
}: {
  banners: InboxNotification[]
  actors: WorkspaceSnapshot['actorsById']
  kipId?: string
  open: (n: InboxNotification) => void
  dismiss: (id: string) => void
}) {
  return (
    <div className="banners" aria-live="polite">
      <AnimatePresence initial={false}>
        {banners.map((n) => (
          <Banner
            key={n.id}
            n={n}
            actors={actors}
            kipId={kipId}
            open={open}
            dismiss={dismiss}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

function Banner({
  n,
  actors,
  kipId,
  open,
  dismiss,
}: {
  n: InboxNotification
  actors: WorkspaceSnapshot['actorsById']
  kipId?: string
  open: (n: InboxNotification) => void
  dismiss: (id: string) => void
}) {
  const kind = tone(n)
  useEffect(() => {
    if (kind !== 'done') return
    const timer = setTimeout(() => dismiss(n.id), 6000)
    return () => clearTimeout(timer)
  }, [kind, n.id, dismiss])
  const label =
    n.kind === 'approval'
      ? 'Needs your approval'
      : n.kind === 'recovery-needed'
        ? 'Work interrupted'
        : labels[kind]
  return (
    <motion.div
      layout="position"
      className="banner mat thick lifted"
      data-notification-id={n.id}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.3, ease }}
    >
      <button
        className="banner-open"
        onClick={() => {
          dismiss(n.id)
          open(n)
        }}
      >
        <NotificationAvatar n={n} actors={actors} kipId={kipId} />
        <span className="banner-text">
          <span className={`banner-tag ${kind}`}>
            <i aria-hidden="true" />
            {n.agent} · {label}
          </span>
          <span className="banner-body">{n.body || n.title}</span>
        </span>
      </button>
      <button
        className="banner-dismiss"
        aria-label="Dismiss"
        onClick={() => dismiss(n.id)}
      >
        <Icon name="close" weight="bold" />
      </button>
    </motion.div>
  )
}
