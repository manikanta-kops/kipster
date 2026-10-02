import { useId } from 'react'
import { useReducedMotion } from 'motion/react'
import { KipHead } from '../../components/Kip'
import { PixelDisplay } from '../status/PixelDisplay'
import { useSettledState } from '../status/use-settled-state'
import { kipScenes } from '../status/kip-scenes'
import { liveStates, type LiveState } from '../status/live-state'
import type { Agent } from '../chat/model'
import type { Mark } from '../../data/notifications'
import { CornerMark, UnreadMark } from '../notifications/Mark'

const cols = 46
const rows = 18
const pitch = 5

/**
 * Kip's home at the top of the sidebar: a live LED sign of what Kip is doing,
 * with its name and state. Collapsed, it shrinks to Kip's head and a state ring.
 */
export function KipHome({
  agent,
  state,
  mark,
  selected,
  collapsed,
  onOpen,
}: {
  agent: Agent
  state: LiveState
  mark?: Mark
  selected: boolean
  collapsed: boolean
  onOpen: () => void
}) {
  const reduced = Boolean(useReducedMotion())
  const shown = useSettledState(state)
  const info = liveStates[shown]
  const resting = shown === 'ready'
  const described = useId()
  const status = (
    <span id={described} className="sr-only">
      {info.description}
    </span>
  )
  const common = {
    'aria-label': agent.name,
    'aria-describedby': mark ? `${described} kip-mark-${mark}` : described,
    'aria-current': selected ? ('page' as const) : undefined,
    'data-tone': info.tone,
    'data-mark': mark,
    onClick: onOpen,
  }
  if (collapsed)
    return (
      <button
        {...common}
        className={`kip-home-mini ${selected ? 'selected' : ''}`}
        data-tip={resting ? agent.name : `${agent.name} · ${info.label}`}
      >
        <span aria-hidden="true" className="avatar kip">
          <KipHead />
        </span>
        <CornerMark mark={mark} />
        {status}
      </button>
    )
  return (
    <button
      {...common}
      className={`kip-home gloss ${selected ? 'selected' : ''}`}
    >
      <span className="kip-sign">
        <PixelDisplay
          state={shown}
          cols={cols}
          rows={rows}
          pitch={pitch}
          reduced={reduced}
          scenes={kipScenes}
        />
      </span>
      <span className="kip-line sidebar-label">
        <span className="kip-name">{agent.name}</span>
        {resting ? null : (
          <span className="kip-state" aria-hidden="true">
            <i />
            {info.label}
          </span>
        )}
        <UnreadMark mark={mark} />
      </span>
      {status}
    </button>
  )
}
