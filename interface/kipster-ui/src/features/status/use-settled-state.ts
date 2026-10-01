import { useEffect, useState } from 'react'
import type { LiveState } from './live-state'

const doneSeconds = 4

/** Done is transient: it shows for a few seconds after work completes, then settles to Ready. */
export function useSettledState(state: LiveState) {
  const [settled, setSettled] = useState(state === 'done')
  const [seen, setSeen] = useState(state)
  if (seen !== state) {
    setSeen(state)
    setSettled(false)
  }
  useEffect(() => {
    if (state !== 'done' || settled) return
    const timer = setTimeout(() => setSettled(true), doneSeconds * 1000)
    return () => clearTimeout(timer)
  }, [state, settled])
  return state === 'done' && settled ? 'ready' : state
}
