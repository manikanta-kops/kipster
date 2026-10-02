import { appProtocol, type ProtocolRange } from '../../data/compatibility'
import { appVersion } from '../../app/version'
import {
  backendMustUpdateFirst,
  manualBackendUpdateInstructions,
  useSoftwareUpdates,
  type SoftwareUpdates,
} from '../../data/software-updates'
import { useUpdateActions } from '../settings/use-update-actions'

export function CompatibilityBlock({
  state,
  coreVersion,
  protocol,
  checking,
  checkAgain,
  changeConnection,
  updateBackend,
  softwareUpdates,
}: {
  state: 'update-app' | 'update-backend'
  coreVersion: string
  protocol: ProtocolRange
  checking: boolean
  checkAgain: () => void
  changeConnection?: () => void
  /** Optional host-provided backend update action. */
  updateBackend?: () => void
  softwareUpdates: SoftwareUpdates
}) {
  const updates = useSoftwareUpdates(softwareUpdates)
  const actions = useUpdateActions(softwareUpdates)
  const appOlder = state === 'update-app'
  const backendFirst = backendMustUpdateFirst(updates)
  const unmanaged = updates.status?.core.managed === false
  const errors = [
    ...new Set(
      [
        updates.error,
        updates.status?.core.error,
        appOlder && updates.app.error,
      ].filter(Boolean),
    ),
  ]
  return (
    <main className="workspace-state connection-setup">
      <section
        className="connection-card"
        aria-labelledby="compatibility-title"
        aria-busy={checking}
      >
        <h1 id="compatibility-title">
          {appOlder ? 'Update the app' : 'Update the backend'}
        </h1>
        {appOlder ? (
          <p role="alert">
            Kipster on this computer is older than the backend it connects to.
            Install the latest Kipster app, then open it again.
          </p>
        ) : (
          <p role="alert">
            The backend is older than Kipster on this computer. Update the
            backend on its host, then check again.
          </p>
        )}
        <dl className="compatibility-versions">
          <div>
            <dt>This app</dt>
            <dd>
              {appVersion} · protocol {appProtocol}
            </dd>
          </div>
          <div>
            <dt>Backend</dt>
            <dd>
              {coreVersion} · protocol{' '}
              {protocol.oldest === protocol.current
                ? protocol.current
                : `${protocol.oldest}–${protocol.current}`}
            </dd>
          </div>
        </dl>
        {!appOlder && unmanaged && <p>{manualBackendUpdateInstructions}</p>}
        <div className="recovery-actions">
          {appOlder && (
            <button
              className="primary-button"
              disabled={
                updates.busy ||
                backendFirst ||
                !updates.app.available ||
                [
                  'unavailable',
                  'checking',
                  'downloading',
                  'installing',
                ].includes(updates.app.state)
              }
              onClick={() => actions.app()}
            >
              {updates.app.state === 'ready'
                ? 'Restart to update'
                : 'Update app'}
            </button>
          )}
          {(!appOlder || backendFirst) && !unmanaged && !updateBackend && (
            <button
              className="primary-button"
              disabled={
                updates.busy ||
                !updates.status?.core.available ||
                updates.status?.core.state === 'installing'
              }
              onClick={() =>
                updates.status?.core.available &&
                actions.backend(updates.status.core.available)
              }
            >
              Update backend
            </button>
          )}
          {updateBackend && !unmanaged && (!appOlder || backendFirst) && (
            <button className="primary-button" onClick={updateBackend}>
              Update backend
            </button>
          )}
          <button
            className={
              updateBackend && !appOlder && !unmanaged ? '' : 'primary-button'
            }
            disabled={checking}
            onClick={checkAgain}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {changeConnection && (
            <button onClick={changeConnection}>Change connection</button>
          )}
        </div>
        {appOlder && backendFirst && (
          <p>Update the backend first, then update this app.</p>
        )}
        {!unmanaged &&
        (updates.reconnecting ||
          updates.status?.core.state === 'installing') ? (
          <output>Updating backend. Waiting for it to restart…</output>
        ) : null}
        {updates.app.message && appOlder && <p>{updates.app.message}</p>}
        {errors.map((error) => (
          <p key={String(error)} role="alert">
            {error}
          </p>
        ))}
        {actions.dialog}
      </section>
    </main>
  )
}
