import { ImageInputs } from './image-inputs.js'
import { nativeInteractions } from './native-interactions.js'
import { codexPermissions } from './permissions.js'
import { launchConfig, conversationLaunch, maintenanceLaunch, isolationSettings, privateDirectory, errorCode, probe, type LaunchConfig } from './launch.js'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import type { AdapterHost, AdapterReadiness, AdapterExecutionContext as ExecutionContext, DurableReconcileResult, ExecutionEvent, ExecutionHandle, MaintenanceCapableAdapter, MaintenanceExecutionContext, RecoveryReference } from '@kipster/core/adapter'

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {} }
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
/** Used when neither the agent nor its organization chooses a model, if Codex lists it. */
const DEFAULT_MODEL = { id: 'gpt-6-luna', effort: 'high' }
class Rpc {
  private sequence = 0
  private exited = false
  private stderr = ''
  private pending = new Map<number, { resolve(value: ObjectValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  readonly notifications: ObjectValue[] = []
  readonly listeners = new Set<(value: ObjectValue) => void>()
  readonly closed: Promise<void>
  private closeResolve!: () => void
  /** Resolves when the process has exited or never started. */
  readonly exit: Promise<void>
  private terminated = false
  constructor(readonly process: ChildProcessWithoutNullStreams) {
    this.closed = new Promise(resolve => { this.closeResolve = resolve })
    this.exit = new Promise(resolve => {
      process.once('exit', () => { this.terminated = true; resolve() })
      process.once('error', () => { if (process.pid === undefined) { this.terminated = true; resolve() } })
    })
    const lines = createInterface({ input: process.stdout })
    lines.on('line', line => {
      let value: ObjectValue
      try { value = object(JSON.parse(line)) } catch { return }
      const id = value.id
      if (value.method === undefined && typeof id === 'number' && this.pending.has(id)) {
        const pending = this.pending.get(id)!
        this.pending.delete(id)
        clearTimeout(pending.timer)
        if (value.error) pending.reject(new Error(JSON.stringify(value.error)))
        else pending.resolve(object(value.result))
      } else {
        if (!this.listeners.size) this.notifications.push(value)
        for (const listener of this.listeners) listener(value)
      }
    })
    process.stderr.setEncoding('utf8')
    process.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096) })
    const stderrEnded = new Promise<void>(resolve => { process.stderr.once('end', resolve); process.stderr.once('close', resolve) })
    const exited = (error?: unknown) => {
      if (this.exited) return
      this.exited = true
      void Promise.race([stderrEnded, new Promise<void>(resolve => setTimeout(resolve, 250))]).then(() => {
        const failure = new Error(`Codex App Server exited${this.diagnostic(error)}`)
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure) }
        this.pending.clear()
        this.closeResolve()
        for (const listener of this.listeners) listener({ method: 'process/exited' })
      })
    }
    process.once('exit', () => exited())
    process.once('error', exited)
    process.stdin.on('error', exited)
  }
  /** A bounded tail of Codex stderr, for example a rejected configuration key. */
  private diagnostic(error: unknown): string {
    const lines = this.stderr.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(line => line.trim()).filter(Boolean)
    const detail = lines.slice(-3).join(' | ') || (error instanceof Error ? error.message : '')
    return detail ? `: ${detail.slice(-500)}` : ''
  }
  send(value: ObjectValue): Promise<void> {
    if (this.exited || this.process.stdin.destroyed) return Promise.reject(new Error('Codex App Server IPC is closed'))
    return new Promise((resolve, reject) => {
      try { this.process.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()) }
      catch (error) { reject(error) }
    })
  }
  request(method: string, params: ObjectValue, timeoutMs = 30000): Promise<ObjectValue> {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void this.send({ id, method, params }).catch(error => {
        if (this.pending.delete(id)) { clearTimeout(timer); reject(error) }
      })
    })
  }
  respond(id: number | string, result: ObjectValue): Promise<void> { return this.send({ id, result }) }
  /** True once the process has exited and no process remains in its group. A group ID is not reused while the group exists. */
  get ended(): boolean { return this.terminated && (this.process.pid === undefined || probe(-this.process.pid) === 'absent') }
  /** Terminates the process group. Returns whether the whole group is gone. */
  async stop(): Promise<boolean> {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (this.ended) break
      try { globalThis.process.kill(-this.process.pid!, signal) } catch { if (!this.terminated) try { this.process.kill(signal) } catch {} }
      const deadline = Date.now() + 2000
      while (!this.ended && Date.now() < deadline) await new Promise<void>(resolve => { setTimeout(resolve, 50); if (!this.terminated) void this.exit.then(resolve) })
    }
    if (this.terminated) await this.closed
    return this.ended
  }
}
/** `disabledMcpServers` names the configured servers a maintenance launch switches off. */
async function appServer(config: LaunchConfig, maintenance = false, disabledMcpServers: readonly string[] = []): Promise<Rpc> {
  const { root, env } = await (maintenance ? maintenanceLaunch(config) : conversationLaunch(config))
  const overrides = maintenance ? [...isolationSettings, ...maintenanceProfile, ...disabledMcpServers.map(name => [`mcp_servers.${name}.enabled`, 'false'] as const)] : conversationSettings
  const child = spawn(config.executable, ['app-server', '--stdio', '--strict-config', ...overrides.flatMap(([key, value]) => ['-c', `${key}=${value}`])], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  return new Rpc(child)
}
/** Kipster owns kip memory, so Codex's own memories stay off in conversations. */
const conversationSettings: readonly (readonly [string, string])[] = [['features.memories', 'false']]
/** Names of MCP servers the effective configuration leaves enabled. Reading configuration starts no server. */
async function enabledMcpServers(rpc: Rpc, cwd?: string): Promise<string[]> {
  const effective = await rpc.request('config/read', { includeLayers: false, ...(cwd ? { cwd } : {}) })
  if (!effective.config || typeof effective.config !== 'object') throw new Error('Codex configuration is unreadable')
  const servers = (effective.config as ObjectValue).mcp_servers
  if (servers === undefined || servers === null) return []
  if (typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Codex MCP server configuration is unreadable')
  return Object.entries(servers).filter(([, value]) => object(value).enabled !== false).map(([name]) => name)
}
/** Fails closed when any configured MCP server stays enabled. */
async function assertMcpServersDisabled(rpc: Rpc, cwd?: string): Promise<void> {
  const enabled = await enabledMcpServers(rpc, cwd)
  if (enabled.length) throw new Error(`Codex isolation check failed: MCP server ${enabled.join(', ')} could not be switched off`)
}
/** Fails closed when Codex offers any MCP tool for the process or thread. */
async function assertNoMcpTools(rpc: Rpc, threadId?: string): Promise<void> {
  let cursor: string | undefined
  do {
    const listing = await rpc.request('mcpServerStatus/list', { ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}), detail: 'toolsAndAuthOnly' })
    if (!Array.isArray(listing.data)) throw new Error('Codex isolation check failed: MCP status is unreadable')
    if (listing.data.some(server => Object.keys(object(object(server).tools)).length)) throw new Error('Codex isolation check failed: MCP tools are available')
    cursor = string(listing.nextCursor)
  } while (cursor)
}
async function initialize(rpc: Rpc): Promise<void> {
  await rpc.request('initialize', { clientInfo: { name: 'kipster', title: 'Kipster', version: '0.0.0' }, capabilities: { experimentalApi: true } })
  await rpc.send({ method: 'initialized', params: {} })
}
/** Maintenance runs without Codex tools; any item beyond messages and reasoning ends the attempt. */
const maintenanceProfile: readonly (readonly [string, string])[] = [
  ...['shell_tool', 'unified_exec', 'image_generation', 'view_image', 'goals', 'sleep_tool', 'skill_search'].map(feature => [`features.${feature}`, 'false'] as const),
  ['web_search', '"disabled"'],
]
const maintenanceItems = new Set(['userMessage', 'agentMessage', 'reasoning'])
const maintenanceInstructions = 'You are a Kipster memory maintenance step. Follow the task in the user message and answer with a single JSON object that matches the output schema. No tools are available.'
const recoveryScope = 'shared-codex-home'
const threadIdPattern = /^[A-Za-z0-9_-]{1,200}$/
/** A start identity that, with the process ID, names one process and does not change when the wall clock is set.
 * Linux: boot ID plus start time in clock ticks since boot. macOS: the start time fixed at fork. Elsewhere: none. */
