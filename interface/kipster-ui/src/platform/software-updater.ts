/// <reference types="vite/client" />
import { isTauri, invoke } from '@tauri-apps/api/core'
import type { Update } from '@tauri-apps/plugin-updater'

export type DownloadedAppUpdate = Pick<
  Update,
  'version' | 'body' | 'download' | 'install' | 'close'
>
export type SoftwareUpdater = {
  available(): Promise<boolean>
  check(endpoint: string): Promise<DownloadedAppUpdate | null>
  onQuit(install: () => Promise<void>): Promise<() => void>
  arm(ready: boolean, automatic: boolean): Promise<void>
  finish(restart: boolean): Promise<void>
}

/** Native bindings stay unreachable in demo, browser and development builds. */
export function nativeSoftwareUpdater(): SoftwareUpdater | null {
  if (__KIPSTER_DEMO__ || import.meta.env.DEV || !isTauri()) return null
  return {
    available: () => invoke<boolean>('software_updater_available'),
    check: async (endpoint) => {
      const { Update } = await import('@tauri-apps/plugin-updater')
      const metadata = await invoke<
        ConstructorParameters<typeof Update>[0] | null
      >('check_software_update', { endpoint })
      return metadata ? new Update(metadata) : null
    },
    onQuit: async (install) =>
      (await import('@tauri-apps/api/event')).listen(
        'software-update-quit',
        () => {
          void install().catch(() =>
            invoke('finish_software_update_quit').catch(() => {}),
          )
        },
      ),
    arm: (ready, automatic) =>
      invoke('arm_software_update', { ready, automatic }),
    finish: async (restart) => {
      await invoke('arm_software_update', { ready: false, automatic: false })
      if (restart) await (await import('@tauri-apps/plugin-process')).relaunch()
      else await invoke('finish_software_update_quit')
    },
  }
}
