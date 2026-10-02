import { useContext, useState, useSyncExternalStore } from 'react'
import type { Platform } from '../../platform/platform'
import {
  desktopAlertsKey,
  InterfacePreferencesContext,
} from '../../data/interface-preferences'
const noPreferences = () => () => {}
export function DesktopPreferences({
  platform,
  scopeKey,
}: {
  platform: Platform
  scopeKey: string
}) {
  const preferences = useContext(InterfacePreferencesContext)
  const shared = useSyncExternalStore(
    preferences?.subscribe ?? noPreferences,
    () => preferences?.value?.desktopNotifications ?? null,
    () => null,
  )
  const [local, setLocal] = useState(
    () => platform.preferences.get(desktopAlertsKey(scopeKey)) === 'enabled',
  )
  const enabled = shared ?? local
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  /** Saves the choice here and in Core, which shares it with Kip and other windows. */
  async function choose(on: boolean) {
    const value = on ? 'enabled' : 'disabled'
    platform.preferences.set(desktopAlertsKey(scopeKey), value)
    if (platform.preferences.get(desktopAlertsKey(scopeKey)) !== value)
      throw new Error('Preference was not saved')
    setLocal(on)
    await preferences?.save({ desktopNotifications: on })
  }
  async function enable() {
    setBusy(true)
    try {
      const result = await platform.notifications.send({
        title: 'Kipster notifications',
        body: 'Desktop notification test. Your inbox is unchanged.',
      })
      if (result.status === 'requested') {
        await choose(true)
        setStatus(
          'Desktop notification requested. The OS may suppress it; delivery is not confirmed.',
        )
      } else
        setStatus(
          `Desktop notifications ${result.status}. Your persistent inbox remains available.`,
        )
    } catch {
      setStatus('Notification preferences could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }
  async function disable() {
    setBusy(true)
    try {
      await choose(false)
      setStatus('Background desktop alerts disabled.')
    } catch {
      setStatus(
        'Preference could not be saved. Background alerts may still be enabled. Retry Disable desktop alerts.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="desktop-preferences" aria-label="Desktop attention">
      <h4 className="group-label">Desktop attention</h4>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label">
            Desktop alerts
            <small>
              {platform.notifications.supported
                ? 'Enable alerts when Kipster is in the background. This action may request operating system permission.'
                : 'Open the Kipster desktop app to try native notifications.'}
            </small>
          </span>
          <div className="row-actions">
            {enabled && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void disable()}
              >
                Disable desktop alerts
              </button>
            )}
            <button
              className={enabled ? 'secondary-button' : 'primary-button'}
              disabled={!platform.notifications.supported || busy}
              onClick={() => void enable()}
            >
              {enabled
                ? 'Send test notification'
                : 'Enable and test notifications'}
            </button>
          </div>
        </div>
      </div>
      <output className="settings-callout">{status}</output>
      <h4 className="group-label">Delivery</h4>
      <div className="settings-group prose">
        <p>
          Alerts are best effort while the app can receive updates. Fully closed
          or suspended delivery is not guaranteed. Reconnect restores the inbox
          without replaying old alerts. This browser profile suppresses repeated
          alerts across tabs; other devices may still alert.
        </p>
        <p>
          Notification clicks are not supported by this host integration. Open
          Kipster and use the inbox to visit the exact original context.
        </p>
      </div>
    </section>
  )
}
