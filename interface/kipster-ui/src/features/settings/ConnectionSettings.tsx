import { appProtocol, type ProtocolRange } from '../../data/compatibility'
import { Icon } from '../../components/Icon'
import { Block, Disclosure, Row, StatusDot } from './ui'

/** The Kipster backend this window talks to. */
export function ConnectionSettings({
  endpoint,
  installationId,
  versions,
  problem,
  reconnect,
  change,
}: {
  endpoint: string
  installationId: string
  versions?: { coreVersion: string; protocol: ProtocolRange }
  /** Empty while settings follow the backend live. */
  problem: string
  reconnect: () => void
  change: () => void
}) {
  const host = (() => {
    try {
      return new URL(endpoint).host
    } catch {
      return endpoint
    }
  })()
  const range = versions
    ? versions.protocol.oldest === versions.protocol.current
      ? `${versions.protocol.current}`
      : `${versions.protocol.oldest}–${versions.protocol.current}`
    : null
  return (
    <>
      <Block>
        <Row
          className="hero"
          lead={
            <span
              className={`set-badge ${problem ? '' : 'ok'}`}
              aria-hidden="true"
            >
              <Icon name="link" />
            </span>
          }
          label={<b className="set-hero-title">Kipster backend</b>}
          sub={
            problem ? (
              <span className="set-ready wait">
                <StatusDot tone="wait" />
                {problem}
              </span>
            ) : (
              <span className="set-ready run">
                <StatusDot tone="run" />
                Connected to {host}
              </span>
            )
          }
          control={
            <>
              {problem && (
                <button className="set-button" onClick={reconnect}>
                  Retry now
                </button>
              )}
              <button className="set-button" onClick={change}>
                Change connection
              </button>
            </>
          }
        />
      </Block>
      <Block bare>
        <Disclosure label="Connection details" summary={host}>
          <dl className="set-list" aria-label="Connection details">
            <div className="set-row">
              <dt className="set-text">Address</dt>
              <dd className="set-control set-mono">{endpoint}</dd>
            </div>
            <div className="set-row">
              <dt className="set-text">Installation</dt>
              <dd className="set-control set-mono">{installationId}</dd>
            </div>
            {versions && (
              <>
                <div className="set-row">
                  <dt className="set-text">Backend</dt>
                  <dd className="set-control set-mono">
                    {versions.coreVersion}
                  </dd>
                </div>
                <div className="set-row">
                  <dt className="set-text">Protocol</dt>
                  <dd className="set-control set-mono">
                    App {appProtocol} · backend {range}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </Disclosure>
      </Block>
    </>
  )
}
