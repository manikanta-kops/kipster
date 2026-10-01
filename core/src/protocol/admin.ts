import { array, boolean, boundedString, integer, literal, nonempty, nullable, object, optional, record, string, union, unknown, utcTimestamp, type Infer, type Schema } from './schema.js'

const id = nonempty()
export const organizationLifecycle = union(literal('active'), literal('deleting'), literal('deleted'))
export const agentLifecycle = union(literal('active'), literal('archived'), literal('deleting'), literal('deleted'))
export const directoryOrganization = object({ id, name: string(), description: string(), lifecycle: organizationLifecycle, revision: integer(), createdAt: utcTimestamp() }, false)
export type DirectoryOrganization = Infer<typeof directoryOrganization>
/** A deleted agent keeps its last name, so history can show it as deleted. */
export const directoryAgent = object({ id, name: string(), description: string(), lifecycle: agentLifecycle, admin: boolean(), revision: integer(), createdAt: utcTimestamp(), deletedAt: nullable(utcTimestamp()) }, false)
export type DirectoryAgent = Infer<typeof directoryAgent>
export const directoryMembership = object({ id, organizationId: id, agentId: id, revision: integer(), createdAt: utcTimestamp() }, false)
export type DirectoryMembership = Infer<typeof directoryMembership>
/** Appearances are ordered. Each names a membership, so every appearance of an agent opens the same chat. */
export const directoryGroup = object({ id, organizationId: id, name: string(), position: integer(), revision: integer(), appearances: array(object({ membershipId: id, agentId: id }, false)) }, false)
export type DirectoryGroup = Infer<typeof directoryGroup>
export const directorySnapshot = object({ version: literal(1), cursor: id, organizations: array(directoryOrganization), agents: array(directoryAgent), memberships: array(directoryMembership), groups: array(directoryGroup) }, false)
export type DirectorySnapshot = Infer<typeof directorySnapshot>
export const organizationRemoved = object({ id }, false)
export const membershipRemoved = object({ id, organizationId: id, agentId: id }, false)
export const groupRemoved = object({ id, organizationId: id }, false)

/** A name must not be blank. */
const name: Schema<string> = { ...boundedString(1, 200), parse(value, path = '$') {
  const parsed = boundedString(1, 200).parse(value, path)
  if (!parsed.trim()) throw new TypeError(`Invalid wire value at ${path}`)
  return parsed
} }
const description = boundedString(0, 2000)
/** Chosen by the client and reused on retry; a repeated ID returns the recorded result. */
const operationId = boundedString(1, 200)
const setting = union(object({ set: nonempty() }), object({ clear: literal(true) }))
/** Execution settings to set or clear. An omitted field is unchanged. */
export const settingsPatch = object({ adapterId: optional(setting), modelId: optional(setting), effort: optional(setting), options: optional(union(object({ set: record() }), object({ clear: literal(true) }))) })
export type SettingsPatch = Infer<typeof settingsPatch>

export const organizationCreate = object({ version: literal(1), operationId, name, description: optional(description), settings: optional(settingsPatch) })
export type OrganizationCreate = Infer<typeof organizationCreate>
/** An omitted field is unchanged. */
export const organizationUpdate = object({ version: literal(1), operationId, name: optional(name), description: optional(description), settings: optional(settingsPatch) })
export type OrganizationUpdate = Infer<typeof organizationUpdate>
/** `organizationId` also adds the new agent to that organization. */
export const agentCreate = object({ version: literal(1), operationId, name, description: optional(description), settings: optional(settingsPatch), organizationId: optional(id) })
export type AgentCreate = Infer<typeof agentCreate>
/** An omitted field is unchanged. */
export const agentUpdate = object({ version: literal(1), operationId, name: optional(name), description: optional(description), settings: optional(settingsPatch) })
export type AgentUpdate = Infer<typeof agentUpdate>

/** `alreadyApplied` marks a repeated operation ID; the result is the one recorded the first time. */
const applied = { version: literal(1), operationId, alreadyApplied: boolean() }
export const organizationResult = object({ ...applied, organization: directoryOrganization }, false)
export type OrganizationResult = Infer<typeof organizationResult>
export const agentCreateResult = object({ ...applied, agent: directoryAgent, membership: nullable(directoryMembership) }, false)
export type AgentCreateResult = Infer<typeof agentCreateResult>
export const agentResult = object({ ...applied, agent: directoryAgent }, false)
export type AgentResult = Infer<typeof agentResult>

export const organizationInstructionsWrite = object({ version: literal(1), content: string() })
export type OrganizationInstructionsWrite = Infer<typeof organizationInstructionsWrite>
export const organizationInstructions = object({ version: literal(1), organizationId: id, content: string() }, false)
export type OrganizationInstructions = Infer<typeof organizationInstructions>

export const membershipAdd = object({ version: literal(1), operationId, agentId: id })
export type MembershipAdd = Infer<typeof membershipAdd>
/** A removal, a group deletion or an appearance removal names its target in the path. */
export const operationRequest = object({ version: literal(1), operationId })
export type OperationRequest = Infer<typeof operationRequest>
/**
 * Permanently deletes an archived agent. `copyFilesToOrganizations` first copies each of its files
 * that appeared in an organization's chats into that organization. The response is the agent as
 * `deleting`; follow the cleanup with `GET /v1/operations/{operationId}`.
 */
