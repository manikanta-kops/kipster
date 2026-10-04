import type {
  EffectiveSettings as CoreEffectiveSettings,
  ExecutionAdapter,
  ExecutionAdapters,
  ExecutionSettings,
  LearningSettings,
  SettingsPatch,
  SettingsRecord as CoreSettingsRecord,
} from '@kipster/core/protocol'
import type {
  DirectoryAgent,
  DirectoryMembership,
  DirectoryOrganization,
} from './directory.js'
import { directoryEventTypes } from './directory.ts'
import { check, incompatible, list, record } from './response.ts'
import { readEvents } from './sse.ts'
export type {
  ExecutionAdapter,
  ExecutionSettings,
  SettingsPatch,
} from '@kipster/core/protocol'
import { TextHttpError, type Scope } from './text.js'

/** Execution setting fields a person edits. Provider options are kept as saved. */
export const settingFields = ['adapterId', 'modelId', 'effort'] as const
export type SettingField = (typeof settingFields)[number]
export type SettingsTarget = CoreSettingsRecord['target']
export type SettingsRecord = Omit<CoreSettingsRecord, 'target'> & {
  target: string
}
export type SavedSettings = {
  agents: Record<string, SettingsRecord>
  organizations: Record<string, SettingsRecord>
}
export type EffectiveSettings = Omit<
  CoreEffectiveSettings,
  'status' | 'sources'
> & {
  status: string
  sources: Partial<Record<SettingField | 'options', string>>
}
export type AdapterCapability = keyof NonNullable<
  ExecutionAdapter['capabilities']
>
export type AdapterList = Pick<ExecutionAdapters, 'revision' | 'adapters'>
export type AgentLearning = LearningSettings['agents'][number]
export type Learning = Omit<LearningSettings, 'version' | 'agents'> & {
  agents: Record<string, AgentLearning>
}
export type Directory = {
  organizations: Pick<DirectoryOrganization, 'id' | 'name' | 'lifecycle'>[]
  agents: Pick<DirectoryAgent, 'id' | 'name' | 'lifecycle' | 'admin'>[]
  memberships: Pick<DirectoryMembership, 'id' | 'organizationId' | 'agentId'>[]
}
/** The modes this interface offers, in order; a mode Core reports outside these is shown as unrecognized. */
export const permissionModes = [
  'supervised',
  'acceptEdits',
  'auto',
  'fullAccess',
] as const
export type PermissionMode = (typeof permissionModes)[number]
/** An action the person always allows, for every kip, until they remove it. */
export type AlwaysAllowed = { id: string; label: string; createdAt: string }
/** The installation's permission mode. `mode` stays a string, since a newer Core may send one this app does not know. */
export type Permissions = {
  revision: number
  mode: string
  alwaysAllowed: AlwaysAllowed[]
}
/** A mode to save, always-allowed actions to remove, or both. */
export type PermissionChange = {
  mode?: PermissionMode
  removeAlwaysAllowed?: string[]
}
export type SettingsEvent = { cursor: string } & (
  | { kind: 'settings'; record: SettingsRecord }
  | { kind: 'permissions'; permissions: Permissions }
  | { kind: 'adapters'; list: AdapterList }
  | {
      kind: 'learning'
      target: string
      id: string
      revision: number
      enabled: boolean
      sleepTime: string | null
    }
  | { kind: 'directory' }
  | { kind: 'skipped' }
)

function parseExecutionSettings(value: unknown): ExecutionSettings {
  check(record(value))
  for (const field of settingFields)
    check(value[field] === undefined || typeof value[field] === 'string')
  check(value.options === undefined || record(value.options))
  return value as ExecutionSettings
}

export function parseSettingsRecord(value: unknown): SettingsRecord {
  check(
    record(value) &&
      typeof value.target === 'string' &&
      typeof value.id === 'string' &&
      typeof value.revision === 'number',
  )
  return {
    ...value,
    settings: parseExecutionSettings(value.settings),
  } as SettingsRecord
}

export function parseSettingsSnapshot(
  value: unknown,
): SavedSettings & { cursor: string } {
  check(record(value) && typeof value.cursor === 'string')
  const index = (items: unknown) =>
    Object.fromEntries(
      list(items, parseSettingsRecord).map((item) => [item.id, item]),
    )
  return {
    cursor: value.cursor,
    agents: index(value.agents),
    organizations: index(value.organizations),
  }
}

