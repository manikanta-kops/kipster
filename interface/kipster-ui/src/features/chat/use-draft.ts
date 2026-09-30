import { useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import {
  conversationStorage,
  type Draft,
} from '../../data/conversation-storage'

export function useDraft(key: string) {
  const [text, setText] = useState('')
  const [observationAttempt, setObservationAttempt] = useState(0)
  const [status, setStatus] = useState<
    'loading' | 'saved' | 'saving' | 'conflict' | 'error'
  >('loading')
  const [conflict, setConflict] = useState<Draft>()
  const state = useRef({
    text: '',
    generation: 0,
    known: undefined as Draft | undefined,
    loaded: false,
    observationFailed: false,
    writing: false,
    alive: true,
    conflict: undefined as Draft | undefined,
  })
  async function flush() {
    const s = state.current
    if (!s.loaded || s.writing || s.conflict) return
    s.writing = true
    if (s.alive) setStatus('saving')
    try {
      while (!s.conflict) {
        const value = s.text
        const generation = s.generation
        const result = await conversationStorage.writeDraft(
          key,
          s.known?.revision ?? null,
          value,
        )
        if (!result.applied) {
          s.conflict = result.current
          if (s.alive) {
            setConflict(result.current)
            setStatus('conflict')
          }
          return
        }
        s.known = result.current
        if (generation === s.generation) {
          if (s.alive) setStatus('saved')
          return
        }
      }
    } catch {
      if (s.alive) setStatus('error')
    } finally {
      s.writing = false
    }
  }
  useEffect(() => {
    const s = state.current
    s.alive = true
    return () => {
      s.alive = false
      // Navigation must not abandon edits made while the first read was delayed.
      if (!s.loaded && s.generation)
        void conversationStorage
          .readDraft(key)
          .then((saved) => {
            s.known = saved
            s.loaded = true
            void flush()
          })
          .catch(() => {})
    }
    // Editors are keyed by their complete destination identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    const s = state.current
    let accepting = true
    let first = true
    const subscription = liveQuery(() =>
      conversationStorage.readDraft(key),
    ).subscribe({
      next(saved) {
        if (!accepting || !s.alive) return
        const restarted = first && observationAttempt > 0
        first = false
        s.observationFailed = false
        if (!s.loaded) {
          s.loaded = true
          s.known = saved
          if (!s.generation) {
            s.text = saved?.text ?? ''
            setText(s.text)
            setStatus('saved')
          } else void flush()
          return
        }
        if (s.writing) return
        if (saved?.revision === s.known?.revision) {
          if (restarted && !s.conflict) {
            if (s.text !== (s.known?.text ?? '')) void flush()
            else setStatus('saved')
          }
          return
        }
        if (s.text === (s.known?.text ?? '')) {
          s.known = saved
          s.text = saved?.text ?? ''
          setText(s.text)
          setStatus('saved')
        } else {
          s.conflict = saved
          setConflict(saved)
          setStatus('conflict')
        }
      },
      error() {
        if (!accepting || !s.alive) return
        s.observationFailed = true
        setStatus('error')
      },
    })
    return () => {
      accepting = false
      subscription.unsubscribe()
    }
    // Restart the failed live query, not just the write path, to retain cross-tab observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, observationAttempt])
  return {
    text,
    status,
    conflict,
    change(value: string) {
      const s = state.current
      s.text = value
      s.generation++
      setText(value)
      void flush()
    },
    async prepare() {
      const s = state.current
      if (!s.loaded || s.conflict)
        throw new Error('Resolve draft storage before sending.')
      const captured = { generation: s.generation, text: s.text }
      while (s.writing) await new Promise((resolve) => setTimeout(resolve, 10))
      if (s.known?.text !== s.text) await flush()
      if (s.known?.text !== s.text) throw new Error('Draft could not be saved.')
      return {
        draft: s.generation === captured.generation ? s.known : undefined,
        ...captured,
      }
    },
    reserved(generation: number, cleared: Draft | undefined) {
      const s = state.current
      if (cleared) s.known = cleared
      if (generation === s.generation && cleared) {
        s.text = ''
        s.generation++
        setText('')
        setStatus('saved')
      } else if (cleared) void flush()
    },
    retry() {
      const s = state.current
      if (!s.loaded || s.observationFailed) {
        setStatus('loading')
        setObservationAttempt((value) => value + 1)
      } else void flush()
    },
    resolve(keepMine: boolean) {
      const s = state.current
      const observed = s.conflict
      if (!observed) return
      s.known = observed
      s.conflict = undefined
      setConflict(undefined)
      if (!keepMine) {
        s.text = observed.text
        s.generation++
        setText(observed.text)
        setStatus('saved')
      } else void flush()
    },
  }
}
