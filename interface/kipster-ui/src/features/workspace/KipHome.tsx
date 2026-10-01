import { useId } from 'react'
import { useReducedMotion } from 'motion/react'
import { KipHead } from '../../components/Kip'
import { PixelDisplay } from '../status/PixelDisplay'
import { useSettledState } from '../status/use-settled-state'
import { kipScenes } from '../status/kip-scenes'
import { liveStates, type LiveState } from '../status/live-state'
import type { Agent } from '../chat/model'

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
  selected,
  collapsed,
  onOpen,
}: {
  agent: Agent
  state: LiveState
  selected: boolean
  collapsed: boolean
  onOpen: () => void
}) {
  const reduced = Boolean(useReducedMotion())
  const shown = useSettledState(state)
  const info = liveStates[shown]
  const described = useId()
  const status = (
    <span id={described} className="sr-only">
      {info.description}
    </span>
  )
  const common = {
    'aria-label': agent.name,
    'aria-describedby': described,
    'aria-current': selected ? ('page' as const) : undefined,
    'data-tone': info.tone,
    onClick: onOpen,
  }
  if (collapsed)
    return (
      <button
        {...common}
        className={`kip-home-mini ${selected ? 'selected' : ''}`}
        data-tip={`${agent.name} · ${info.label}`}
      >
        <span aria-hidden="true" className="avatar kip">
          <KipHead />
        </span>
        <span className="kip-home-dot" aria-hidden="true" />
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
        <span className="kip-state" aria-hidden="true">
          <i />
          {info.label}
        </span>
      </span>
      {status}
    </button>
  )
}
