import Dexie, { type Table } from 'dexie'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Platform } from '../../platform/platform'
import { deliveryKind, type InboxNotification } from '../../data/notifications'
import { notificationSetting, useSystemNotifications } from './settings'

const db = new Dexie('kipster-notification-attention') as Dexie & {
  claims: Table<{ id: string; at: number }, string>
}
db.version(1).stores({ claims: '&id' })
/** One tab of this browser profile claims each arrival, so several tabs alert once. */
async function claim(key: string, eligible: () => boolean) {
  return db.transaction('rw', db.claims, async () => {
    if ((await db.claims.get(key)) || !eligible()) return false
    await db.claims.add({ id: key, at: Date.now() })
    return true
  })
}

export const foreground = (platform: Platform) =>
  platform.attention?.isForeground() ??
  (document.visibilityState === 'visible' && document.hasFocus())

/**
 * Delivers each newly arrived notification once: nothing for the thread on screen, an
 * in-app banner for another thread while Kipster is in front, else a system notification.
 */
export function useDelivery(
  platform: Platform | null,
  scope: string,
  items: InboxNotification[],
  arrivals: string[],
  selected: string | null,
) {
  const [banners, setBanners] = useState<string[]>([])
  const seen = useRef(new Set<string>())
  const system = useSystemNotifications(platform, scope).on
  const latest = useRef({ items, selected, scope, system })
  useEffect(() => {
    latest.current = { items, selected, scope, system }
  })
  useEffect(() => {
    if (!platform || !scope) return
    for (const id of arrivals) {
      const key = JSON.stringify([scope, id])
      if (seen.current.has(key)) continue
      seen.current.add(key)
      const route = () => {
        const now = latest.current
        const n = now.items.find((n) => n.id === id)
        if (!n || n.read || now.scope !== scope) return null
        if (foreground(platform))
          return n.target.threadId !== now.selected &&
            notificationSetting(platform, 'banners')
            ? { n, banner: true }
            : null
        return platform.notifications.sendExisting &&
          now.system &&
          notificationSetting(platform, deliveryKind(n))
          ? { n, banner: false }
          : null
      }
      if (!route()) continue
      void (async () => {
        try {
          if (!(await claim(key, () => !!route()))) return
          const chosen = route()
          if (!chosen) return void (await db.claims.delete(key))
          const { n } = chosen
          if (chosen.banner)
            setBanners((old) => [...old.filter((b) => b !== id), id].slice(-3))
          else
            await platform.notifications.sendExisting?.({
              notificationId: n.id,
              threadId: n.target.threadId,
              title: n.title,
              subtitle: n.thread,
              body: n.body,
            })
        } catch {
          /* The inbox still shows it. */
        }
      })()
    }
  }, [platform, scope, arrivals])
  useEffect(() => {
    if (selected)
      setBanners((old) =>
        old.filter(
          (id) => items.find((n) => n.id === id)?.target.threadId !== selected,
        ),
      )
    // Opening a thread dismisses its banners; later arrivals there are read on sight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])
  return {
    banners: banners.flatMap((id) => {
      const n = items.find((n) => n.id === id)
      return n && n.target.threadId !== selected && (!n.read || n.pending)
        ? [n]
        : []
    }),
    dismiss: useCallback(
      (id: string) => setBanners((old) => old.filter((b) => b !== id)),
      [],
    ),
  }
}
