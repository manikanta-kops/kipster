import { useRef, useState, type SetStateAction } from 'react'

/** Unsent edits are scoped like the immutable save journal, but never dispatch work. */
export function useSettingsDraft<T>(key: string, empty: T) {
  const storageKey = `kipster-settings-draft:${key}`
  const [draft, update] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved === null) return empty
      const value: unknown = JSON.parse(saved)
      const valid =
        empty === null
          ? value === null || typeof value === 'string'
          : value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.values(value).every((item) => typeof item === 'string')
      return valid ? (value as T) : empty
    } catch {
      return empty
    }
  })
  // Keep updater evaluation and storage writes outside React's replayable updater.
  const current = useRef(draft)
  const setDraft = (action: SetStateAction<T>) => {
    const previous = current.current
    const value =
      typeof action === 'function'
        ? (action as (previous: T) => T)(previous)
        : action
    current.current = value
    try {
      const serialized = JSON.stringify(value)
      if (serialized === JSON.stringify(empty)) {
        // A late save in this tab must not erase another tab's newer edit.
        if (localStorage.getItem(storageKey) === JSON.stringify(previous))
          localStorage.removeItem(storageKey)
      } else localStorage.setItem(storageKey, serialized)
    } catch {
      /* A device storage failure must not erase the visible edit. */
    }
    update(value)
  }
  return [draft, setDraft] as const
}
