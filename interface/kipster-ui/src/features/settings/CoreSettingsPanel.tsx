import { useContext, type ReactNode } from 'react'
import { PlatformContext } from '../../platform/context'
import type { Appearance } from '../../app/appearance'
import { AppearanceSettings } from './AppearanceSettings'
import { DesktopPreferences } from './DesktopPreferences'
import { IdentityFiles } from './IdentityFiles'
import type { ApplicationUpdates } from '../../data/application-updates'
import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { Panel } from './Panel'
import type { Scope } from '../../data/text'
import {
  CoreSettingsClient,
  settingFields,
  settingsPatch,
  type AdapterList,
  type Directory,
  type ExecutionSettings,
  type SettingField,
  type SettingsPatch,
  type SettingsTarget,
} from '../../data/core-settings'
import { useCoreSettings } from '../../data/use-core-settings'
import { useSettingsDraft } from '../../data/use-settings-draft'
import { useSettingsSave } from '../../data/use-settings-save'

type Settings = ReturnType<typeof useCoreSettings>
type Tab =
  | 'workspace'
  | 'organization'
  | 'agent'
  | 'adapters'
  | 'learning'
  | 'identity'
  | 'desktop'
  | 'appearance'
const tabs: Record<
  Tab,
  {
    label: string
    icon: 'organization' | 'spark' | 'settings' | 'identity' | 'brain' | 'sun'
    description: string
  }
> = {
  workspace: {
    label: 'Workspace',
    icon: 'organization',
    description: 'Organization, connection and archive',
  },
  appearance: {
    label: 'Appearance',
    icon: 'sun',
    description: 'Palette and light or dark mode for this device',
  },
  desktop: {
    label: 'Desktop',
    icon: 'settings',
    description: 'Attention on this device',
  },
  identity: {
    label: 'Identity files',
    icon: 'identity',
    description: 'Read authored identity files and restore a saved backup',
  },
  organization: {
    label: 'Organization',
    icon: 'organization',
    description: 'Defaults for member kips and shared instructions',
  },
  agent: {
    label: 'Kips',
    icon: 'spark',
    description: 'Each kip’s own settings and what its next run will use',
  },
  adapters: {
    label: 'Adapters',
    icon: 'settings',
    description: 'Execution adapters connected to Kipster',
  },
  learning: {
    label: 'Learning',
    icon: 'brain',
    description: 'Whether kips learn from completed conversations',
  },
}
const fieldLabels: Record<SettingField, string> = {
  adapterId: 'Adapter',
  modelId: 'Model',
  effort: 'Effort',
}
const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'Not saved.'

