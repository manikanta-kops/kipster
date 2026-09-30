import { isTauri } from '@tauri-apps/api/core'
import { browserPlatform } from './browser'
import type { Platform } from './platform'

export async function resolvePlatform(): Promise<Platform> {
  // Load native plugin bindings only when hosted by Tauri.
  if (isTauri()) return (await import('./tauri')).tauriPlatform
  return browserPlatform
}

/**
 * The macOS desktop window draws its traffic lights over the page
 * (`titleBarStyle: Overlay`), so the UI must reserve room for them.
 */
export function usesOverlayTitleBar(): boolean {
  return (
    isTauri() &&
    /Macintosh/.test(navigator.userAgent) &&
    navigator.maxTouchPoints === 0
  )
}