export const agentDelete = object({ version: literal(1), operationId, copyFilesToOrganizations: optional(boolean()) })
export type AgentDelete = Infer<typeof agentDelete>
/** Progress of an operation recorded under the caller's operation ID. `waitingFor` says why a waiting operation waits. */
export const operationStatus = object({
  version: literal(1), operationId, kind: string(), target: object({ kind: nullable(string()), id: nullable(id) }),
  state: union(literal('pending'), literal('running'), literal('waiting'), literal('succeeded'), literal('failed')),
  step: nullable(string()), waitingFor: nullable(string()), result: unknown(), error: nullable(string()),
  createdAt: utcTimestamp(), updatedAt: utcTimestamp(),
}, false)
export type OperationStatusRecord = Infer<typeof operationStatus>
export const groupCreate = object({ version: literal(1), operationId, name })
export type GroupCreate = Infer<typeof groupCreate>
export const groupRename = object({ version: literal(1), operationId, name })
export type GroupRename = Infer<typeof groupRename>
/** Lists every group of the organization in its new order. */
export const groupOrder = object({ version: literal(1), operationId, groupIds: array(id) })
export type GroupOrder = Infer<typeof groupOrder>
export const appearanceAdd = object({ version: literal(1), operationId, membershipId: id })
export type AppearanceAdd = Infer<typeof appearanceAdd>
/** Lists every membership in the group in its new order. */
export const appearanceOrder = object({ version: literal(1), operationId, membershipIds: array(id) })
export type AppearanceOrder = Infer<typeof appearanceOrder>

export const membershipResult = object({ ...applied, membership: directoryMembership }, false)
export type MembershipResult = Infer<typeof membershipResult>
export const membershipRemovalResult = object({ ...applied, removed: membershipRemoved }, false)
export type MembershipRemovalResult = Infer<typeof membershipRemovalResult>
export const groupResult = object({ ...applied, group: directoryGroup }, false)
export type GroupResult = Infer<typeof groupResult>
export const groupRemovalResult = object({ ...applied, removed: groupRemoved }, false)
export type GroupRemovalResult = Infer<typeof groupRemovalResult>
export const groupOrderResult = object({ ...applied, groups: array(directoryGroup) }, false)
export type GroupOrderResult = Infer<typeof groupOrderResult>

/** Execution settings as saved. Organization defaults apply to their members; an agent's own settings override them. */
export const executionSettings = object({ adapterId: optional(string()), modelId: optional(string()), effort: optional(string()), options: optional(record()) }, false)
export type ExecutionSettings = Infer<typeof executionSettings>
export const settingsTarget = union(literal('agent'), literal('organization'))
/** The saved settings of one agent or organization. The revision counts settings changes only. */
export const settingsRecord = object({ target: settingsTarget, id, revision: integer(), settings: executionSettings }, false)
export type SettingsRecord = Infer<typeof settingsRecord>
/** Saved settings of the listed agents and active organizations, with the application cursor to follow changes from. */
export const settingsSnapshot = object({ version: literal(1), cursor: id, agents: array(settingsRecord), organizations: array(settingsRecord) }, false)
export type SettingsSnapshot = Infer<typeof settingsSnapshot>
export const settingsWrite = object({ version: literal(1), operationId, settings: settingsPatch })
export type SettingsWrite = Infer<typeof settingsWrite>
export const settingsResult = object({ ...applied, settings: settingsRecord }, false)
export type SettingsResult = Infer<typeof settingsResult>

const settingsSource = union(literal('organization'), literal('agent'), literal('default'))
/**
 * The settings an execution of the agent would use in the organization, or in the installation
 * when `organizationId` is null. `sources` names where each value comes from: the agent, its
 * organization, or `default`, the first configured adapter and that adapter's default model. A
 * selection that cannot run keeps its saved values and carries the reason.
 */
export const effectiveSettings = object({
  version: literal(1), agentId: id, organizationId: nullable(id),
  status: union(literal('ready'), literal('unknown-catalog'), literal('missing'), literal('incompatible')),
  reason: nullable(string()), settings: executionSettings,
  sources: object({ adapterId: optional(settingsSource), modelId: optional(settingsSource), effort: optional(settingsSource), options: optional(settingsSource) }, false),
}, false)
export type EffectiveSettings = Infer<typeof effectiveSettings>

export const adapterCapabilities = object({ text: boolean(), publication: boolean(), cancellation: boolean(), steering: boolean(), nativeResume: boolean(), maintenance: boolean() }, false)
/**
 * A registered execution adapter. An unavailable adapter carries the reason and its last known
 * catalog; `capabilities` is null when the adapter never reported one. `defaultModel` is the model
 * and effort used when neither the agent nor its organization chooses one.
 */
export const executionAdapter = object({
  id, version: string(), available: boolean(), reason: nullable(string()),
  models: array(object({ id, efforts: array(string()) }, false)),
  defaultModel: nullable(object({ id, effort: nullable(string()) }, false)), supportedOptions: array(string()), capabilities: nullable(adapterCapabilities),
}, false)
export type ExecutionAdapter = Infer<typeof executionAdapter>
export const executionAdapters = object({ version: literal(1), cursor: id, revision: integer(), adapters: array(executionAdapter) }, false)
export type ExecutionAdapters = Infer<typeof executionAdapters>
export const adaptersRefresh = object({ version: literal(1) })
export type AdaptersRefresh = Infer<typeof adaptersRefresh>
export const adaptersChange = object({ adapters: array(executionAdapter) }, false)
