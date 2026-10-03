import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdapterHost, AdapterReadiness, AdapterExecutionContext as ExecutionContext, DurableReconcileResult, ExecutionEvent, ExecutionHandle, MaintenanceCapableAdapter, MaintenanceExecutionContext, RecoveryReference, TextExecutionContext } from '@kipster/core/adapter'
import { launchConfig, launchEnvironment, privateDirectory, probe, processIdentity, type LaunchConfig } from './launch.js'
import { ClaudeProcess, type Message } from './process.js'
import { permissionTool, ToolServer, type ToolResult } from './tool-server.js'
import { permissionDecision } from './interactions.js'
import { nativeInputs } from './inputs.js'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
type Models = AdapterReadiness['catalog']['models']
/** Effort used with the default model when the agent and its organization choose none, if the model supports it. */
const DEFAULT_EFFORT = 'high'
const recoveryScope = 'claude-cli-process'
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const streamJson = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
const maintenanceInstructions = 'You are a Kipster memory maintenance step. Follow the task in the user message and answer with a single JSON object that matches the output schema. No other tools are available.'
const toolNote = 'Kipster tools are available to you as MCP tools named mcp__kipster__<tool name>, for example mcp__kipster__conversation_publish.'
const capabilities = (maintenance: boolean) => ({ text: true as const, publication: true, cancellation: true, steering: false as const, nativeResume: false as const, maintenance })

class Queue implements AsyncIterable<ExecutionEvent> {
  private values: ExecutionEvent[] = []
  private wake: (() => void) | undefined
  ended = false
  push(event: ExecutionEvent): void { if (this.ended) return; this.values.push(event); this.wake?.(); this.wake = undefined }
  finish(): void { this.ended = true; this.wake?.(); this.wake = undefined }
  async *[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
function run(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { env, cwd, timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`${String(stderr || error.message).trim().slice(-500)}`))
    else resolve(stdout)
  }))
}

class ClaudeAdapter implements MaintenanceCapableAdapter {
  readonly id = 'claude-cli'
  readonly version = '0.0.0'
  readonly contractMajor = 1 as const
  readonly recoveryVersions = [1] as const
  readonly recoveryStateScopes = [recoveryScope] as const
  private readonly config: LaunchConfig
  private readonly server = new ToolServer()
  private readonly processes = new Set<ClaudeProcess>()
  private models: Models | undefined
  private closed = false
  private closing: Promise<void> | undefined
  constructor(private readonly host: AdapterHost, config?: Readonly<Record<string, unknown>>) { this.config = launchConfig(config, host.dataDirectory) }

  private spawn(args: readonly string[], cwd: string): ClaudeProcess {
    if (this.closed) throw new Error('Claude CLI adapter is closed')
    const child = new ClaudeProcess(this.config.executable, args, cwd, launchEnvironment(this.config))
    this.processes.add(child)
    void child.exit.then(() => { if (child.ended) this.processes.delete(child) })
    return child
  }

