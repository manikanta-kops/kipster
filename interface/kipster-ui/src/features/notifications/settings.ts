import { useMemo, useSyncExternalStore } from 'react'
import type { Platform } from '../../platform/platform'

/** App-wide notification switches kept on this device. */
const defaults = {
  needs: true,
  failures: true,
  replies: true,
  banners: false,
  badge: true,
}
export type NotificationSetting = keyof typeof defaults
export type NotificationSettings = Record<NotificationSetting, boolean>
const names = Object.keys(defaults) as NotificationSetting[]
const key = (name: string) => `notifications.${name}`
const listeners = new Set<() => void>()

export function notificationSetting(
  platform: Platform,
  name: NotificationSetting,
): boolean {
  const value = platform.preferences.get(key(name))
  return value === null ? defaults[name] : value === 'on'
}

export function setNotificationSetting(
  platform: Platform,
  name: NotificationSetting,
  on: boolean,
) {
  platform.preferences.set(key(name), on ? 'on' : 'off')
  changed()
}

const changed = () => {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

export function useNotificationSettings(
  platform: Platform | null,
): NotificationSettings {
  const snapshot = useSyncExternalStore(subscribe, () =>
    names
      .map((name) =>
        (platform ? notificationSetting(platform, name) : defaults[name])
          ? '1'
          : '0',
      )
      .join(''),
  )
  return useMemo(
    () =>
      Object.fromEntries(
        names.map((name, index) => [name, snapshot[index] === '1']),
      ) as NotificationSettings,
    [snapshot],
  )
}

/** Desktop builds ask for permission once, after the workspace first connects. */
export const permissionAskedKey = 'notifications.permission-asked'

const systemKey = (scope: string) => `desktop-notifications:${scope}`
/**
 * The "macOS notifications" master switch: the installation's desktop alert choice,
 * kept for this window while Core keeps none. Unset means on.
 */
export function useSystemNotifications(
  platform: Platform | null,
  scope: string,
) {
  const saved = useSyncExternalStore(subscribe, () =>
    platform ? platform.preferences.get(systemKey(scope)) : null,
  )
  return {
    on: saved !== 'disabled',
    set(on: boolean) {
      platform?.preferences.set(systemKey(scope), on ? 'enabled' : 'disabled')
      changed()
    },
  }
}
