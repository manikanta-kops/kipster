import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar } from './Message'

export type ThreadFilterValue = 'all' | 'you' | 'kips'

const filterLabels: Record<ThreadFilterValue, string> = {
  all: 'All threads',
  you: 'Started by you',
  kips: 'From other kips',
}

/**
 * The feed's thread filter, next to the theme toggle. Hovering or keyboard focus opens its
 * menu; the choice is view state for this chat only.
 */
export function ThreadFilter({
  value,
  counts,
  senders,
  onChange,
}: {
  value: ThreadFilterValue
  counts: Record<ThreadFilterValue, number>
  /** The faces of the kips that started threads here. */
  senders: ReactNode
  onChange: (value: ThreadFilterValue) => void
}) {
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const open = hover || focused
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // Focus returning to the trigger after a choice does not reopen the menu.
  const quiet = useRef(false)
  const menuId = useId()
  const headingId = useId()
  const items = () =>
    Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ??
        [],
    )
  const close = (restoreFocus: boolean) => {
    setHover(false)
    setFocused(false)
    if (restoreFocus) {
      quiet.current = true
      trigger.current?.focus()
      quiet.current = false
    }
  }
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])
  const enter = (index: 'first' | 'last' | 'checked') => {
    setFocused(true)
    requestAnimationFrame(() => {
      const all = items()
      const checked = all.findIndex(
        (item) => item.getAttribute('aria-checked') === 'true',
      )
      all[
        index === 'last'
          ? all.length - 1
          : index === 'checked'
            ? Math.max(0, checked)
            : 0
      ]?.focus()
    })
  }
  const onTriggerKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close(false)
    } else if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      enter('checked')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      enter('last')
    }
  }
  const onMenuKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'Tab') {
      close(false)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const all = items()
    const index = all.indexOf(document.activeElement as HTMLElement)
    all[
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? all.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + all.length) %
            all.length
    ]?.focus()
  }
  const choose = (next: ThreadFilterValue) => {
    onChange(next)
    close(true)
  }
  const options: { value: ThreadFilterValue; icon: ReactNode }[] = [
    { value: 'all', icon: <Icon name="list" size={16} /> },
    { value: 'you', icon: <Avatar name="You" isSelf /> },
    { value: 'kips', icon: <Icon name="link" size={16} /> },
  ]
  return (
    <div
      ref={root}
      className={`thread-filter ${value === 'all' ? '' : 'on'}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (!next || !root.current?.contains(next)) setFocused(false)
      }}
    >
      <div className="capsule mat thin">
        <button
          ref={trigger}
          className="icon-button"
          aria-label={
            value === 'all'
              ? 'Filter threads'
              : `Filter threads: ${filterLabels[value]}`
          }
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          onFocus={(event) => {
            if (!quiet.current && event.currentTarget.matches(':focus-visible'))
              setFocused(true)
          }}
          onClick={() => setFocused((was) => !was || hover)}
          onKeyDown={onTriggerKey}
        >
          <Icon name="slider" />
        </button>
        {value !== 'all' && (
          <span className="filter-label">
            {filterLabels[value]}
            <button
              className="filter-clear"
              aria-label="Show all threads"
              onClick={() => {
                onChange('all')
                quiet.current = true
                trigger.current?.focus()
                quiet.current = false
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}
      </div>
      <div
        ref={menu}
        id={menuId}
        role="menu"
        aria-labelledby={headingId}
        className="filter-menu mat thick lifted"
        tabIndex={-1}
        hidden={!open}
        onKeyDown={onMenuKey}
      >
        <h2 id={headingId}>Show threads</h2>
        {options.map((option) => (
          <button
            key={option.value}
            role="menuitemradio"
            aria-checked={value === option.value}
            tabIndex={-1}
            onClick={() => choose(option.value)}
          >
            <span className="filter-icon" aria-hidden="true">
              {option.icon}
            </span>
            <span className="filter-name">{filterLabels[option.value]}</span>
            {option.value === 'kips' && (
              <span className="reply-participants" aria-hidden="true">
                {senders}
              </span>
            )}
            <span className="filter-count">{counts[option.value]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
