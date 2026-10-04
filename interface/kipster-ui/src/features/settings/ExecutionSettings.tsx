import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { effectiveQuery, readiness } from './effective'
import {
  settingFields,
  settingsPatch,
  type AdapterList,
  type CoreSettingsClient,
  type ExecutionSettings,
  type SettingField,
  type SettingsPatch,
  type SettingsTarget,
} from '../../data/core-settings'
import type { useCoreSettings } from '../../data/use-core-settings'
import { useSettingsDraft } from '../../data/use-settings-draft'
import { useSettingsSave } from '../../data/use-settings-save'
import {
  ActionRow,
  Block,
  Disclosure,
  Row,
  SaveRow,
  Segmented,
  StatusDot,
  Stepper,
} from './ui'
import { effortLabel, errorText } from './format'

export type Settings = ReturnType<typeof useCoreSettings>
const fieldLabels: Record<SettingField, string> = {
  adapterId: 'Adapter',
  modelId: 'Model',
  effort: 'Effort',
}

/**
 * Adapter, model and effort for an organization or a kip, with the save state as the group's
 * last row. Only edited fields are sent; an empty choice clears the saved value.
 */
export function ExecutionEditor({
  journalScope,
  title,
  label,
  foot,
  target,
  id,
  saved,
  inherited,
  adapters,
  save,
  reset,
}: {
  journalScope: string
  /** The accessible name of the section. */
  title: string
  label?: ReactNode
  foot: ReactNode
  target: SettingsTarget
  id: string
  saved: ExecutionSettings
  /** The organization default a kip falls back to; undefined when nothing is inherited. */
  inherited?: ExecutionSettings
  adapters: AdapterList | null
  save: Settings['saveSettings']
  /** Label of the row that clears every own value, such as "Use organization defaults". */
  reset?: string
}) {
  const [draft, setDraft] = useSettingsDraft<
    Partial<Record<SettingField, string>>
  >(JSON.stringify([journalScope, target, id]), {})
  const status = useSettingsSave(
    JSON.stringify([journalScope, target, id]),
    (operationId, patch) => save(target, id, operationId, patch),
  )
  const value = (field: SettingField) => {
    const held = status.pending?.patch[field]
    return held
      ? 'set' in held
        ? held.set
        : ''
      : (draft[field] ?? saved[field] ?? '')
  }
  const current = (field: SettingField) => value(field) || inherited?.[field]
  const adapter = adapters?.adapters.find((a) => a.id === current('adapterId'))
  const model = adapter?.models.find((m) => m.id === current('modelId'))
  const patch = settingsPatch(saved, draft)
  const changed = Object.keys(patch).length > 0
  const locked = !status.ready || status.busy || !!status.pending
  async function send(patch: SettingsPatch) {
    if (await status.send(patch)) setDraft({})
  }
  const set = (field: SettingField, next: string) =>
    setDraft((old) => ({ ...old, [field]: next }))
  const choices = (field: SettingField) =>
    field === 'adapterId'
      ? (adapters?.adapters.map((a) => ({
          id: a.id,
          label: a.available ? a.id : `${a.id} (unavailable)`,
        })) ?? [])
      : field === 'modelId'
        ? (adapter?.models.map((m) => ({ id: m.id, label: m.id })) ?? [])
        : (model?.efforts.map((e) => ({ id: e, label: effortLabel(e) })) ?? [])
  const emptyLabel = (field: SettingField) =>
    inherited
      ? `Organization default (${inherited[field] ?? 'adapter default'})`
      : 'Adapter default'
  const source = (field: SettingField) => {
    const change = patch[field]
    if (change) return 'clear' in change ? 'Will be removed' : 'Changed'
    if (value(field)) return inherited ? 'Own setting' : undefined
    if (!inherited) return field === 'effort' ? undefined : 'Adapter default'
    if (field !== 'effort' || !inherited.effort)
      return inherited[field] ? 'Organization default' : 'Adapter default'
    return `Organization default, ${effortLabel(inherited.effort)}`
  }
  const select = (field: SettingField) => {
    const chosen = value(field)
    const options = choices(field)
    return (
      <select
        aria-label={fieldLabels[field]}
        value={chosen}
        disabled={locked}
        onChange={(e) => set(field, e.target.value)}
      >
        <option value="">{emptyLabel(field)}</option>
        {chosen && !options.some((o) => o.id === chosen) && (
          <option value={chosen}>{chosen} (not offered)</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  const effort = () => {
    const chosen = value('effort')
    const levels = model?.efforts ?? []
    // A saved effort the model no longer offers stays visible until someone clears it.
    if (!levels.length || (chosen && !levels.includes(chosen)))
      return chosen ? (
        select('effort')
      ) : (
        <span className="set-note">
          {model ? 'Not supported by this model' : 'Choose a model first'}
        </span>
      )
    const options = [
      { value: '', label: 'Default', name: emptyLabel('effort'), tick: false },
      ...levels.map((level) => ({ value: level, label: effortLabel(level) })),
    ]
    return levels.length <= 4 ? (
      <Segmented
        label="Effort"
        value={chosen}
        options={options}
        disabled={locked}
        change={(next) => set('effort', next)}
        className="effort"
      />
    ) : (
      <Stepper
        label="Effort"
        value={chosen}
        options={options}
        disabled={locked}
        change={(next) => set('effort', next)}
      />
    )
  }
  const hasOwn = settingFields.some((field) => value(field))
  const state = status.busy
    ? 'saving'
    : status.pending
      ? 'failed'
      : changed
        ? 'dirty'
        : status.saved
          ? 'saved'
          : null
  return (
    <section aria-label={title} className="set-block">
      {label && <h4 className="set-label">{label}</h4>}
      <div className="set-group">
        {settingFields.map((field) => {
          const sub = source(field)
          return (
            <Row
              key={field}
              label={fieldLabels[field]}
              sub={sub}
              subTone={
                patch[field]
                  ? 'changed'
                  : sub === 'Own setting'
                    ? 'own'
                    : undefined
              }
              changed={!!patch[field]}
              control={field === 'effort' ? effort() : select(field)}
            />
          )
        })}
        {reset && hasOwn && !locked && (
          <ActionRow
            onClick={() =>
              setDraft(
                Object.fromEntries(
                  settingFields
                    .filter((field) => saved[field])
                    .map((field) => [field, '']),
                ),
              )
            }
          >
            {reset}
          </ActionRow>
        )}
        {state && (
          <SaveRow state={state}>
            {state === 'failed' ? (
              <button
                className="set-button primary"
                disabled={!status.ready}
                onClick={() => void send(status.pending!.patch)}
              >
                Retry save
              </button>
            ) : state === 'dirty' ? (
              <>
                <button
                  className="set-button"
                  disabled={locked}
                  onClick={() => setDraft({})}
                >
                  Discard
                </button>
                <button
                  className="set-button primary"
                  disabled={locked}
                  onClick={() => void send(patch)}
                >
                  Save
                </button>
              </>
            ) : null}
          </SaveRow>
        )}
      </div>
      <p className="set-foot">{foot}</p>
      {status.storageError && (
        <p role="alert" className="set-alert">
          Saved requests could not be read. Nothing will be sent until storage
          recovers.
          <button className="set-link" onClick={status.retryStorage}>
            Retry request storage
          </button>
        </p>
      )}
      {status.error && (
        <p role="alert" className="set-alert">
          {status.error}
        </p>
      )}
    </section>
  )
}

const statusText: Record<string, string> = {
  ready: 'Ready to run',
  'unknown-catalog': 'Adapter list unavailable',
  missing: 'Not fully configured',
  incompatible: 'Cannot run',
}
const sourceText: Record<string, string> = {
  agent: 'Own setting',
  organization: 'Organization default',
  default: 'Adapter default',
}
/** What the kip's next run will use, collapsed to one line until opened. */
export function NextRun({
  client,
  agentId,
  organizationId,
}: {
  client: CoreSettingsClient
  agentId: string
  organizationId: string | null
}) {
  const query = useQuery(effectiveQuery(client, agentId, organizationId))
  const effective = query.data
  if (query.isError && !effective)
    return (
      <Block region="Effective execution settings">
        <Row
          label="Next run"
          sub={errorText(query.error)}
          subTone="bad"
          control={
            <button className="set-button" onClick={() => void query.refetch()}>
              Retry
            </button>
          }
        />
      </Block>
    )
  const tone = effective ? readiness(effective.status) : null
  return (
    <section className="set-block" aria-label="Effective execution settings">
      <Disclosure
        label="Next run"
        sub={
          <span className={`set-ready ${tone ?? ''}`}>
            {tone && <StatusDot tone={tone} />}
            {effective
              ? (statusText[effective.status] ?? effective.status)
              : 'Checking…'}
          </span>
        }
        summary={
          effective &&
          [
            effective.settings.adapterId,
            effective.settings.modelId,
            effective.settings.effort && effortLabel(effective.settings.effort),
          ]
            .filter(Boolean)
            .join(' · ')
        }
      >
        {effective && (
          <>
            {settingFields.map((field) => (
              <Row
                key={field}
                label={fieldLabels[field]}
                control={
                  <span className="set-value">
                    <b>
                      {effective.settings[field]
                        ? field === 'effort'
                          ? effortLabel(effective.settings[field])
                          : effective.settings[field]
                        : field === 'effort'
                          ? 'Adapter default'
                          : 'Not set'}
                    </b>
                    <small>
                      {effective.sources[field]
                        ? (sourceText[effective.sources[field]] ??
                          effective.sources[field])
                        : 'No setting'}
                    </small>
                  </span>
                }
              />
            ))}
            {effective.reason && (
              <Row
                label={
                  <span className={`set-ready ${tone}`}>
                    <StatusDot tone={tone!} />
                    {statusText[effective.status] ?? effective.status}
                  </span>
                }
                sub={effective.reason}
              />
            )}
          </>
        )}
      </Disclosure>
    </section>
  )
}
