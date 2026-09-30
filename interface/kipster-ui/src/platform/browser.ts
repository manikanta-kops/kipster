import { browserRecording } from './recording'
import type { Platform } from './platform'
import { localPreferences } from './preferences'

export const browserPlatform: Platform = {
  preferences: localPreferences,
  attention: {
    isForeground: () =>
      document.visibilityState === 'visible' && document.hasFocus(),
  },
  recording: browserRecording,
  notifications: {
    supported: false,
    async send() {
      return { status: 'unavailable' }
    },
  },
}