export function parseSettingsResult(value: unknown): SettingsRecord {
  check(record(value))
  return parseSettingsRecord(value.settings)
}

export function parseEffectiveSettings(value: unknown): EffectiveSettings {
  check(
    record(value) &&
      typeof value.status === 'string' &&
      (value.reason === null || typeof value.reason === 'string') &&
      record(value.sources),
  )
  for (const field of settingFields)
    check(
      value.sources[field] === undefined ||
        typeof value.sources[field] === 'string',
    )
  return {
    ...value,
    settings: parseExecutionSettings(value.settings),
  } as EffectiveSettings
}

function parseAdapter(value: unknown): ExecutionAdapter {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.version === 'string' &&
      typeof value.available === 'boolean' &&
      (value.reason === null || typeof value.reason === 'string') &&
      (value.defaultModel === null ||
        (record(value.defaultModel) &&
          typeof value.defaultModel.id === 'string' &&
          (value.defaultModel.effort === null ||
            typeof value.defaultModel.effort === 'string'))) &&
      (value.capabilities === null || record(value.capabilities)),
  )
  return {
    ...value,
    models: list(value.models, (model) => {
      check(record(model) && typeof model.id === 'string')
      return {
        ...model,
        efforts: list(model.efforts, (effort) => {
          check(typeof effort === 'string')
          return effort
        }),
      }
    }),
    supportedOptions: list(value.supportedOptions, (option) => {
      check(typeof option === 'string')
      return option
    }),
  } as ExecutionAdapter
}

export function parseAdapterList(value: unknown): AdapterList {
  check(record(value) && typeof value.revision === 'number')
  return {
    revision: value.revision,
    adapters: list(value.adapters, parseAdapter),
  }
}

export function parseAgentLearning(value: unknown): AgentLearning {
  check(
    record(value) &&
      typeof value.agentId === 'string' &&
      typeof value.enabled === 'boolean' &&
      (value.sleepTime === null || typeof value.sleepTime === 'string') &&
      typeof value.revision === 'number' &&
      typeof value.effective === 'boolean',
  )
  return value as AgentLearning
}

/** Installation-wide interface choices; null is the interface default. */
/** Notification choices are undefined when the connected Core does not keep them. */
export const notificationChoices = [
  'notifyNeeds',
  'notifyFailures',
  'notifyReplies',
  'inAppBanners',
  'dockBadge',
] as const
export type InterfaceChoices = {
  revision: number
  palette: string | null
  theme: string | null
  desktopNotifications: boolean | null
} & Partial<Record<(typeof notificationChoices)[number], boolean | null>>
export function parseInterfaceChoices(value: unknown): InterfaceChoices {
  check(
    record(value) &&
      typeof value.revision === 'number' &&
      (value.palette === null || typeof value.palette === 'string') &&
      (value.theme === null || typeof value.theme === 'string') &&
      (value.desktopNotifications === null ||
        typeof value.desktopNotifications === 'boolean') &&
      notificationChoices.every(
        (name) =>
          value[name] === undefined ||
          value[name] === null ||
          typeof value[name] === 'boolean',
      ),
  )
  return {
    revision: value.revision,
    palette: value.palette,
    theme: value.theme,
    desktopNotifications: value.desktopNotifications,
    ...Object.fromEntries(
      notificationChoices.flatMap((name) =>
        value[name] === undefined ? [] : [[name, value[name]]],
      ),
    ),
  }
}
export function parsePermissions(value: unknown): Permissions {
  check(
    record(value) &&
      typeof value.revision === 'number' &&
      typeof value.mode === 'string' &&
      Array.isArray(value.alwaysAllowed),
  )
  return {
    revision: value.revision,
    mode: value.mode,
    alwaysAllowed: (value.alwaysAllowed as unknown[]).map((item) => {
      check(
        record(item) &&
          typeof item.id === 'string' &&
          typeof item.label === 'string' &&
          typeof item.createdAt === 'string',
      )
      return { id: item.id, label: item.label, createdAt: item.createdAt }
    }),
  }
}
/** The newer of two permission records by revision. */
export function mergePermissions(
  held: Permissions | null,
  next: Permissions,
): Permissions {
  return held && held.revision > next.revision ? held : next
}
export function parseLearning(value: unknown): Learning {
  check(
    record(value) &&
      typeof value.enabled === 'boolean' &&
      typeof value.sleepTime === 'string' &&
      typeof value.revision === 'number' &&
      typeof value.available === 'boolean',
  )
  return {
    ...value,
    agents: Object.fromEntries(
      list(value.agents, parseAgentLearning).map((agent) => [
        agent.agentId,
        agent,
      ]),
    ),
  } as Learning
}

