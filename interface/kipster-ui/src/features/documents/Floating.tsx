import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'

export type Anchor = Element | (() => DOMRect | null)
const rectOf = (anchor: Anchor) =>
  typeof anchor === 'function'
    ? anchor()
    : anchor.isConnected
      ? anchor.getBoundingClientRect()
      : null

/**
 * A small surface beside an anchor: above or below it, kept inside the window, following it
 * as the page scrolls. Escape and a press outside close it.
 */
export function Floating({
  anchor,
  placement = 'below',
  align = 'start',
  onClose,
  className = '',
  label,
  role = 'dialog',
  children,
}: {
  anchor: Anchor
  placement?: 'above' | 'below'
  align?: 'start' | 'center'
  onClose: () => void
  className?: string
  label: string
  role?: 'dialog' | 'menu' | 'toolbar'
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const [position, setPosition] = useState<{
    left: number
    top: number
    above: boolean
  } | null>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useLayoutEffect(() => {
    const place = () => {
      const rect = rectOf(anchor)
      const element = ref.current
      if (!rect || !element) return close.current()
      const width = element.offsetWidth,
        height = element.offsetHeight
      let above = placement === 'above'
      if (above && rect.top - height - 10 < 8) above = false
      else if (!above && rect.bottom + height + 10 > innerHeight - 8)
        above = rect.top - height - 10 >= 8
      const left =
        align === 'center' ? rect.left + rect.width / 2 - width / 2 : rect.left
      setPosition({
        left: Math.max(8, Math.min(left, innerWidth - width - 8)),
        top: above ? rect.top - height - 8 : rect.bottom + 8,
        above,
      })
    }
    place()
    addEventListener('resize', place)
    addEventListener('scroll', place, true)
    return () => {
      removeEventListener('resize', place)
      removeEventListener('scroll', place, true)
    }
  }, [anchor, placement, align])
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if (anchor instanceof Element && anchor.contains(target)) return
      close.current()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      removeEventListener('keydown', onKey, true)
    }
  }, [anchor])
  return createPortal(
    <motion.div
      ref={ref}
      role={role}
      aria-label={label}
      className={`doc-float mat thick lifted ${className}`}
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? 0,
        transformOrigin: position?.above ? 'bottom left' : 'top left',
      }}
      initial={{
        opacity: 0,
        scale: reduceMotion ? 1 : 0.96,
        y: reduceMotion ? 0 : 4,
      }}
      animate={position ? { opacity: 1, scale: 1, y: 0 } : { opacity: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
    >
      {children}
    </motion.div>,
    document.body,
  )
}
