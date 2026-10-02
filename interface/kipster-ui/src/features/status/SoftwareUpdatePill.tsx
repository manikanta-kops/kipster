import { useReducedMotion } from 'motion/react'
import {
  softwareUpdatePill,
  useSoftwareUpdates,
  type SoftwareUpdates,
} from '../../data/software-updates'
import { PixelDisplay } from './PixelDisplay'

export function SoftwareUpdatePill({
  updates,
  open,
}: {
  updates: SoftwareUpdates
  open: (trigger: HTMLElement) => void
}) {
  const value = useSoftwareUpdates(updates)
  const pill = softwareUpdatePill(value)
  const reduced = Boolean(useReducedMotion())
  if (!pill) return null
  return (
    <button
      className="software-update-pill"
      aria-label={pill.label}
      data-tip={pill.label}
      data-state={pill.state}
      onClick={(event) => open(event.currentTarget)}
    >
      <PixelDisplay
        state={pill.state}
        cols={12}
        rows={9}
        pitch={2}
        reduced={reduced}
      />
      <span className="sidebar-label" aria-live="polite">
        {pill.label}
      </span>
    </button>
  )
}
