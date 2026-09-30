import { type ReactNode, type RefObject } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Icon } from '../../components/Icon'
import { quickFade } from '../../app/motion'
import { Avatar } from './Message'
import type { Agent, Thread } from './model'
import { StatusIsland } from '../status/StatusIsland'
import type { LiveState } from '../status/live-state'

/** The inspector swings in from the right edge, like a page turning toward you. */
const inspectorAway = { opacity: 0, x: '108%', rotateY: -14 }
const inspectorArrive = {
  default: { type: 'spring', stiffness: 210, damping: 27, mass: 0.9 },
  opacity: { duration: 0.2 },
} as const
const inspectorExit = { duration: 0.32, ease: [0.4, 0, 0.8, 0.2] } as const

export function ThreadPane({
  thread,
  agent,
  state,
  expanded,
  onExpand,
  onClose,
  closeButton,
  scroll,
  history,
  work,
  recovery,
  attention,
  composer,
  unread,
  latest,
  messages,
}: {
  thread: Thread
  agent: Agent
  state: LiveState
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  closeButton: RefObject<HTMLButtonElement | null>
  scroll: RefObject<HTMLDivElement | null>
  work: ReactNode
  history: ReactNode
  recovery: ReactNode
  attention: ReactNode
  composer: ReactNode
  unread: boolean
  latest: () => void
  messages: ReactNode
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.section
      key={thread.id}
      initial={reduceMotion ? { opacity: 0 } : inspectorAway}
      animate={{ opacity: 1, x: 0, rotateY: 0 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: quickFade }
          : { ...inspectorAway, transition: inspectorExit }
      }
      transition={inspectorArrive}
      style={{ originX: 1, originY: 0.5 }}
      className="thread-pane"
      aria-label={`Thread: ${thread.title}`}
    >
      <header className="pane-header">
        <div className="pane-title">
          <p className="thread-eyebrow">
            {expanded ? `${agent.name} / Thread` : 'Thread'}
          </p>
          <StatusIsland
            state={state}
            name={thread.title}
            heading="h2"
            maxName={190}
            announce={false}
            mark={<Avatar name={agent.name} color={agent.color} />}
          />
        </div>
        <div className="header-actions">
          <button
            className="icon-button expand-thread"
            aria-label={expanded ? 'Restore split view' : 'Expand thread'}
            onClick={() => onExpand()}
          >
            <Icon name={expanded ? 'shrink' : 'expand'} />
          </button>
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="Close thread"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div ref={scroll} className="thread-scroll">
        {history}
        {messages}
        {work}
      </div>
      {unread && (
        <button className="jump-latest" onClick={latest}>
          Back to latest messages
        </button>
      )}
      {recovery}
      {attention}
      {composer}
    </motion.section>
  )
}