export function CoreSettingsPanel({
  workspaceControls,
  updates,
  appearance,
  endpoint,
  scope,
  organizationId,
  opener,
  close,
}: {
  workspaceControls?: ReactNode
  updates?: ApplicationUpdates
  appearance: Appearance
  endpoint: string
  scope: Scope
  /** The organization shown first. */
  organizationId: string
  opener?: HTMLElement | null
  close: () => void
}) {
  const platform = useContext(PlatformContext)
  const client = useMemo(() => new CoreSettingsClient(endpoint), [endpoint])
  const settings = useCoreSettings(client, scope, updates)
  const journalScope = JSON.stringify([
    client.endpoint,
    scope.installationId,
    scope.callerId,
  ])
  const [tab, setTab] = useState<Tab>(
    workspaceControls ? 'workspace' : 'organization',
  )
  const ready = settings.saved && settings.learning && settings.directory
  return (
    <Panel
      title="Settings"
      className="settings-panel"
      opener={opener}
      close={close}
    >
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings category">
          {(Object.keys(tabs) as Tab[])
            .filter((id) => id !== 'workspace' || workspaceControls)
            .map((id) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                <span className={`nav-glyph ${id}`} aria-hidden="true">
                  <Icon name={tabs[id].icon} weight="fill" />
                </span>
                {tabs[id].label}
              </button>
            ))}
        </nav>
        <div className="settings-content">
          <header className="settings-section-head">
            <h3>{tabs[tab].label}</h3>
            <p className="settings-description">{tabs[tab].description}</p>
          </header>
          {settings.connection &&
            tab !== 'workspace' &&
            tab !== 'appearance' &&
            tab !== 'desktop' && (
              <output className="settings-callout" data-tone="wait">
                {settings.connection}
                {!ready && (
                  <button className="text-button" onClick={settings.reconnect}>
                    Retry now
                  </button>
                )}
              </output>
            )}
          {tab === 'workspace' ? (
            workspaceControls
          ) : tab === 'appearance' ? (
            <AppearanceSettings appearance={appearance} />
          ) : tab === 'desktop' ? (
            platform ? (
              <DesktopPreferences platform={platform} scopeKey={journalScope} />
            ) : (
              <p>Desktop preferences are unavailable.</p>
            )
          ) : ready ? (
            tab === 'identity' ? (
              <IdentityFiles
                endpoint={endpoint}
                directory={settings.directory!}
              />
            ) : tab === 'organization' ? (
              <OrganizationSettings
                key={organizationId}
                client={client}
                settings={settings}
                initial={organizationId}
                journalScope={journalScope}
              />
            ) : tab === 'agent' ? (
              <AgentSettings
                client={client}
                settings={settings}
                journalScope={journalScope}
              />
            ) : tab === 'adapters' ? (
              <Adapters settings={settings} />
            ) : (
              <LearningSettings settings={settings} />
            )
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

function OrganizationSettings({
  client,
  settings,
  initial,
  journalScope,
}: {
  client: CoreSettingsClient
  settings: Settings
  initial: string
  journalScope: string
}) {
  const organizations = settings.directory!.organizations.filter(
    (o) => o.lifecycle === 'active',
  )
  const [chosen, setChosen] = useState(initial)
  const organization =
    organizations.find((o) => o.id === chosen) ?? organizations[0]
  if (!organization)
    return <p className="settings-callout">No organizations yet.</p>
  return (
    <>
      {organizations.length > 1 && (
        <div className="settings-group">
          <label className="setting-row">
            <span className="setting-label">Organization</span>
            <select
              value={organization.id}
              onChange={(e) => setChosen(e.target.value)}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <SettingsEditor
        key={`${journalScope}:${organization.id}`}
        journalScope={journalScope}
        title="Default execution settings"
        note="Members use these unless they have their own setting. Adapter and model can be changed but not removed."
        target="organization"
        id={organization.id}
        saved={settings.saved!.organizations[organization.id]?.settings ?? {}}
        adapters={settings.adapters}
        save={settings.saveSettings}
      />
      <InstructionsEditor
        key={`instructions:${journalScope}:${organization.id}`}
        journalScope={journalScope}
        client={client}
        organizationId={organization.id}
        name={organization.name}
      />
    </>
  )
}

function agentOrganizations(directory: Directory, agentId: string) {
  const active = new Set(
    directory.organizations
      .filter((o) => o.lifecycle === 'active')
      .map((o) => o.id),
  )
  return directory.memberships
    .filter((m) => m.agentId === agentId && active.has(m.organizationId))
    .map((m) => directory.organizations.find((o) => o.id === m.organizationId)!)
}

function AgentSettings({
  client,
  settings,
  journalScope,
}: {
  client: CoreSettingsClient
  settings: Settings
  journalScope: string
}) {
  const directory = settings.directory!
  const agents = directory.agents
    .filter((a) => a.lifecycle !== 'deleted')
    .sort((a, b) => Number(b.admin) - Number(a.admin))
  const [chosen, setChosen] = useState<string | null>(null)
  const agent = agents.find((a) => a.id === chosen) ?? agents[0]
  const organizations = agent
    ? agent.admin
      ? []
      : agentOrganizations(directory, agent.id)
    : []
  const [chosenOrganization, setChosenOrganization] = useState<string | null>(
    null,
  )
  const organization =
    organizations.find((o) => o.id === chosenOrganization) ?? organizations[0]
  if (!agent) return <p className="settings-callout">No kips yet.</p>
  const organizationId = organization?.id ?? null
  return (
    <>
      <div className="settings-group">
        <label className="setting-row">
          <span className="setting-label">Kip</span>
          <select value={agent.id} onChange={(e) => setChosen(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.admin ? ' (admin)' : ''}
                {a.lifecycle === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </label>
        {organizations.length > 1 && (
          <label className="setting-row">
            <span className="setting-label">
              Organization
              <small>Whose defaults to show and check against.</small>
            </span>
            <select
              value={organizationId ?? ''}
              onChange={(e) => setChosenOrganization(e.target.value)}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <SettingsEditor
        key={`${journalScope}:${agent.id}`}
        journalScope={journalScope}
        title="Own settings"
        note={
          agent.admin
            ? 'Your main kip works outside organizations. Without its own settings, it uses the default adapter and model.'
            : `Choose “Organization default” to follow ${organization?.name ?? 'the organization'} again.`
        }
        target="agent"
        id={agent.id}
        saved={settings.saved!.agents[agent.id]?.settings ?? {}}
        inherited={
          agent.admin
            ? undefined
            : organizationId
              ? (settings.saved!.organizations[organizationId]?.settings ?? {})
              : {}
        }
        adapters={settings.adapters}
        save={settings.saveSettings}
      />
      <Effective
        client={client}
        agentId={agent.id}
        organizationId={organizationId}
        context={
          agent.admin
            ? 'installation work'
            : (organization?.name ?? 'work outside organizations')
        }
      />
      <AgentLearning
        key={`learning:${agent.id}`}
        agentId={agent.id}
        settings={settings}
      />
    </>
  )
}

function SettingsEditor({
  journalScope,
  title,
  note,
  target,
  id,
  saved,
  inherited,
  adapters,
  save,
}: {
  journalScope: string
  title: string
  note: string
  target: SettingsTarget
  id: string
  saved: ExecutionSettings
  /** The organization default an agent falls back to; undefined when nothing is inherited. */
  inherited?: ExecutionSettings
  adapters: AdapterList | null
  save: Settings['saveSettings']
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
  const choices = (field: SettingField) =>
    field === 'adapterId'
      ? (adapters?.adapters.map((a) => ({
          id: a.id,
          label: a.available ? a.id : `${a.id} (unavailable)`,
        })) ?? [])
      : field === 'modelId'
        ? (adapter?.models.map((m) => ({ id: m.id, label: m.id })) ?? [])
        : (model?.efforts.map((e) => ({ id: e, label: e })) ?? [])
  const emptyLabel = (field: SettingField) =>
    inherited
      ? `Organization default (${inherited[field] ?? 'adapter default'})`
      : 'Adapter default'
  return (
    <section aria-label={title} className="settings-editor">
      <h4 className="group-label">{title}</h4>
      <div className="settings-group">
        {settingFields.map((field) => {
          const chosen = value(field)
          const options = choices(field)
          return (
            <label className="setting-row" key={field}>
              <span className="setting-label">
                {fieldLabels[field]}
                {patch[field] && (
                  <small className="setting-changed">
                    {'clear' in patch[field]! ? 'Will be removed' : 'Changed'}
                  </small>
                )}
              </span>
              <select
                aria-label={fieldLabels[field]}
                value={chosen}
                disabled={locked}
                onChange={(e) =>
                  setDraft((old) => ({ ...old, [field]: e.target.value }))
                }
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
            </label>
          )
        })}
      </div>
      <p className="group-note">{note}</p>
      {status.storageError && (
        <p role="alert">
          Saved requests could not be read. Nothing will be sent until storage
          recovers.
          <button onClick={status.retryStorage}>Retry request storage</button>
        </p>
      )}
      {status.error && <p role="alert">{status.error}</p>}
      {status.pending && !status.busy ? (
        <output className="settings-callout" data-tone="wait">
          Kipster did not confirm this save. Retrying sends the original
          request, including after closing Settings or reloading this page.
          <button
            className="text-button"
            disabled={!status.ready}
            onClick={() => void send(status.pending!.patch)}
          >
            Retry save
          </button>
        </output>
      ) : status.saved && !changed ? (
        <output className="settings-callout" data-tone="run">
          Saved.
        </output>
      ) : null}
      {!status.pending && (
        <div className="settings-actions">
          <button
            className="secondary-button"
            disabled={locked || !changed}
            onClick={() => {
              setDraft({})
            }}
          >
            Discard changes
          </button>
          <button
            className="primary-button"
            disabled={locked || !changed}
            onClick={() => void send(patch)}
          >
            {status.busy ? 'Saving…' : 'Save'}
          </button>
        </div>
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

function Effective({
  client,
  agentId,
  organizationId,
  context,
}: {
  client: CoreSettingsClient
  agentId: string
  organizationId: string | null
  context: string
}) {
  const query = useQuery({
    queryKey: ['core-effective', client.endpoint, agentId, organizationId],
    queryFn: ({ signal }) => client.effective(agentId, organizationId, signal),
    retry: false,
  })
  const effective = query.data
  return (
    <section
      className="effective-settings"
      aria-label="Effective execution settings"
    >
      <h4 className="group-label">Next run in {context}</h4>
      {query.isError && !effective ? (
        <p role="alert">
          {errorText(query.error)}{' '}
          <button className="text-button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : !effective ? (
        <output className="settings-callout">Checking…</output>
      ) : (
        <>
          <dl className="settings-group">
            {settingFields.map((field) => (
              <div className="setting-row" key={field}>
                <dt>{fieldLabels[field]}</dt>
                <dd>
                  {effective.settings[field] ??
                    (field === 'effort' ? 'Adapter default' : 'Not set')}
                  <small>
                    {effective.sources[field]
                      ? (sourceText[effective.sources[field]] ??
                        effective.sources[field])
                      : 'No setting'}
                  </small>
                </dd>
              </div>
            ))}
          </dl>
          {effective.status === 'ready' ? (
            <p className="settings-ready">
              <Icon name="check" size={15} weight="bold" />
              {statusText.ready}
            </p>
          ) : (
            <output className="settings-callout" data-tone="wait">
              <strong>
                {statusText[effective.status] ?? effective.status}.
              </strong>
              {effective.reason}
            </output>
          )}
        </>
      )}
    </section>
  )
}

const instructionLimit = 64 * 1024

function InstructionsEditor({
  journalScope,
  client,
  organizationId,
  name,
}: {
  client: CoreSettingsClient
  organizationId: string
  name: string
  journalScope: string
}) {
  const queries = useQueryClient()
  const key = ['core-instructions', client.endpoint, organizationId]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.instructions(organizationId, signal),
    retry: false,
  })
  const [draft, setDraft] = useSettingsDraft<string | null>(
    JSON.stringify([journalScope, 'instructions', organizationId]),
    null,
  )
  const [status, setStatus] = useState<
    'idle' | 'saving' | 'saved' | { error: string }
  >('idle')
  const text = draft ?? query.data ?? ''
  const tooLarge = new TextEncoder().encode(text).length > instructionLimit
  const changed = draft !== null && draft !== query.data
  async function save() {
    const content = text
    setStatus('saving')
    try {
      const saved = await client.saveInstructions(
        organizationId,
        content,
        AbortSignal.timeout(20000),
      )
      queries.setQueryData(key, saved)
      setDraft((current) => (current === content ? null : current))
      setStatus('saved')
    } catch (error) {
      setStatus({ error: errorText(error) })
    }
  }
  return (
    <section aria-label="Organization instructions">
      <h4 className="group-label">Instructions</h4>
      <div className="settings-group">
        <label className="setting-row stacked">
          <span className="setting-label">
            Instructions for {name}
            <small>
              Every kip working in this organization reads these on its next
              run. The latest save wins.
            </small>
          </span>
          <textarea
            aria-label="Organization instructions"
            rows={8}
            value={text}
            disabled={query.isPending}
            aria-invalid={tooLarge}
            onChange={(e) => {
              setDraft(e.target.value)
              if (status !== 'saving') setStatus('idle')
            }}
          />
        </label>
      </div>
      {query.isError && (
        <p role="alert">
          Instructions could not be loaded.{' '}
          <button className="text-button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {tooLarge && (
        <p role="alert">
          Instructions are limited to 64 KB. Shorten them to save.
        </p>
      )}
      {typeof status === 'object' && (
        <p role="alert">Not saved: {status.error} Your text is kept here.</p>
      )}
      <div className="settings-actions">
        <output className="save-state" aria-live="polite">
          {status === 'saving'
            ? 'Saving…'
            : changed
              ? 'Unsaved changes'
              : status === 'saved'
                ? 'Saved'
                : ''}
        </output>
        <button
          className="secondary-button"
          disabled={!changed || status === 'saving'}
          onClick={() => {
            setDraft(null)
            setStatus('idle')
          }}
        >
          Discard changes
        </button>
        <button
          className="primary-button"
          disabled={!changed || tooLarge || status === 'saving'}
          onClick={() => void save()}
        >
          Save instructions
        </button>
      </div>
    </section>
  )
}

function Adapters({ settings }: { settings: Settings }) {
  const [state, setState] = useState<'idle' | 'refreshing' | { error: string }>(
    'idle',
  )
  const list = settings.adapters?.adapters ?? []
  const available = list.filter((a) => a.available).length
  return (
    <>
      <div className="settings-group">
        <div className="setting-row catalog-status">
          <span className="setting-label">
            <span
              className="status-dot"
              data-state={
                state === 'refreshing'
                  ? 'loading'
                  : settings.adapterError || (list.length && !available)
                    ? 'error'
                    : available < list.length
                      ? 'stale'
                      : 'ready'
              }
              aria-hidden="true"
            />
            {settings.adapterError
              ? settings.adapterError
              : `${available} of ${list.length} available`}
          </span>
          <button
            className="secondary-button"
            disabled={state === 'refreshing' || !!settings.adapterError}
            onClick={async () => {
              setState('refreshing')
              try {
                await settings.refreshAdapters()
                setState('idle')
              } catch (error) {
                setState({ error: errorText(error) })
              }
            }}
          >
            <Icon name="refresh" size={15} />
            {state === 'refreshing' ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
      {typeof state === 'object' && (
        <p role="alert">Could not check adapters: {state.error}</p>
      )}
      {list.map((adapter) => (
        <section
          key={adapter.id}
          aria-label={`Adapter ${adapter.id}`}
          className="adapter-card"
        >
          <h4 className="group-label">{adapter.id}</h4>
          <dl className="settings-group">
            <div className="setting-row">
              <dt>Status</dt>
              <dd>
                <span
                  className="status-dot"
                  data-state={adapter.available ? 'ready' : 'error'}
                  aria-hidden="true"
                />
                {adapter.available ? 'Available' : 'Unavailable'}
                {adapter.reason && <small>{adapter.reason}</small>}
              </dd>
            </div>
            <div className="setting-row">
              <dt>Version</dt>
              <dd>{adapter.version || 'Not reported'}</dd>
            </div>
            <div className="setting-row">
              <dt>Models</dt>
              <dd>
                {adapter.models.length
                  ? adapter.models.map((m) => (
                      <span className="adapter-model" key={m.id}>
                        {m.id}
                        {m.efforts.length > 0 && (
                          <small>{m.efforts.join(', ')}</small>
                        )}
                      </span>
                    ))
                  : 'None reported'}
              </dd>
            </div>
            <div className="setting-row">
              <dt>Supports</dt>
              <dd>
                {adapter.capabilities
                  ? Object.entries(adapter.capabilities)
                      .filter(([, on]) => on)
                      .map(([name]) => capabilityText[name] ?? name)
                      .join(', ') || 'Nothing reported'
                  : 'Not reported'}
              </dd>
            </div>
          </dl>
        </section>
      ))}
    </>
  )
}
const capabilityText: Record<string, string> = {
  text: 'Text',
  publication: 'Publishing files',
  cancellation: 'Stop',
  steering: 'Steering',
  nativeResume: 'Resume',
  maintenance: 'Learning',
} as const

function LearningSettings({ settings }: { settings: Settings }) {
  const learning = settings.learning!
  const [time, setTime] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | { error: string }>(
    'idle',
  )
  const run = async (update: { enabled?: boolean; sleepTime?: string }) => {
    setState('saving')
    try {
      await settings.saveLearning(update)
      if (update.sleepTime) setTime(null)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  const chosenTime = time ?? learning.sleepTime
  return (
    <>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label" id="learning-switch">
            Learning
            <small>
              {learning.available
                ? 'Kips learn from completed conversations and tidy what they learned while they sleep. Off by default.'
                : 'Learning needs an embedding profile configured in Kipster Core.'}
            </small>
          </span>
          <span className="management-checkbox setting-switch">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby="learning-switch"
              checked={learning.enabled}
              aria-checked={learning.enabled}
              disabled={
                state === 'saving' || (!learning.available && !learning.enabled)
              }
              onChange={(e) => void run({ enabled: e.target.checked })}
            />
          </span>
        </div>
        <label className="setting-row">
          <span className="setting-label">
            Sleep time
            <small>
              Daily, in this computer’s local time. Kips can use their own.
            </small>
          </span>
          <span className="setting-inline">
            <input
              type="time"
              aria-label="Default sleep time"
              value={chosenTime}
              disabled={state === 'saving'}
              onChange={(e) => setTime(e.target.value)}
            />
            <button
              className="secondary-button"
              disabled={
                state === 'saving' || !time || time === learning.sleepTime
              }
              onClick={() => void run({ sleepTime: time! })}
            >
              Save
            </button>
          </span>
        </label>
      </div>
      {typeof state === 'object' && (
        <p role="alert">Not saved: {state.error}</p>
      )}
      <p className="group-note">
        Each kip can also be switched off or given its own sleep time under
        Agents.
      </p>
    </>
  )
}

function AgentLearning({
  agentId,
  settings,
}: {
  agentId: string
  settings: Settings
}) {
  const learning = settings.learning!
  const agent = learning.agents[agentId]
  const [time, setTime] = useState<string | null>(null)
  const [state, setState] = useState<'idle' | 'saving' | { error: string }>(
    'idle',
  )
  if (!agent) return null
  const run = async (update: {
    enabled?: boolean
    sleepTime?: string | null
  }) => {
    setState('saving')
    try {
      await settings.saveAgentLearning(agentId, update)
      if (update.sleepTime !== undefined) setTime(null)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  const chosenTime = time ?? agent.sleepTime ?? learning.sleepTime
  return (
    <section aria-label="Kip learning">
      <h4 className="group-label">Learning</h4>
      <div className="settings-group">
        <div className="setting-row">
          <span className="setting-label" id={`learning-${agentId}`}>
            Learn from conversations
            <small>
              {agent.effective
                ? 'Learning now.'
                : !learning.enabled
                  ? 'Learning is off for all kips.'
                  : agent.enabled
                    ? 'Not learning right now.'
                    : 'Off for this kip.'}
            </small>
          </span>
          <span className="management-checkbox setting-switch">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby={`learning-${agentId}`}
              checked={agent.enabled}
              aria-checked={agent.enabled}
              disabled={state === 'saving'}
              onChange={(e) => void run({ enabled: e.target.checked })}
            />
          </span>
        </div>
        <label className="setting-row">
          <span className="setting-label">
            Sleep time
            <small>
              {agent.sleepTime
                ? 'Own sleep time.'
                : `Uses the default, ${learning.sleepTime}.`}
            </small>
          </span>
          <span className="setting-inline">
            <input
              type="time"
              aria-label="Kip sleep time"
              value={chosenTime}
              disabled={state === 'saving'}
              onChange={(e) => setTime(e.target.value)}
            />
            {time && time !== (agent.sleepTime ?? learning.sleepTime) ? (
              <button
                className="secondary-button"
                disabled={state === 'saving'}
                onClick={() => void run({ sleepTime: time })}
              >
                Save
              </button>
            ) : (
              agent.sleepTime && (
                <button
                  className="secondary-button"
                  disabled={state === 'saving'}
                  onClick={() => void run({ sleepTime: null })}
                >
                  Use default
                </button>
              )
            )}
          </span>
        </label>
      </div>
      {typeof state === 'object' && (
        <p role="alert">Not saved: {state.error}</p>
      )}
    </section>
  )
}
