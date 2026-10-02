import { useState } from 'react'
import { appProtocol, compatibility } from '../../data/compatibility'
import {
  backendMustUpdateFirst,
  useSoftwareUpdates,
  type SoftwareUpdates,
} from '../../data/software-updates'
import {
  compareVersions,
  type ChannelEntry,
  type UpdateSettings,
} from '../../data/software-update-contract'
import { Panel } from './Panel'

type Confirmation = {
  title: string
  messages: string[]
  action: string
  accept: () => Promise<void>
}

/** Shared actions keep protocol and data-loss confirmations on recovery screens too. */
export function useUpdateActions(updates: SoftwareUpdates) {
  const value = useSoftwareUpdates(updates)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const run = (action: () => Promise<void>) => {
    void updates.run(action)
  }
  const confirmOrRun = (request: Confirmation) =>
    request.messages.length ? setConfirmation(request) : run(request.accept)
  const backend = (entry: ChannelEntry, pin = false, backupId?: string) => {
    const core = value.status?.core
    if (!core?.managed) return
    const older = compareVersions(entry.version, core.version) < 0
    const messages: string[] = []
    if (older) {
      if (!backupId) return
      messages.push(
        `Going back to backend ${entry.version} restores its backup. Data written since that backup will be lost, including conversations and kip work.`,
      )
    }
    if (entry.protocolRange && entry.protocolRange.oldest > appProtocol)
      messages.push(
        `Backend ${entry.version} requires a newer app protocol. This app speaks protocol ${appProtocol} and will need an update after the backend restarts.`,
      )
    confirmOrRun({
      title: older
        ? 'Restore an older backend?'
        : 'This app will need an update',
      messages,
      action: older ? 'Restore backup and install' : 'Update backend',
      accept: () =>
        updates.installBackend({
          target: entry.version,
          pin: pin || older,
          ...(older ? { backupId, confirmDataLoss: true } : {}),
        }),
    })
  }
  const app = (entry = value.app.available, pin = false) => {
    if (!entry || backendMustUpdateFirst(value)) return
    const messages: string[] = []
    if (entry.protocol === undefined || !value.protocol)
      messages.push(
        'The app’s protocol compatibility could not be confirmed. You may need to update the backend before connecting again.',
      )
    else if (compatibility(value.protocol, entry.protocol) !== 'compatible')
      messages.push(
        `App ${entry.version} speaks protocol ${entry.protocol}, outside the backend’s supported range (${value.protocol.oldest}–${value.protocol.current}). The app may be unable to connect until the backend changes.`,
      )
    confirmOrRun({
      title: 'Check app compatibility',
      messages,
      action: pin
        ? 'Install and pin app'
        : value.app.state === 'ready'
          ? 'Restart to update'
          : 'Update app',
      accept: () =>
        pin
          ? updates.chooseAppVersion(entry.version)
          : value.app.state === 'ready'
            ? updates.installApp(true)
            : updates.updateApp(),
    })
  }
  const settings = (next: UpdateSettings) => {
    confirmOrRun({
      title: 'Are you sure?',
      action: 'Switch to Beta',
      messages:
        next.channel === 'next' && value.settings.channel !== 'next'
          ? [
              'Beta releases arrive sooner and may be less reliable. This changes the update channel for the whole installation.',
            ]
          : [],
      accept: () => updates.saveSettings(next),
    })
  }
  const dialog = confirmation && (
    <Panel
      title={confirmation.title}
      className="update-confirmation"
      close={() => setConfirmation(null)}
    >
      <div className="update-confirmation-body">
        {confirmation.messages.map((message) => (
          <p key={message}>{message}</p>
        ))}
        <div className="recovery-actions">
          <button onClick={() => setConfirmation(null)}>Cancel</button>
          <button
            className="primary-button"
            onClick={() => {
              const action = confirmation.accept
              setConfirmation(null)
              run(action)
            }}
          >
            {confirmation.action}
          </button>
        </div>
      </div>
    </Panel>
  )
  return { app, backend, settings, run, dialog }
}
