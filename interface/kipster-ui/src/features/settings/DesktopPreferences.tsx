import { useState } from 'react'
import type { Platform } from '../../platform/platform'
const preferenceKey = (scope: string) => `desktop-notifications:${scope}`
export function DesktopPreferences({
  platform,
  scopeKey,
}: {
  platform: Platform
  scopeKey: string
}) {
  const [enabled, setEnabled] = useState(
    () => platform.preferences.get(preferenceKey(scopeKey)) === 'enabled',
  )
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  async function enable() {
    setBusy(true)
    try {
      const result = await platform.notifications.send({
        title: 'Kipster notifications',
        body: 'Desktop notification test. Your inbox is unchanged.',
      })
      if (result.status === 'requested') {
        platform.preferences.set(preferenceKey(scopeKey), 'enabled')
        if (platform.preferences.get(preferenceKey(scopeKey)) !== 'enabled')
          throw new Error('Preference was not saved')
        setEnabled(true)
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
                onClick={() => {
                  try {
                    platform.preferences.set(
                      preferenceKey(scopeKey),
                      'disabled',
                    )
                    if (
                      platform.preferences.get(preferenceKey(scopeKey)) !==
                      'disabled'
                    )
                      throw new Error('Preference was not saved')
                    setEnabled(false)
                    setStatus('Background desktop alerts disabled.')
                  } catch {
                    setStatus(
                      'Preference could not be saved. Background alerts may still be enabled. Retry Disable desktop alerts.',
                    )
                  }
                }}
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
