import { requestAdminApproval, requestInstallApproval, requestPermissionsApproval, requestPluginsInstallApproval } from './admin-approvals.js'
import type { Postgres } from '../platform/postgres/public.js'
import type { Jobs } from '../platform/jobs/public.js'
import { MAX_IDENTITY_BYTES, MAX_ORGANIZATION_INSTRUCTIONS_BYTES, type Home, type IdentityFileName } from '../platform/home/public.js'
import { authorizeAdministration, type AgentCaller } from '../modules/identity/public.js'
import { addAppearance, addMembership, changeSettings, createAgent, createGroup, createOrganization, deleteGroup, readDirectory, readOperation, readOrganizationInstructions, removeAppearance, removeMembership, renameGroup, reorderAppearances, reorderGroups, restoreAgent, updateAgent, updateOrganization, writeOrganizationInstructions, type Changes } from '../modules/administration/public.js'
import { effectiveSettings, listIdentityBackups, readAdapters, readIdentityBackup, readIdentityFile, readInterfacePreferences, readPermissions, readSettings, requireSettingsOwner, restoreIdentityBackup, writeIdentityFile, writeInterfacePreferences, writePermissions, type Catalog, type Patch } from '../modules/settings/public.js'
import type { LearningService } from '../modules/memory/public.js'
import type { UpdatesService } from '../modules/updates/public.js'
import { agentCreate, agentUpdate, appearanceAdd, appearanceOrder, groupCreate, groupOrder, groupRename, interfacePreferencesWrite, membershipAdd, permissionSettingsWrite, organizationCreate, organizationInstructionsWrite, organizationUpdate, settingsTarget } from '../protocol/admin.js'
import { agentLearningUpdate, identityFileName, identityRestore, identityWrite, learningUpdate } from '../protocol/text.js'
import { updateChannel, updateInstall, updateMode, updatePluginsInstall } from '../protocol/updates.js'
import { lessonUpdate, memoryUpdate } from '../protocol/memory.js'
import { pluginAccountRename } from '../protocol/plugins.js'
import { PluginControlClient, PluginRouteError } from '../plugins/client.js'
import type { PluginServerEndpoint } from '../plugins/supervisor.js'
import { deleteLesson, deleteMemory, editLesson, editMemory, listLessons, listMemories, readLesson, readMemory } from './memory-items.js'
import { readRoutineSettings, writeRoutineSettings } from '../modules/routines/public.js'
import { routineSettingsWrite } from '../protocol/routines.js'
import { array, boolean, boundedInteger, boundedString, literal, nonempty, object, optional, record, union, type Infer, type Schema, type WireShape } from '../protocol/schema.js'

/** What the administration tools need from the dispatcher that runs the calling attempt. */
export interface AdministrationToolHost {
  readonly db: Postgres
  readonly home: Home
  readonly jobs: Jobs
  readonly learning: LearningService
  readonly updates: UpdatesService
  /** The plugin server while it runs; without it the `plugins` operations fail with `plugins-unavailable`. */
  readonly plugins?: PluginServerEndpoint | undefined
  catalog(): Catalog | null
  refreshAdapters(): Promise<void>
}

/** Areas group the operations for listing; every operation names one. */
const areas = {
  directory: 'Everything at a glance: workspaces (organizations), kips (agents), memberships and groups.',
  organizations: 'Workspaces: create, rename, describe, edit instructions, delete.',
  agents: 'Kips: create, rename, describe, archive, restore, delete.',
  identity: 'The identity files of any kip: soul.md (character and working rules) and identity.md (role).',
  memberships: 'Which kips belong to which workspace.',
  groups: 'The sidebar groups of a workspace and the kips shown in each.',
  settings: 'Execution settings of kips and workspaces: adapter, model, effort and options.',
  adapters: 'Execution adapters and the models they offer.',
  permissions: 'What kips may do without asking the person: supervised, auto-accept edits, auto or full access, and the actions the person always allows.',
  learning: 'Memory: on or off and the nightly sleep time, for the installation and each kip; the nightly model; how many core memories every turn loads and how many memories and thread chunks a turn\'s search adds.',
  memory: 'Memories, the facts about the person every kip shares, and lessons, how each kip should do its work; both learned each night from conversations. Read, edit or delete them; messages stay.',
  interface: 'How the app looks and alerts: colour palette, light or dark theme, desktop notifications and their kinds, in-app banners, the app icon badge.',
  updates: 'Software updates of Kipster Core and Kipster Plugins: channel, automatic or notify mode, checks, installs and pins.',
  plugins: 'Kipster Plugins: the services kips can use, signing in to them, and the signed-in accounts with their names and the default account of each plugin.',
  routines: 'Routines, work kips do on their own on a schedule: the most routine runs one kip starts a day. Kips create and change routines with their routine tools.',
  operations: 'The state and result of an earlier change, by its operationId.',
} as const
type Area = keyof typeof areas

/**
 * `read` changes nothing. `write` changes records; with `receipt` it needs an operationId and records its result, so a retry
 * with the same ID returns that result instead of acting again. `approval` asks the owner with an approval card and ends
 * the turn; the change happens only when the owner approves.
 */