async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]).catch(() => [])
    const ticks = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return boot?.trim() && ticks && /^\d+$/.test(ticks) ? `${boot.trim()}:${ticks}` : undefined
  }
  if (process.platform !== 'darwin') return undefined
  return new Promise(resolve => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)))
}
function identityPath(config: LaunchConfig, threadId: string): string { return join(config.dataDirectory, 'maintenance', 'processes', `${threadId}.json`) }
/** Deletes the regular files below `directory` whose name `matches`, without following links. A missing directory has none. */
async function regularDirectory(directory: string): Promise<boolean> {
  const entry = await lstat(directory).catch(error => { if (errorCode(error) === 'ENOENT') return null; throw error })
  return !!entry?.isDirectory() && !entry.isSymbolicLink()
}
async function removeFiles(directory: string, matches: (name: string) => boolean): Promise<void> {
  if (!await regularDirectory(directory)) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (errorCode(error) === 'ENOENT') return []; throw error })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await removeFiles(path, matches)
    else if (entry.isFile() && matches(entry.name)) await unlink(path).catch(error => { if (errorCode(error) !== 'ENOENT') throw error })
  }
}
class Queue implements AsyncIterable<ExecutionEvent> {
  private values: ExecutionEvent[] = []
  private wake: (() => void) | undefined
  ended = false
  push(event: ExecutionEvent): void { this.values.push(event); this.wake?.(); this.wake = undefined }
  finish(): void { this.ended = true; this.wake?.(); this.wake = undefined }
  async *[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
interface Owned { images: ImageInputs; rpc: Rpc; queue: Queue; threadId: string | undefined; turnId: string | undefined; ended: boolean; cancelAcknowledged: boolean }
class CodexAdapter implements MaintenanceCapableAdapter {
  readonly id = 'codex-cli'
  readonly version = '0.0.0'
  readonly contractMajor = 1 as const
  readonly recoveryVersions = [1] as const
  readonly recoveryStateScopes = [recoveryScope] as const
  private readonly owned = new Map<string, Owned>()
  private readonly maintenanceProcesses = new Set<Rpc>()
  private readonly readinessProcesses = new Set<Rpc>()
  private readonly readinessProbes = new Set<Promise<AdapterReadiness>>()
  private closing: Promise<void> | undefined
  private closed = false
  private modelCatalog: AdapterReadiness['catalog']['models'] | undefined
  private readonly config: LaunchConfig
  constructor(private readonly host: AdapterHost, config?: Readonly<Record<string, unknown>>) { this.config = launchConfig(config, host.dataDirectory) }
  /** Starts maintenance with every configured MCP server switched off; a short-lived process reads their names first. */
  private async maintenanceServer(processes: Set<Rpc>, cwd?: string): Promise<Rpc> {
    const reader = await appServer(this.config, true)
    processes.add(reader)
    let names: string[]
    try {
      await initialize(reader)
      names = await enabledMcpServers(reader, cwd)
    } finally { await reader.stop(); processes.delete(reader) }
    if (this.closed) throw new Error('Codex adapter is closed')
    const rpc = await appServer(this.config, true, names)
    processes.add(rpc)
    return rpc
  }
  /** Launch and isolation failures are reported as not ready. */
  async readiness(): Promise<AdapterReadiness> {
    const probe = this.probeReadiness()
    this.readinessProbes.add(probe)
    try { return await probe } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : 'Codex readiness failed', catalog: { models: [], supportedOptions: [], capabilities: { text: true, publication: true, cancellation: true, steering: false, nativeResume: true, maintenance: false } } }
    } finally { this.readinessProbes.delete(probe) }
  }
  private async probeReadiness(): Promise<AdapterReadiness> {
    if (this.closed) throw new Error('Codex adapter is closed')
    const rpc = await appServer(this.config)
    this.readinessProcesses.add(rpc)
    try {
      if (this.closed) throw new Error('Codex adapter is closed')
      await initialize(rpc)
      const listing = await rpc.request('model/list', { limit: 100 })
      const data = Array.isArray(listing.data) ? listing.data : Array.isArray(listing.models) ? listing.models : []
      const models = data.map(value => {
        const row = object(value)
        const id = string(row.id) ?? string(row.model)
        const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map(x => string(object(x).reasoningEffort) ?? string(x)).filter((x): x is string => !!x) : undefined
        return id ? { id, ...(efforts?.length ? { efforts } : {}) } : undefined
      }).filter((x): x is { id: string; efforts?: string[] } => !!x)
      const listed = models.find(model => model.id === DEFAULT_MODEL.id)
      const defaultModel = listed ? { id: listed.id, ...(listed.efforts?.includes(DEFAULT_MODEL.effort) ? { effort: DEFAULT_MODEL.effort } : {}) } : undefined
      let maintenance = false
      let maintenanceReason: string | undefined
      let maintenanceRpc: Rpc | undefined
      try {
        maintenanceRpc = await this.maintenanceServer(this.readinessProcesses)
        if (this.closed) throw new Error('Codex adapter is closed')
        await initialize(maintenanceRpc)
        await assertMcpServersDisabled(maintenanceRpc)
        await assertNoMcpTools(maintenanceRpc)
        const catalog = await maintenanceRpc.request('model/list', { limit: 100 })
        const available = Array.isArray(catalog.data) ? catalog.data : Array.isArray(catalog.models) ? catalog.models : []
        maintenance = available.length > 0
        if (!maintenance) maintenanceReason = 'Maintenance model catalog is empty'
      } catch (error) { maintenanceReason = error instanceof Error ? error.message : 'Maintenance unavailable' }
      finally { if (maintenanceRpc) { await maintenanceRpc.stop(); this.readinessProcesses.delete(maintenanceRpc) } }
      const catalog = { models, ...(defaultModel ? { defaultModel } : {}), supportedOptions: [] as string[], capabilities: { text: true as const, publication: true, cancellation: true, steering: false as const, nativeResume: true, maintenance } }
      if (!models.length) return { ready: false, reason: 'Codex returned no models', catalog }
      if (this.closed) throw new Error('Codex adapter is closed')
      this.modelCatalog = models
      return { ready: true, ...(maintenanceReason ? { reason: `Maintenance unavailable: ${maintenanceReason}` } : {}), catalog, recoveryVersions: this.recoveryVersions, recoveryStateScopes: this.recoveryStateScopes }
    } finally { await rpc.stop(); this.readinessProcesses.delete(rpc) }
  }
  async execute(context: ExecutionContext): Promise<ExecutionHandle> {
    if (context.kind === 'maintenance') return this.maintenance(context)
    const model = context.settings?.modelId
    const supported = this.modelCatalog?.find(entry => entry.id === model)
    if (!model || !supported || context.settings?.adapterId !== this.id) throw new Error('Codex model is unavailable')
    if (context.settings?.effort && (!supported.efforts || !supported.efforts.includes(context.settings.effort))) throw new Error('Codex effort is unsupported')
    if (context.settings?.options && Object.keys(context.settings.options).length) throw new Error('Codex options are unsupported')
    if (!context.workingDirectory) throw new Error('Persistent agent working directory is required')
    const tools = context.tools ?? []
    const rpc = await appServer(this.config)
    const queue = new Queue()
    const images = new ImageInputs()
    const owned: Owned = { images, rpc, queue, threadId: undefined, turnId: undefined, ended: false, cancelAcknowledged: false }
    this.owned.set(context.attemptId, owned)
    const clean = async () => { await rpc.stop(); await images.close(); this.owned.delete(context.attemptId) }
    try {
      await initialize(rpc)
      const settings = { model, cwd: context.workingDirectory, ...codexPermissions(context.permissionMode), baseInstructions: context.instructions }
      // A thread reopened after a wait keeps its history and Kipster tools; one that cannot be reopened starts fresh.
      const resume = context.resume?.providerStateScope === 'shared-codex-home' && await this.ownsThread(context.resume.threadId) ? context.resume : undefined
      const reopened = resume ? await rpc.request('thread/resume', { threadId: resume.threadId, ...settings, excludeTurns: true }).catch(() => undefined) : undefined
      const thread = reopened ?? await rpc.request('thread/start', { ...settings, serviceName: 'kipster', dynamicTools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) })
      owned.threadId = string(object(thread.thread).id)
      if (!owned.threadId) throw new Error('Codex thread ID is missing')
      await this.recordThread(owned.threadId)
      queue.push({ kind: 'provider', attemptId: context.attemptId, threadId: owned.threadId, processId: rpc.process.pid!, providerStateScope: 'shared-codex-home', workingDirectory: context.workingDirectory, modelId: model, ...(context.settings?.effort ? { effort: context.settings.effort } : {}) })
      const input = reopened ? [{ type: 'text', text: resume!.prompt }] : [{ type: 'text', text: context.prompt }, ...await images.prepare(context.input)]
      const params: ObjectValue = { threadId: owned.threadId, input, model }
      if (context.settings?.effort) params.effort = context.settings.effort
      const turn = await rpc.request('turn/start', params, 120000)
      owned.turnId = string(object(turn.turn).id)
      if (!owned.turnId) throw new Error('Codex turn ID is missing')
      queue.push({ kind: 'provider', attemptId: context.attemptId, threadId: owned.threadId, turnId: owned.turnId, processId: rpc.process.pid!, providerStateScope: 'shared-codex-home', workingDirectory: context.workingDirectory, modelId: model, ...(context.settings?.effort ? { effort: context.settings.effort } : {}) })
      let requestedInteraction = false
      let repeatedInteraction = false
      let yielding = false
      const texts = new Map<string, string>()
      const finalized = new Set<string>()
      const fileChanges = new Map<string, unknown>()
      const consumedApprovals = new Set<unknown>()
      const onMessage = (message: ObjectValue) => {
        const method = string(message.method)
        const params = object(message.params)
        if (yielding || owned.ended) return
        if (method === 'process/exited') {
          void images.close()
          if (!owned.ended) { queue.push({ kind: 'failed', attemptId: context.attemptId, confirmedEnded: false, message: 'Codex process exited without a terminal turn' }); queue.finish() }
          return
        }
        if ((params.threadId !== undefined && string(params.threadId) !== owned.threadId) || (params.threadId === undefined && message.id === undefined) || (params.turnId !== undefined && string(params.turnId) !== owned.turnId && method !== 'turn/completed')) return
        if (method === 'item/started' || method === 'item/completed') {
          const item = object(params.item)
          if (item.type === 'fileChange' && typeof item.id === 'string' && item.changes) fileChanges.set(item.id, item.changes)
        }
        if (message.id !== undefined && method !== 'item/tool/call') {
          yielding = true
          void (async () => {
            try {
              const changes = fileChanges.get(String(params.itemId))
              const interactions = nativeInteractions(context, method ?? 'unknown', changes ? { ...params, changes } : params)
              let response: ObjectValue = {}
              for (const interaction of interactions) {
                if (interaction.saved) {
                  if (interaction.kind === 'approval' && !interaction.granted) {
                    const id = interaction.arguments.proposalId
                    if (consumedApprovals.has(id)) throw new Error('Codex repeated an already consumed native approval')
                    consumedApprovals.add(id)
                  }
                  const result = interaction.result(interaction.saved)
                  if (method === 'item/tool/requestUserInput') response = { answers: { ...object(response.answers), ...object(result.answers) } }
                  else if (method === 'mcpServer/elicitation/request' && result.action === 'accept') response = { ...result, content: { ...object(response.content), ...object(result.content) } }
                  else response = result
                  if (response.action === 'decline') break
                  continue
                }
                const saved = object(await this.host.invokeTool({ attemptId: context.attemptId, callId: `native:${String(message.id)}`, name: interaction.kind === 'approval' ? 'interactions_request_approval' : 'interactions_ask', arguments: interaction.arguments }))
                if (saved.status !== 'pending' || typeof saved.interactionId !== 'string') throw new Error('Native interaction was not recorded')
                queue.push({ kind: 'waiting', attemptId: context.attemptId, for: interaction.kind, interactionId: saved.interactionId })
                const ended = await rpc.stop()
                owned.ended = ended
                queue.push(ended ? { kind: 'ended', attemptId: context.attemptId, confirmed: true } : { kind: 'failed', attemptId: context.attemptId, confirmedEnded: false, message: 'Native interaction saved but provider termination is unconfirmed' })
                queue.finish()
                return
              }
              yielding = false
              await rpc.respond(message.id as number | string, response)
            } catch (error) {
              yielding = true
              const ended = await rpc.stop()
              owned.ended = ended
              queue.push({ kind: 'failed', attemptId: context.attemptId, confirmedEnded: ended, message: String(error) })
              queue.finish()
            } finally { if (yielding && owned.ended) { await images.close(); this.owned.delete(context.attemptId) } }
          })()
          return
        }
        if (method === 'item/tool/call' && message.id !== undefined) {
          const callId = string(params.callId) ?? randomUUID()
          const args = object(params.arguments)
          void (async () => {
            try {
              const tool = tools.find(item => item.name === string(params.tool))
              if (!tool) throw new Error('Unsupported tool or invalid arguments')
              if (tool.waits === 'question' || tool.waits === 'approval') {
                if (requestedInteraction) { repeatedInteraction = true; throw new Error('Only one interaction is supported per provider turn') }
                requestedInteraction = true
              }
              const result = await this.host.invokeTool({ attemptId: context.attemptId, callId, name: tool.name, arguments: args })
              const saved = object(result)
              if (tool.waits === 'question' || tool.waits === 'approval') {
                if (saved.status !== 'pending' || !string(saved.interactionId)) throw new Error('Interaction was not recorded')
                queue.push({ kind: 'waiting', attemptId: context.attemptId, for: tool.waits, interactionId: string(saved.interactionId)! })
              } else if (tool.waits === 'child' && !['completed', 'failed', 'cancelled', 'recovery-needed'].includes(String(saved.state))) {
                queue.push({ kind: 'waiting', attemptId: context.attemptId, for: 'child', interactionId: string(saved.id) ?? callId })
              }
              await rpc.respond(message.id as number | string, { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: true })
            } catch (error) { await rpc.respond(message.id as number | string, { contentItems: [{ type: 'inputText', text: String(error) }], success: false }).catch(() => undefined) }
          })()
        } else if (method === 'item/agentMessage/delta') {
          const id = string(params.itemId)
          if (id && typeof params.delta === 'string' && !finalized.has(id)) {
            const text = (texts.get(id) ?? '') + params.delta
            texts.set(id, text)
            queue.push({ kind: 'text', attemptId: context.attemptId, messageId: id, text, final: false })
          }
        } else if (method === 'item/completed') {
          const item = object(params.item)
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            const id = string(item.id) ?? randomUUID()
            if (!finalized.has(id)) {
              finalized.add(id)
              texts.delete(id)
              const phase = item.phase === 'commentary' ? 'progress' : item.phase === 'final_answer' ? 'answer' : undefined
              queue.push({ kind: 'text', attemptId: context.attemptId, messageId: id, text: item.text, final: true, ...(phase ? { phase } : {}) })
            }
          }
        } else if (method === 'turn/completed' && string(object(params.turn).id) === owned.turnId) {
          owned.ended = true
          const status = string(object(params.turn).status)
          if (status === 'completed' && repeatedInteraction) queue.push({ kind: 'failed', attemptId: context.attemptId, confirmedEnded: true, message: 'Provider repeated an interaction request in one turn' })
          else if (status === 'completed') queue.push({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
          else queue.push({ kind: 'failed', attemptId: context.attemptId, confirmedEnded: true, message: `Codex turn ${status ?? 'ended'}` })
          queue.finish()
          rpc.listeners.delete(onMessage)
          void clean()
        }
      }
      rpc.listeners.add(onMessage)
      for (const message of rpc.notifications.splice(0)) onMessage(message)
      return {
        events: queue,
        cancel: async () => {
          if (owned.ended) return { acknowledged: true, confirmedEnded: true }
          try { await rpc.request('turn/interrupt', { threadId: owned.threadId, turnId: owned.turnId }); owned.cancelAcknowledged = true; return { acknowledged: true, confirmedEnded: owned.ended } }
          catch { return { acknowledged: false, confirmedEnded: owned.ended } }
        },
        reconcile: async () => owned.ended ? 'ended' : rpc.process.exitCode === null ? 'active' : 'unknown',
      }
    } catch (error) {
      queue.finish()
      await clean()
      throw error
    }
  }
  /** Runs one maintenance task (extraction, consolidation or identity promotion) as an ephemeral, tool-free Codex thread in its own App Server process. The turn runs inside that process, so its observed exit confirms the end. */
  private async maintenance(context: MaintenanceExecutionContext): Promise<ExecutionHandle> {
    const { attemptId } = context
    const payload = context.maintenance
    const { settings } = payload
    const queue = new Queue()
    const refused = (message: string): ExecutionHandle => {
      queue.push({ kind: 'failed', attemptId, confirmedEnded: true, message })
      queue.finish()
      return { events: queue, cancel: async () => ({ acknowledged: true, confirmedEnded: true }), reconcile: async () => 'ended' }
    }
    if (payload.task !== 'extract' && payload.task !== 'consolidate' && payload.task !== 'identity') return refused('Unsupported maintenance task')
    const supported = this.modelCatalog?.find(entry => entry.id === settings.modelId)
    if (settings.adapterId !== this.id || !supported) return refused('Codex model is unavailable')
    if (settings.effort && !supported.efforts?.includes(settings.effort)) return refused('Codex effort is unsupported')
    if (settings.options && Object.keys(settings.options).length) return refused('Codex options are unsupported')
    const directory = join(this.config.dataDirectory, 'maintenance')
    const workspace = join(directory, 'workspace')
    let rpc: Rpc
    try {
      for (const path of [directory, workspace, join(directory, 'processes')]) await privateDirectory(path)
      rpc = await this.maintenanceServer(this.maintenanceProcesses, workspace)
    } catch (error) { return refused(error instanceof Error ? error.message : 'Codex launch failed') }
    const pid = rpc.process.pid
    let threadId: string | undefined
    let identity: string | undefined
    let settling: Promise<boolean> | undefined
    const settle = (failure?: string): Promise<boolean> => settling ??= (async () => {
      const exited = await rpc.stop()
      this.maintenanceProcesses.delete(rpc)
      if (exited && identity) await unlink(identity).catch(() => undefined)
      queue.push(failure === undefined && exited ? { kind: 'ended', attemptId, confirmed: true } : { kind: 'failed', attemptId, confirmedEnded: exited, message: failure ?? 'Codex process did not exit after the turn completed' })
      queue.finish()
      return exited
    })()
    rpc.listeners.add(message => {
      if (settling) return
      const method = string(message.method)
      if (method === 'process/exited') return void settle('Codex process exited before the turn completed')
      if (message.id !== undefined) return void settle(`Codex requested ${method ?? 'an action'} during maintenance`)
      const params = object(message.params)
      if (!threadId || string(params.threadId) !== threadId) return
      if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item)
        const type = string(item.type)
        if (!type || !maintenanceItems.has(type)) return void settle(`Codex produced a ${type ?? 'malformed'} item during maintenance`)
        if (method === 'item/completed' && type === 'agentMessage') {
          const text = string(item.text) ?? ''
          queue.push({ kind: 'text', attemptId, messageId: string(item.id) ?? randomUUID(), text, final: true })
        }
      } else if (method === 'turn/completed') {
        const status = string(object(params.turn).status)
        void settle(status === 'completed' ? undefined : `Codex turn ${status ?? 'ended'}`)
      }
    })
    void (async () => {
      if (!pid) throw new Error('Codex App Server did not start')
      const started = await processIdentity(pid)
      if (!started) throw new Error('Codex process identity is unavailable')
      await initialize(rpc)
      await assertMcpServersDisabled(rpc, workspace)
      const thread = await rpc.request('thread/start', { model: settings.modelId, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, serviceName: 'kipster', baseInstructions: maintenanceInstructions })
      const id = string(object(thread.thread).id)
      if (!id || !threadIdPattern.test(id)) throw new Error('Codex thread ID is missing')
      await assertNoMcpTools(rpc, id)
      if (settling) return
      identity = identityPath(this.config, id)
      const temporary = `${identity}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ processId: pid, started }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, identity)
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
      if (settling) { if (await settling) await unlink(identity).catch(() => undefined); return }
      threadId = id
      queue.push({ kind: 'provider', attemptId, threadId, processId: pid, providerStateScope: recoveryScope, workingDirectory: workspace, modelId: settings.modelId, ...(settings.effort ? { effort: settings.effort } : {}) })
      await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: payload.instructions }], model: settings.modelId, outputSchema: payload.outputSchema, ...(settings.effort ? { effort: settings.effort } : {}) }, 120000)
    })().catch(error => settle(error instanceof Error ? error.message : 'Codex maintenance failed'))
    return {
      events: queue,
      cancel: async () => { const exited = await settle('Maintenance cancelled'); return { acknowledged: true, confirmedEnded: exited } },
      reconcile: async () => rpc.ended ? 'ended' : 'active',
    }
  }
  /** Recovers a maintenance attempt after process loss from its recorded Codex process. Confirms an end only when that process and its group are gone. */
  async durableReconcile({ recoveryRef }: { readonly recoveryRef: RecoveryReference }): Promise<DurableReconcileResult> {
    const result = (outcome: DurableReconcileResult['outcome'], evidence: string): DurableReconcileResult => ({ outcome, evidence, generationMismatch: false })
    if (recoveryRef.adapterId !== this.id || recoveryRef.recoveryVersion !== 1 || recoveryRef.stateScope !== recoveryScope) return result('unknown', 'Incompatible recovery identity')
    const { processId: pid, threadId } = object(recoveryRef.providerIds)
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || typeof threadId !== 'string' || !threadIdPattern.test(threadId)) return result('unknown', 'Incomplete recovery identity')
    const group = probe(-pid)
    const leader = probe(pid)
    if (group === 'denied' || leader === 'denied') return result('unknown', 'Codex process cannot be inspected')
    if (group === 'absent' && leader === 'absent') {
      await unlink(identityPath(this.config, threadId)).catch(() => undefined)
      return result('ended', 'Codex process group is gone')
    }
    if (leader === 'absent') return result('active', 'Codex process group is still running')
    const recorded = object(await readFile(identityPath(this.config, threadId), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined))
    const started = await processIdentity(pid)
    if (recorded.processId !== pid || typeof recorded.started !== 'string' || !started) return result('unknown', 'Codex process identity is unavailable')
    if (started === recorded.started) return result('active', 'Codex process is running')
    await unlink(identityPath(this.config, threadId)).catch(() => undefined)
    return result('ended', 'Codex process is gone; its process ID was reused')
  }
  /**
   * Records ownership before a turn starts; cleanup must not infer ownership from the selected home.
   */
  private async recordThread(threadId: string): Promise<void> {
    if (!threadIdPattern.test(threadId)) throw new Error('Invalid Codex thread ID')
    const home = await realpath(this.config.codexHome)
    const candidate = await realpath(this.config.dataDirectory).catch(error => { if (errorCode(error) === 'ENOENT') return this.config.dataDirectory; throw error })
    if (candidate === home || candidate.startsWith(home + sep)) throw new Error('Kipster state must be outside the user Codex home')
    await privateDirectory(this.config.dataDirectory)
    const root = await realpath(this.config.dataDirectory)
    if (root === home || root.startsWith(home + sep)) throw new Error('Kipster state must be outside the user Codex home')
    const records = join(root, 'conversation-sessions')
    await privateDirectory(records)
    const path = join(records, `${threadId}.json`)
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ threadId, home }), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  }
  /** Only a thread this adapter started, in the Codex home it still uses, is reopened. */
  private async ownsThread(threadId: string): Promise<boolean> {
    if (!threadIdPattern.test(threadId)) return false
    try {
      const record = object(JSON.parse(await readFile(join(this.config.dataDirectory, 'conversation-sessions', `${threadId}.json`), 'utf8')))
      return record.threadId === threadId && record.home === await realpath(this.config.codexHome)
    } catch { return false }
  }
  async forgetProviderState(request: { readonly threadIds: readonly string[] }): Promise<void> {
    const ids = new Set(request.threadIds.filter(id => threadIdPattern.test(id)))
    if (!ids.size) return
    const root = this.config.dataDirectory
    if (!await regularDirectory(root)) return
    const records = join(root, 'conversation-sessions')
    if (await regularDirectory(records)) for (const id of ids) {
      const path = join(records, `${id}.json`)
      const entry = await lstat(path).catch(() => undefined)
      if (!entry?.isFile() || entry.isSymbolicLink()) continue
      const record = object(JSON.parse(await readFile(path, 'utf8')))
      const home = string(record.home)
      if (record.threadId !== id || !home || !isAbsolute(home) || !await regularDirectory(home)) throw new Error('Invalid Codex session ownership record')
      for (const directory of ['sessions', 'archived_sessions']) await removeFiles(join(home, directory), name => name.endsWith(`-${id}.jsonl`))
      await unlink(path)
    }
    if (await regularDirectory(join(root, 'maintenance')) && await regularDirectory(join(root, 'maintenance', 'processes'))) {
      for (const id of ids) await unlink(identityPath(this.config, id)).catch(error => { if (errorCode(error) !== 'ENOENT') throw error })
    }
  }
  async close(): Promise<void> {
    this.closed = true
    return this.closing ??= (async () => {
      await Promise.all([...this.owned.values()].map(owner => owner.images.close()))
      await Promise.all([...[...this.owned.values()].map(owner => owner.rpc), ...this.maintenanceProcesses, ...this.readinessProcesses].map(rpc => rpc.stop()))
      await Promise.allSettled([...this.readinessProbes])
    })()
  }
}
export function createAdapter(host: AdapterHost, config?: Readonly<Record<string, unknown>>): MaintenanceCapableAdapter { return new CodexAdapter(host, config) }