export function parseDirectory(value: unknown): Directory {
  check(record(value))
  return {
    organizations: list(value.organizations, (organization) => {
      check(
        record(organization) &&
          typeof organization.id === 'string' &&
          typeof organization.name === 'string' &&
          typeof organization.lifecycle === 'string',
      )
      return organization as Directory['organizations'][number]
    }),
    agents: list(value.agents, (agent) => {
      check(
        record(agent) &&
          typeof agent.id === 'string' &&
          typeof agent.name === 'string' &&
          typeof agent.lifecycle === 'string' &&
          typeof agent.admin === 'boolean',
      )
      return agent as Directory['agents'][number]
    }),
    memberships: list(value.memberships, (membership) => {
      check(
        record(membership) &&
          typeof membership.organizationId === 'string' &&
          typeof membership.agentId === 'string',
      )
      return membership as Directory['memberships'][number]
    }),
  }
}

/** Reads settings updates; unrelated kinds and scopes are skipped. */
export function parseSettingsEvent(
  value: unknown,
  scope: Scope,
): SettingsEvent {
  check(
    record(value) &&
      record(value.scope) &&
      typeof value.cursor === 'string' &&
      typeof value.type === 'string',
  )
  const cursor = value.cursor
  if (
    value.scope.kind !== 'application' ||
    value.scope.installationId !== scope.installationId ||
    value.scope.callerId !== scope.callerId
  )
    return { cursor, kind: 'skipped' }
  if (value.type === 'resync-required')
    throw new TextHttpError('Live settings need refreshing.', 'resync-required')
  if (value.type === 'settings-changed')
    return { cursor, kind: 'settings', record: parseSettingsRecord(value.data) }
  if (value.type === 'adapters-changed') {
    check(record(value.data) && typeof value.revision === 'number')
    return {
      cursor,
      kind: 'adapters',
      list: {
        revision: value.revision,
        adapters: list(value.data.adapters, parseAdapter),
      },
    }
  }
  if (value.type === 'permissions-changed')
    return {
      cursor,
      kind: 'permissions',
      permissions: parsePermissions(value.data),
    }
  if (value.type === 'learning-changed') {
    check(
      record(value.data) &&
        typeof value.resourceId === 'string' &&
        typeof value.revision === 'number' &&
        typeof value.data.target === 'string' &&
        typeof value.data.enabled === 'boolean' &&
        (value.data.sleepTime === null ||
          typeof value.data.sleepTime === 'string'),
    )
    return {
      cursor,
      kind: 'learning',
      target: value.data.target,
      id: value.resourceId,
      revision: value.revision,
      enabled: value.data.enabled,
      sleepTime: value.data.sleepTime,
    }
  }
  return {
    cursor,
    kind: directoryEventTypes.has(value.type) ? 'directory' : 'skipped',
  }
}

/** A record replaces the one held when its revision is not older. */
export function mergeSettingsRecord(
  saved: SavedSettings,
  item: SettingsRecord,
): SavedSettings {
  if (item.target !== 'agent' && item.target !== 'organization') return saved
  const key = item.target === 'agent' ? 'agents' : 'organizations'
  const current = saved[key][item.id]
  if (current && current.revision > item.revision) return saved
  return { ...saved, [key]: { ...saved[key], [item.id]: item } }
}

/**
 * A new snapshot lists the current records. Records it omits have left the directory; a newer
 * record already held (from an event or a save) is kept.
 */
