import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Icon } from '../../components/Icon'

const popoverMargin = 12
const popoverWidth = 400
const popoverMinHeight = 320

/**
 * Places a popover next to the control that opened it: beside a trigger in the
 * sidebar, below a trigger in the toolbar. The popover keeps a usable minimum
 * height and stays inside the window, moving away from the trigger if needed.
 * Narrow windows use a full sheet.
 */
function anchorTo(trigger: HTMLElement | null): CSSProperties | undefined {
  if (!trigger?.isConnected || window.innerWidth < 640) return undefined
  const rect = trigger.getBoundingClientRect()
  if (!rect.width) return undefined
  const width = Math.min(popoverWidth, window.innerWidth - 2 * popoverMargin)
  const minHeight = Math.min(
    popoverMinHeight,
    window.innerHeight - 2 * popoverMargin,
  )
  const farthest = window.innerHeight - popoverMargin - minHeight
  if (rect.left + rect.width / 2 < window.innerWidth / 3) {
    const bottom = Math.max(
      popoverMargin,
      Math.min(window.innerHeight - rect.bottom, farthest),
    )
    return {
      left: Math.max(
        popoverMargin,
        Math.min(
          rect.right + popoverMargin,
          window.innerWidth - width - popoverMargin,
        ),
      ),
      bottom,
      width,
      maxHeight: window.innerHeight - bottom - popoverMargin,
      transformOrigin: 'left bottom',
    }
  }
  const top = Math.max(popoverMargin, Math.min(rect.bottom + 10, farthest))
  return {
    top,
    right: Math.max(
      popoverMargin,
      Math.min(
        window.innerWidth - rect.right,
        window.innerWidth - width - popoverMargin,
      ),
    ),
    width,
    maxHeight: window.innerHeight - top - popoverMargin,
    transformOrigin: 'top right',
  }
}

export function Panel({
  title,
  subtitle,
  variant = 'sheet',
  className = '',
  header = true,
  opener,
  close,
  children,
}: {
  title: string
  /** False when the content draws its own title bar and close button. */
  header?: boolean
  subtitle?: React.ReactNode
  variant?: 'sheet' | 'popover'
  className?: string
  /**
   * The control that opened the panel. Popovers anchor to it and focus returns
   * to it on close. WebKit does not focus buttons on click, so the focused
   * element is only a fallback.
   */
  opener?: HTMLElement | null
  close: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [trigger] = useState(
    () => opener ?? (document.activeElement as HTMLElement | null),
  )
  const [anchor, setAnchor] = useState(() =>
    variant === 'popover' ? anchorTo(trigger) : undefined,
  )
  const dismiss = useRef(close)
  useEffect(() => {
    dismiss.current = close
  })
  useLayoutEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    // The panel itself takes focus so WebKit does not ring the close button on
    // open; Tab moves to its first control.
    dialog?.focus()
    return () => {
      dialog?.close()
      trigger?.focus()
    }
  }, [trigger])
  useEffect(() => {
    const dialog = ref.current
    if (variant !== 'popover' || !dialog) return
    const place = () => setAnchor(anchorTo(trigger))
    // Clicks on the transparent backdrop land on the dialog itself, outside its box.
    const lightDismiss = (event: MouseEvent) => {
      if (event.target !== dialog) return
      const box = dialog.getBoundingClientRect()
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        dismiss.current()
    }
    window.addEventListener('resize', place)
    dialog.addEventListener('click', lightDismiss)
    return () => {
      window.removeEventListener('resize', place)
      dialog.removeEventListener('click', lightDismiss)
    }
  }, [variant, trigger])
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      className={`panel panel-${variant} ${anchor ? 'anchored' : ''} ${className}`}
      aria-label={title}
      style={anchor}
      onCancel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        close()
      }}
    >
      {header && (
        <header className="panel-header">
          <div className="panel-title">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </header>
      )}
      {children}
    </dialog>
  )
}