type Kind = 'read' | 'write' | 'approval'
interface Call<A> { readonly host: AdministrationToolHost; readonly caller: AgentCaller; readonly callId: string; readonly operationId: string; readonly args: A }
interface Operation<A = never> {
  readonly area: Area
  readonly description: string
  readonly kind: Kind
  readonly receipt?: true
  readonly input: Schema<A>
  /** Largest JSON size of the arguments, in bytes. */
  readonly maxBytes?: number
  run(call: Call<A>): Promise<unknown>
}
const operation = <A>(definition: Operation<A>): Operation<A> => definition

const id = nonempty()
const none = object({})
type Fields<S extends Record<string, Schema<unknown>>> = { [K in keyof S]: Infer<S[K]> }
/**
 * Arguments named by `ids` plus the fields of a protocol request `body`, which parses them with the same rules as the
 * HTTP route. Core supplies the body's `version` and `operationId`.
 */
function fields<const S extends Record<string, Schema<unknown>>, B extends object = Record<never, never>>(ids: S, body?: Schema<B>): Schema<Fields<S> & Omit<B, 'version' | 'operationId'>> {
  const idSchema = object(ids)
  const shape = body?.describe()
  const bodyFields = shape?.type === 'object' ? Object.fromEntries(Object.entries(shape.fields).filter(([key]) => key !== 'version' && key !== 'operationId')) : {}
  const needsOperationId = shape?.type === 'object' && 'operationId' in shape.fields
  return {
    describe: () => ({ type: 'object', exact: true, fields: { ...(idSchema.describe() as Extract<WireShape, { type: 'object' }>).fields, ...bodyFields } }),
    parse(value, path = '$') {
      const source = record().parse(value, path)
      const own = (key: string) => Object.hasOwn(ids, key)
      const parsedIds = idSchema.parse(Object.fromEntries(Object.entries(source).filter(([key]) => own(key))), path)
      const rest = Object.fromEntries(Object.entries(source).filter(([key]) => !own(key)))
      if ('version' in rest || 'operationId' in rest) throw new TypeError(`Invalid wire value at ${path}.${'version' in rest ? 'version' : 'operationId'}`)
      if (!body) { none.parse(rest, path); return parsedIds as Fields<S> & Omit<B, 'version' | 'operationId'> }
      const { version: _version, operationId: _operationId, ...parsed } = body.parse({ ...rest, version: 1, ...(needsOperationId ? { operationId: '-' } : {}) }, path) as B & { version?: unknown; operationId?: unknown }
      return { ...parsedIds, ...parsed } as Fields<S> & Omit<B, 'version' | 'operationId'>
    },
  }
}

const changes = (input: { name?: string | undefined; description?: string | undefined; settings?: Changes['settings'] | undefined }): Changes => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined ? { description: input.description } : {}),
  ...(input.settings !== undefined ? { settings: input.settings } : {}),
})
const recorded = <T extends object>(operationId: string, result: T): T & { operationId: string } => ({ operationId, ...result })
const settingField = union(literal('adapterId'), literal('modelId'), literal('effort'), literal('options'))
const identityTarget = { agentId: id, file: identityFileName }
/** Runs a plugin server call; its refusal keeps the code, such as `plugins-unavailable`, at the start of the message. */
async function viaPlugins<T>(host: AdministrationToolHost, call: (client: PluginControlClient) => Promise<T>): Promise<T> {
  try { return await call(new PluginControlClient(host.plugins)) }
  catch (error) { throw error instanceof PluginRouteError ? new Error(`${error.code}: ${error.message}`) : error }
}