export function mergeSettingsSnapshot(
  held: SavedSettings | null,
  snapshot: SavedSettings,
): SavedSettings {
  const keep = (
    next: Record<string, SettingsRecord>,
    old: Record<string, SettingsRecord> | undefined,
  ) =>
    Object.fromEntries(
      Object.entries(next).map(([id, item]) => [
        id,
        old?.[id] && old[id].revision > item.revision ? old[id] : item,
      ]),
    )
  return {
    agents: keep(snapshot.agents, held?.agents),
    organizations: keep(snapshot.organizations, held?.organizations),
  }
}

export function mergeAdapterList(
  held: AdapterList | null,
  next: AdapterList,
): AdapterList {
  return held && held.revision > next.revision ? held : next
}

/** Installation and agent learning records merge independently by revision. */
export function mergeLearning(held: Learning | null, next: Learning): Learning {
  if (!held) return next
  const agents = { ...next.agents }
  for (const [id, agent] of Object.entries(held.agents))
    if (agents[id] && agent.revision > agents[id].revision) agents[id] = agent
  const installation =
    held.revision > next.revision
      ? {
          enabled: held.enabled,
          sleepTime: held.sleepTime,
          revision: held.revision,
        }
      : {
          enabled: next.enabled,
          sleepTime: next.sleepTime,
          revision: next.revision,
        }
  return { ...next, ...installation, agents }
}

export function mergeAgentLearning(
  held: Learning,
  agent: Omit<AgentLearning, 'effective'> & { effective?: boolean },
): Learning {
  const current = held.agents[agent.agentId]
  if (current && current.revision > agent.revision) return held
  const enabled = agent.enabled
  return {
    ...held,
    agents: {
      ...held.agents,
      [agent.agentId]: {
        ...agent,
        effective:
          agent.effective ?? (held.available && held.enabled && enabled),
      },
    },
  }
}

export function applyLearningEvent(
  held: Learning,
  event: Extract<SettingsEvent, { kind: 'learning' }>,
): Learning {
  if (event.target === 'agent')
    return mergeAgentLearning(held, {
      agentId: event.id,
      enabled: event.enabled,
      sleepTime: event.sleepTime,
      revision: event.revision,
    })
  if (event.target !== 'installation' || held.revision > event.revision)
    return held
  return {
    ...held,
    enabled: event.enabled,
    sleepTime: event.sleepTime ?? held.sleepTime,
    revision: event.revision,
  }
}

/**
 * The fields whose chosen value differs from the saved one. An empty choice clears the saved
 * value, so an agent inherits its organization's default again.
 */
export function settingsPatch(
  saved: ExecutionSettings,
  draft: Partial<Record<SettingField, string>>,
): SettingsPatch {
  let patch: SettingsPatch = {}
  for (const field of settingFields) {
    const chosen = draft[field]
    if (chosen === undefined || chosen === (saved[field] ?? '')) continue
    patch = { ...patch, [field]: chosen ? { set: chosen } : { clear: true } }
  }
  return patch
}

/** Saves are safe to retry with the same operation ID when the outcome is unknown. */
export function uncertainFailure(error: unknown) {
  return !(error instanceof TextHttpError) || error.code === 'unavailable'
}

