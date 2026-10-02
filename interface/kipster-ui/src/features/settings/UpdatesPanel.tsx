import { useState } from 'react'
import { appProtocol, compatibility } from '../../data/compatibility'
import {
  backendMustUpdateFirst,
  manualBackendUpdateInstructions,
  useSoftwareUpdates,
  type SoftwareUpdates,
} from '../../data/software-updates'
import {
  compareVersions,
  knownUpdateSettings,
  type ChannelEntry,
  type UpdateSettings,
} from '../../data/software-update-contract'
import { useUpdateActions } from './use-update-actions'

const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Not yet checked'
const newer = (entry: ChannelEntry | null, current: string) =>
  entry && compareVersions(entry.version, current) > 0

export function UpdatesPanel({ updates }: { updates: SoftwareUpdates }) {
  const value = useSoftwareUpdates(updates)
  const actions = useUpdateActions(updates)
  const { settings, app, status, busy } = value
  const core = status?.core
  const errors = [
    ...new Set([value.error, core?.error, app.error].filter(Boolean)),
  ]
  const [advanced, setAdvanced] = useState(false)
  const [appTarget, setAppTarget] = useState('')
  const [coreTarget, setCoreTarget] = useState('')
  const [chosenBackup, setChosenBackup] = useState('')
  const appReleases = value.releases?.packages['@kipster/ui'] ?? []
  const coreReleases = (value.releases?.packages['@kipster/core'] ?? []).filter(
    (entry) =>
      core &&
      (compareVersions(entry.version, core.version) >= 0 ||
        core.backups.some((backup) => backup.coreVersion === entry.version)),
  )
  const appEntry = appReleases.find((entry) => entry.version === appTarget)
  const coreEntry = coreReleases.find((entry) => entry.version === coreTarget)
  const olderCore =
    !!coreEntry &&
    !!core &&
    compareVersions(coreEntry.version, core.version) < 0
  const backups =
    core?.backups.filter((backup) => backup.coreVersion === coreTarget) ?? []
  const backupId =
    backups.find((backup) => backup.id === chosenBackup)?.id ?? backups[0]?.id
  const backendFirst = backendMustUpdateFirst(value)
  const appBusy = ['checking', 'downloading', 'installing'].includes(app.state)
  const coreBusy =
    core?.managed &&
    (value.reconnecting ||
      core?.state === 'installing' ||
      core?.state === 'checking')
  const knownPolicy = knownUpdateSettings(settings)
  return (
    <div className="software-updates">
      {errors.map((error) => (
        <p
          key={error}
          className="settings-callout"
          data-tone="danger"
          role="alert"
        >
          {error}
        </p>
      ))}
      {value.backendUnsupported && (
        <p className="settings-description">
          This backend does not support software updates yet.
        </p>
      )}
      {!knownPolicy && (
        <p className="settings-callout">
          This update policy is not recognized by this app.
        </p>
      )}
      <div className="settings-group">
        <label className="setting-row">
          <span className="setting-label">
            Channel<small>Shared by this installation</small>
          </span>
          <select
            aria-label="Update channel"
            value={settings.channel}
            disabled={busy || !status || !knownPolicy || coreBusy}
            onChange={(event) =>
              actions.settings({
                ...settings,
                channel: event.target.value as UpdateSettings['channel'],
              })
            }
          >
            {!knownPolicy && (
              <option value={settings.channel}>Unknown channel</option>
            )}
            <option value="stable">Stable</option>
            <option value="next">Beta</option>
          </select>
        </label>
        <label className="setting-row">
          <span className="setting-label">
            Install updates
            <small>
              {settings.mode === 'automatic'
                ? core?.managed === false
                  ? 'App: on quit and launch. Backend: updated manually on its host.'
                  : 'Backend: 02:00–05:00, when no kip is working. App: on quit and launch.'
                : 'Show available updates; install when you choose.'}
            </small>
          </span>
          <select
            aria-label="Update mode"
            value={settings.mode}
            disabled={busy || !status || !knownPolicy}
            onChange={(event) =>
              actions.settings({
                ...settings,
                mode: event.target.value as UpdateSettings['mode'],
              })
            }
          >
            {!knownPolicy && (
              <option value={settings.mode}>Unknown mode</option>
            )}
            <option value="automatic">Automatic</option>
            <option value="notify">Notify me</option>
          </select>
        </label>
      </div>
      {settings.channel === 'stable' && (
        <p className="settings-description update-policy-note">
          Stable never downgrades. If you are ahead of Stable, Kipster waits
          until Stable passes your current version.
        </p>
      )}
      <section
        className="settings-group update-release"
        aria-label="App update"
      >
        <div className="setting-row">
          <span className="setting-label">
            App
            <small>
              {app.version}
              {app.available ? ` → ${app.available.version}` : ''}
            </small>
          </span>
          <button
            disabled={
              busy ||
              appBusy ||
              backendFirst ||
              app.state === 'unavailable' ||
              !app.available
            }
            onClick={() => actions.app()}
          >
            {app.state === 'ready'
              ? 'Restart to update'
              : app.state === 'downloading'
                ? 'Downloading…'
                : app.state === 'checking'
                  ? 'Checking…'
                  : app.state === 'installing'
                    ? 'Restarting…'
                    : 'Update app'}
          </button>
        </div>
        {app.message && <p className="update-detail">{app.message}</p>}
        {backendFirst && app.available && (
          <p className="update-detail">
            Update the backend first, then update this app.
          </p>
        )}
        {app.state === 'ready' && (
          <p className="update-detail">
            Downloaded and ready.{' '}
            {settings.mode === 'automatic'
              ? 'It installs when you quit and open Kipster again.'
              : 'Restart to install when you are ready.'}
          </p>
        )}
        {app.pinned && (
          <div className="update-pin">
            <span>Pinned to {app.pinned} on this device</span>
            <button
              disabled={busy || appBusy}
              onClick={() => actions.run(() => updates.unpinApp())}
            >
              Unpin app
            </button>
          </div>
        )}
        {app.available && <ReleaseNotes entry={app.available} />}
      </section>
      <section
        className="settings-group update-release"
        aria-label="Backend update"
      >
        <div className="setting-row">
          <span className="setting-label">
            Backend
            <small>
              {core?.version ?? 'Unavailable'}
              {core?.available ? ` → ${core.available.version}` : ''}
            </small>
          </span>
          {core?.managed !== false && (
            <button
              disabled={
                busy ||
                coreBusy ||
                !core ||
                !newer(core.available, core.version) ||
                !['idle', 'scheduled', 'failed'].includes(core.state)
              }
              onClick={() => core?.available && actions.backend(core.available)}
            >
              {coreBusy ? 'Updating…' : 'Update backend'}
            </button>
          )}
        </div>
        {core?.managed === false ? (
          <p className="update-detail">{manualBackendUpdateInstructions}</p>
        ) : value.reconnecting ? (
          <output className="update-detail">
            Updating backend. Waiting for it to restart…
          </output>
        ) : (
          core && (
            <output className="update-detail">
              {core.state === 'scheduled'
                ? 'Scheduled for 02:00–05:00, when no kip is working.'
                : core.state === 'installing'
                  ? (core.step ?? 'Updating backend…')
                  : core.state === 'checking'
                    ? 'Checking for backend updates…'
                    : ['idle', 'failed'].includes(core.state)
                      ? core.step
                      : 'Backend update status not recognized.'}
            </output>
          )
        )}
        {core?.managed && core.pinned && (
          <div className="update-pin">
            <span>
              Pinned to {core.pinned}. Automatic backend installs are paused.
            </span>
            <button
              disabled={busy || coreBusy}
              onClick={() => actions.run(() => updates.unpinBackend())}
            >
              Unpin backend
            </button>
          </div>
        )}
        {core?.lastResult && (
          <p
            className="update-detail"
            data-tone={
              core.lastResult.outcome === 'installed' ? 'success' : 'danger'
            }
          >
            {core.lastResult.outcome === 'installed'
              ? `Updated from ${core.lastResult.from} to ${core.lastResult.to}.`
              : core.lastResult.outcome === 'rolled-back'
                ? `Update to ${core.lastResult.to} rolled back. Backend ${core.version} is running again.`
                : core.lastResult.outcome === 'failed'
                  ? `Update from ${core.lastResult.from} to ${core.lastResult.to} failed.`
                  : 'Last update result not recognized.'}
          </p>
        )}
        {core?.available && <ReleaseNotes entry={core.available} />}
      </section>
      <div className="update-check">
        <span>
          Backend checked: {time(status?.checkedAt ?? null)}
          <br />
          App checked: {time(app.checkedAt)}
        </span>
        <button
          disabled={busy || coreBusy || appBusy}
          onClick={() => actions.run(() => updates.checkNow())}
        >
          Check now
        </button>
      </div>
      <details
        onToggle={(event) => {
          if (event.currentTarget.open && !advanced) {
            setAdvanced(true)
            actions.run(() => updates.loadReleases())
          }
        }}
      >
        <summary>Advanced</summary>
        <p className="settings-description">
          {core?.managed === false
            ? 'Installing a specific app version pins it on this device.'
            : 'Installing a specific version pins it. Older backend versions need a matching backup and restore its data.'}
        </p>
        <div className="settings-group">
          <label className="setting-row">
            <span className="setting-label">App version</span>
            <select
              aria-label="App version"
              value={appTarget}
              disabled={busy}
              onChange={(event) => setAppTarget(event.target.value)}
            >
              <option value="">Choose a version</option>
              {appReleases.map((entry) => (
                <option
                  key={entry.version}
                  value={entry.version}
                  disabled={entry.updater?.platform !== 'darwin-aarch64'}
                >
                  {entry.version}
                  {entry.updater?.platform !== 'darwin-aarch64'
                    ? ' (unsigned)'
                    : ''}
                </option>
              ))}
            </select>
          </label>
          {appEntry && <ReleaseNotes entry={appEntry} />}
          {appEntry?.protocol !== undefined &&
            value.protocol &&
            compatibility(value.protocol, appEntry.protocol) !==
              'compatible' && (
              <p className="update-detail settings-callout">
                This app version speaks protocol {appEntry.protocol}, outside
                the backend’s supported range ({value.protocol.oldest}–
                {value.protocol.current}). It may be unable to connect.
              </p>
            )}
          <div className="update-detail row-actions">
            <button
              disabled={
                busy ||
                appBusy ||
                backendFirst ||
                app.state === 'unavailable' ||
                !appEntry?.updater
              }
              onClick={() => appEntry && actions.app(appEntry, true)}
            >
              Install and pin app
            </button>
          </div>
          {core?.managed && (
            <>
              <label className="setting-row">
                <span className="setting-label">Backend version</span>
                <select
                  aria-label="Backend version"
                  value={coreTarget}
                  disabled={busy || coreBusy || !core}
                  onChange={(event) => {
                    setCoreTarget(event.target.value)
                    setChosenBackup('')
                  }}
                >
                  <option value="">Choose a version</option>
                  {coreReleases.map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      {entry.version}
                    </option>
                  ))}
                </select>
              </label>
              {olderCore && (
                <label className="setting-row">
                  <span className="setting-label">Restore backup</span>
                  <select
                    aria-label="Restore backup"
                    value={backupId ?? ''}
                    onChange={(event) => setChosenBackup(event.target.value)}
                  >
                    {backups.map((backup) => (
                      <option key={backup.id} value={backup.id}>
                        {time(backup.createdAt)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {coreEntry && <ReleaseNotes entry={coreEntry} />}
              {coreEntry?.protocolRange &&
                coreEntry.protocolRange.oldest > appProtocol && (
                  <p className="update-detail settings-callout">
                    This backend version requires a newer app protocol. This app
                    will need an update after the backend restarts.
                  </p>
                )}
              <div className="update-detail row-actions">
                <button
                  disabled={
                    busy || coreBusy || !coreEntry || (olderCore && !backupId)
                  }
                  onClick={() =>
                    coreEntry && actions.backend(coreEntry, true, backupId)
                  }
                >
                  Install and pin backend
                </button>
              </div>
            </>
          )}
        </div>
        {advanced && !value.releases && !busy && (
          <button onClick={() => actions.run(() => updates.loadReleases())}>
            Retry release history
          </button>
        )}
      </details>
      {actions.dialog}
    </div>
  )
}

function ReleaseNotes({ entry }: { entry: ChannelEntry }) {
  return (
    <details className="update-notes">
      <summary>Release notes · {entry.version}</summary>
      <p>{entry.notes || 'No release notes for this version.'}</p>
    </details>
  )
}