/** Every administration operation, by name. Add one here for each new setting or action the interface offers. */
export const adminOperations: Readonly<Record<string, Operation<any>>> = {
  'directory.get': operation({
    area: 'directory', kind: 'read', input: none,
    description: 'Read all workspaces, kips, memberships and groups with their appearances. Start here to find IDs.',
    run: ({ host, caller }) => readDirectory(host.db, caller),
  }),
  'organizations.get': operation({
    area: 'organizations', kind: 'read', input: fields({ organizationId: id }),
    description: 'Read one workspace with its kip memberships and groups.',
    async run({ host, caller, args }) {
      const directory = await readDirectory(host.db, caller)
      const organization = directory.organizations.find(item => item.id === args.organizationId)
      if (!organization) throw new Error('Organization not found')
      return { cursor: directory.cursor, organization, memberships: directory.memberships.filter(item => item.organizationId === args.organizationId), groups: directory.groups.filter(item => item.organizationId === args.organizationId) }
    },
  }),
  'organizations.create': operation({
    area: 'organizations', kind: 'write', receipt: true, input: fields({}, organizationCreate),
    description: 'Create a workspace with an optional description and default execution settings. The owner becomes a member.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await createOrganization(host.db, host.home, caller, operationId, { name: args.name, ...changes(args) })),
  }),
  'organizations.update': operation({
    area: 'organizations', kind: 'write', receipt: true, input: fields({ organizationId: id }, organizationUpdate),
    description: 'Change the name, description or default execution settings of a workspace. Omitted fields are unchanged.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await updateOrganization(host.db, caller, args.organizationId, operationId, changes(args))),
  }),
  'organizations.instructions_get': operation({
    area: 'organizations', kind: 'read', input: fields({ organizationId: id }),
    description: 'Read the instructions every kip follows in a workspace.',
    run: async ({ host, caller, args }) => ({ organizationId: args.organizationId, content: await readOrganizationInstructions(host.db, host.home, caller, args.organizationId) }),
  }),
  'organizations.instructions_set': operation({
    area: 'organizations', kind: 'write', receipt: true, input: fields({ organizationId: id }, organizationInstructionsWrite), maxBytes: 8 * MAX_ORGANIZATION_INSTRUCTIONS_BYTES,
    description: 'Replace the instructions of a workspace. The next execution there reads the saved text.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await writeOrganizationInstructions(host.db, host.home, caller, args.organizationId, args.content, operationId)),
  }),
  'organizations.delete': operation({
    area: 'organizations', kind: 'approval', input: fields({ organizationId: id }),
    description: 'Ask the owner to approve permanently deleting a workspace with its chats and shared resources. Kips stay.',
    run: ({ host, caller, callId, args }) => requestAdminApproval(host.db, caller, callId, 'organization.delete', args.organizationId),
  }),
  'agents.get': operation({
    area: 'agents', kind: 'read', input: fields({ agentId: id }),
    description: 'Read one kip with its workspace memberships.',
    async run({ host, caller, args }) {
      const directory = await readDirectory(host.db, caller)
      const agent = directory.agents.find(item => item.id === args.agentId)
      if (!agent) throw new Error('Agent not found')
      return { cursor: directory.cursor, agent, memberships: directory.memberships.filter(item => item.agentId === args.agentId) }
    },
  }),
  'agents.create': operation({
    area: 'agents', kind: 'write', receipt: true, input: fields({}, agentCreate),
    description: 'Create a kip with an optional description and execution settings. With organizationId, also add it to that workspace. Then write its identity files.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await createAgent(host.db, host.home, caller, operationId, { name: args.name, ...changes(args), ...(args.organizationId !== undefined ? { organizationId: args.organizationId } : {}) })),
  }),
  'agents.update': operation({
    area: 'agents', kind: 'write', receipt: true, input: fields({ agentId: id }, agentUpdate),
    description: 'Change the name, description or execution settings of a kip. Omitted fields are unchanged.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await updateAgent(host.db, caller, args.agentId, operationId, changes(args))),
  }),
  'agents.archive': operation({
    area: 'agents', kind: 'approval', input: fields({ agentId: id }),
    description: 'Ask the owner to approve archiving a kip. Its work stops; chats, memory and files stay, and it can be restored.',
    run: ({ host, caller, callId, args }) => requestAdminApproval(host.db, caller, callId, 'agent.archive', args.agentId),
  }),
  'agents.delete': operation({
    area: 'agents', kind: 'approval', input: fields({ agentId: id, copyFilesToOrganizations: optional(boolean()) }),
    description: 'Ask the owner to approve permanently deleting an archived kip. copyFilesToOrganizations first copies its files shown in workspace chats into those workspaces.',
    run: ({ host, caller, callId, args }) => requestAdminApproval(host.db, caller, callId, 'agent.delete', args.agentId, args.copyFilesToOrganizations === true),
  }),
  'agents.restore': operation({
    area: 'agents', kind: 'write', receipt: true, input: fields({ agentId: id }),
    description: 'Restore an archived kip. It takes new work again; work stopped when it was archived stays stopped.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await restoreAgent(host.db, host.jobs, caller, args.agentId, operationId)),
  }),
  'identity.get': operation({
    area: 'identity', kind: 'read', input: fields(identityTarget),
    description: 'Read one identity file of a kip with its sha256. Pass that sha256 as expectedSha256 when you change the file.',
    run: async ({ host, caller, args }) => ({ version: 1, agentId: args.agentId, ...await readIdentityFile(host.db, host.home, caller, args.agentId, args.file as IdentityFileName) }),
  }),
  'identity.set': operation({
    area: 'identity', kind: 'write', input: fields(identityTarget, identityWrite), maxBytes: 8 * MAX_IDENTITY_BYTES,
    description: 'Replace one identity file of a kip. expectedSha256 is the hash you read; if the file changed since, read it again. The previous content is kept as a backup.',
    run: async ({ host, caller, args }) => ({ version: 1, agentId: args.agentId, ...await writeIdentityFile(host.db, host.home, caller, args.agentId, args.file as IdentityFileName, args.content, args.expectedSha256) }),
  }),
  'identity.backups': operation({
    area: 'identity', kind: 'read', input: fields(identityTarget),
    description: 'List the kept backups of one identity file of a kip, newest first.',
    run: async ({ host, caller, args }) => ({ version: 1, agentId: args.agentId, file: args.file, backups: await listIdentityBackups(host.db, host.home, caller, args.agentId, args.file as IdentityFileName) }),
  }),
  'identity.backup_get': operation({
    area: 'identity', kind: 'read', input: fields({ ...identityTarget, backupId: id }),
    description: 'Read one backup of an identity file.',
    run: async ({ host, caller, args }) => ({ version: 1, agentId: args.agentId, ...await readIdentityBackup(host.db, host.home, caller, args.agentId, args.file as IdentityFileName, args.backupId) }),
  }),
  'identity.restore': operation({
    area: 'identity', kind: 'write', input: fields({ ...identityTarget, backupId: id }, identityRestore),
    description: 'Restore a backup of an identity file. expectedSha256 is the hash of the current file.',
    run: async ({ host, caller, args }) => ({ version: 1, agentId: args.agentId, ...await restoreIdentityBackup(host.db, host.home, caller, args.agentId, args.file as IdentityFileName, args.backupId, args.expectedSha256) }),
  }),
  'memberships.add': operation({
    area: 'memberships', kind: 'write', receipt: true, input: fields({ organizationId: id }, membershipAdd),
    description: 'Add a kip to a workspace and return the membership.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await addMembership(host.db, caller, operationId, args.organizationId, args.agentId)),
  }),
  'memberships.remove': operation({
    area: 'memberships', kind: 'write', receipt: true, input: fields({ membershipId: id }),
    description: "Remove a kip from a workspace. The kip's chat there stays readable and work already accepted still finishes.",
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await removeMembership(host.db, caller, operationId, args.membershipId)),
  }),
  'groups.create': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ organizationId: id }, groupCreate),
    description: 'Create an empty sidebar group after the other groups of a workspace.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await createGroup(host.db, caller, operationId, args.organizationId, args.name)),
  }),
  'groups.rename': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ groupId: id }, groupRename),
    description: 'Rename a sidebar group of a workspace.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await renameGroup(host.db, caller, operationId, args.groupId, args.name)),
  }),
  'groups.delete': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ groupId: id }),
    description: 'Delete a group and its appearances. Kips and memberships are unchanged.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await deleteGroup(host.db, caller, operationId, args.groupId)),
  }),
  'groups.reorder': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ organizationId: id }, groupOrder),
    description: 'Order the groups of a workspace. List every current group ID in the new order.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await reorderGroups(host.db, caller, operationId, args.organizationId, args.groupIds)),
  }),
  'appearances.add': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ groupId: id }, appearanceAdd),
    description: "Show a membership of the group's workspace at the end of a group.",
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await addAppearance(host.db, caller, operationId, args.groupId, args.membershipId)),
  }),
  'appearances.remove': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ groupId: id, membershipId: id }),
    description: 'Take a membership out of a group. The membership stays.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await removeAppearance(host.db, caller, operationId, args.groupId, args.membershipId)),
  }),
  'appearances.reorder': operation({
    area: 'groups', kind: 'write', receipt: true, input: fields({ groupId: id }, appearanceOrder),
    description: 'Order the appearances of a group. List every membership ID in the group in the new order.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, await reorderAppearances(host.db, caller, operationId, args.groupId, args.membershipIds)),
  }),
  'settings.list': operation({
    area: 'settings', kind: 'read', input: none,
    description: 'Read the saved execution settings of kips and workspaces.',
    run: ({ host, caller }) => readSettings(host.db, caller),
  }),
  'settings.effective': operation({
    area: 'settings', kind: 'read', input: fields({ agentId: id, organizationId: optional(id) }),
    description: 'Read the settings a kip would run with in a workspace, or in the installation when organizationId is omitted, with the source of each value and whether they can run.',
    run: ({ host, caller, args }) => effectiveSettings(host.db, host.home, caller, args.agentId, args.organizationId ?? null, host.catalog()),
  }),
  'settings.set': operation({
    area: 'settings', kind: 'write', receipt: true,
    input: fields({ target: settingsTarget, id, adapterId: optional(nonempty()), modelId: optional(nonempty()), effort: optional(nonempty()), options: optional(record()) }),
    description: 'Set execution settings of a kip or a workspace. Only the given fields change. Read adapters.list for valid adapters, models and efforts.',
    async run({ host, caller, operationId, args }) {
      const { target, id: targetId, ...values } = args
      const patch = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([field, value]) => [field, { set: value }])) as Patch
      if (!Object.keys(patch).length) throw new TypeError('Invalid wire value at $: no setting given')
      return recorded(operationId, await changeSettings(host.db, caller, operationId, target, targetId, patch))
    },
  }),
  'settings.clear': operation({
    area: 'settings', kind: 'write', receipt: true, input: fields({ target: settingsTarget, id, fields: array(settingField) }),
    description: 'Clear saved execution settings of a kip or a workspace. A cleared kip field inherits the workspace default; a field neither sets comes from the first configured adapter and its default model.',
    async run({ host, caller, operationId, args }) {
      if (!args.fields.length || new Set(args.fields).size !== args.fields.length) throw new TypeError('Invalid wire value at $.fields')
      return recorded(operationId, await changeSettings(host.db, caller, operationId, args.target, args.id, Object.fromEntries(args.fields.map(field => [field, { clear: true }])) as Patch))
    },
  }),
  'adapters.list': operation({
    area: 'adapters', kind: 'read', input: none,
    description: 'List the execution adapters with their availability, models, efforts and capabilities.',
    run: ({ host, caller }) => readAdapters(host.db, caller),
  }),
  'adapters.refresh': operation({
    area: 'adapters', kind: 'write', input: none,
    description: 'Probe the execution adapters again and return the updated list.',
    async run({ host, caller }) {
      await requireSettingsOwner(host.db, caller)
      await host.refreshAdapters()
      return readAdapters(host.db, caller)
    },
  }),
  'permissions.get': operation({
    area: 'permissions', kind: 'read', input: none,
    description: 'Read the permission mode every kip runs with: supervised (asks before commands and file changes), acceptEdits (approves edits, asks before other actions), auto (the default: supported providers approve routine actions, others still ask) or fullAccess (commands and edits without prompts). alwaysAllowed lists the actions the person chose to always allow from approval cards; they apply to every kip.',
    run: ({ host, caller }) => readPermissions(host.db, caller),
  }),
  'permissions.set': operation({
    area: 'permissions', kind: 'write', input: fields({}, permissionSettingsWrite),
    description: "Change the permission mode of every kip, remove always-allowed actions by ID, or both; each kip's next turn uses the result. supervised, acceptEdits, auto and removals are saved at once. fullAccess asks the owner with an approval card and ends the turn; it is saved only when the owner approves. Only the person can add always-allowed actions, from an approval card.",
    async run({ host, caller, callId, args }) {
      if (args.mode !== 'fullAccess') return writePermissions(host.db, caller, { version: 1, ...(args.mode ? { mode: args.mode } : {}), ...(args.removeAlwaysAllowed ? { removeAlwaysAllowed: args.removeAlwaysAllowed } : {}) })
      if (args.removeAlwaysAllowed) await writePermissions(host.db, caller, { version: 1, removeAlwaysAllowed: args.removeAlwaysAllowed })
      return requestPermissionsApproval(host.db, caller, callId, args.mode)
    },
  }),
  'learning.get': operation({
    area: 'learning', kind: 'read', input: none,
    description: 'Read the memory settings: the switch and default sleep time of the installation, the switch and sleep time of each kip, the nightly model (null runs the nightly memory steps with the admin kip\'s model), coreMemoryCount (memories loaded on every turn) and searchMemoryCount and searchChunkCount (memories and thread chunks a turn\'s memory search adds). A kip has memory while both switches are on; available tells whether meaning search has an embedding provider.',
    run: ({ host, caller }) => host.learning.get(caller),
  }),
  'learning.set': operation({
    area: 'learning', kind: 'write', input: fields({}, learningUpdate),
    description: 'Change the installation\'s memory settings; only the given fields change. enabled turns memory on or off; sleepTime is the default time of the nightly run ("HH:MM", local time); nightlyModel is { adapterId, modelId, effort? } from adapters.list for the nightly run, or null for the admin kip\'s model; coreMemoryCount (0-200, default 60) is how many core memories every turn loads; searchMemoryCount (0-50, default 10) and searchChunkCount (0-30, default 6) are how many memories and thread chunks a turn\'s memory search adds.',
    run: ({ host, caller, args }) => host.learning.setInstallation(caller, args, host.catalog()),
  }),
  'learning.agent_set': operation({
    area: 'learning', kind: 'write', input: fields({ agentId: id }, agentLearningUpdate),
    description: "Turn memory on or off for one kip, or set its own sleep time (\"HH:MM\"); a null sleepTime uses the installation default.",
    run: ({ host, caller, args }) => { const { agentId, ...update } = args; return host.learning.setAgent(caller, agentId, update) },
  }),
  'memory.memories_list': operation({
    area: 'memory', kind: 'read', input: fields({ ended: optional(boolean()), limit: optional(boundedInteger(1, 200)), cursor: optional(id) }),
    description: 'List memories of the installation and every workspace, newest first, each with its type, subject, statement, details, confirmed (the person said it) or inferred, core (loaded on every turn), organizationId (null for an installation memory), valid dates and source messages. ended true also lists replaced and retired memories. limit is 1-200 (default 50); pass nextCursor as cursor for the next page.',
    run: async ({ host, caller, args }) => ({ version: 1, ...await listMemories(host.db, caller, args) }),
  }),
  'memory.memory_get': operation({
    area: 'memory', kind: 'read', input: fields({ memoryId: id }),
    description: 'Read one memory with its source messages.',
    run: async ({ host, caller, args }) => ({ version: 1, memory: await readMemory(host.db, caller, args.memoryId) }),
  }),
  'memory.memory_update': operation({
    area: 'memory', kind: 'write', receipt: true, input: fields({ memoryId: id }, memoryUpdate),
    description: 'Correct a current memory when the person asks: type, subject, statement or details (a JSON object); omitted fields are unchanged. The memory becomes confirmed. A replaced or retired memory cannot be edited; edit its replacement. A repeat with the same operationId changes nothing and returns the memory as it is now.',
    run: async ({ host, caller, operationId, args }) => { const { memoryId, ...edit } = args; return recorded(operationId, { version: 1, ...await editMemory(host.db, caller, memoryId, edit, operationId) }) },
  }),
  'memory.memory_delete': operation({
    area: 'memory', kind: 'write', receipt: true, input: fields({ memoryId: id }),
    description: 'Delete a memory the person wants forgotten, with its sources and embedding. The messages it was learned from stay. deleted is false when it was already gone; a repeat with the same operationId returns the first outcome.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, { version: 1, ...await deleteMemory(host.db, caller, args.memoryId, operationId) }),
  }),
  'memory.lessons_list': operation({
    area: 'memory', kind: 'read', input: fields({ agentId: optional(id), ended: optional(boolean()), limit: optional(boundedInteger(1, 200)), cursor: optional(id) }),
    description: 'List lessons, of one kip with agentId or of every kip, newest first, each with its statement, agentId, organizationId (the workspace it was learned in, or null), confirmations (nights it came up), lastConfirmedNight, valid dates and source messages. A kip\'s 10 most confirmed lessons are the Learned section of its identity.md. ended true also lists merged and retired lessons. limit is 1-200 (default 50); pass nextCursor as cursor for the next page.',
    run: async ({ host, caller, args }) => ({ version: 1, ...await listLessons(host.db, caller, args) }),
  }),
  'memory.lesson_get': operation({
    area: 'memory', kind: 'read', input: fields({ lessonId: id }),
    description: 'Read one lesson with its source messages.',
    run: async ({ host, caller, args }) => ({ version: 1, lesson: await readLesson(host.db, caller, args.lessonId) }),
  }),
  'memory.lesson_update': operation({
    area: 'memory', kind: 'write', receipt: true, input: fields({ lessonId: id }, lessonUpdate),
    description: 'Reword a current lesson when the person asks; its confirmations stay, and the kip\'s Learned section is written again. A merged or retired lesson cannot be edited. A repeat with the same operationId changes nothing and returns the lesson as it is now.',
    run: async ({ host, caller, operationId, args }) => { const { lessonId, statement } = args; return recorded(operationId, { version: 1, ...await editLesson(host.db, host.home.identity, caller, lessonId, statement, operationId) }) },
  }),
  'memory.lesson_delete': operation({
    area: 'memory', kind: 'write', receipt: true, input: fields({ lessonId: id }),
    description: 'Delete a lesson the person wants forgotten, with its sources and embedding; the kip\'s Learned section is written again. The messages it was learned from stay. deleted is false when it was already gone; a repeat with the same operationId returns the first outcome.',
    run: async ({ host, caller, operationId, args }) => recorded(operationId, { version: 1, ...await deleteLesson(host.db, host.home.identity, caller, args.lessonId, operationId) }),
  }),
  'interface.get': operation({
    area: 'interface', kind: 'read', input: none,
    description: 'Read the colour palette, theme and notification choices every open Kipster window applies. null means the app default: desktop notifications, needs-you, failure and reply alerts and the badge on; in-app banners off.',
    run: ({ host, caller }) => readInterfacePreferences(host.db, caller),
  }),
  'interface.set': operation({
    area: 'interface', kind: 'write', input: fields({}, interfacePreferencesWrite),
    description: 'Change the colour palette, the theme (light, dark, or system to follow the computer), whether desktop notifications are on, which kinds alert (notifyNeeds: questions and approvals, notifyFailures, notifyReplies), inAppBanners for chats not on screen, or dockBadge, the count of items that need the person. Open windows apply it at once. Turning notifications on may still need the person to allow them once in the operating system.',
    run: ({ host, caller, args }) => writeInterfacePreferences(host.db, caller, { version: 1, ...args }),
  }),
  'updates.get': operation({
    area: 'updates', kind: 'read', input: none,
    description: 'Read the update channel and mode, the running and available Core versions, any pin, the install state and the kept backups. With a plugin server, plugins has the running and available Kipster Plugins versions and their install state.',
    run: ({ host, caller }) => host.updates.get(caller),
  }),
  'updates.settings_set': operation({
    area: 'updates', kind: 'write', receipt: true, input: fields({ channel: optional(updateChannel), mode: optional(updateMode) }),
    description: 'Change the update channel (stable, or next for early builds) or mode (automatic installs Core at night and Kipster Plugins right away, notify only tells). Omitted values are unchanged.',
    async run({ host, caller, operationId, args }) {
      const current = await host.updates.settings(caller)
      const channel = args.channel ?? current.channel, mode = args.mode ?? current.mode
      return recorded(operationId, await host.updates.setSettings(caller, { version: 1, operationId, channel, mode }))
    },
  }),
  'updates.check': operation({
    area: 'updates', kind: 'write', input: none,
    description: 'Check the update channel for a newer Core and Kipster Plugins now and return the update status.',
    run: ({ host, caller }) => host.updates.check(caller),
  }),
  'updates.install': operation({
    area: 'updates', kind: 'approval', input: fields({}, updateInstall),
    description: 'Ask the owner to approve installing a Core version from updates.get. pin (default true) stays on it until unpinned. To go back to an older version, give a backupId taken on it and confirmDataLoss true. Kipster restarts to install.',
    run({ host, caller, callId, args }) {
      host.updates.checkInstall(args)
      return requestInstallApproval(host.db, caller, callId, args, host.updates.coreVersion)
    },
  }),
  'updates.plugins_install': operation({
    area: 'updates', kind: 'approval', input: fields({}, updatePluginsInstall),
    description: 'Ask the owner to approve installing the Kipster Plugins version that updates.get shows in plugins.available. Only the plugin server restarts; Kipster and running work keep going.',
    run({ host, caller, callId, args }) {
      host.updates.checkPluginsInstall(args)
      return requestPluginsInstallApproval(host.db, caller, callId, args.target, host.updates.pluginsVersion)
    },
  }),
  'updates.unpin': operation({
    area: 'updates', kind: 'write', receipt: true, input: none,
    description: 'Stop staying on a pinned Core version and follow the update channel again.',
    run: async ({ host, caller, operationId }) => recorded(operationId, await host.updates.unpin(caller, { version: 1, operationId })),
  }),
  'plugins.list': operation({
    area: 'plugins', kind: 'read', input: none,
    description: 'List the plugins: each service with its id, whether it is available, whether signing in needs an address (addressPrompt asks for it) and how many accounts are signed in.',
    run: ({ host }) => viaPlugins(host, client => client.listPlugins()),
  }),
  'plugins.get': operation({
    area: 'plugins', kind: 'read', input: fields({ pluginId: id }),
    description: 'Read one plugin with its signed-in accounts. An account with status reconnect-needed needs the person to sign in again.',
    run: ({ host, args }) => viaPlugins(host, client => client.getPlugin(args.pluginId)),
  }),
  'plugins.sign_in': operation({
    area: 'plugins', kind: 'write', input: fields({ pluginId: id, address: optional(boundedString(1, 2000)) }),
    description: 'Start signing the person in to a plugin; address answers the plugin\'s addressPrompt when it needsAddress. A redirect result has an authorizationUrl: give it to the person to open in their browser on this computer, then check plugins.sign_in_status with its id until it completes or fails. needs-client-metadata-document means this installation cannot sign in to that service yet.',
    run: ({ host, args }) => viaPlugins(host, client => client.startSignIn(args.pluginId, { address: args.address })),
  }),
  'plugins.sign_in_status': operation({
    area: 'plugins', kind: 'read', input: fields({ signInId: id }),
    description: 'Read a sign-in started with plugins.sign_in: pending while the person signs in, completed with the account (duplicate when it reconnected a known account), or failed with a code such as denied or expired.',
    run: ({ host, args }) => viaPlugins(host, client => client.signInStatus(args.signInId)),
  }),
  'plugins.accounts_list': operation({
    area: 'plugins', kind: 'read', input: fields({ pluginId: optional(id) }),
    description: 'List the signed-in accounts of every plugin, or of one plugin with pluginId, with their names (label), status and which one is the default.',
    run: ({ host, args }) => viaPlugins(host, client => client.listAccounts(args.pluginId)),
  }),
  'plugins.account_rename': operation({
    area: 'plugins', kind: 'write', input: fields({ accountId: id }, pluginAccountRename),
    description: 'Rename a signed-in account, such as Work or Personal: 1 to 64 characters, unique within its plugin ignoring case.',
    run: ({ host, args }) => viaPlugins(host, client => client.renameAccount(args.accountId, args.label)),
  }),
  'plugins.default_set': operation({
    area: 'plugins', kind: 'write', input: fields({ pluginId: id, accountId: id }),
    description: 'Make an account the default of its plugin, the one kips use when they do not name an account.',
    run: ({ host, args }) => viaPlugins(host, client => client.setDefaultAccount(args.pluginId, args.accountId)),
  }),
  'plugins.default_clear': operation({
    area: 'plugins', kind: 'write', input: fields({ pluginId: id }),
    description: 'Clear the default account of a plugin. Its accounts stay signed in.',
    run: ({ host, args }) => viaPlugins(host, client => client.clearDefaultAccount(args.pluginId)),
  }),
  'plugins.account_remove': operation({
    area: 'plugins', kind: 'write', input: fields({ accountId: id }),
    description: 'Sign out and remove an account the person no longer wants kips to use. revoked tells whether the service confirmed revoking its access; the account is removed either way.',
    run: ({ host, args }) => viaPlugins(host, client => client.removeAccount(args.accountId)),
  }),
  'routines.settings_get': operation({
    area: 'routines', kind: 'read', input: none,
    description: 'Read dailyRunLimit, the most routine runs one kip starts a day across its routines. Runs past it are skipped and recorded.',
    run: ({ host, caller }) => readRoutineSettings(host.db, caller),
  }),
  'routines.settings_set': operation({
    area: 'routines', kind: 'write', input: fields({}, routineSettingsWrite),
    description: 'Set dailyRunLimit, the most routine runs one kip starts a day across its routines: 1 to 1000. The default is 50.',
    run: ({ host, caller, args }) => writeRoutineSettings(host.db, caller, { version: 1, ...args }),
  }),
  'operations.get': operation({
    area: 'operations', kind: 'read', input: fields({ operationId: boundedString(1, 200) }),
    description: 'Read the state and result of a change by the operationId an earlier call returned.',
    run: ({ host, caller, args }) => readOperation(host.db, caller, args.operationId),
  }),
}