export class CoreSettingsClient {
  readonly endpoint: string
  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, '')
  }
  private async request(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null)
      throw new TextHttpError(
        record(error) && typeof error.message === 'string'
          ? error.message
          : `Kipster is unavailable (HTTP ${response.status}).`,
        response.status >= 500
          ? 'unavailable'
          : record(error) && typeof error.code === 'string'
            ? error.code
            : 'invalid',
      )
    }
    return response.json().catch(() => incompatible())
  }
  async settings(signal: AbortSignal) {
    return parseSettingsSnapshot(
      await this.request('GET', '/v1/settings', signal),
    )
  }
  async saveSettings(
    target: SettingsTarget,
    id: string,
    operationId: string,
    patch: SettingsPatch,
    signal: AbortSignal,
  ) {
    const collection = target === 'agent' ? 'agents' : 'organizations'
    return parseSettingsResult(
      await this.request(
        'PUT',
        `/v1/${collection}/${encodeURIComponent(id)}/settings`,
        signal,
        { version: 1, operationId, settings: patch },
      ),
    )
  }
  async effective(
    agentId: string,
    organizationId: string | null,
    signal: AbortSignal,
  ) {
    const query = organizationId
      ? `?organizationId=${encodeURIComponent(organizationId)}`
      : ''
    const result = parseEffectiveSettings(
      await this.request(
        'GET',
        `/v1/agents/${encodeURIComponent(agentId)}/effective-settings${query}`,
        signal,
      ),
    )
    return result
  }
  async adapters(signal: AbortSignal) {
    return parseAdapterList(
      await this.request('GET', '/v1/execution-adapters', signal),
    )
  }
  async refreshAdapters(signal: AbortSignal) {
    return parseAdapterList(
      await this.request('POST', '/v1/execution-adapters/refresh', signal, {
        version: 1,
      }),
    )
  }
  async instructions(organizationId: string, signal: AbortSignal) {
    const v = await this.request(
      'GET',
      `/v1/organizations/${encodeURIComponent(organizationId)}/instructions`,
      signal,
    )
    check(record(v) && typeof v.content === 'string')
    return v.content as string
  }
  async saveInstructions(
    organizationId: string,
    content: string,
    signal: AbortSignal,
  ) {
    const v = await this.request(
      'PUT',
      `/v1/organizations/${encodeURIComponent(organizationId)}/instructions`,
      signal,
      { version: 1, content },
    )
    check(record(v) && typeof v.content === 'string')
    return v.content as string
  }
  async learning(signal: AbortSignal) {
    return parseLearning(
      await this.request('GET', '/v1/settings/learning', signal),
    )
  }
  async saveLearning(
    update: { enabled?: boolean; sleepTime?: string },
    signal: AbortSignal,
  ) {
    return parseLearning(
      await this.request('PUT', '/v1/settings/learning', signal, {
        version: 1,
        ...update,
      }),
    )
  }
  async saveAgentLearning(
    agentId: string,
    update: { enabled?: boolean; sleepTime?: string | null },
    signal: AbortSignal,
  ) {
    const v = await this.request(
      'PUT',
      `/v1/agents/${encodeURIComponent(agentId)}/learning`,
      signal,
      { version: 1, ...update },
    )
    const result = parseAgentLearning(v)
    return result
  }
  async permissions(signal: AbortSignal) {
    return parsePermissions(
      await this.request('GET', '/v1/settings/permissions', signal),
    )
  }
  async savePermissions(change: PermissionChange, signal: AbortSignal) {
    return parsePermissions(
      await this.request('PUT', '/v1/settings/permissions', signal, {
        version: 1,
        ...change,
      }),
    )
  }
  async directory(signal: AbortSignal) {
    return parseDirectory(await this.request('GET', '/v1/directory', signal))
  }
  async interfacePreferences(signal: AbortSignal) {
    return parseInterfaceChoices(
      await this.request('GET', '/v1/settings/interface', signal),
    )
  }
  async saveInterfacePreferences(
    changes: Partial<Omit<InterfaceChoices, 'revision'>>,
    signal: AbortSignal,
  ) {
    return parseInterfaceChoices(
      await this.request('PUT', '/v1/settings/interface', signal, {
        version: 1,
        ...changes,
      }),
    )
  }
  /** Follows the application stream after `cursor` until it fails or `signal` aborts. */
  async events(
    scope: Scope,
    cursor: string,
    signal: AbortSignal,
    apply: (event: SettingsEvent) => void,
  ): Promise<never> {
    const response = await fetch(
      `${this.endpoint}/v1/app/events?after=${encodeURIComponent(cursor)}`,
      { signal, cache: 'no-store', headers: { Accept: 'text/event-stream' } },
    )
    if (response.status === 409)
      throw new TextHttpError(
        'Live settings need refreshing.',
        'resync-required',
      )
    if (!response.ok || !response.body)
      throw new TextHttpError('Live updates are unavailable.', 'unavailable')
    return readEvents(response, signal, (type, raw) => {
      // Transport control frames have no resource envelope; others end with the stream.
      if (record(raw) && !record(raw.scope)) {
        if (type === 'resync-required')
          throw new TextHttpError(
            'Live settings need refreshing.',
            'resync-required',
          )
        return
      }
      apply(parseSettingsEvent(raw, scope))
    })
  }
}
