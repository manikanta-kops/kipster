import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import {
  isAsk,
  tone,
  when,
  type InboxNotification,
} from '../../data/notifications'

const label = (n: InboxNotification) =>
  n.kind === 'approval'
    ? 'Needs your approval'
    : isAsk(n)
      ? 'Needs your answer'
      : n.kind === 'recovery-needed'
        ? 'Was interrupted'
        : 'Couldn’t finish'

/** The threads waiting on the person, under the status island. */
export function ActionMenu({
  anchor,
  name,
  items,
  titleOf,
  open,
  onClose,
}: {
  anchor: HTMLButtonElement
  name: string
  items: InboxNotification[]
  titleOf: (item: InboxNotification) => string
  open: (item: InboxNotification) => void
  onClose: (restoreFocus: boolean) => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const reduceMotion = useReducedMotion()
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.getBoundingClientRect()
      const width = ref.current?.offsetWidth ?? 0
      setPosition({
        left: Math.max(12, Math.min(window.innerWidth - width - 12, box.left)),
        top: box.bottom + 8,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  useEffect(() => {
    const panel = ref.current
    panel?.querySelector<HTMLElement>('button')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node
      if (!panel?.contains(node) && !anchor.contains(node)) close.current(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [anchor])
  function onKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close.current(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button') ?? [],
    )
    const index = buttons.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
            buttons.length
    event.preventDefault()
    buttons[next]?.focus()
  }
  return createPortal(
    <motion.dialog
      ref={ref}
      open
      aria-label={`${name} needs you`}
      className="action-menu mat thick lifted"
      style={position}
      initial={{
        opacity: 0,
        y: reduceMotion ? 0 : -6,
        scale: reduceMotion ? 1 : 0.98,
      }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && !ref.current?.contains(next) && !anchor.contains(next))
          close.current(false)
      }}
    >
      <h2>Needs you</h2>
      <ul>
        {items.map((n) => (
          <li key={n.id}>
            <button onClick={() => open(n)}>
              <span className={`action-dot ${tone(n)}`} aria-hidden="true" />
              <span className="action-text">
                <span className="action-title">{titleOf(n)}</span>
                <span className="action-label">{label(n)}</span>
              </span>
              <time dateTime={n.createdAt}>{when(n.createdAt)}</time>
            </button>
          </li>
        ))}
      </ul>
    </motion.dialog>,
    document.body,
  )
}
