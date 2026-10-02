import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Transition } from 'motion/react'
import { useMediaQuery } from '../../app/use-media-query'
import { PixelDisplay } from './PixelDisplay'
import { liveStates } from './live-state'
import { useSettledState } from './use-settled-state'
import type { LiveState } from './live-state'

const morph: Transition = {
  type: 'spring',
  stiffness: 210,
  damping: 23,
  mass: 1,
}
const instant: Transition = { duration: 0 }
const pitch = 2.4

/**
 * The title capsule. Ready is a glass capsule with the mark and name; any
 * other state morphs it into a black island holding the pixel scene and a
 * short word.
 */
export function StatusIsland({
  state,
  name,
  mark,
  heading: Heading = 'h1',
  others = 0,
  maxName = 200,
  announce = true,
}: {
  state: LiveState
  name: string
  mark: ReactNode
  heading?: 'h1' | 'h2'
  others?: number
  maxName?: number
  announce?: boolean
}) {
  const reduceMotion = Boolean(useReducedMotion())
  const compact = useMediaQuery('(max-width: 820px)')
  const shown = useSettledState(state)
  const info = liveStates[shown]
  const active = shown !== 'ready'
  const nameRef = useRef<HTMLHeadingElement>(null)
  const wordRef = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ name: 0, word: 0 })
  const [measured, setMeasured] = useState(false)
  useLayoutEffect(() => {
    const next = {
      name: Math.min(nameRef.current?.scrollWidth ?? 0, maxName),
      word: wordRef.current?.offsetWidth ?? 0,
    }
    setSize((current) =>
      current.name === next.name && current.word === next.word ? current : next,
    )
  }, [name, info.label, maxName])
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMeasured(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  const cols = compact ? 22 : 28
  const fieldWidth = cols * pitch
  const markSize = active ? 28 : 34
  const inset = (44 - markSize) / 2
  const textX = inset + markSize + (active ? 9 : 10)
  const column = active ? Math.max(size.name * 0.87, size.word) : size.name
  const fieldX = textX + column + 11
  const width = active ? fieldX + fieldWidth + 12 : textX + size.name + 18
  const transition = measured && !reduceMotion ? morph : instant

  return (
    <div
      className={`status-island ${active ? 'active' : ''}`}
      data-tone={info.tone}
    >
      <motion.div
        className="island-shape"
        initial={false}
        animate={{ width }}
        transition={transition}
      >
        <motion.span
          className="island-ink"
          initial={false}
          animate={{ opacity: active ? 1 : 0 }}
          transition={reduceMotion ? instant : { duration: 0.35 }}
        />
        <motion.span
          className="island-mark"
          initial={false}
          animate={{ x: inset, y: inset, scale: markSize / 34 }}
          transition={transition}
        >
          {mark}
        </motion.span>
        <motion.div
          className="island-name"
          initial={false}
          animate={{ x: textX, y: active ? 5 : 13.5, scale: active ? 0.87 : 1 }}
          transition={transition}
        >
          <Heading ref={nameRef} title={name} style={{ maxWidth: maxName }}>
            {name}
          </Heading>
        </motion.div>
        <motion.span
          className="island-word"
          aria-hidden="true"
          initial={false}
          animate={{ x: textX, y: active ? 22.5 : 29, opacity: active ? 1 : 0 }}
          transition={transition}
        >
          <AnimatePresence initial={false}>
            {active && (
              <motion.span
                key={shown}
                initial={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: 7, filter: 'blur(2px)' }
                }
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={
                  reduceMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: -7, filter: 'blur(2px)' }
                }
                transition={reduceMotion ? instant : { duration: 0.3 }}
              >
                {info.label}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.span>
        <motion.span
          className="island-field"
          initial={false}
          animate={{
            x: fieldX,
            opacity: active ? 1 : 0,
            scale: active ? 1 : 0.72,
          }}
          transition={transition}
        >
          <PixelDisplay
            state={active ? shown : null}
            cols={cols}
            pitch={pitch}
            reduced={reduceMotion}
          />
        </motion.span>
      </motion.div>
      <AnimatePresence initial={false}>
        {active && others > 0 && (
          <motion.span
            className="island-more"
            aria-hidden="true"
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.3 }}
            transition={reduceMotion ? instant : morph}
          >
            +{others}
          </motion.span>
        )}
      </AnimatePresence>
      <span className="island-measure" aria-hidden="true" ref={wordRef}>
        {info.label}
      </span>
      {announce && (
        <p className="sr-only" aria-live="polite">
          {`${name}, ${info.description}${others > 0 ? `, ${others} more active` : ''}`}
        </p>
      )}
    </div>
  )
}
