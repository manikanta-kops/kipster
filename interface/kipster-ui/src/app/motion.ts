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