/** A protocol shape as JSON Schema, for the model reading an operation's arguments. */
export function jsonSchema(shape: WireShape): Record<string, unknown> {
  switch (shape.type) {
    case 'string': return { type: 'string', ...(shape.min !== undefined ? { minLength: shape.min } : {}), ...(shape.max !== undefined ? { maxLength: shape.max } : {}), ...(shape.format === 'clock-time' ? { pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' } : shape.format === 'utc-timestamp' ? { format: 'date-time' } : {}) }
    case 'integer': return { type: 'integer', minimum: shape.min, ...(shape.max !== undefined ? { maximum: shape.max } : {}) }
    case 'boolean': return { type: 'boolean' }
    case 'record': return { type: 'object' }
    case 'unknown': return {}
    case 'literal': return { const: shape.value }
    case 'array': return { type: 'array', items: jsonSchema(shape.items), ...(shape.min !== undefined ? { minItems: shape.min } : {}), ...(shape.max !== undefined ? { maxItems: shape.max } : {}) }
    case 'nullable': return { anyOf: [jsonSchema(shape.of), { type: 'null' }] }
    case 'optional': return jsonSchema(shape.of)
    case 'object': return {
      type: 'object', properties: Object.fromEntries(Object.entries(shape.fields).map(([key, field]) => [key, jsonSchema(field)])),
      required: Object.entries(shape.fields).filter(([, field]) => field.type !== 'optional').map(([key]) => key), additionalProperties: !shape.exact,
    }
    case 'union': return shape.of.every(choice => choice.type === 'literal') ? { enum: shape.of.map(choice => (choice as { value: unknown }).value) } : { anyOf: shape.of.map(jsonSchema) }
  }
}

const describeOperation = (name: string, definition: Operation<unknown>) => ({
  operation: name, area: definition.area, kind: definition.kind, description: definition.description,
  operationId: definition.receipt ? 'required' : 'not used', arguments: jsonSchema(definition.input.describe()),
})
const operationsRequest = object({ area: optional(nonempty()), operation: optional(nonempty()) })
const callRequest = object({ operation: nonempty(), arguments: optional(record()), operationId: optional(boundedString(1, 200)) })

/**
 * Runs one administration tool call of the admin agent: `list_admin_operations` lists the catalog or describes one operation,
 * and `run_admin_operation` runs one. Operations call the same services as the HTTP routes, authorized for the calling attempt.
 * A write with a receipt uses the explicit operation ID, stable across execution retries; reusing it returns its receipt.
 */
export async function administrationTool(host: AdministrationToolHost, caller: AgentCaller, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (typeof callId !== 'string' || !callId || callId.length > 160) throw new Error('Invalid administration call ID')
  await authorizeAdministration(host.db, caller)
  if (name === 'list_admin_operations') {
    const request = operationsRequest.parse(args)
    if (request.operation !== undefined) {
      const definition = adminOperations[request.operation]
      if (!definition || !Object.hasOwn(adminOperations, request.operation)) throw new Error(`Unknown administration operation ${request.operation}; list the operations without arguments`)
      return describeOperation(request.operation, definition)
    }
    if (request.area !== undefined && !Object.hasOwn(areas, request.area)) throw new Error(`Unknown administration area ${request.area}`)
    return {
      areas: (Object.keys(areas) as Area[]).filter(area => request.area === undefined || area === request.area).map(area => ({
        area, description: areas[area],
        operations: Object.entries(adminOperations).filter(([, definition]) => definition.area === area).map(([operation, definition]) => ({ operation, kind: definition.kind, description: definition.description })),
      })),
      next: 'Call list_admin_operations with an operation name to read its arguments, then run it with run_admin_operation.',
    }
  }
  if (name !== 'run_admin_operation') throw new Error('Unsupported administration tool')
  const request = callRequest.parse(args)
  const definition = Object.hasOwn(adminOperations, request.operation) ? adminOperations[request.operation] : undefined
  if (!definition) throw new Error(`Unknown administration operation ${request.operation}; list the operations with list_admin_operations`)
  const values = request.arguments ?? {}
  if (Buffer.byteLength(JSON.stringify(values)) > (definition.maxBytes ?? 64 * 1024)) throw new TypeError(`Invalid ${request.operation} arguments: too large`)
  if (definition.receipt && request.operationId === undefined) throw new TypeError(`${request.operation} needs an operationId`)
  const operationId = definition.receipt ? request.operationId! : `${caller.attemptId}:${callId}`
  return definition.run({ host, caller, callId, operationId, args: definition.input.parse(values, '$.arguments') })
}
