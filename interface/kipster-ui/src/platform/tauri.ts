import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { browserRecording } from './recording'
import { localPreferences } from './preferences'
import {
  requestNotification,
  sendExistingNotification,
  type NotificationDriver,
} from './notification-service'
import type {
  HostSetting,
  NotificationPermission,
  NotificationTarget,
  Platform,
} from './platform'

/** Rust commands in `src-tauri/src/notifications.rs`. */
const notifications: NotificationDriver = {
  isPermissionGranted: async () =>
    (await invoke<NotificationPermission>('notification_permission')) ===
    'granted',
  requestPermission: () =>
    invoke<NotificationPermission>('request_notification_permission'),
  sendNotification: ({ title, subtitle, body, threadId, notificationId }) =>
    invoke('send_notification', {
      message: { title, subtitle, body, threadId, notificationId },
    }),
}

function onNotificationOpen(listener: (target: NotificationTarget) => void) {
  let active = true
  // Rust keeps the latest click until it is taken, so a click that launched
  // the app is delivered once the interface subscribes.
  const deliver = async () => {
    if (!active) return
    const target = await invoke<NotificationTarget | null>(
      'take_pending_notification_target',
    ).catch(() => null)
    if (target) listener(target)
  }
  const unlisten = listen('notification-open', () => void deliver())
  void unlisten.then(deliver, () => {})
  return () => {
    active = false
    void unlisten.then(
      (stop) => stop(),
      () => {},
    )
  }
}

function hostSetting(read: string, write: string): HostSetting {
  return {
    get: () => invoke<boolean>(read),
    set: (on) => invoke(write, { on }),
  }
}

const macOS = /Macintosh/.test(navigator.userAgent)

export const tauriPlatform: Platform = {
  preferences: localPreferences,
  attention: {
    isForeground: () =>
      document.visibilityState === 'visible' && document.hasFocus(),
  },
  recording: browserRecording,
  notifications: {
    supported: true,
    permission: () => invoke<NotificationPermission>('notification_permission'),
    requestPermission: () =>
      invoke<NotificationPermission>('request_notification_permission'),
    sendExisting: (message) => sendExistingNotification(notifications, message),
    send: (message) => requestNotification(notifications, message),
    onOpen: onNotificationOpen,
    openSettings: macOS
      ? () => invoke('open_notification_settings')
      : undefined,
  },
  // Window lifecycle and the Dock badge are implemented for macOS only.
  badge: macOS
    ? {
        set: (count) =>
          getCurrentWindow().setBadgeCount(count > 0 ? count : undefined),
      }
    : undefined,
  app: macOS
    ? {
        keepRunning: hostSetting('keep_running_enabled', 'set_keep_running'),
        openAtLogin: hostSetting('open_at_login_enabled', 'set_open_at_login'),
      }
    : undefined,
}
