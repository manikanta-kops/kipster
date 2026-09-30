import { useEffect, useRef, useState } from 'react'
import Dexie, { liveQuery, type Table } from 'dexie'
import { uncertainFailure, type SettingsPatch } from './core-settings'

type PendingSave = { key: string; operationId: string; patch: SettingsPatch }
const db = new Dexie('kipster-core-settings-saves') as Dexie & {
  pending: Table<PendingSave, string>
}
db.version(1).stores({ pending: '&key' })

async function reserve(key: string, patch: SettingsPatch) {
  return db.transaction('rw', db.pending, async () => {
    const existing = await db.pending.get(key)
    if (existing) return existing
    const entry = { key, operationId: crypto.randomUUID(), patch }
    await db.pending.add(entry)
    return entry
  })
}
async function settle(entry: PendingSave) {
  await db.transaction('rw', db.pending, async () => {
    if ((await db.pending.get(entry.key))?.operationId === entry.operationId)
      await db.pending.delete(entry.key)
  })
}

/** One immutable save per scoped target. Recovery never automatically resends it. */
export function useSettingsSave(
  key: string,
  save: (operationId: string, patch: SettingsPatch) => Promise<unknown>,
) {
  const [pending, setPending] = useState<PendingSave | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [saved, setSaved] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const sending = useRef(false)
  useEffect(() => {
    const subscription = liveQuery(() => db.pending.get(key)).subscribe({
      next: (entry) => {
        setPending(entry ?? null)
        setReady(true)
        setStorageError(false)
      },
      error: () => {
        setReady(false)
        setStorageError(true)
      },
    })
    return () => subscription.unsubscribe()
  }, [key, attempt])

  async function send(patch: SettingsPatch) {
    if (!ready || sending.current) return false
    sending.current = true
    setBusy(true)
    setError('')
    setSaved(false)
    let entry: PendingSave
    try {
      entry = await reserve(key, patch)
    } catch {
      setError('Could not save this request on this device. Nothing was sent.')
      sending.current = false
      setBusy(false)
      return false
    }
    setPending(entry)
    try {
      try {
        await save(entry.operationId, entry.patch)
      } catch (cause) {
        if (!uncertainFailure(cause)) {
          await settle(entry)
          setError(cause instanceof Error ? cause.message : 'Save rejected.')
        }
        return false
      }
      await settle(entry)
      setSaved(true)
      return true
    } catch {
      setError(
        'The outcome could not be saved locally. Retry the original request to confirm it.',
      )
      return false
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return {
    pending,
    ready,
    busy,
    error,
    storageError,
    saved,
    send,
    retryStorage: () => setAttempt((value) => value + 1),
  }
}
