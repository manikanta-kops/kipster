import { useState, type CSSProperties } from 'react'
import type { Mark } from '../../data/notifications'

const breath = 2800

/** True once the mark has changed since mount, so it only animates in on change. */
function useChanged(mark: Mark | undefined) {
  const [previous, setPrevious] = useState(mark)
  const [changed, setChanged] = useState(false)
  if (mark !== previous) {
    setPrevious(mark)
    setChanged(true)
  }
  return changed
}

/** A dot on the avatar's corner: needs you, failed, or a slow breath while working. */
export function CornerMark({ mark }: { mark?: Mark }) {
  const changed = useChanged(mark)
  // Every working dot breathes on the same clock, whenever it mounts.
  const [phase] = useState(() => `-${Date.now() % breath}ms`)
  if (!mark || mark === 'unread') return null
  return (
    <span
      key={mark}
      className={`corner-mark ${mark} ${changed ? 'mark-in' : ''}`}
      style={{ '--phase': phase } as CSSProperties}
      aria-hidden="true"
    />
  )
}

/** A small neutral dot at the row's edge for an unread reply. */
export function UnreadMark({ mark }: { mark?: Mark }) {
  const changed = useChanged(mark)
  return mark === 'unread' ? (
    <i
      className={`unread-mark ${changed ? 'mark-in' : ''}`}
      aria-hidden="true"
    />
  ) : null
}
