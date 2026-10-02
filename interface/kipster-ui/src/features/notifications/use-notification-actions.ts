import { useEffect, useMemo, useRef } from 'react'
import type { NotificationClient } from '../../data/core-work'

/** Pending reads and clears for one client. Both are idempotent, so failures go again. */
function notificationQueue(client: NotificationClient) {
  const read = new Set<string>()
  const clear = new Set<string>()
  const signal = new AbortController().signal
  let busy = false
  let failures = 0
  let timer = 0
  async function flush(): Promise<void> {
    if (busy || (!read.size && !clear.size)) return
    busy = true
    clearTimeout(timer)
    try {
      const clearing = [...clear]
      if (clearing.length) await client.clear(clearing, signal)
      for (const id of clearing) clear.delete(id)
      const reading = [...read]
      if (reading.length) await client.read(reading, signal)
      for (const id of reading) read.delete(id)
      failures = 0
    } catch {
      timer = window.setTimeout(
        () => void flush(),
        Math.min(30000, 1000 * 2 ** failures++),
      )
      return
    } finally {
      busy = false
    }
    return flush()
  }
  return {
    read(ids: string[]) {
      for (const id of ids) read.add(id)
      void flush()
    },
    clear(ids: string[]) {
      for (const id of ids) clear.add(id)
      void flush()
    },
    retry: () => void flush(),
  }
}

/**
 * Reads and clears show at once and are sent in the background. Failed sends stay queued
 * and go again with backoff, or as soon as `retry` is called.
 */
export function useNotificationActions(
  client: NotificationClient | undefined,
  apply: { read: (ids: string[]) => void; remove: (ids: string[]) => void },
) {
  const queue = useMemo(() => client && notificationQueue(client), [client])
  const applied = useRef(apply)
  useEffect(() => {
    applied.current = apply
  })
  return useMemo(
    () => ({
      canClear: !!client?.canClear,
      read(ids: string[]) {
        if (!ids.length) return
        applied.current.read(ids)
        queue?.read(ids)
      },
      clear(ids: string[]) {
        if (!ids.length || !client?.canClear) return
        applied.current.remove(ids)
        queue?.clear(ids)
      },
      retry: () => queue?.retry(),
    }),
    [client, queue],
  )
}
