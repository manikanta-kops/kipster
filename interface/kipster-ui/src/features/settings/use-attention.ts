import Dexie, { type Table } from 'dexie'
import { useEffect, useRef, useState } from 'react'
import type { Platform } from '../../platform/platform'
import type { InboxNotification } from '../../data/settings'
const db = new Dexie('kipster-notification-attention') as Dexie & {
  claims: Table<{ id: string; at: number }, string>
}
db.version(1).stores({ claims: '&id' })
async function claimAttention(
  scope: string,
  id: string,
  eligible: () => boolean,
) {
  return db.transaction('rw', db.claims, async () => {
    const key = JSON.stringify([scope, id])
    if (await db.claims.get(key)) return false
    if (!eligible()) return false
    await db.claims.add({ id: key, at: Date.now() })
    return true
  })
}
const preferenceKey = (scope: string) => `desktop-notifications:${scope}`
export function useAttention(
  platform: Platform,
  scopeKey: string,
  notifications: InboxNotification[],
  attention: string[],
  threadId: string | null,
) {
  const seen = useRef(new Set<string>())
  const current = useRef({ notifications, threadId })
  useEffect(() => {
    current.current = { notifications, threadId }
  }, [notifications, threadId])
  const [notice, setNotice] = useState<InboxNotification | null>(null)
  const [delivery, setDelivery] = useState('')
  const life = useRef({ active: true })
  useEffect(() => {
    const generation = { active: true }
    life.current = generation
    return () => {
      generation.active = false
    }
  }, [scopeKey])
  useEffect(() => {
    const generation = life.current
    for (const id of attention) {
      if (seen.current.has(id)) continue
      seen.current.add(id)
      const n = notifications.find((n) => n.id === id)
      if (!n || n.read) continue
      void (async () => {
        try {
          function candidate() {
            if (!generation.active) return null
            const latest = current.current.notifications.find(
              (n) => n.id === id,
            )
            if (!latest || latest.read) return null
            const foreground =
              platform.attention?.isForeground() ??
              (document.visibilityState === 'visible' && document.hasFocus())
            if (foreground)
              return latest.target.threadId !== current.current.threadId
                ? { latest, foreground }
                : null
            return platform.notifications.supported &&
              platform.notifications.sendExisting &&
              platform.preferences.get(preferenceKey(scopeKey)) === 'enabled'
              ? { latest, foreground }
              : null
          }
          if (!candidate()) return
          if (!(await claimAttention(scopeKey, id, () => !!candidate()))) return
          const eligible = candidate()
          if (!eligible) {
            await db.claims.delete(JSON.stringify([scopeKey, id]))
            return
          }
          const { latest, foreground } = eligible
          if (foreground) setNotice(latest)
          else {
            const result = await platform.notifications.sendExisting?.({
              title: latest.title,
              body: 'Open Kipster to view the original context.',
              notificationId: latest.id,
            })
            if (generation.active)
              setDelivery(
                result?.status === 'requested'
                  ? 'Desktop notification requested; visibility is controlled by the OS.'
                  : `Desktop notification ${result?.status ?? 'unavailable'}. The update remains in your inbox.`,
              )
          }
        } catch {
          if (generation.active)
            setDelivery(
              'Attention could not be recorded locally. The update remains in your inbox.',
            )
        }
      })()
    }
  }, [platform, scopeKey, attention, notifications, threadId])
  return {
    notice:
      notice &&
      !notifications.find((n) => n.id === notice.id)?.read &&
      notice.target.threadId !== threadId
        ? notice
        : null,
    delivery,
    dismiss: () => setNotice(null),
  }
}
