import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { PlatformContext } from '../../platform/context'
import type { Platform } from '../../platform/platform'
import { createNotificationClient } from '../../data/core-work'
import { needsYou, type InboxNotification } from '../../data/notifications'
import { useNotificationActions } from './use-notification-actions'
import { foreground, useDelivery } from './use-delivery'
import { permissionAskedKey, useNotificationSettings } from './settings'

/** Whether the window is in front, following focus and visibility changes. */
function useForeground(platform: Platform | null) {
  const check = () => (platform ? foreground(platform) : true)
  const [value, setValue] = useState(check)
  useEffect(() => {
    const update = () => setValue(check())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
    // The check reads the platform it closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform])
  return value
}

/**
 * The workspace's notification behaviour: reading what is on screen, delivery, the app
 * badge, the system permission prompt and opening a thread from a system notification.
 */
export function useNotifications(input: {
  endpoint: string
  /** Core advertises batch read and clear. Undefined until connected. */
  actions: boolean | undefined
  scope: string
  items: InboxNotification[]
  arrivals: string[]
  selected: string | null
  ready: boolean
  online: boolean
  read: (ids: string[]) => void
  remove: (ids: string[]) => void
  openThread: (threadId: string) => void
}) {
  const platform = useContext(PlatformContext)
  const { items, selected, ready } = input
  const client = useMemo(
    () =>
      input.actions === undefined
        ? undefined
        : createNotificationClient(input.endpoint, input.actions),
    [input.endpoint, input.actions],
  )
  const { canClear, read, clear, retry } = useNotificationActions(client, input)
  const unreadIn = (threadId: string) =>
    items
      .filter((n) => n.target.threadId === threadId && !n.read)
      .map((n) => n.id)
  const readThread = (threadId: string) => read(unreadIn(threadId))

  const front = useForeground(platform)
  const onScreen = selected && front ? unreadIn(selected).join(' ') : ''
  useEffect(() => {
    if (onScreen) read(onScreen.split(' '))
  }, [onScreen, read])

  useEffect(() => {
    if (input.online) void retry()
  }, [input.online, retry])

  const { settings } = useNotificationSettings(platform)
  const needs = items.filter(needsYou).length
  useEffect(() => {
    void platform?.badge?.set(settings.badge ? needs : 0).catch(() => {})
  }, [platform, settings.badge, needs])

  useEffect(() => {
    if (!ready || !platform?.notifications.requestPermission) return
    if (platform.preferences.get(permissionAskedKey)) return
    platform.preferences.set(permissionAskedKey, 'yes')
    void platform.notifications.requestPermission().catch(() => {})
  }, [platform, ready])

  const latest = useRef({ ready, openThread: input.openThread, readThread })
  useEffect(() => {
    latest.current = { ready, openThread: input.openThread, readThread }
  })
  // A click can arrive before the workspace loads, such as the one that launched the app.
  const requested = useRef<string | null>(null)
  useEffect(() => {
    const open = (threadId: string) => {
      latest.current.openThread(threadId)
      latest.current.readThread(threadId)
    }
    return platform?.notifications.onOpen?.(({ threadId }) => {
      if (latest.current.ready) open(threadId)
      else requested.current = threadId
    })
  }, [platform])
  useEffect(() => {
    const threadId = requested.current
    if (!ready || !threadId) return
    requested.current = null
    latest.current.openThread(threadId)
    latest.current.readThread(threadId)
  }, [ready])

  const delivery = useDelivery(
    platform,
    input.scope,
    items,
    input.arrivals,
    selected,
  )
  return {
    ...delivery,
    needs,
    unread: items.filter((n) => !n.read).length,
    canClear,
    read,
    clear,
    readThread,
  }
}
