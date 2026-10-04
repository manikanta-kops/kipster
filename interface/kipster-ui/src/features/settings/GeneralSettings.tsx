import { useEffect, useState } from 'react'
import type { HostSetting, Platform } from '../../platform/platform'
import { Block, SwitchRow } from './ui'

/** A switch kept by the host, such as open at login. */
function useHostSetting(setting: HostSetting | undefined) {
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setting?.get().then(
      (value) => active && setOn(value),
      () => active && setError('Couldn’t read this setting.'),
    )
    return () => {
      active = false
    }
  }, [setting])
  return {
    on,
    error,
    async set(value: boolean) {
      if (!setting) return
      setError('')
      try {
        await setting.set(value)
        setOn(await setting.get())
      } catch {
        setError('Couldn’t change this setting. Try again.')
      }
    },
  }
}

/** How the desktop app starts and runs. */
export function GeneralSettings({
  app,
}: {
  app: NonNullable<Platform['app']>
}) {
  const openAtLogin = useHostSetting(app.openAtLogin)
  const keepRunning = useHostSetting(app.keepRunning)
  return (
    <Block label="Startup">
      <SwitchRow
        label="Open at login"
        sub={
          openAtLogin.error ||
          'Starts in the background after you sign in to your Mac.'
        }
        on={!!openAtLogin.on}
        disabled={openAtLogin.on === null}
        change={(on) => void openAtLogin.set(on)}
      />
      <SwitchRow
        label="Keep running when the window closes"
        sub={
          keepRunning.error ||
          'Kipster stays in the Dock so notifications keep arriving. ⌘Q quits.'
        }
        on={!!keepRunning.on}
        disabled={keepRunning.on === null}
        change={(on) => void keepRunning.set(on)}
      />
    </Block>
  )
}
