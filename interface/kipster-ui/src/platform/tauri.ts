import { browserRecording } from './recording'
import * as notification from '@tauri-apps/plugin-notification'
import { localPreferences } from './preferences'
import {
  requestNotification,
  sendExistingNotification,
} from './notification-service'
import type { Platform } from './platform'

export const tauriPlatform: Platform = {
  preferences: localPreferences,
  attention: {
    isForeground: () =>
      document.visibilityState === 'visible' && document.hasFocus(),
  },
  recording: browserRecording,
  notifications: {
    supported: true,
    sendExisting: (message) => sendExistingNotification(notification, message),
    send: (message) => requestNotification(notification, message),
  },
}
