import { useEffect, useId, useState, type ReactNode } from 'react'
import type {
  HostSetting,
  NotificationPermission,
  Platform,
} from '../../platform/platform'
import {
  setNotificationSetting,
  useNotificationSettings,
  useSystemNotifications,
  type NotificationSetting,
} from './settings'

function Row({
  label,
  hint,
  sub,
  off,
  children,
}: {
  label: string
  hint: ReactNode
  sub?: boolean
  off?: boolean
  children: (labelId: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className={`setting-row ${sub ? 'sub' : ''} ${off ? 'off' : ''}`}>
      <span className="setting-label" id={id}>
        {label}
        <small>{hint}</small>
      </span>
      {children(id)}
    </div>
  )
}

function Switch({
  labelId,
  on,
  disabled,
  change,
}: {
  labelId: string
  on: boolean
  disabled?: boolean
  change: (on: boolean) => void
}) {
  return (
    <span className="management-checkbox setting-switch">
      <input
        type="checkbox"
        role="switch"
        aria-labelledby={labelId}
        checked={on}
        aria-checked={on}
        disabled={disabled}
        onChange={(event) => change(event.target.checked)}
      />
    </span>
  )
}

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

const permissionHint: Record<NotificationPermission, string> = {
  granted: 'Allowed in System Settings',
  denied: 'Turned off for Kipster in System Settings.',
  prompt: 'Kipster asks before showing the first one.',
  unavailable: 'Not available on this device.',
}

export function NotificationSettings({
  platform,
  scope,
}: {
  platform: Platform
  /** The connection and caller, as `JSON.stringify([endpoint, installationId, callerId])`. */
  scope: string
}) {
  const settings = useNotificationSettings(platform)
  const master = useSystemNotifications(platform, scope)
  const set = (name: NotificationSetting) => (on: boolean) =>
    setNotificationSetting(platform, name, on)
  const system = platform.notifications.supported
  const [permission, setPermission] = useState<NotificationPermission | null>(
    null,
  )
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => {
    let active = true
    platform.notifications.permission?.().then(
      (value) => active && setPermission(value),
      () => {},
    )
    return () => {
      active = false
    }
  }, [platform])
  const keepRunning = useHostSetting(platform.app?.keepRunning)
  const openAtLogin = useHostSetting(platform.app?.openAtLogin)
  async function test() {
    setSending(true)
    try {
      const result = await platform.notifications.send({
        title: 'Kipster',
        body: 'Notifications are on. This is how your kips reach you.',
      })
      setStatus(
        result.status === 'requested'
          ? 'Sent. If it didn’t appear, check Focus and System Settings.'
          : result.status === 'denied'
            ? 'Notifications are turned off for Kipster in System Settings.'
            : 'The test notification couldn’t be sent.',
      )
      const now = await platform.notifications.permission?.()
      if (now) setPermission(now)
    } finally {
      setSending(false)
    }
  }
  const kinds: [NotificationSetting, string, string][] = [
    ['needs', 'Needs you', 'Questions and approvals from your kips'],
    ['failures', 'Failures', 'Work that couldn’t finish or was interrupted'],
    ['replies', 'Replies', 'A kip finished and replied'],
  ]
  return (
    <section className="notification-settings" aria-label="Notifications">
      {system && (
        <>
          <h4 className="group-label">macOS</h4>
          <div className="settings-group">
            <Row
              label="macOS notifications"
              hint={
                <>
                  Shown when Kipster isn’t in front.{' '}
                  {permission && (
                    <span className="permission" data-state={permission}>
                      <i aria-hidden="true" />
                      {permissionHint[permission]}
                    </span>
                  )}
                </>
              }
            >
              {(id) => (
                <Switch labelId={id} on={master.on} change={master.set} />
              )}
            </Row>
            {kinds.map(([name, label, hint]) => (
              <Row key={name} label={label} hint={hint} sub off={!master.on}>
                {(id) => (
                  <Switch
                    labelId={id}
                    on={settings[name]}
                    disabled={!master.on}
                    change={set(name)}
                  />
                )}
              </Row>
            ))}
            <Row
              label="Test notification"
              hint={status || 'Check how Kipster’s notifications look.'}
            >
              {() => (
                <div className="row-actions">
                  {permission === 'denied' &&
                    platform.notifications.openSettings && (
                      <button
                        className="secondary-button"
                        onClick={() =>
                          void platform.notifications.openSettings?.()
                        }
                      >
                        Open System Settings
                      </button>
                    )}
                  <button
                    className="secondary-button"
                    disabled={sending}
                    onClick={() => void test()}
                  >
                    Send test notification
                  </button>
                </div>
              )}
            </Row>
          </div>
        </>
      )}
      <h4 className="group-label">While Kipster is open</h4>
      <div className="settings-group">
        <Row
          label="In-app banners"
          hint="Show a banner in the top-right corner for chats you aren’t looking at."
        >
          {(id) => (
            <Switch
              labelId={id}
              on={settings.banners}
              change={set('banners')}
            />
          )}
        </Row>
      </div>
      {(platform.app || platform.badge) && (
        <>
          <h4 className="group-label">App</h4>
          <div className="settings-group">
            {platform.app && (
              <>
                <Row
                  label="Keep running when the window closes"
                  hint={
                    keepRunning.error ||
                    'Kipster stays in the Dock so notifications keep arriving. ⌘Q quits.'
                  }
                >
                  {(id) => (
                    <Switch
                      labelId={id}
                      on={!!keepRunning.on}
                      disabled={keepRunning.on === null}
                      change={(on) => void keepRunning.set(on)}
                    />
                  )}
                </Row>
                <Row
                  label="Open at login"
                  hint={
                    openAtLogin.error ||
                    'Starts in the background after you sign in to your Mac.'
                  }
                >
                  {(id) => (
                    <Switch
                      labelId={id}
                      on={!!openAtLogin.on}
                      disabled={openAtLogin.on === null}
                      change={(on) => void openAtLogin.set(on)}
                    />
                  )}
                </Row>
              </>
            )}
            {platform.badge && (
              <Row
                label="Dock badge"
                hint="Counts questions, approvals and failures that need you."
              >
                {(id) => (
                  <Switch
                    labelId={id}
                    on={settings.badge}
                    change={set('badge')}
                  />
                )}
              </Row>
            )}
          </div>
        </>
      )}
    </section>
  )
}
