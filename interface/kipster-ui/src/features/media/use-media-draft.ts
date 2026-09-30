import { useContext, useEffect, useRef, useState } from 'react'
import { liveQuery } from 'dexie'
import { WorkspaceContext } from '../../data/workspace-context'
import {
  mediaStorage,
  type PendingMedia,
} from '../../data/conversation-storage'
import { digest, type MediaPurpose } from '../../data/media'
import type { ConversationTarget } from '../../data/conversations'
// Quota failures retain bytes across view navigation for this session only.
const volatileMedia = new Map<string, PendingMedia>()
let selectionOrder = Date.now() * 1000
export function useMediaDraft(key: string, target: ConversationTarget) {
  const client = useContext(WorkspaceContext)?.media
  const [storageReady, setStorageReady] = useState(false)
  const [entries, setEntries] = useState<PendingMedia[]>([])
  const [unsaved, setUnsaved] = useState<PendingMedia[]>(() =>
    [...volatileMedia.values()].filter((e) => e.draftKey === key),
  )
  const [error, setError] = useState(() =>
    [...volatileMedia.values()].some((e) => e.draftKey === key)
      ? 'File bytes are not saved on this device. Retry storage before closing this app.'
      : '',
  )
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [attempt, setAttempt] = useState(0)
  const alive = useRef(true)
  const abort = useRef(new AbortController())
  const jobs = useRef(new Map<string, Promise<void>>())
  const transfers = useRef(new Map<string, AbortController>())
  const selecting = useRef(0)
  const removed = useRef(new Set<string>())
  const [busy, setBusy] = useState(false)
  async function reconcile(entry: PendingMedia) {
    if (!client || abort.current.signal.aborted) return
    const existing = jobs.current.get(entry.id)
    if (existing) return existing
    const task = (async () => {
      try {
        const result = await client.receipt(entry.intent, abort.current.signal)
        if (abort.current.signal.aborted) return
        const current = await mediaStorage.get(entry.id)
        if (!current || current.state === 'ready') return
        if (result.status === 'accepted')
          await mediaStorage.change(current, {
            state: 'ready',
            receipt: result,
          })
      } catch {
        /* Read failure cannot prove the write failed. */
      }
    })()
    jobs.current.set(entry.id, task)
    await task
    if (jobs.current.get(entry.id) === task) jobs.current.delete(entry.id)
  }
  async function upload(entry: PendingMedia, retry = false) {
    if (!client || abort.current.signal.aborted) return
    if (retry) await reconcile(entry)
    await jobs.current.get(entry.id)
    if (abort.current.signal.aborted) return
    let current = await mediaStorage.get(entry.id)
    if (
      !current ||
      current.association !== 'draft' ||
      current.state === 'ready'
    )
      return
    if (
      current.state === 'uploading' &&
      Date.now() - current.updatedAt < 35000
    ) {
      if (!retry) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.max(0, 35000 - (Date.now() - current!.updatedAt)),
        )
        abort.current.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      if (abort.current.signal.aborted) return
      await reconcile(current)
      current = await mediaStorage.get(entry.id)
      if (
        !current ||
        current.state === 'ready' ||
        current.association !== 'draft'
      )
        return
    }
    const claim = await mediaStorage.change(current, { state: 'uploading' })
    if (!claim || abort.current.signal.aborted) return
    const controller = new AbortController()
    transfers.current.set(entry.id, controller)
    const task = (async () => {
      try {
        const capabilities = await client.capabilities(abort.current.signal)
        if (claim.bytes.size > capabilities.maxUploadBytes)
          throw new Error(
            `File exceeds the server’s ${capabilities.maxUploadBytes} byte upload capability. Original bytes remain saved locally.`,
          )
        const receipt = await client.upload(
          claim.intent,
          claim.bytes,
          AbortSignal.any([controller.signal, abort.current.signal]),
          (value) => {
            if (alive.current) setProgress((p) => ({ ...p, [entry.id]: value }))
          },
        )
        const latest = await mediaStorage.get(entry.id)
        // Removing an association never gets reversed by a late acknowledgement.
        if (latest && latest.state !== 'ready')
          await mediaStorage.change(
            latest,
            receipt.status === 'accepted'
              ? { state: 'ready', receipt, error: undefined }
              : { state: 'uncertain' },
          )
      } catch (error) {
        const latest = await mediaStorage.get(entry.id)
        if (latest?.state === 'uploading')
          await mediaStorage.change(latest, {
            state: 'uncertain',
            error:
              error instanceof Error
                ? error.message
                : 'Upload outcome unconfirmed.',
          })
      }
    })().catch(() => {
      if (alive.current)
        setError(
          'Upload state could not be saved. Original bytes remain on this device; check the receipt before retrying.',
        )
    })
    jobs.current.set(entry.id, task)
    await task
    if (jobs.current.get(entry.id) === task) jobs.current.delete(entry.id)
    transfers.current.delete(entry.id)
  }
  useEffect(() => {
    alive.current = true
    abort.current = new AbortController()
    const subscription = liveQuery(() => mediaStorage.list(key)).subscribe({
      next: (values) => {
        setEntries(values)
        setStorageReady(true)
      },
      error: () => {
        setStorageReady(false)
        setError(
          'Attachment storage is unavailable. Retry storage before sending.',
        )
      },
    })
    return () => {
      alive.current = false
      abort.current.abort()
      subscription.unsubscribe()
    }
  }, [key, attempt])
  useEffect(() => {
    const pending = entries.filter((e) =>
      ['uploading', 'uncertain'].includes(e.state),
    )
    const check = () => {
      for (const entry of pending) void reconcile(entry)
    }
    check()
    const timer = setInterval(check, 3000)
    return () => clearInterval(timer)
    // No write replay when restoring a journal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, client])
  async function add(
    files: { blob: Blob; name: string; purpose: MediaPurpose }[],
  ) {
    if (!client) {
      setError('Media service is not configured.')
      return
    }
    const positions = files.map(() => {
      selectionOrder = Math.max(selectionOrder + 1, Date.now() * 1000)
      return selectionOrder
    })
    const captured = structuredClone(target)
    selecting.current++
    setBusy(true)
    try {
      for (const [index, file] of files.entries()) {
        const id = crypto.randomUUID()
        const entry: PendingMedia = {
          id,
          draftKey: key,
          bytes: file.blob,
          intent: {
            uploadId: id,
            target: captured,
            name: file.name,
            mimeType: file.blob.type || 'application/octet-stream',
            size: file.blob.size,
            sha256: await digest(file.blob),
            purpose: file.purpose,
          },
          revision: crypto.randomUUID(),
          state: 'saved',
          association: 'draft',
          createdAt: positions[index],
          updatedAt: Date.now(),
        }
        try {
          await mediaStorage.add(entry)
          if (!abort.current.signal.aborted)
            void upload(entry).catch(() => {
              if (alive.current)
                setError(
                  'Upload state cannot be saved. Original bytes remain local. Retry attachment storage before uploading.',
                )
            })
        } catch {
          volatileMedia.set(entry.id, entry)
          if (alive.current) {
            setUnsaved((list) => [...list, entry])
            setError(
              'File bytes are not saved on this device. Keep this view open and retry storage before sending.',
            )
          }
        }
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Could not prepare files.')
    } finally {
      selecting.current--
      if (alive.current) setBusy(selecting.current > 0)
    }
  }
  return {
    // A committed row can arrive before the quota-recovery promise settles.
    entries: [
      ...entries.filter((e) => e.association === 'draft'),
      ...unsaved.filter((e) => !entries.some((saved) => saved.id === e.id)),
    ],
    progress,
    error,
    busy,
    blocked:
      !storageReady ||
      busy ||
      unsaved.length > 0 ||
      entries.some((e) => e.association === 'draft' && e.state !== 'ready'),
    add,
    async remove(entry: PendingMedia) {
      removed.current.add(entry.id)
      transfers.current.get(entry.id)?.abort()
      if (unsaved.some((e) => e.id === entry.id)) {
        volatileMedia.delete(entry.id)
        setUnsaved((list) => list.filter((e) => e.id !== entry.id))
      }
      // During recovery the same ID can already exist in both stores.
      try {
        while (true) {
          const latest = await mediaStorage.get(entry.id)
          if (!latest || latest.association !== 'draft') break
          if (await mediaStorage.change(latest, { association: 'removed' }))
            break
        }
      } catch {
        setError(
          'The attachment could not be removed from saved storage. Retry storage and remove it again.',
        )
      }
    },
    cancel(entry: PendingMedia) {
      transfers.current.get(entry.id)?.abort()
    },
    retry: (entry: PendingMedia) =>
      upload(entry, true).catch(() => {
        if (alive.current)
          setError(
            'Upload state cannot be saved. Original bytes remain local. Retry attachment storage before uploading.',
          )
      }),
    async retryStorage() {
      setError('')
      setStorageReady(false)
      setAttempt((a) => a + 1)
      for (const entry of unsaved) {
        try {
          await mediaStorage.add(entry)
          if (removed.current.has(entry.id)) {
            while (true) {
              const current = await mediaStorage.get(entry.id)
              if (!current || current.association !== 'draft') break
              if (
                await mediaStorage.change(current, { association: 'removed' })
              )
                break
            }
          }
          volatileMedia.delete(entry.id)
          setUnsaved((list) => list.filter((e) => e.id !== entry.id))
        } catch {
          setError('File bytes still cannot be saved. Keep this view open.')
          break
        }
      }
    },
  }
}
