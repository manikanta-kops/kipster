import { useEffect, useState } from 'react'
import type { NotificationPermission, Platform } from '../../platform/platform'
import { Block, Row, SwitchRow } from '../settings/ui'
import {
  useNotificationSettings,
  useSystemNotifications,
  type NotificationSetting,
} from './settings'

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
  const { settings, set: save } = useNotificationSettings(platform)
  const master = useSystemNotifications(platform, scope)
  const set = (name: NotificationSetting) => (on: boolean) => save(name, on)
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
    <>
      {system && (
        <Block
          label="macOS notifications"
          foot="Shown when Kipster isn’t in front."
        >
          <SwitchRow
            label="Allow notifications"
            sub={
              permission && (
                <span className="permission" data-state={permission}>
                  <i aria-hidden="true" />
                  {permissionHint[permission]}
                </span>
              )
            }
            on={master.on}
            change={master.set}
          />
          {kinds.map(([name, label, hint]) => (
            <SwitchRow
              key={name}
              label={label}
              sub={hint}
              on={settings[name]}
              disabled={!master.on}
              dim={!master.on}
              change={set(name)}
            />
          ))}
          <Row
            label="Test notification"
            sub={status || 'Check how Kipster’s notifications look.'}
            control={
              <>
                {permission === 'denied' &&
                  platform.notifications.openSettings && (
                    <button
                      className="set-button"
                      onClick={() =>
                        void platform.notifications.openSettings?.()
                      }
                    >
                      Open System Settings
                    </button>
                  )}
                <button
                  className="set-button"
                  disabled={sending}
                  onClick={() => void test()}
                >
                  Send test
                </button>
              </>
            }
          />
        </Block>
      )}
      <Block label="While Kipster is open">
        <SwitchRow
          label="In-app banners"
          sub="Show a banner in the top-right corner for chats you aren’t looking at."
          on={settings.banners}
          change={set('banners')}
        />
        {platform.badge && (
          <SwitchRow
            label="Dock badge"
            sub="Counts questions, approvals and failures that need you."
            on={settings.badge}
            change={set('badge')}
          />
        )}
      </Block>
    </>
  )
}
