import { useState } from 'react'
import { Icon } from '../../components/Icon'
import type { ExecutionAdapter } from '../../data/core-settings'
import type { Settings } from './ExecutionSettings'
import { Block, Callout, Disclosure, Glyph, Row, StatusDot } from './ui'
import { useSheet } from './sheet'
import { effortLabel, errorText } from './format'

const capabilityText: Record<string, string> = {
  text: 'Text',
  publication: 'Publishing files',
  cancellation: 'Stop',
  steering: 'Steering',
  nativeResume: 'Resume',
  maintenance: 'Learning',
}

/** Checks every adapter again. Shared by the list and each adapter's page. */
function useCheck(settings: Settings) {
  const [state, setState] = useState<'idle' | 'refreshing' | { error: string }>(
    'idle',
  )
  return {
    state,
    async check() {
      setState('refreshing')
      try {
        await settings.refreshAdapters()
        setState('idle')
      } catch (error) {
        setState({ error: errorText(error) })
      }
    },
  }
}
function CheckButton({
  check,
  disabled,
}: {
  check: ReturnType<typeof useCheck>
  disabled?: boolean
}) {
  const busy = check.state === 'refreshing'
  return (
    <button
      className="set-button"
      disabled={busy || disabled}
      onClick={() => void check.check()}
    >
      {busy ? (
        <i className="set-spin" aria-hidden="true" />
      ) : (
        <Icon name="refresh" />
      )}
      {busy ? 'Checking…' : 'Check again'}
    </button>
  )
}
function Status({
  adapter,
  checking,
}: {
  adapter: ExecutionAdapter
  checking: boolean
}) {
  return checking ? (
    <span className="set-status">
      <i className="set-spin" aria-hidden="true" />
      Checking…
    </span>
  ) : (
    <span className={`set-status ${adapter.available ? 'run' : 'danger'}`}>
      <StatusDot tone={adapter.available ? 'run' : 'danger'} />
      {adapter.available ? 'Available' : 'Unavailable'}
    </span>
  )
}
const models = (adapter: ExecutionAdapter) =>
  `${adapter.models.length} ${adapter.models.length === 1 ? 'model' : 'models'}`

export function AdaptersPage({ settings }: { settings: Settings }) {
  const { push } = useSheet()
  const check = useCheck(settings)
  const list = settings.adapters?.adapters ?? []
  const available = list.filter((a) => a.available).length
  const tone =
    settings.adapterError || (list.length && !available)
      ? 'danger'
      : available < list.length
        ? 'wait'
        : 'run'
  return (
    <>
      <Block>
        <Row
          lead={<StatusDot tone={tone} />}
          className="set-catalog"
          label={
            settings.adapterError
              ? settings.adapterError
              : `${available} of ${list.length} available`
          }
          control={
            <CheckButton check={check} disabled={!!settings.adapterError} />
          }
        />
      </Block>
      {typeof check.state === 'object' && (
        <p role="alert" className="set-alert">
          Could not check adapters: {check.state.error}
        </p>
      )}
      {list.length > 0 && (
        <Block label="Execution" foot="Adapters connect kips to AI providers.">
          {list.map((adapter) => (
            <Row
              key={adapter.id}
              lead={<Glyph icon="terminal" hue="var(--hue-ocean)" size={30} />}
              label={adapter.id}
              sub={
                adapter.available
                  ? `${models(adapter)} · Version ${adapter.version || 'not reported'}`
                  : (adapter.reason ?? 'Unavailable')
              }
              subTone={adapter.available ? undefined : 'bad'}
              control={
                <Status
                  adapter={adapter}
                  checking={check.state === 'refreshing'}
                />
              }
              chevron
              onClick={() =>
                push({
                  kind: 'adapter',
                  adapterId: adapter.id,
                  title: adapter.id,
                })
              }
            />
          ))}
        </Block>
      )}
    </>
  )
}

const range = (efforts: string[]) =>
  !efforts.length
    ? 'No effort levels'
    : efforts.length === 1
      ? effortLabel(efforts[0])
      : `${effortLabel(efforts[0])} – ${effortLabel(efforts.at(-1)!)}`

export function AdapterPage({
  settings,
  adapterId,
}: {
  settings: Settings
  adapterId: string
}) {
  const check = useCheck(settings)
  const adapter = settings.adapters?.adapters.find((a) => a.id === adapterId)
  if (!adapter)
    return <Callout>This adapter is no longer in Kipster’s list.</Callout>
  const most = Math.max(1, ...adapter.models.map((m) => m.efforts.length))
  const capabilities = adapter.capabilities
    ? Object.entries(adapter.capabilities)
    : []
  const supported = capabilities.filter(([, on]) => on).length
  return (
    <>
      <Block>
        <Row
          className="hero"
          lead={<Glyph icon="terminal" hue="var(--hue-ocean)" size={40} />}
          label={<b className="set-hero-name">{adapter.id}</b>}
          sub={`Execution adapter · Version ${adapter.version || 'not reported'}`}
          control={
            <Status adapter={adapter} checking={check.state === 'refreshing'} />
          }
        />
      </Block>
      {!adapter.available && (
        <Callout tone="danger" actions={<CheckButton check={check} />}>
          {adapter.reason ?? 'This adapter is unavailable.'}
        </Callout>
      )}
      {typeof check.state === 'object' && (
        <p role="alert" className="set-alert">
          Could not check adapters: {check.state.error}
        </p>
      )}
      <Block
        label={models(adapter)}
        foot="Effort levels each model accepts. Kips choose one in their model settings."
      >
        {adapter.models.length ? (
          <table className="set-table" aria-label={`${adapter.id} models`}>
            <tbody>
              {adapter.models.map((model) => (
                <tr key={model.id}>
                  <td className="set-model">
                    {model.id}
                    {adapter.defaultModel?.id === model.id && (
                      <em className="set-tag">Default</em>
                    )}
                  </td>
                  <td className="set-range">{range(model.efforts)}</td>
                  <td className="set-levels" aria-hidden="true">
                    {Array.from({ length: most }, (_, i) => (
                      <i
                        key={i}
                        className={i < model.efforts.length ? 'on' : ''}
                      />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Row label={<span className="set-muted">None reported</span>} />
        )}
      </Block>
      <Block bare>
        <Disclosure
          label="Capabilities"
          summary={
            adapter.capabilities
              ? `${supported} of ${capabilities.length}`
              : 'Not reported'
          }
        >
          {capabilities.length ? (
            capabilities.map(([name, on]) => (
              <Row
                key={name}
                label={capabilityText[name] ?? name}
                control={
                  on ? (
                    <span className="set-cap yes">
                      <Icon name="check" weight="bold" />
                      Supported
                    </span>
                  ) : (
                    <span className="set-cap">Not supported</span>
                  )
                }
              />
            ))
          ) : (
            <Row label={<span className="set-muted">Nothing reported</span>} />
          )}
        </Disclosure>
      </Block>
      {adapter.available && (
        <Block>
          <Row
            label="Status"
            sub="Check again after installing or signing in to a provider."
            control={<CheckButton check={check} />}
          />
        </Block>
      )}
    </>
  )
}