  async readiness(): Promise<AdapterReadiness> {
    try { return await this.probeReadiness() } catch (error) {
      return { ready: false, reason: error instanceof Error ? error.message : 'Claude CLI readiness failed', catalog: { models: [], supportedOptions: [], capabilities: capabilities(false) } }
    }
  }
  /** Checks the login, then reads the live model catalog through the CLI's initialize request. Neither spends tokens. */
  private async probeReadiness(): Promise<AdapterReadiness> {
    await privateDirectory(this.config.dataDirectory)
    const env = launchEnvironment(this.config)
    let status: ObjectValue
    try { status = object(JSON.parse(await run(this.config.executable, ['auth', 'status', '--json'], env, this.config.dataDirectory))) }
    catch (error) { throw new Error(`Claude CLI is unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    if (status.loggedIn !== true) throw new Error('Claude CLI is not signed in. Run claude auth login as the user that runs Kipster.')
    const child = this.spawn([...streamJson, '--safe-mode', '--strict-mcp-config', '--no-session-persistence'], this.config.dataDirectory)
    try {
      const response = await new Promise<ObjectValue>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Claude CLI initialize timed out')), 30000)
        child.listen(message => {
          if (message.type === 'control_response' && object(message.response).request_id === 'readiness') { clearTimeout(timer); resolve(object(message.response)) }
          else if (message.type === 'process/exited') { clearTimeout(timer); reject(new Error(`Claude CLI exited during initialize${child.diagnostic() ? `: ${child.diagnostic()}` : ''}`)) }
        })
        child.send({ type: 'control_request', request_id: 'readiness', request: { subtype: 'initialize' } })
      })
      if (response.subtype !== 'success') throw new Error(`Claude CLI initialize failed: ${string(response.error) ?? 'unknown error'}`)
      const listed = (Array.isArray(object(response.response).models) ? object(response.response).models as unknown[] : []).map(object)
      const models = listed.filter(row => typeof row.value === 'string' && row.value !== 'default').map(row => {
        const efforts = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels) ? row.supportedEffortLevels.filter((x): x is string => typeof x === 'string') : []
        return { id: row.value as string, ...(efforts.length ? { efforts } : {}) }
      })
      if (!models.length) return { ready: false, reason: 'Claude CLI returned no models', catalog: { models: [], supportedOptions: [], capabilities: capabilities(false) } }
      const resolved = string(listed.find(row => row.value === 'default')?.resolvedModel)
      const fallback = models.find(model => resolved && string(listed.find(row => row.value === model.id)?.resolvedModel) === resolved) ?? models[0]!
      const defaultModel = { id: fallback.id, ...(fallback.efforts?.includes(DEFAULT_EFFORT) ? { effort: DEFAULT_EFFORT } : {}) }
      this.models = models
      return { ready: true, catalog: { models, defaultModel, supportedOptions: [], capabilities: capabilities(true) }, recoveryVersions: this.recoveryVersions, recoveryStateScopes: this.recoveryStateScopes }
    } finally { await child.stop(); this.processes.delete(child) }
  }

  private supported(settings: { adapterId: string; modelId: string; effort?: string; options?: Readonly<Record<string, unknown>> } | undefined): string | undefined {
    const model = this.models?.find(entry => entry.id === settings?.modelId)
    if (!settings || settings.adapterId !== this.id || !model) return 'Claude model is unavailable'
    if (settings.effort && !model.efforts?.includes(settings.effort)) return 'Claude effort is unsupported'
    if (settings.options && Object.keys(settings.options).length) return 'Claude options are unsupported'
    return undefined
  }

  async execute(context: ExecutionContext): Promise<ExecutionHandle> {
    if (context.kind === 'maintenance') return this.maintenance(context)
    if (context.kind !== undefined && context.kind !== 'text') throw new Error('Unsupported execution kind')
    const refusal = this.supported(context.settings)
    if (refusal) throw new Error(refusal)
    if (!context.workingDirectory) throw new Error('Persistent agent working directory is required')
    return this.conversation(context, context.settings!, context.workingDirectory)
  }

  private async conversation(context: TextExecutionContext, settings: NonNullable<TextExecutionContext['settings']>, workingDirectory: string): Promise<ExecutionHandle> {
    const { attemptId } = context
    const tools = context.tools ?? []
    const queue = new Queue()
    const directory = join(this.config.dataDirectory, 'attempts', randomUUID())
    let child: ClaudeProcess | undefined
    let ended = false
    let cancelled = false
    let yielding = false
    let resulted = false
    let requestedInteraction = false
    let repeatedInteraction = false
    const consumed = new Set<string>()
    const port = await this.server.start()
    const finish = async (event: ExecutionEvent) => {
      if (ended) return
      ended = true
      registration.close()
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      queue.push(event)
      queue.finish()
    }
    /** Saves a card, reports the wait, and stops the process; the next attempt resumes with the saved answer. */
    const yieldTo = async (card: { kind: 'question' | 'approval'; arguments: ObjectValue }, toolUseId: string | undefined): Promise<ToolResult> => {
      yielding = true
      try {
        const saved = object(await this.host.invokeTool({ attemptId, callId: `native:${toolUseId ?? randomUUID()}`, name: card.kind === 'approval' ? 'interactions_request_approval' : 'interactions_ask', arguments: card.arguments }))
        if (saved.status !== 'pending' || typeof saved.interactionId !== 'string') throw new Error('Native interaction was not recorded')
        queue.push({ kind: 'waiting', attemptId, for: card.kind, interactionId: saved.interactionId })
        const stopped = await child!.stop()
        await finish(stopped ? { kind: 'ended', attemptId, confirmed: true } : { kind: 'failed', attemptId, confirmedEnded: false, message: 'Native interaction saved but Claude termination is unconfirmed' })
      } catch (error) {
        const stopped = await child!.stop()
        await finish({ kind: 'failed', attemptId, confirmedEnded: stopped, message: String(error) })
      }
      return { text: JSON.stringify({ behavior: 'deny', message: 'Waiting for the person to answer.' }) }
    }
    const registration = this.server.register({
      tools,
      call: async (name, args, toolUseId) => {
        const tool = tools.find(item => item.name === name)
        if (!tool || yielding) return { text: 'Unsupported tool or invalid arguments', isError: true }
        if (tool.waits === 'question' || tool.waits === 'approval') {
          if (requestedInteraction) { repeatedInteraction = true; return { text: 'Only one interaction is supported per provider turn', isError: true } }
          requestedInteraction = true
        }
        try {
          const result = await this.host.invokeTool({ attemptId, callId: toolUseId ?? randomUUID(), name: tool.name, arguments: args })
          const saved = object(result)
          if (tool.waits === 'question' || tool.waits === 'approval') {
            if (saved.status !== 'pending' || !string(saved.interactionId)) throw new Error('Interaction was not recorded')
            queue.push({ kind: 'waiting', attemptId, for: tool.waits, interactionId: string(saved.interactionId)! })
          } else if (tool.waits === 'child' && !['completed', 'failed', 'cancelled', 'recovery-needed'].includes(String(saved.state))) {
            queue.push({ kind: 'waiting', attemptId, for: 'child', interactionId: string(saved.id) ?? toolUseId ?? randomUUID() })
          }
          return { text: JSON.stringify(result) }
        } catch (error) { return { text: String(error), isError: true } }
      },
      permission: async args => {
        const toolName = string(args.tool_name) ?? ''
        const input = object(args.input)
        const allow = { text: JSON.stringify({ behavior: 'allow', updatedInput: input }) }
        if (toolName.startsWith('mcp__kipster__')) return allow
        if (yielding || ended) return { text: JSON.stringify({ behavior: 'deny', message: 'The attempt is ending.' }) }
        try {
          const decision = permissionDecision(context, toolName, input)
          if (decision.kind === 'ask') return await yieldTo(decision.card, string(args.tool_use_id))
          if (decision.behavior === 'deny') return { text: JSON.stringify({ behavior: 'deny', message: decision.message }) }
          if (decision.proposalId) {
            if (consumed.has(decision.proposalId)) return { text: JSON.stringify({ behavior: 'deny', message: 'This exact action was already approved once in this run. Request approval again if it must repeat.' }) }
            consumed.add(decision.proposalId)
          }
          return { text: JSON.stringify({ behavior: 'allow', updatedInput: decision.updatedInput }) }
        } catch (error) { return { text: JSON.stringify({ behavior: 'deny', message: String(error) }) } }
      },
    })
    try {
      await privateDirectory(join(this.config.dataDirectory, 'attempts'))
      await privateDirectory(directory)
      const { blocks, readable } = await nativeInputs(context.input)
      const server = (path: string, extra: ObjectValue = {}) => ({ type: 'http', url: `http://127.0.0.1:${port}${path}`, headers: { Authorization: `Bearer ${registration.token}` }, ...extra })
      await writeFile(join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { kipster: server('/tools', { alwaysLoad: true, timeout: 3600000 }), kipster_permission: server('/permission', { timeout: 3600000 }) } }), { mode: 0o600, flag: 'wx' })
      await writeFile(join(directory, 'instructions.md'), `${context.instructions}\n\n${toolNote}`, { mode: 0o600, flag: 'wx' })
      const args = [...streamJson, '--include-partial-messages', '--no-session-persistence', '--model', settings.modelId, ...(settings.effort ? ['--effort', settings.effort] : []),
        '--mcp-config', join(directory, 'mcp.json'), '--permission-prompt-tool', `mcp__kipster_permission__${permissionTool}`, '--disallowedTools', `mcp__kipster_permission__${permissionTool}`,
        '--append-system-prompt-file', join(directory, 'instructions.md'), ...(this.config.permissionMode ? ['--permission-mode', this.config.permissionMode] : []),
        ...(readable.length ? ['--allowedTools', ...readable.map(path => `Read(/${path})`)] : [])]
      child = this.spawn(args, workingDirectory)
      const process = child
      const blocksByIndex = new Map<number, { id: string; text: string }>()
      let messageId: string | undefined
      let provider = false
      process.listen((message: Message) => {
        if (ended) return
        if (message.type === 'process/exited') {
          if (resulted || yielding) return
          void finish({ kind: 'failed', attemptId, confirmedEnded: process.ended, message: cancelled ? 'Claude turn cancelled' : `Claude CLI exited without a result${process.diagnostic() ? `: ${process.diagnostic()}` : ''}` })
          return
        }
        if (message.type === 'system' && message.subtype === 'init' && !provider) {
          provider = true
          queue.push({ kind: 'provider', attemptId, threadId: string(message.session_id) ?? attemptId, processId: process.pid!, providerStateScope: recoveryScope, workingDirectory, modelId: settings.modelId, ...(settings.effort ? { effort: settings.effort } : {}) })
          return
        }
        if (message.parent_tool_use_id) return
        if (message.type === 'stream_event') {
          const event = object(message.event)
          const index = typeof event.index === 'number' ? event.index : -1
          if (event.type === 'message_start') { messageId = string(object(event.message).id) ?? randomUUID(); blocksByIndex.clear() }
          else if (event.type === 'content_block_start' && object(event.content_block).type === 'text') blocksByIndex.set(index, { id: `${messageId ?? randomUUID()}:${index}`, text: '' })
          else if (event.type === 'content_block_delta' && object(event.delta).type === 'text_delta') {
            const block = blocksByIndex.get(index)
            const delta = string(object(event.delta).text)
            if (block && delta) { block.text += delta; queue.push({ kind: 'text', attemptId, messageId: block.id, text: block.text, final: false }) }
          } else if (event.type === 'content_block_stop') {
            const block = blocksByIndex.get(index)
            blocksByIndex.delete(index)
            if (block?.text) queue.push({ kind: 'text', attemptId, messageId: block.id, text: block.text, final: true })
          }
          return
        }
        if (message.type === 'result') {
          resulted = true
          const failure = message.is_error === true || message.subtype !== 'success'
            ? `Claude turn failed: ${string(message.result) ?? (Array.isArray(message.errors) ? message.errors.join('; ') : string(message.subtype) ?? 'error')}`
            : repeatedInteraction ? 'Provider repeated an interaction request in one turn' : undefined
          void (async () => {
            process.endInput()
            await process.settle(5000)
            const stopped = process.ended || await process.stop()
            await finish(failure ? { kind: 'failed', attemptId, confirmedEnded: stopped, message: failure } : stopped ? { kind: 'ended', attemptId, confirmed: true } : { kind: 'failed', attemptId, confirmedEnded: false, message: 'Claude CLI did not exit after the turn completed' })
          })()
        }
      })
      process.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: context.prompt }, ...blocks] }, parent_tool_use_id: null })
    } catch (error) {
      const stopped = child ? await child.stop() : true
      await finish({ kind: 'failed', attemptId, confirmedEnded: stopped, message: String(error) })
      throw error
    }
    return {
      events: queue,
      cancel: async () => {
        if (ended || !child) return { acknowledged: true, confirmedEnded: true }
        cancelled = true
        return { acknowledged: true, confirmedEnded: await child.stop() }
      },
      reconcile: async () => ended ? 'ended' : child?.running ? 'active' : 'unknown',
    }
  }

  private identityPath(sessionId: string): string { return join(this.config.dataDirectory, 'maintenance', 'processes', `${sessionId}.json`) }

  /** Runs one maintenance task as a tool-free, session-free Claude turn with Core's output schema. The turn runs inside that
   * process, so its observed exit confirms the end. */
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
    const refusal = this.supported(settings)
    if (refusal) return refused(refusal)
    const sessionId = randomUUID()
    const workspace = join(this.config.dataDirectory, 'maintenance', 'workspace')
    const identity = this.identityPath(sessionId)
    let child: ClaudeProcess
    try {
      for (const path of [join(this.config.dataDirectory, 'maintenance'), workspace, join(this.config.dataDirectory, 'maintenance', 'processes')]) await privateDirectory(path)
      child = this.spawn([...streamJson, '--no-session-persistence', '--session-id', sessionId, '--model', settings.modelId, ...(settings.effort ? ['--effort', settings.effort] : []),
        '--json-schema', JSON.stringify(payload.outputSchema), '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--permission-prompts', 'none', '--system-prompt', maintenanceInstructions], workspace)
    } catch (error) { return refused(error instanceof Error ? error.message : 'Claude CLI launch failed') }
    const pid = child.pid
    let recorded = false
    let settling: Promise<boolean> | undefined
    const settle = (failure?: string, output?: string): Promise<boolean> => settling ??= (async () => {
      child.endInput()
      await child.settle(failure ? 0 : 5000)
      const exited = child.ended || await child.stop()
      if (exited && recorded) await unlink(identity).catch(() => undefined)
      if (output !== undefined && failure === undefined) queue.push({ kind: 'text', attemptId, messageId: sessionId, text: output, final: true })
      queue.push(failure === undefined && exited ? { kind: 'ended', attemptId, confirmed: true } : { kind: 'failed', attemptId, confirmedEnded: exited, message: failure ?? 'Claude CLI did not exit after the turn completed' })
      queue.finish()
      return exited
    })()
    child.listen(message => {
      if (settling) return
      if (message.type === 'process/exited') return void settle(`Claude CLI exited before the turn completed${child.diagnostic() ? `: ${child.diagnostic()}` : ''}`)
      if (message.type === 'system' && message.subtype === 'init') {
        const tools = Array.isArray(message.tools) ? message.tools : []
        const servers = Array.isArray(message.mcp_servers) ? message.mcp_servers : []
        if (tools.some(tool => tool !== 'StructuredOutput') || servers.length) return void settle('Claude isolation check failed: tools or MCP servers are available during maintenance')
      } else if (message.type === 'assistant') {
        const content = Array.isArray(object(message.message).content) ? object(message.message).content as unknown[] : []
        const used = content.map(object).find(block => block.type === 'tool_use' && block.name !== 'StructuredOutput')
        if (used) return void settle(`Claude used ${string(used.name) ?? 'a tool'} during maintenance`)
      } else if (message.type === 'result') {
        if (message.is_error === true || message.subtype !== 'success') return void settle(`Claude turn failed: ${string(message.result) ?? string(message.subtype) ?? 'error'}`)
        const output = message.structured_output !== undefined ? JSON.stringify(message.structured_output) : string(message.result)
        return void settle(undefined, output || undefined)
      }
    })
    void (async () => {
      if (!pid) throw new Error('Claude CLI did not start')
      const started = await processIdentity(pid)
      if (!started) throw new Error('Claude process identity is unavailable')
      const temporary = `${identity}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ processId: pid, started }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, identity)
        recorded = true
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
      if (settling) { if (await settling) await unlink(identity).catch(() => undefined); return }
      queue.push({ kind: 'provider', attemptId, threadId: sessionId, processId: pid, providerStateScope: recoveryScope, workingDirectory: workspace, modelId: settings.modelId, ...(settings.effort ? { effort: settings.effort } : {}) })
      child.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: payload.instructions }] }, parent_tool_use_id: null })
    })().catch(error => settle(error instanceof Error ? error.message : 'Claude maintenance failed'))
    return {
      events: queue,
      cancel: async () => ({ acknowledged: true, confirmedEnded: await settle('Maintenance cancelled') }),
      reconcile: async () => child.ended ? 'ended' : 'active',
    }
  }

  /** Recovers a maintenance attempt after process loss from its recorded process. Confirms an end only when that process and its group are gone. */
  async durableReconcile({ recoveryRef }: { readonly recoveryRef: RecoveryReference }): Promise<DurableReconcileResult> {
    const result = (outcome: DurableReconcileResult['outcome'], evidence: string): DurableReconcileResult => ({ outcome, evidence, generationMismatch: false })
    if (recoveryRef.adapterId !== this.id || recoveryRef.recoveryVersion !== 1 || recoveryRef.stateScope !== recoveryScope) return result('unknown', 'Incompatible recovery identity')
    const { processId: pid, threadId } = object(recoveryRef.providerIds)
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 2 || typeof threadId !== 'string' || !sessionIdPattern.test(threadId)) return result('unknown', 'Incomplete recovery identity')
    const group = probe(-pid)
    const leader = probe(pid)
    if (group === 'denied' || leader === 'denied') return result('unknown', 'Claude process cannot be inspected')
    if (group === 'absent' && leader === 'absent') {
      await unlink(this.identityPath(threadId)).catch(() => undefined)
      return result('ended', 'Claude process group is gone')
    }
    if (leader === 'absent') return result('active', 'Claude process group is still running')
    const recorded = object(await readFile(this.identityPath(threadId), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined))
    const started = await processIdentity(pid)
    if (recorded.processId !== pid || typeof recorded.started !== 'string' || !started) return result('unknown', 'Claude process identity is unavailable')
    if (started === recorded.started) return result('active', 'Claude process is running')
    await unlink(this.identityPath(threadId)).catch(() => undefined)
    return result('ended', 'Claude process is gone; its process ID was reused')
  }

  /** Conversations run without session persistence, so the CLI keeps no transcript to remove. Maintenance records go with their sessions. */
  async forgetProviderState(request: { readonly threadIds: readonly string[] }): Promise<void> {
    for (const id of request.threadIds) if (sessionIdPattern.test(id)) await unlink(this.identityPath(id)).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closed = true
    return this.closing ??= (async () => {
      await Promise.all([...this.processes].map(child => child.stop()))
      await this.server.close()
    })()
  }
}

export function createAdapter(host: AdapterHost, config?: Readonly<Record<string, unknown>>): MaintenanceCapableAdapter { return new ClaudeAdapter(host, config) }
