import { useState } from 'react'
import { appProtocol, compatibility } from '../../data/compatibility'
import {
  backendMustUpdateFirst,
  manualBackendUpdateInstructions,
  useSoftwareUpdates,
  type SoftwareUpdates,
  type SoftwareUpdateSnapshot,
} from '../../data/software-updates'
import {
  compareVersions,
  knownUpdateSettings,
  type ChannelEntry,
  type UpdateSettings,
} from '../../data/software-update-contract'
import { useUpdateActions } from './use-update-actions'

type Actions = ReturnType<typeof useUpdateActions>
type Props = {
  value: SoftwareUpdateSnapshot
  updates: SoftwareUpdates
  actions: Actions
  coreBusy: boolean
}

const time = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Not yet checked'
const newer = (entry: ChannelEntry | null, current: string) =>
  entry && compareVersions(entry.version, current) > 0
const latest = (...values: (string | null | undefined)[]) =>
  values
    .filter((value): value is string => !!value)
    .sort()
    .at(-1) ?? null
/** Testing controls ship only in builds made by the Release next workflow. */
const isNextBuild = (version: string) => version.includes('-next.')

export function UpdatesPanel({ updates }: { updates: SoftwareUpdates }) {
  const value = useSoftwareUpdates(updates)
  const actions = useUpdateActions(updates)
  const { settings, app, status, busy } = value
  const core = status?.core
  const errors = [
    ...new Set([value.error, core?.error, app.error].filter(Boolean)),
  ]
  const coreBusy =
    !!core?.managed &&
    (value.reconnecting ||
      core.state === 'installing' ||
      core.state === 'checking')
  const knownPolicy = knownUpdateSettings(settings)
  const props = { value, updates, actions, coreBusy }
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
      <Summary {...props} />
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label" id="update-automatically">
            Update automatically
            <small>
              {settings.mode !== 'automatic'
                ? 'You choose when to install updates.'
                : core?.managed === false
                  ? 'The app updates when you quit Kipster.'
                  : 'The backend updates overnight when no kip is working. The app updates when you quit Kipster.'}
            </small>
          </span>
          <span className="management-checkbox setting-switch">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby="update-automatically"
              checked={settings.mode === 'automatic'}
              aria-checked={settings.mode === 'automatic'}
              disabled={busy || !status || !knownPolicy}
              onChange={(event) =>
                actions.settings({
                  ...settings,
                  mode: event.target.checked ? 'automatic' : 'notify',
                })
              }
            />
          </span>
        </div>
      </div>
      {isNextBuild(app.version) && <Testing {...props} />}
      {actions.dialog}
    </div>
  )
}

/** One button walks the update order: backend, then the app restart. */
function Summary({ value, updates, actions, coreBusy }: Props) {
  const { app, status, busy } = value
  const core = status?.core
  const available =
    core && newer(core.available, core.version) ? core.available : null
  const backend = core?.managed ? available : null
  const appUpdate = app.state !== 'unavailable' ? app.available : null
  const installing =
    !!core?.managed && (value.reconnecting || core.state === 'installing')
  const appBusy = ['checking', 'downloading', 'installing'].includes(app.state)
  const stage = installing
    ? 'installing'
    : backend
      ? 'backend'
      : app.state === 'ready' && appUpdate
        ? 'restart'
        : appUpdate && appBusy
          ? 'downloading'
          : appUpdate
            ? 'app'
            : available
              ? 'manual'
              : 'current'
  const result = core?.lastResult
  const failed =
    !!result &&
    !core?.error &&
    result.outcome !== 'installed' &&
    result.to === backend?.version
  const notes = [
    ...new Set(
      [available?.notes, stage === 'current' ? '' : appUpdate?.notes].filter(
        Boolean,
      ),
    ),
  ]
  const title = {
    installing: 'Updating',
    backend: 'Update available',
    restart: 'Update ready',
    downloading: 'Downloading update',
    app: 'Update available',
    manual: 'Update available',
    current: 'Up to date',
  }[stage]
  const detail =
    stage === 'installing'
      ? value.reconnecting
        ? 'Waiting for the backend to restart…'
        : (core?.step ?? 'Updating the backend…')
      : stage === 'backend' && failed
        ? `The last update didn’t install. The backend is still on ${core!.version}.`
        : stage === 'backend' && core?.state === 'scheduled'
          ? 'Installs tonight when no kip is working, or update now.'
          : stage === 'restart'
            ? 'Restart Kipster to finish updating.'
            : null
  const button =
    stage === 'installing' ? (
      <button disabled>Updating…</button>
    ) : stage === 'backend' ? (
      <button
        className="primary-button"
        disabled={
          busy ||
          coreBusy ||
          !['idle', 'scheduled', 'failed'].includes(core!.state)
        }
        onClick={() => actions.backend(backend!)}
      >
        {failed || core?.state === 'failed' ? 'Try again' : 'Update'}
      </button>
    ) : stage === 'restart' ? (
      <button
        className="primary-button"
        disabled={busy || backendMustUpdateFirst(value)}
        onClick={() => actions.app()}
      >
        Restart to update
      </button>
    ) : stage === 'downloading' ? (
      <button disabled>Downloading…</button>
    ) : stage === 'app' ? (
      <button
        className="primary-button"
        disabled={busy}
        onClick={() => actions.run(() => updates.updateApp())}
      >
        {app.state === 'failed' ? 'Try again' : 'Update'}
      </button>
    ) : null
  return (
    <section className="settings-group update-summary" aria-label="Update">
      <div className="setting-row">
        <span className="setting-label">
          {title}
          <small>
            App {app.version}
            {core ? ` · Backend ${core.version}` : ''}
            {stage === 'current' ? (
              ''
            ) : (
              <NewVersions backend={available} appUpdate={appUpdate} />
            )}
          </small>
        </span>
        {button}
      </div>
      {detail && <output className="update-detail">{detail}</output>}
      {core?.managed === false && (
        <p className="update-detail">{manualBackendUpdateInstructions}</p>
      )}
      {notes.length > 0 && (
        <details className="update-notes">
          <summary>What’s new</summary>
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </details>
      )}
      <div className="update-check">
        <span>
          Last checked: {time(latest(status?.checkedAt, app.checkedAt))}
        </span>
        <button
          className="secondary-button"
          disabled={busy || coreBusy || appBusy}
          onClick={() => actions.run(() => updates.checkNow())}
        >
          Check for updates
        </button>
      </div>
    </section>
  )
}

