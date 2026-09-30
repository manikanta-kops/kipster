import type { Platform } from './platform'

/** Web storage works in both the browser and Tauri webview. Not for secrets. */
export const localPreferences: Platform['preferences'] = {
  get(key) {
    try {
      return localStorage.getItem(`kipster:${key}`)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`kipster:${key}`, value)
    } catch {
      /* Storage may be disabled. */
    }
  },
}
