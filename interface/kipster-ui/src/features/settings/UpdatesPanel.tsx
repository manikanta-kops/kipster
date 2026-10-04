import { useId, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { appVersion } from '../../app/version'
import {
  appProtocol,
  compatibility,
  type ProtocolRange,
} from '../../data/compatibility'
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
import { Block, Callout, Disclosure, Row, Switch } from './ui'
import { useSheet } from './sheet'

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

/** Shared state for the Updates page and its Testing page. */
function useUpdates(updates: SoftwareUpdates) {
  const value = useSoftwareUpdates(updates)
  const actions = useUpdateActions(updates)
  const core = value.status?.core
  const coreBusy =
    !!core?.managed &&
    (value.reconnecting ||
      core.state === 'installing' ||
      core.state === 'checking')
  const errors = [
    ...new Set([value.error, core?.error, value.app.error].filter(Boolean)),
  ] as string[]
  return { value, updates, actions, coreBusy, errors }
}
function Errors({ errors }: { errors: string[] }) {
  return errors.map((error) => (
    <Callout key={error} tone="danger" alert>
      {error}
    </Callout>
  ))
}

export function UpdatesPage({
  updates,
  versions,
}: {
  updates?: SoftwareUpdates
  versions?: { coreVersion: string; protocol: ProtocolRange }
}) {
  return (
    <>
      {updates && <Software updates={updates} />}
      {versions && <VersionDetails {...versions} />}
      {updates && <TestingRow updates={updates} />}
    </>
  )
}

function Software({ updates }: { updates: SoftwareUpdates }) {
  const { value, actions, coreBusy, errors } = useUpdates(updates)
  const { settings, status, busy } = value
  const core = status?.core
  const knownPolicy = knownUpdateSettings(settings)
  const switchId = useId()
  return (
    <>
      <Errors errors={errors} />
      {value.backendUnsupported && (
        <Callout>This backend does not support software updates yet.</Callout>
      )}
      {!knownPolicy && (
        <Callout tone="wait">
          This update policy is not recognized by this app.
        </Callout>
      )}
      <Summary
        value={value}
        updates={updates}
        actions={actions}
        coreBusy={coreBusy}
      />
      <Block>
        <Row
          label="Update automatically"
          labelId={switchId}
          sub={
            settings.mode !== 'automatic'
              ? 'You choose when to install updates.'
              : core?.managed === false
                ? 'The app updates when you quit Kipster.'
                : 'The backend updates overnight when no kip is working. The app updates when you quit Kipster.'
          }
          control={
            <Switch
              labelId={switchId}
              on={settings.mode === 'automatic'}
              disabled={busy || !status || !knownPolicy}
              change={(on) =>
                actions.settings({
                  ...settings,
                  mode: on ? 'automatic' : 'notify',
                })
              }
            />
          }
        />
      </Block>
      {actions.dialog}
    </>
  )
}

/** A row that opens to show longer text in the same group, such as release notes. */
function MoreRow({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <button
        type="button"
        className="set-row nav set-disclosure set-more"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="set-text">
          <span>{label}</span>
        </span>
        <span className="set-control">
          <Icon name="chevron" className="set-caret" />
        </span>
      </button>
      {open && (
        <div className="set-row set-prose" id={id}>
          {children}
        </div>
      )}
    </>
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
  const checked = `Last checked: ${time(latest(status?.checkedAt, app.checkedAt))}`
  const check = (
    <button
      className="set-button"
      disabled={busy || coreBusy || appBusy}
      onClick={() => actions.run(() => updates.checkNow())}
    >
      Check for updates
    </button>
  )
  const button =
    stage === 'installing' ? (
      <button className="set-button" disabled>
        Updating…
      </button>
    ) : stage === 'backend' ? (
      <button
        className="set-button primary"
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
        className="set-button primary"
        disabled={busy || backendMustUpdateFirst(value)}
        onClick={() => actions.app()}
      >
        Restart to update
      </button>
    ) : stage === 'downloading' ? (
      <button className="set-button" disabled>
        Downloading…
      </button>
    ) : stage === 'app' ? (
      <button
        className="set-button primary"
        disabled={busy}
        onClick={() => actions.run(() => updates.updateApp())}
      >
        {app.state === 'failed' ? 'Try again' : 'Update'}
      </button>
    ) : stage === 'current' ? (
      check
    ) : null
  return (
    <section className="set-block" aria-label="Update">
      <div className="set-group">
        <Row
          className="hero"
          lead={
            <span
              className={`set-badge ${stage === 'current' ? 'ok' : ''}`}
              aria-hidden="true"
            >
              {installing || stage === 'downloading' ? (
                <i className="set-spin" />
              ) : (
                <Icon name={stage === 'current' ? 'success' : 'download'} />
              )}
            </span>
          }
          label={<b className="set-hero-title">{title}</b>}
          sub={
            <>
              <span className="set-line">
                App {app.version}
                {core ? ` · Backend ${core.version}` : ''}
                {stage === 'current' ? (
                  ''
                ) : (
                  <NewVersions backend={available} appUpdate={appUpdate} />
                )}
              </span>
              {stage === 'current' && (
                <span className="set-line">{checked}</span>
              )}
            </>
          }
          control={button}
        />
        {detail && (
          <output className="set-row set-prose" aria-live="polite">
            {detail}
          </output>
        )}
        {core?.managed === false && (
          <p className="set-row set-prose">{manualBackendUpdateInstructions}</p>
        )}
        {notes.length > 0 && (
          <MoreRow label="What’s new">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </MoreRow>
        )}
        {stage !== 'current' && <Row label={checked} control={check} />}
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

/** App, backend and protocol versions, for bug reports. */
function VersionDetails({
  coreVersion,
  protocol,
}: {
  coreVersion: string
  protocol: ProtocolRange
}) {
  const [copied, setCopied] = useState(false)
  const backendRange =
    protocol.oldest === protocol.current
      ? `${protocol.current}`
      : `${protocol.oldest}–${protocol.current}`
  const lines: [string, string][] = [
    ['Kipster app', appVersion],
    ['Backend', coreVersion],
    ['Protocol', `App ${appProtocol} · backend ${backendRange}`],
  ]
  return (
    <Block bare>
      <Disclosure label="Version details" summary={`Kipster ${appVersion}`}>
        <dl className="set-list" aria-label="Versions">
          {lines.map(([label, value]) => (
            <div className="set-row" key={label}>
              <dt className="set-text">{label}</dt>
              <dd className="set-control set-mono">{value}</dd>
            </div>
          ))}
        </dl>
        <Row
          label={
            <span className="set-muted">Include these in bug reports.</span>
          }
          control={
            <button
              className="set-button"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(lines.map((line) => line.join(': ')).join('\n'))
                  .then(() => setCopied(true))
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} />
              {copied ? 'Copied' : 'Copy'}
            </button>
          }
        />
      </Disclosure>
    </Block>
  )
}

function TestingRow({ updates }: { updates: SoftwareUpdates }) {
  const { push } = useSheet()
  const { app, settings } = useSoftwareUpdates(updates)
  if (!isNextBuild(app.version)) return null
  return (
    <Block foot="Choose a channel or install a specific version.">
      <Row
        label="Testing"
        sub={settings.channel === 'stable' ? 'Stable channel' : 'Next channel'}
        chevron
        onClick={() => push({ kind: 'testing', title: 'Testing' })}
      />
    </Block>
  )
}

export function TestingPage({ updates }: { updates: SoftwareUpdates }) {
  const { value, actions, coreBusy, errors } = useUpdates(updates)
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
    <section aria-label="Testing">
      <Errors errors={errors} />
      <Block
        label="Channel"
        foot="For trying fixes before they reach Stable. Most people never need this."
      >
        <Row
          label="Update channel"
          sub={
            settings.channel === 'stable'
              ? 'Stable never downgrades. Kipster waits until Stable passes your current version.'
              : 'Shared by this installation'
          }
          control={
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
          }
        />
      </Block>
      <Block label="Versions">
        <Row
          label="App version"
          sub="Installing a version pins it on this device."
          control={
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
          }
        />
        {appEntry && <ReleaseNotes entry={appEntry} />}
        {appEntry?.protocol !== undefined &&
          value.protocol &&
          compatibility(value.protocol, appEntry.protocol) !== 'compatible' && (
            <p className="set-row set-prose warn">
              This app version speaks protocol {appEntry.protocol}, outside the
              backend’s supported range ({value.protocol.oldest}–
              {value.protocol.current}). It may be unable to connect.
            </p>
          )}
        {appEntry && (
          <Row
            label={`App ${appEntry.version}`}
            control={
              <button
                className="set-button"
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
            }
          />
        )}
        {app.pinned && (
          <Row
            label={`App pinned to ${app.pinned} on this device`}
            control={
              <button
                className="set-button"
                disabled={busy || appBusy}
                onClick={() => actions.run(() => updates.unpinApp())}
              >
                Unpin app
              </button>
            }
          />
        )}
        {core?.managed && (
          <>
            <Row
              label="Backend version"
              sub="Installing a version pins it. Older versions restore a backup from that version."
              control={
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
              }
            />
            {olderCore && (
              <Row
                label="Restore backup"
                control={
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
                }
              />
            )}
            {coreEntry && <ReleaseNotes entry={coreEntry} />}
            {coreEntry?.protocolRange &&
              coreEntry.protocolRange.oldest > appProtocol && (
                <p className="set-row set-prose warn">
                  This backend version requires a newer app protocol. This app
                  will need an update after the backend restarts.
                </p>
              )}
            {coreEntry && (
              <Row
                label={`Backend ${coreEntry.version}`}
                control={
                  <button
                    className="set-button"
                    disabled={busy || coreBusy || (olderCore && !backupId)}
                    onClick={() => actions.backend(coreEntry, true, backupId)}
                  >
                    Install and pin backend
                  </button>
                }
              />
            )}
            {core.pinned && (
              <Row
                label={`Backend pinned to ${core.pinned}`}
                sub="Automatic backend installs are paused."
                control={
                  <button
                    className="set-button"
                    disabled={busy || coreBusy}
                    onClick={() => actions.run(() => updates.unpinBackend())}
                  >
                    Unpin backend
                  </button>
                }
              />
            )}
          </>
        )}
        {!value.releases && (
          <Row
            label="Available versions"
            sub="Loaded from the release channel."
            control={
              <button
                className="set-button"
                disabled={busy}
                onClick={() => actions.run(() => updates.loadReleases())}
              >
                Load versions
              </button>
            }
          />
        )}
      </Block>
      <Block label="Status">
        <dl className="set-list" aria-label="Update status">
          <div className="set-row">
            <dt className="set-text">Backend</dt>
            <dd className="set-control">
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
          <div className="set-row">
            <dt className="set-text">App</dt>
            <dd className="set-control">
              {[app.state, app.message].filter(Boolean).join(' · ')}
            </dd>
          </div>
          {result && (
            <div className="set-row">
              <dt className="set-text">Last backend update</dt>
              <dd className="set-control">
                {['installed', 'rolled-back', 'failed'].includes(result.outcome)
                  ? `${result.from} → ${result.to}, ${result.outcome}`
                  : 'Last update result not recognized'}
              </dd>
            </div>
          )}
          <div className="set-row">
            <dt className="set-text">Checked</dt>
            <dd className="set-control">
              Backend {time(status?.checkedAt ?? null)} · App{' '}
              {time(app.checkedAt)}
            </dd>
          </div>
        </dl>
      </Block>
      {actions.dialog}
    </section>
  )
}

function ReleaseNotes({ entry }: { entry: ChannelEntry }) {
  return (
    <MoreRow label={`Release notes · ${entry.version}`}>
      <p>{entry.notes || 'No release notes for this version.'}</p>
    </MoreRow>
  )
}
