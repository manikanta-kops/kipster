import type { Transition } from 'motion/react'

// Short responses to user actions; no looping or idle animation.
export const paneSpring: Transition = {
  type: 'spring',
  stiffness: 380,
  damping: 38,
  mass: 0.8,
}
export const quickFade: Transition = {
  duration: 0.16,
  ease: [0.22, 1, 0.36, 1],
}

/** The inspector swings in from the right edge, like a page turning toward you. */
export const inspectorAway = { opacity: 0, x: '108%', rotateY: -14 }
export const inspectorArrive = {
  default: { type: 'spring', stiffness: 210, damping: 27, mass: 0.9 },
  opacity: { duration: 0.2 },
} as const
export const inspectorExit = {
  duration: 0.32,
  ease: [0.4, 0, 0.8, 0.2],
} as const
