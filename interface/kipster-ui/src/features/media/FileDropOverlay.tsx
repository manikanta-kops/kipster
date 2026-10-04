import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Icon } from '../../components/Icon'
import { quickFade } from '../../app/motion'

export function FileDropOverlay({
  zone,
  over,
  hint,
}: {
  zone: HTMLElement | null
  over: boolean
  hint: string
}) {
  const reduceMotion = useReducedMotion()
  if (!zone) return null
  return createPortal(
    <AnimatePresence>
      {over && (
        <motion.div
          className="file-drop"
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={quickFade}
        >
          <motion.div
            className="file-drop-card"
            initial={reduceMotion ? false : { y: 8, scale: 0.97 }}
            animate={{ y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { y: 4, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <span className="file-drop-icon">
              <Icon name="attach" size={20} />
            </span>
            <strong>Drop to attach</strong>
            <small>{hint}</small>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    zone,
  )
}
