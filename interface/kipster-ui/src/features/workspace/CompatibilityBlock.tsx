import { appProtocol, type ProtocolRange } from '../../data/compatibility'
import { appVersion } from '../../app/version'

export function CompatibilityBlock({
  state,
  coreVersion,
  protocol,
  checking,
  checkAgain,
  changeConnection,
  updateBackend,
}: {
  state: 'update-app' | 'update-backend'
  coreVersion: string
  protocol: ProtocolRange
  checking: boolean
  checkAgain: () => void
  changeConnection?: () => void
  /** Starts a remote backend update. Absent until Kipster can update its backend. */
  updateBackend?: () => void
}) {
  const appOlder = state === 'update-app'
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
        <div className="recovery-actions">
          {updateBackend && !appOlder && (
            <button className="primary-button" onClick={updateBackend}>
              Update backend
            </button>
          )}
          <button
            className={updateBackend && !appOlder ? '' : 'primary-button'}
            disabled={checking}
            onClick={checkAgain}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {changeConnection && (
            <button onClick={changeConnection}>Change connection</button>
          )}
        </div>
      </section>
    </main>
  )
}
