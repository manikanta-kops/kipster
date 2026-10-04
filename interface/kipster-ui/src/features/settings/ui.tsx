import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useSheet } from './sheet'

/** Controls shown in the title bar of the current page, such as a view toggle. */
export function BarTools({ children }: { children: ReactNode }) {
  const { tools } = useSheet()
  return tools ? createPortal(children, tools) : null
}

/** A modal confirmation inside the sheet. Escape cancels it without closing Settings. */
export function Confirm({
  title,
  children,
  cancel,
}: {
  title: string
  children: ReactNode
  cancel: () => void
}) {
  const { overlay } = useSheet()
  const box = useRef<HTMLDivElement>(null)
  const dismiss = useRef(cancel)
  useEffect(() => {
    dismiss.current = cancel
  })
  useEffect(() => {
    box.current
      ?.querySelector<HTMLElement>('input:not([type="checkbox"]), button')
      ?.focus()
    // Escape closes this confirmation first; the Settings sheet stays open.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss.current()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [])
  const body = (
    <div className="set-confirm-scrim">
      <div
        ref={box}
        className="set-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
      >
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
  return overlay ? createPortal(body, overlay) : body
}

/** A titled group of rows with an optional note under it. */
export function Block({
  label,
  foot,
  children,
  region,
  className = '',
  bare = false,
}: {
  label?: ReactNode
  foot?: ReactNode
  children?: ReactNode
  /** Accessible name when the block is a landmark region. */
  region?: string
  className?: string
  /** Children bring their own group, such as a disclosure. */
  bare?: boolean
}) {
  return (
    <section className={`set-block ${className}`} aria-label={region}>
      {label && <h4 className="set-label">{label}</h4>}
      {bare ? children : <div className="set-group">{children}</div>}
      {foot && <p className="set-foot">{foot}</p>}
    </section>
  )
}

/** One settings row: label and note on the left, a control on the right. */
export function Row({
  label,
  sub,
  subTone,
  lead,
  control,
  chevron,
  onClick,
  className = '',
  changed,
  labelId,
  disabled,
  dim,
}: {
  label: ReactNode
  sub?: ReactNode
  subTone?: 'own' | 'bad' | 'changed'
  lead?: ReactNode
  control?: ReactNode
  chevron?: boolean
  onClick?: () => void
  className?: string
  changed?: boolean
  /** Lets a control in the row use the label as its name. */
  labelId?: string
  disabled?: boolean
  dim?: boolean
}) {
  const content = (
    <>
      {lead}
      <span className="set-text">
        <span className="set-title" id={labelId}>
          {changed && <i className="set-changed" aria-hidden="true" />}
          {label}
        </span>
        {sub && <small className={subTone}>{sub}</small>}
      </span>
      {(control || chevron) && (
        <span className="set-control">
          {control}
          {chevron && <Icon name="caret" className="set-chevron" />}
        </span>
      )}
    </>
  )
  const classes = `set-row ${lead ? 'has-lead' : ''} ${dim ? 'dim' : ''} ${className}`
  return onClick ? (
    <button
      type="button"
      className={`${classes} nav`}
      onClick={onClick}
      disabled={disabled}
    >
      {content}
    </button>
  ) : (
    <div className={classes}>{content}</div>
  )
}

/** A row that reads as a link, such as "Manage kips and groups…". */
export function ActionRow({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      className="set-row set-action"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </button>
  )
}

/** A switch row whose name is its label. */
export function SwitchRow({
  label,
  sub,
  on,
  disabled,
  dim,
  change,
}: {
  label: string
  sub?: ReactNode
  on: boolean
  disabled?: boolean
  dim?: boolean
  change: (on: boolean) => void
}) {
  const id = useId()
  return (
    <Row
      label={label}
      sub={sub}
      labelId={id}
      dim={dim}
      control={
        <Switch labelId={id} on={on} disabled={disabled} change={change} />
      }
    />
  )
}

export function Switch({
  labelId,
  on,
  disabled,
  change,
}: {
  labelId: string
  on: boolean
  disabled?: boolean
  change: (on: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="set-switch"
      aria-labelledby={labelId}
      checked={on}
      aria-checked={on}
      disabled={disabled}
      onChange={(event) => change(event.target.checked)}
    />
  )
}

/** Mutually exclusive choices with one height and keyboard arrows from native radios. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  change,
  className = '',
}: {
  label: string
  value: T
  options: { value: T; label: string; name?: string }[]
  disabled?: boolean
  change: (value: T) => void
  className?: string
}) {
  const name = useId()
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={`set-segmented ${className}`}
      style={{ '--count': options.length } as CSSProperties}
    >
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            aria-label={option.name}
            onChange={() => change(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}

/** Steps through a long ordered list, such as six effort levels. */
export function Stepper<T extends string>({
  label,
  value,
  options,
  disabled,
  change,
}: {
  label: string
  value: T
  options: { value: T; label: string; tick?: boolean }[]
  disabled?: boolean
  change: (value: T) => void
}) {
  const index = options.findIndex((option) => option.value === value)
  const ticks = options.filter((option) => option.tick !== false)
  const at = ticks.findIndex((option) => option.value === value)
  return (
    <fieldset className="set-stepper" aria-label={label}>
      <button
        type="button"
        aria-label={`Less ${label.toLowerCase()}`}
        disabled={disabled || index <= 0}
        onClick={() => change(options[index - 1].value)}
      >
        <Icon name="divider" />
      </button>
      <output aria-live="polite">
        <b>{options[index]?.label ?? value}</b>
        <span className="set-ticks" aria-hidden="true">
          {ticks.map((option, i) => (
            <i key={option.value} className={at >= 0 && i <= at ? 'on' : ''} />
          ))}
        </span>
      </output>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={disabled || index >= options.length - 1}
        onClick={() => change(options[index + 1].value)}
      >
        <Icon name="plus" />
      </button>
    </fieldset>
  )
}

/** A group whose first row is a one-line summary that opens to show details. */
export function Disclosure({
  label,
  sub,
  summary,
  children,
  initiallyOpen = false,
}: {
  label: ReactNode
  sub?: ReactNode
  summary?: ReactNode
  children: ReactNode
  initiallyOpen?: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const id = useId()
  return (
    <div className="set-group">
      <button
        type="button"
        className="set-row nav set-disclosure"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="set-text">
          <span>{label}</span>
          {sub && <small>{sub}</small>}
        </span>
        <span className="set-control">
          {summary && <span className="set-summary">{summary}</span>}
          <Icon name="chevron" className="set-caret" />
        </span>
      </button>
      {open && (
        <div className="set-disclosure-body" id={id}>
          {children}
        </div>
      )}
    </div>
  )
}

/** Save state as the last row of a group. */
export function SaveRow({
  state,
  children,
}: {
  state: 'dirty' | 'saving' | 'saved' | 'failed'
  children?: ReactNode
}) {
  return (
    <div className={`set-row set-save ${state}`}>
      <span className="set-save-note" aria-live="polite">
        {state === 'saving' ? (
          <>
            <i className="set-spin" aria-hidden="true" />
            Saving…
          </>
        ) : state === 'saved' ? (
          <>
            <Icon name="check" weight="bold" />
            Saved
          </>
        ) : state === 'failed' ? (
          <>
            <Icon name="warning" />
            Not confirmed. Retry sends the same request.
          </>
        ) : (
          <>
            <i className="set-changed" aria-hidden="true" />
            Unsaved changes
          </>
        )}
      </span>
      {children && <span className="set-control">{children}</span>}
    </div>
  )
}

export function Callout({
  tone = 'neutral',
  children,
  actions,
  alert,
}: {
  tone?: 'neutral' | 'wait' | 'danger' | 'run'
  children: ReactNode
  actions?: ReactNode
  alert?: boolean
}) {
  return (
    <div
      className="set-callout"
      data-tone={tone}
      role={alert ? 'alert' : undefined}
    >
      <Icon
        name={
          tone === 'danger' ? 'warning' : tone === 'run' ? 'success' : 'info'
        }
      />
      <span>{children}</span>
      {actions && <span className="set-callout-actions">{actions}</span>}
    </div>
  )
}

/** A colored tile with an icon, for pages, organizations and adapters. */
export function Glyph({
  icon,
  hue,
  size = 22,
}: {
  icon: Parameters<typeof Icon>[0]['name']
  hue: string
  size?: number
}) {
  return (
    <span
      className="set-glyph"
      aria-hidden="true"
      style={{ '--g': hue, width: size, height: size } as CSSProperties}
    >
      <Icon name={icon} weight="fill" />
    </span>
  )
}

export function StatusDot({ tone }: { tone: 'run' | 'wait' | 'danger' }) {
  return <i className={`set-dot ${tone}`} aria-hidden="true" />
}
