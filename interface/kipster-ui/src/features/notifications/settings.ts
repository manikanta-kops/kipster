import { useContext, useMemo, useSyncExternalStore } from 'react'
import {
  desktopAlertsKey,
  InterfacePreferencesContext,
  type InterfaceChange,
  type InterfacePreferences,
} from '../../data/interface-preferences'
import type { Platform } from '../../platform/platform'

/** Notification switches: Core's choice when it keeps one, else this window's, else the default. */
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
const shared = {
  needs: 'notifyNeeds',
  failures: 'notifyFailures',
  replies: 'notifyReplies',
  banners: 'inAppBanners',
  badge: 'dockBadge',
} as const satisfies Record<NotificationSetting, keyof InterfaceChange>
const key = (name: string) => `notifications.${name}`
const listeners = new Set<() => void>()
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
const noPreferences = () => () => {}

function value(
  platform: Platform | null,
  preferences: InterfacePreferences | null,
  name: NotificationSetting,
) {
  const core = preferences?.value?.[shared[name]]
  if (typeof core === 'boolean') return core
  const own = platform?.preferences.get(key(name))
  return own === 'on' ? true : own === 'off' ? false : defaults[name]
}

export function useNotificationSettings(platform: Platform | null) {
  const preferences = useContext(InterfacePreferencesContext)
  useSyncExternalStore(
    preferences?.subscribe ?? noPreferences,
    () => preferences?.value,
  )
  const snapshot = useSyncExternalStore(subscribe, () =>
    names
      .map((name) => (value(platform, preferences, name) ? '1' : '0'))
      .join(''),
  )
  const settings = useMemo(
    () =>
      Object.fromEntries(
        names.map((name) => [name, value(platform, preferences, name)]),
      ) as NotificationSettings,
    // The snapshot string changes whenever a value does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, preferences?.value],
  )
  const set = (name: NotificationSetting, on: boolean) => {
    platform?.preferences.set(key(name), on ? 'on' : 'off')
    changed()
    void preferences?.save({ [shared[name]]: on }).catch(() => {})
  }
  return { settings, set }
}

/** This window's own choices, which fill those Core never saved. */
export function ownNotificationChoices(platform: Platform): InterfaceChange {
  return Object.fromEntries(
    names.map((name) => {
      const own = platform.preferences.get(key(name))
      return [shared[name], own === null ? null : own === 'on']
    }),
  )
}

/** Desktop builds ask for permission once, after the workspace first connects. */
export const permissionAskedKey = 'notifications.permission-asked'

/**
 * The "macOS notifications" master switch: the installation's desktop alert choice in
 * Core, shared with Kip and other windows, else this window's own. Unset means on.
 */
export function useSystemNotifications(
  platform: Platform | null,
  scope: string,
) {
  const preferences = useContext(InterfacePreferencesContext)
  const shared = useSyncExternalStore(
    preferences?.subscribe ?? noPreferences,
    () => preferences?.value?.desktopNotifications ?? null,
  )
  const own = useSyncExternalStore(subscribe, () =>
    platform ? platform.preferences.get(desktopAlertsKey(scope)) : null,
  )
  return {
    on: shared ?? own !== 'disabled',
    set(on: boolean) {
      platform?.preferences.set(
        desktopAlertsKey(scope),
        on ? 'enabled' : 'disabled',
      )
      changed()
      void preferences?.save({ desktopNotifications: on }).catch(() => {})
    },
  }
}