function NewVersions({
  backend,
  appUpdate,
}: {
  backend: ChannelEntry | null | undefined
  appUpdate: ChannelEntry | null
}) {
  const parts = [
    appUpdate && `app ${appUpdate.version}`,
    backend && `backend ${backend.version}`,
  ].filter(Boolean)
  return parts.length ? <>{` → ${parts.join(', ')}`}</> : null
}

function Testing({ value, updates, actions, coreBusy }: Props) {
  const { settings, app, status, busy } = value
  const core = status?.core
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
  const appBusy = ['checking', 'downloading', 'installing'].includes(app.state)
  const knownPolicy = knownUpdateSettings(settings)
  const result = core?.lastResult
  return (
    <section className="update-testing" aria-label="Testing">
      <h4 className="group-label">Testing</h4>
      <div className="settings-group">
        <label className="setting-row">
          <span className="setting-label">
            Channel
            <small>
              {settings.channel === 'stable'
                ? 'Stable never downgrades. Kipster waits until Stable passes your current version.'
                : 'Shared by this installation'}
            </small>
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
            <option value="next">Next</option>
          </select>
        </label>
        <label className="setting-row">
          <span className="setting-label">
            App version
            <small>Installing a version pins it on this device.</small>
          </span>
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
          compatibility(value.protocol, appEntry.protocol) !== 'compatible' && (
            <p className="update-detail settings-callout">
              This app version speaks protocol {appEntry.protocol}, outside the
              backend’s supported range ({value.protocol.oldest}–
              {value.protocol.current}). It may be unable to connect.
            </p>
          )}
        {appEntry && (
          <div className="update-detail row-actions">
            <button
              disabled={
                busy ||
                appBusy ||
                backendMustUpdateFirst(value) ||
                app.state === 'unavailable' ||
                !appEntry.updater
              }
              onClick={() => actions.app(appEntry, true)}
            >
              Install and pin app
            </button>
          </div>
        )}
        {app.pinned && (
          <div className="update-pin">
            <span>App pinned to {app.pinned} on this device</span>
            <button
              disabled={busy || appBusy}
              onClick={() => actions.run(() => updates.unpinApp())}
            >
              Unpin app
            </button>
          </div>
        )}
        {core?.managed && (
          <>
            <label className="setting-row">
              <span className="setting-label">
                Backend version
                <small>
                  Installing a version pins it. Older versions restore a backup
                  from that version.
                </small>
              </span>
              <select
                aria-label="Backend version"
                value={coreTarget}
                disabled={busy || coreBusy}
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
            {coreEntry && (
              <div className="update-detail row-actions">
                <button
                  disabled={busy || coreBusy || (olderCore && !backupId)}
                  onClick={() => actions.backend(coreEntry, true, backupId)}
                >
                  Install and pin backend
                </button>
              </div>
            )}
            {core.pinned && (
              <div className="update-pin">
                <span>
                  Backend pinned to {core.pinned}. Automatic backend installs
                  are paused.
                </span>
                <button
                  disabled={busy || coreBusy}
                  onClick={() => actions.run(() => updates.unpinBackend())}
                >
                  Unpin backend
                </button>
              </div>
            )}
          </>
        )}
        {!value.releases && (
          <div className="update-detail row-actions">
            <button
              disabled={busy}
              onClick={() => actions.run(() => updates.loadReleases())}
            >
              Load versions
            </button>
          </div>
        )}
      </div>
      <dl className="settings-group about-versions" aria-label="Update status">
        <div className="setting-row">
          <dt>Backend</dt>
          <dd>
            {!core
              ? 'Unavailable'
              : !core.managed
                ? 'Updated manually'
                : [
                    [
                      'idle',
                      'checking',
                      'scheduled',
                      'installing',
                      'failed',
                    ].includes(core.state)
                      ? core.state
                      : 'Backend update status not recognized',
                    core.step,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
          </dd>
        </div>
        <div className="setting-row">
          <dt>App</dt>
          <dd>{[app.state, app.message].filter(Boolean).join(' · ')}</dd>
        </div>
        {result && (
          <div className="setting-row">
            <dt>Last backend update</dt>
            <dd>
              {['installed', 'rolled-back', 'failed'].includes(result.outcome)
                ? `${result.from} → ${result.to}, ${result.outcome}`
                : 'Last update result not recognized'}
            </dd>
          </div>
        )}
        <div className="setting-row">
          <dt>Checked</dt>
          <dd>
            Backend {time(status?.checkedAt ?? null)} · App{' '}
            {time(app.checkedAt)}
          </dd>
        </div>
      </dl>
    </section>
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
