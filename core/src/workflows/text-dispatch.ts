import { coalesceDrafts } from './draft-events.js'
import { administrationReceipts } from '../modules/administration/public.js'
import { organizationDeletionSteps } from './organization-deletion.js'
import { randomUUID } from 'node:crypto'
import { recoveryCompatible } from '../adapter-api/index.js'
import type { TextExecutionAdapter, ExecutionContext, ExecutionEvent, AdapterHost, AdapterReadiness, ExecutionHandle, MaintenanceExecutionContext, MaintenanceCapableAdapter, RecoveryReference } from '../adapter-api/index.js'
import { AdapterRegistry, adapterRecord, boundedReason, notReadyReason, validReadiness } from './adapter-registry.js'
import type { Runtime } from '../runtime.js'
import { acceptsType } from '../transcription/index.js'
import type { CoordinatorLock, SqlClient } from '../platform/postgres/public.js'
import { claimPreparation, issueAttempt, childDelegation, delegate, delegationActivity, delegationRecord, delegationStatus, finishDelegation, getAgent, listAgents, reconcileInterruptedDelegations, stopRun, type Attempt } from '../modules/work/public.js'
import { sealAttemptMessages, runContext, executionHistory, messageRecord, workRecord, authorizedChat } from '../modules/conversations/public.js'
import { administrationRun, isLive, type TrustedActor } from '../modules/identity/public.js'
import { administrationTool } from './admin-tools.js'
import { executionTools, toolGuidance } from './agent-tools.js'
import { adminSkill, skillsSection } from './skills.js'
import type { Context } from '../protocol/text.js'
import { recordAdapters, resolveSettings, resolveAgentSettings, type Catalog } from '../modules/settings/public.js'
import type { ExecutionAdapter } from '../protocol/admin.js'
import { publishThreadChange, createNotification, interactionNotificationChanged } from '../modules/synchronization/public.js'
import { askInteraction, interactionRecord, type InteractionInput } from '../modules/work/public.js'
import { OperationEngine, type StepOutcome } from './operations.js'
import { agentDeletionSteps, type ForgetOutcome } from './agent-deletion.js'
import { MaintenanceService, SleepService, MAINTENANCE_LIMITS, MAINTENANCE_INSTRUCTIONS_V1, MAINTENANCE_SWEEP_JOB_ID, CONSOLIDATION, consolidationPrompt, promotionPrompt } from '../modules/memory/public.js'
import type { MaintenanceSettleMode, MaintenanceSource, SleepRunClaim } from '../modules/memory/public.js'
import { createDocumentIn, createdDocument, documentCreation, documentInput, documentTool, finishRunDocuments } from '../modules/documents/public.js'
import type { MessagePart } from '../protocol/text.js'

/** An unavailable adapter that work selects is probed again at most this often. */
const REPROBE_INTERVAL_MS = 30000
/** How often stopped attempts this process drives are checked for adapter cancellation, after a fence committed anywhere. */
const CANCELLATION_DELIVERY_MS = 5000

export interface MemoryContextPort { read(agentId: string, organizationId: string | null, threadId: string, query?: string): Promise<readonly string[]> }
export interface ControlInput { operationId: string; context: Context; chatId: string; threadId: string; runId: string; attemptId?: string; action: 'stop'|'resume'|'retry'|'cancel-queued'|'steer' }
export interface ControlReceipt { version: 1; operationId: string; outcome: 'accepted'|'unsupported'|'rejected'; reason: string; runId: string; threadId: string; state: string }
export interface DispatchHooks { afterClaim?(runId: string): Promise<void>; afterIssue?(attemptId: string): Promise<void>; afterOutput?(messageId: string): Promise<void>; beforeVoiceClaimLock?(runId:string):Promise<void>; beforeVoiceSettleLock?(runId:string):Promise<void>; beforeToolClaimLock?(runId:string):Promise<void>; beforeToolSettleLock?(runId:string):Promise<void>; afterMaintenanceClaim?(sourceRunId: string): Promise<void>; afterMaintenanceIssue?(runId: string): Promise<void>; afterStartupRecovery?(): Promise<void>; afterMaintenanceProvider?(runId: string): Promise<void>; afterMaintenanceSettlement?(runId: string, outcome: string): Promise<void>; maintenanceFailed?(error: unknown): void | Promise<void>; coordinatorLock?(state: 'lost' | 'retry-failed' | 'restored', error?: unknown): void | Promise<void>; afterOperationStep?(operationId: string, step: string, outcome: StepOutcome): Promise<void> }
const transcriptionFailures=new Set(['unavailable','timeout','cancelled','invalid-input','output-limit','provider-error'])
function normalizedTranscription(value:unknown,provider:string):{status:'succeeded'|'no-speech';text:string;provider:string}|{status:'unavailable';reason:string;provider:string}{
  const row=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
  if(row.provider===provider){
    if((row.status==='succeeded'||row.status==='no-speech')&&typeof row.text==='string'){
      if(Buffer.byteLength(row.text)>1048576)return {status:'unavailable',reason:'output-limit',provider}
      if(!row.text.includes('\0'))return {status:row.status,text:row.text,provider}
    }
    if(row.status==='unavailable'&&typeof row.reason==='string'&&transcriptionFailures.has(row.reason))return {status:'unavailable',reason:row.reason,provider}
  }
  return {status:'unavailable',reason:'provider-error',provider}
}
export function abortableResult<T>(signal:AbortSignal,operation:()=>Promise<T>,interrupted:T):Promise<T>{
  if(signal.aborted)return Promise.resolve(interrupted)
  return new Promise<T>((resolve,reject)=>{
    let done=false
    const finish=(value:T)=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);resolve(value)}
    const fail=(error:unknown)=>{if(done)return;done=true;signal.removeEventListener('abort',onAbort);reject(error)}
    const onAbort=()=>finish(interrupted)
    signal.addEventListener('abort',onAbort,{once:true})
    if(signal.aborted){onAbort();return}
    try{operation().then(finish,fail)}catch(error){fail(error)}
  })
}
const publicationPartsKey=(parts:readonly unknown[]):string=>JSON.stringify(parts.map(part=>{const row=part&&typeof part==='object'&&!Array.isArray(part)?part as Record<string,unknown>:{};return row.kind==='text'?['text',row.text]:row.kind==='file'?['file',row.artifactId,row.purpose]:row.kind==='document'?['document',row.documentId,row.revision]:['invalid']}))
export function textPublicationHost(dispatcher: Pick<TextDispatcher, 'publishToolText' | 'askToolInteraction' | 'memoryTool' | 'structuredTool' | 'vectorTool' | 'writeArtifactTool' | 'publishArtifactTool' | 'copyArtifactTool' | 'transcribeTool' | 'agentTool'> & Partial<Pick<TextDispatcher, 'isMaintenanceAttempt' | 'adminTool' | 'documentTool'>>): AdapterHost {
  return {
    now: () => new Date().toISOString(),
    async invokeTool(request) {
      if (await dispatcher.isMaintenanceAttempt?.(request.attemptId)) throw new Error('Maintenance tools denied')
      if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new Error('Unsupported Kipster tool')
      const args = request.arguments as Record<string, unknown>
      if (request.name === 'conversation_publish') {
        if (Object.keys(args).some(key=>!['text','artifactIds'].includes(key)) || (args.text!==undefined&&typeof args.text!=='string') || (args.artifactIds!==undefined&&(!Array.isArray(args.artifactIds)||args.artifactIds.some(id=>typeof id!=='string')))) throw new Error('Invalid publication arguments')
        return dispatcher.publishToolText(request.attemptId, request.callId, typeof args.text==='string'?args.text:'', args.artifactIds as string[]|undefined)
      }
      if(request.name==='audio_transcribe'){
        if(Object.keys(args).length!==1||typeof args.artifactId!=='string')throw new Error('Invalid transcription arguments')
        return dispatcher.transcribeTool(request.attemptId,request.callId,args.artifactId)
      }
      if(request.name==='artifacts_write'){
        if(Object.keys(args).some(key=>!['name','content'].includes(key))||typeof args.name!=='string'||typeof args.content!=='string')throw new Error('Invalid artifact write arguments')
        return dispatcher.writeArtifactTool(request.attemptId,request.callId,args.name,args.content)
      }
      if(request.name==='artifacts_publish'){
        if(Object.keys(args).length!==1||typeof args.outputId!=='string')throw new Error('Invalid artifact publication arguments')
        return dispatcher.publishArtifactTool(request.attemptId,request.callId,args.outputId)
      }
      if(request.name==='artifacts_copy_to_organization'){
        if(Object.keys(args).length!==1||typeof args.artifactId!=='string')throw new Error('Invalid organization publication arguments')
        return dispatcher.copyArtifactTool(request.attemptId,request.callId,args.artifactId)
      }
      if (request.name === 'interactions_ask' || request.name === 'interactions_request_approval') {
        const kind = request.name === 'interactions_ask' ? 'question' : 'approval'
        return dispatcher.askToolInteraction(request.attemptId, request.callId, { ...args, kind } as unknown as InteractionInput)
      }
      // Agent and memory tools keep their Core names, such as `memory.relationship_get` for `memory_relationship_get`.
      if (/^agents_(list|get|delegate|delegation_status)$/.test(request.name)) return dispatcher.agentTool(request.attemptId,request.callId,request.name.replace('_','.'),args)
      if ((request.name === 'admin_operations' || request.name === 'admin_call') && dispatcher.adminTool) return dispatcher.adminTool(request.attemptId, request.callId, request.name, args)
      if (request.name.startsWith('memory_')) return dispatcher.memoryTool(request.attemptId, request.callId, request.name.replace('_','.'), args)
      if (request.name === 'data_space') return dispatcher.structuredTool(request.attemptId, request.callId, args)
      if (request.name === 'vectors_space') return dispatcher.vectorTool(request.attemptId, request.callId, args)
      const document = /^documents_(create|list|read|edit|delete)$/.exec(request.name)
      if (document && dispatcher.documentTool) return dispatcher.documentTool(request.attemptId, request.callId, `documents.${document[1]}`, args)
      throw new Error('Unsupported Kipster tool')
    },
  }
}
async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

interface RunRow { id: string; thread_id: string; chat_id: string; input_message_id: string; state: string; queue_position: string; current_attempt_id: string | null; installation_id: string; caller_id: string; stop_requested: boolean; continuation_interaction_id: string | null; queue_hold: boolean; queue_generation: string; retry_continue_generation: string | null }

async function runRow(client: SqlClient, id: string): Promise<RunRow | undefined> {
  return (await client.query<RunRow>(`SELECT r.id,r.thread_id,t.chat_id,r.input_message_id,r.state,r.queue_position,r.current_attempt_id,r.stop_requested,r.continuation_interaction_id,r.queue_hold,r.queue_generation,r.retry_continue_generation,c.installation_id,c.caller_id
    FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE r.id=$1`, [id])).rows[0]
}
async function workRevision(client: SqlClient, runId: string): Promise<number> {
  const row = (await client.query<{ revision: string }>('SELECT revision FROM kipster.text_runs WHERE id=$1', [runId])).rows[0]
  if (!row) throw new Error('Run not found')
  return Number(row.revision)
}
async function lockCapacity(client: SqlClient, installationId: string): Promise<number> {
  await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [installationId])
  const row = (await client.query<{ ceiling: number; update_request_id: string | null }>('SELECT ceiling,update_request_id FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [installationId])).rows[0]!
  return row.update_request_id === null ? row.ceiling : 0
}
async function isHead(client: SqlClient, row: RunRow): Promise<boolean> {
  // A revived earlier queue position must never overtake work already admitted
  // in this thread, even when installation capacity has another free permit.
  const active = await client.query(`SELECT 1 FROM kipster.text_runs WHERE thread_id=$1 AND id<>$2 AND state IN ('preparing','running','waiting','cancellation-requested','recovery-needed') LIMIT 1`, [row.thread_id,row.id])
  if (active.rows.length) return false
  const head = (await client.query<{ id: string; state: string }>(`SELECT id,state FROM kipster.text_runs WHERE thread_id=$1 AND NOT (state IN ('completed','cancelled','failed') AND queue_hold=false) ORDER BY queue_position LIMIT 1`, [row.thread_id])).rows[0]
  return head?.id === row.id && head.state === row.state
}
async function wakeEligible(client: SqlClient, runtime: Runtime, installationId: string): Promise<void> {
  const rows = await client.query<{ id: string }>(`SELECT DISTINCT ON (r.thread_id) r.id,r.thread_id,r.queue_position,r.state
    FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
    WHERE c.installation_id=$1 AND NOT (r.state IN ('completed','cancelled','failed') AND r.queue_hold=false) ORDER BY r.thread_id,r.queue_position`, [installationId])
  for (const row of rows.rows as { id: string; state?: string }[]) if (row.state === 'queued') await runtime.jobs.send(client, row.id)
}

const lockRetryMs = { first: 500, max: 10000 }

/** One Core incarnation. Call start() only after runtime bootstrap and adapter selection.
 * If the coordinator lock connection is lost, the dispatcher stops claiming and issuing work,
 * lets in-flight attempts settle, and resumes only after it holds the lock again. */
export class TextDispatcher {
  private readonly incarnation = randomUUID()
  private stopped = false
  private startPromise: Promise<void> | null = null
  private lock: CoordinatorLock | null = null
  private lockEpoch = 0
  private started = false
  /** Holds the lock and has recovered abandoned work: only then may work be claimed or issued. */
  private coordinating = false
  private relocking = false
  private wakeRelock: (() => void) | null = null
  /** Claimed or issued attempts whose preparation or execution this process still drives. */
  private readonly live = new Set<string>()
  private readonly active = new Set<Promise<void>>()
  private readonly handles = new Map<string, ExecutionHandle>()
  private readonly voiceControllers = new Map<string, AbortController>()
  private readonly toolControllers = new Map<string, AbortController>()
  private readonly toolFlights = new Map<string,{artifactId:string;result:Promise<unknown>}>()
  /** Attempts whose adapter cancellation is in flight. */
  private readonly cancelling = new Set<string>()
  private readonly maintenance: MaintenanceService
  /** Administration operations run only while this dispatcher coordinates. Register their kinds before start(). */
  readonly operations: OperationEngine
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private cancellationTimer: ReturnType<typeof setInterval> | null = null
  private maintenanceTicking = false
  private directMaintenanceReady = false
  /** Generations pinned by attempts whose provider end is unconfirmed. */
  private readonly retainedRoutes = new Map<string, () => void>()
  /** Last valid readiness of a direct adapter, and why it is unavailable (null while available). */
  private directReadiness: AdapterReadiness | undefined
  private directReason: string | null = null
  /** Adapter list updates run one at a time, so a slow probe never records over a newer state. */
  private adapterSync: Promise<void> = Promise.resolve()
  private stopAdapterUpdates: (() => void) | undefined
  /** When each adapter was last probed, and probes that work is waiting for. */
  private readonly probedAt = new Map<string, number>()
  private readonly reprobes = new Map<string, Promise<void>>()
  /** `hostCatalog`, when given, is the catalog of a direct adapter; otherwise its readiness report supplies it. */
  constructor(private readonly runtime: Runtime, private readonly adapter: TextExecutionAdapter | AdapterRegistry, private readonly memory?: MemoryContextPort, private readonly hooks: DispatchHooks = {}, private readonly hostCatalog: Catalog | null = null) {
    this.maintenance = new MaintenanceService(runtime.db, runtime.bootstrap.installationId, runtime.home.identity)
    this.operations = new OperationEngine(runtime, hooks, () => this.deliverCancellations())
    this.operations.register('agent.delete', agentDeletionSteps({ runtime, maintenance: this.maintenance, forgetProviderState: (adapterId, threadIds) => this.forgetProviderState(adapterId, threadIds) }))
    this.operations.register('organization.delete', organizationDeletionSteps({ runtime, maintenance: this.maintenance, forgetProviderState: (adapterId, threadIds) => this.forgetProviderState(adapterId, threadIds) }))
  }

  /**
   * Asks the adapter that ran provider threads to forget their state, such as session files. An
   * attempt recorded without an adapter ID ran on the direct adapter. Adapter failures throw.
   */
  async forgetProviderState(adapterId: string | null, threadIds: readonly string[]): Promise<{ outcome: ForgetOutcome; adapterId: string | null }> {
    const adapter = this.adapter
    if (adapter instanceof AdapterRegistry) return { outcome: adapterId === null ? 'unavailable' : await adapter.forgetProviderState(adapterId, threadIds), adapterId }
    if (adapterId !== null && adapterId !== adapter.id) return { outcome: 'unavailable', adapterId }
    if (typeof adapter.forgetProviderState !== 'function') return { outcome: 'unsupported', adapterId: adapter.id }
    await adapter.forgetProviderState({ threadIds })
    return { outcome: 'forgotten', adapterId: adapter.id }
  }

  /** The catalog settings are checked against. An unavailable direct adapter offers nothing; an unknown catalog is null. */
  catalog(): Catalog | null {
    if (this.adapter instanceof AdapterRegistry) return this.adapter.catalog()
    if (this.directReason !== null) return { complete: true, defaultAdapterId: this.adapter.id, adapters: [] }
    if (this.hostCatalog) return this.hostCatalog
    const catalog = this.directReadiness?.catalog
    return catalog ? { complete: true, defaultAdapterId: this.adapter.id, adapters: [{ id: this.adapter.id, models: catalog.models, ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}) }] } : null
  }

  /** Probes the direct adapter. A probe that throws, times out or reports not ready makes it unavailable with the reason. */
  private async probeDirect(): Promise<void> {
    if (this.adapter instanceof AdapterRegistry) return
    const adapter = this.adapter
    if (typeof adapter.readiness !== 'function') { this.directReason = null; return }
    this.probedAt.set(adapter.id, this.runtime.clock().getTime())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const report: unknown = await Promise.race([adapter.readiness(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Adapter readiness timed out')), 30000) })])
      if (validReadiness(report)) { this.directReadiness = report; this.directReason = null }
      else this.directReason = notReadyReason(report)
    } catch (error) { this.directReason = boundedReason(error instanceof Error ? error.message : 'Adapter readiness failed') }
    finally { if (timer) clearTimeout(timer) }
    const direct = adapter as Partial<MaintenanceCapableAdapter>
    const ready = this.directReason === null ? this.directReadiness : undefined
    this.directMaintenanceReady = !!ready && !!direct.durableReconcile && !!direct.recoveryVersions?.length && !!direct.recoveryStateScopes?.length &&
      ready.catalog.capabilities.maintenance === true && !!ready.recoveryVersions?.length && !!ready.recoveryStateScopes?.length
  }

  /** The adapters this dispatcher routes to, including unavailable ones with their reason. */
  adapters(): ExecutionAdapter[] {
    const adapter = this.adapter
    if (adapter instanceof AdapterRegistry) return adapter.adapters()
    const record = adapterRecord(adapter.id, adapter.version, this.directReadiness, this.directReason)
    const hostModels = this.hostCatalog?.adapters.find(entry => entry.id === adapter.id)?.models
    return [hostModels ? { ...record, models: hostModels.map(model => ({ id: model.id, efforts: [...(model.efforts ?? [])] })) } : record]
  }

  /** Runs `probe`, then records the adapter list and publishes `adapters-changed` when it changed. */
  private updateAdapters(probe: () => Promise<void> = async () => undefined): Promise<void> {
    const run = this.adapterSync.then(async () => {
      await probe()
      await recordAdapters(this.runtime.db, this.runtime.bootstrap.installationId, this.adapters())
    })
    this.adapterSync = run.catch(() => undefined)
    return run
  }

  /** Probes every adapter's readiness again and records the result. */
  refreshAdapters(): Promise<void> {
    const adapter = this.adapter
    return this.updateAdapters(async () => {
      if (!(adapter instanceof AdapterRegistry)) return this.probeDirect()
      for (const record of adapter.adapters()) this.probedAt.set(record.id, this.runtime.clock().getTime())
      await adapter.refresh()
    })
  }

  /**
   * Work that selects an unavailable adapter probes it again first, so a readiness failure that has
   * passed heals without a refresh. An adapter is probed at most once per interval; work arriving
   * while a probe runs waits for it. Returns whether the adapter was probed, so the caller resolves again.
   */
  private async reprobe(adapterId: string): Promise<boolean> {
    const adapter = this.adapter
    const running = this.reprobes.get(adapterId)
    if (running) { await running; return true }
    const unavailable = adapter instanceof AdapterRegistry ? adapter.notReady(adapterId) : adapterId === adapter.id && this.directReason !== null
    if (!unavailable || this.runtime.clock().getTime() - (this.probedAt.get(adapterId) ?? -Infinity) < REPROBE_INTERVAL_MS) return false
    this.probedAt.set(adapterId, this.runtime.clock().getTime())
    const probe = this.updateAdapters(() => adapter instanceof AdapterRegistry ? adapter.refresh(adapterId) : this.probeDirect())
      .catch(() => undefined).finally(() => { this.reprobes.delete(adapterId) })
    this.reprobes.set(adapterId, probe)
    await probe
    return true
  }

  /** Maintenance attempts expose zero tools; the Core host denies every call. */
  async isMaintenanceAttempt(attemptId: string): Promise<boolean> {
    const found = (await this.runtime.db.query(
      `SELECT 1 FROM kipster.attempts a JOIN kipster.maintenance_runs r ON r.id=a.intent_id WHERE a.id=$1`, [attemptId])).rows.length
    return found > 0
  }

  /** Maintenance needs the memory service that commits write to; learning switches gate each source. */
  private maintenanceActive(): boolean { return !!this.runtime.memory }

  /** Text reserves capacity only while some available adapter can run maintenance. The check is
   * coordinator-wide, not per source agent: a source whose agent uses another adapter fails preparation. */
  private maintenanceServable(): boolean {
    return this.maintenanceActive() && (this.adapter instanceof AdapterRegistry ? this.adapter.maintenanceCapable() : this.directMaintenanceReady)
  }

  /** Maintenance transition under the capacity lock. Transitions that free a permit
   * or clear the reservation wake text held back while maintenance was due. */
  private maintenanceTx<T>(work: (client: SqlClient) => Promise<T>, released: (result: T) => boolean = () => true): Promise<T> {
    const installationId = this.runtime.bootstrap.installationId
    return this.runtime.db.transaction(async client => {
      await lockCapacity(client, installationId)
      const result = await work(client)
      if (released(result)) await wakeEligible(client, this.runtime, installationId)
      return result
    })
  }

  private releaseRetainedRoute(attemptId: string): void {
    const release = this.retainedRoutes.get(attemptId)
    this.retainedRoutes.delete(attemptId)
    release?.()
  }

  private track(work: Promise<void>): void {
    this.active.add(work)
    const done = () => { this.active.delete(work) }
    work.then(done, done)
  }

  private async lockedRun(client:SqlClient,runId:string,beforeLock?:()=>Promise<void>):Promise<RunRow|undefined>{
    const locator=await runRow(client,runId)
    if(!locator)return undefined
    await beforeLock?.()
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[locator.thread_id])
    return runRow(client,runId)
  }

  async controlReceipt(actor: TrustedActor, input: ControlInput): Promise<ControlReceipt | { version:1; operationId:string; status:'unknown' }> {
    return this.runtime.db.transaction(async client => {
      const chat=await authorizedChat(client,actor,input.context,input.chatId)
      const row=await runRow(client,input.runId)
      if(!row||row.thread_id!==input.threadId||row.chat_id!==chat.id||row.installation_id!==actor.installationId||row.caller_id!==actor.personId||!!(await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 AND internal=true',[row.thread_id])).rows.length) throw new Error('Run target denied')
      const found=(await client.query<{receipt:ControlReceipt}>('SELECT receipt FROM kipster.work_controls WHERE installation_id=$1 AND caller_id=$2 AND operation_id=$3',[actor.installationId,actor.personId,input.operationId])).rows[0]
      return found?.receipt??{version:1 as const,operationId:input.operationId,status:'unknown' as const}
    })
  }

  async control(actor: TrustedActor, input: ControlInput): Promise<ControlReceipt> {
    if (!input.operationId || input.operationId.length > 200) throw new Error('Invalid operation ID')
    const cancelAttempts: string[] = []
    const receipt = await this.runtime.db.transaction(async client => {
      await lockCapacity(client, actor.installationId)
      const chat = await authorizedChat(client, actor, input.context, input.chatId)
      const row = await runRow(client, input.runId)
      if (!row || row.thread_id !== input.threadId || row.chat_id !== chat.id || row.installation_id !== actor.installationId || row.caller_id !== actor.personId || !!(await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 AND internal=true',[row.thread_id])).rows.length) throw new Error('Run target denied')
      // Retry starts new work, so the agent and organization must be live; owners are locked before the thread.
      const live = input.action !== 'retry' || await isLive(client,actor.installationId,'agent',chat.agent_id) && (chat.context_kind !== 'organization' || await isLive(client,actor.installationId,'organization',chat.context_id))
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
      const prior = (await client.query<{ receipt: ControlReceipt }>('SELECT receipt FROM kipster.work_controls WHERE installation_id=$1 AND caller_id=$2 AND operation_id=$3',[actor.installationId,actor.personId,input.operationId])).rows[0]
      if (prior) return prior.receipt
      let outcome: ControlReceipt['outcome'] = 'accepted', reason = ''
      if (input.action === 'steer') { outcome='unsupported'; reason='Adapter steering is unsupported' }
      else if (input.action === 'cancel-queued') {
        if (row.state !== 'queued' || row.current_attempt_id) { outcome='rejected'; reason='Work is not queued' }
        else {
          await client.query('UPDATE kipster.text_runs SET state=$2,revision=revision+1 WHERE id=$1',[row.id,'cancelled'])
          await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1',[row.id,'settled'])
        }
      } else if (input.action === 'stop') {
        if (!['queued','preparing','running','waiting','cancellation-requested'].includes(row.state)) { outcome='rejected'; reason='Work is already settled' }
        else if (row.current_attempt_id && input.attemptId !== row.current_attempt_id) { outcome='rejected'; reason='Attempt target changed' }
        else if (row.state === 'cancellation-requested') { outcome='accepted'; reason='Cancellation already requested' }
        else cancelAttempts.push(...(await stopRun(client,row)).cancelAttempts)
      } else if (input.action === 'resume') {
        const permit = await client.query('SELECT 1 FROM kipster.owned_permits WHERE attempt_id=$1',[row.current_attempt_id])
        if (!row.queue_hold || !['failed','cancelled','completed'].includes(row.state) || permit.rows.length) { outcome='rejected'; reason='Work is not safely held' }
        else await client.query('UPDATE kipster.text_runs SET queue_hold=false,queue_generation=queue_generation+1,retry_continue_generation=NULL,revision=revision+1 WHERE id=$1',[row.id])
      } else if (input.action === 'retry') {
        const permit = await client.query('SELECT 1 FROM kipster.owned_permits WHERE attempt_id=$1',[row.current_attempt_id])
        if (!live) { outcome='rejected'; reason='Agent is not available for new work' }
        else if (row.state !== 'failed' || !row.queue_hold || permit.rows.length || row.stop_requested || input.attemptId !== row.current_attempt_id || !await isHead(client,row)) { outcome='rejected'; reason='Failed work is not safe to retry' }
        else {
          await client.query('UPDATE kipster.text_runs SET state=$2,queue_hold=true,retry_continue_generation=queue_generation,failure=NULL,revision=revision+1 WHERE id=$1',[row.id,'queued'])
          await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1',[row.id,'queued'])
          await this.runtime.jobs.send(client,row.id)
        }
      }
      const current=await workRecord(client,row.id)
      if (outcome==='accepted') {
        await publishThreadChange(client,row.installation_id,row.caller_id,row.thread_id,row.chat_id,'work-changed',row.id,current.revision,current,current.state,null)
        if (input.action==='resume'||input.action==='cancel-queued') await wakeEligible(client,this.runtime,row.installation_id)
      }
      const result={ version:1 as const,operationId:input.operationId,outcome,reason,runId:row.id,threadId:row.thread_id,state:current.state }
      await client.query('INSERT INTO kipster.work_controls(installation_id,caller_id,operation_id,thread_id,run_id,attempt_id,action,outcome,reason,receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[actor.installationId,actor.personId,input.operationId,row.thread_id,row.id,input.attemptId??null,input.action,outcome,reason,JSON.stringify(result)])
      return result
    })
    if (input.action==='stop') {this.voiceControllers.get(input.runId)?.abort();for(const [key,controller] of this.toolControllers)if(key.startsWith(`${input.runId}:`))controller.abort()}
    for(const cancelAttempt of cancelAttempts)this.requestCancel(cancelAttempt)
    if (receipt.outcome === 'accepted') await finishRunDocuments(this.runtime.db, receipt.runId).catch(() => undefined)
    return receipt
  }

  /** Asks the adapter to cancel an attempt this process drives, once at a time, and records the answer. */
  private requestCancel(attemptId: string): void {
    const handle = this.handles.get(attemptId)
    if (!handle || this.cancelling.has(attemptId)) return
    this.cancelling.add(attemptId)
    void handle.cancel().then(result => this.recordCancellation(attemptId, result.acknowledged)).catch(() => this.recordCancellation(attemptId, false)).catch(() => undefined).finally(() => { this.cancelling.delete(attemptId) })
  }

  private async recordCancellation(attemptId:string, acknowledged:boolean): Promise<void> {
    const owner=(await this.runtime.db.query<{intent_id:string;installation_id:string}>('SELECT a.intent_id,i.installation_id FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id WHERE a.id=$1',[attemptId])).rows[0]
    if(!owner)return
    await this.runtime.db.transaction(async client=>{
      await lockCapacity(client,owner.installation_id)
      const row=await runRow(client,owner.intent_id)
      if(!row)return
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[row.thread_id])
      if(row.current_attempt_id!==attemptId||row.state!=='cancellation-requested')return
      await client.query('UPDATE kipster.text_runs SET cancel_delivery=$2,revision=revision+1 WHERE id=$1',[row.id,acknowledged?'acknowledged':'uncertain'])
      await publishThreadChange(client,row.installation_id,row.caller_id,row.thread_id,row.chat_id,'work-changed',row.id,await workRevision(client,row.id),await workRecord(client,row.id),row.state,null)
    })
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Text dispatcher is closed')
    if (!this.startPromise) this.startPromise = this.startOwned()
    try { await this.startPromise } catch (error) { this.startPromise = null; throw error }
  }

  private async startOwned(): Promise<void> {
    const lock = await this.holdLock()
    try {
    // A registry records its adapters as they are registered; a direct adapter is probed once here.
    if (this.adapter instanceof AdapterRegistry && !this.stopAdapterUpdates) {
      this.stopAdapterUpdates = this.adapter.onChange(() => { if (!this.stopped) void this.updateAdapters().catch(() => undefined) })
    }
    await this.updateAdapters(() => this.probeDirect())
    await this.recoverAbandoned()
    await this.hooks.afterStartupRecovery?.()
    if (this.lock !== lock) throw new Error('Coordinator lock lost during startup')
    this.started = true
    await this.coordinate()
    this.maintenanceTimer = setInterval(() => { void this.maintenanceTick() }, MAINTENANCE_LIMITS.scannerTickMs)
    this.maintenanceTimer.unref?.()
    // Runs whether or not this process coordinates: it drives its own attempts either way.
    this.cancellationTimer = setInterval(() => { void this.deliverCancellations().catch(() => undefined) }, CANCELLATION_DELIVERY_MS)
    this.cancellationTimer.unref?.()
    } catch (error) {
      if (this.lock === lock) this.lock = null
      this.started = false
      this.coordinating = false
      await lock.release()
      throw error
    }
  }

  private async holdLock(): Promise<CoordinatorLock> {
    const epoch = ++this.lockEpoch
    const lock = await this.runtime.db.acquireCoordinatorLock(error => this.lockLost(epoch, error))
    this.lock = lock
    return lock
  }

  /** The fence for claiming and issuing, checked inside the caller's capacity-locked transaction. Loss is
   * normally seen on the lock connection; this also covers a loss the connection has not reported yet. */
  private async mayCoordinate(client: SqlClient): Promise<boolean> {
    const lock = this.lock
    if (this.stopped || !this.coordinating || !lock) return false
    const held = await client.query(`SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory' AND classid=78315 AND objid=6 AND objsubid=2 AND pid=$1 AND granted`, [lock.pid])
    if (held.rows.length) return true
    lock.discard()
    this.lockLost(this.lockEpoch, new Error('Coordinator lock is no longer held'))
    return false
  }

  private async coordinate(): Promise<void> {
    if (this.stopped) return
    this.coordinating = true
    await this.runtime.jobs.work(async id => {
      const work = id === MAINTENANCE_SWEEP_JOB_ID
        ? this.processMaintenanceSweep().catch(error => this.reportMaintenanceFailure(this.runtime.bootstrap.installationId, error))
        : this.process(id)
      this.active.add(work)
      try { await work } finally { this.active.delete(work) }
    })
    if (this.coordinating && !this.stopped) await this.operations.start()
    if (!this.coordinating || this.stopped) {
      this.coordinating = false
      await this.runtime.jobs.stopWork()
      await this.operations.stop()
    }
  }

  /** Stops claiming and issuing at once. Another coordinator may take the lock meanwhile;
   * this one keeps retrying and never resumes without it. */
  private lockLost(epoch: number, error: Error): void {
    if (epoch !== this.lockEpoch || this.stopped) return
    this.lock = null
    if (!this.coordinating) return
    this.coordinating = false
    void this.runtime.jobs.stopWork().catch(() => undefined)
    void this.operations.stop().catch(() => undefined)
    this.reportLock('lost', error)
    if (this.relocking) return
    this.relocking = true
    this.track(this.reacquire().finally(() => { this.relocking = false }))
  }

  private async reacquire(): Promise<void> {
    for (let delay = lockRetryMs.first; ; delay = Math.min(delay * 2, lockRetryMs.max)) {
      await new Promise<void>(resolve => { this.wakeRelock = resolve; setTimeout(resolve, delay).unref?.() })
      this.wakeRelock = null
      if (this.stopped) return
      await this.cancelRecovered().catch(() => undefined)
      let lock: CoordinatorLock | undefined
      try {
        lock = await this.holdLock()
        if (!this.stopped) await this.recoverAbandoned()
        if (this.lock === lock) await this.coordinate()
        if (this.coordinating) {
          this.reportLock('restored')
          await this.cancelRecovered().catch(() => undefined)
          return
        }
      } catch (error) {
        if (!(error instanceof Error && error.message === 'Text coordinator already active')) this.reportLock('retry-failed', error)
      }
      this.coordinating = false
      if (this.lock === lock) this.lock = null
      await lock?.release().catch(() => undefined)
      if (this.stopped) return
    }
  }

  /** Cancels provider turns this process still drives after another coordinator recovered their attempts. */
  private async cancelRecovered(): Promise<void> {
    if (!this.live.size) return
    const recovered = await this.runtime.db.query<{ id: string }>(`SELECT id FROM kipster.attempts WHERE id = ANY($1::uuid[]) AND state='uncertain'`, [[...this.live]])
    for (const { id } of recovered.rows) void this.handles.get(id)?.cancel().catch(() => undefined)
  }

  private reportLock(state: 'lost' | 'retry-failed' | 'restored', error?: unknown): void {
    void Promise.resolve().then(() => this.hooks.coordinatorLock?.(state, error)).catch(() => undefined)
  }

  /** Only the lock holder may reconcile abandoned work. Attempts this process still drives are not abandoned. */
  private async recoverAbandoned(): Promise<void> {
    await this.runtime.db.transaction(async client => {
      const ids = await client.query<{ installation_id: string }>('SELECT installation_id FROM kipster.bootstrap ORDER BY installation_id')
      for (const { installation_id: installationId } of ids.rows) {
        await lockCapacity(client, installationId)
        const rows = await client.query<{ id: string; thread_id: string; state: string; current_attempt_id: string | null }>(`SELECT r.id,r.thread_id,r.state,r.current_attempt_id FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE c.installation_id=$1 AND r.current_attempt_id <> ALL($2::uuid[]) AND (r.state='preparing' OR (r.state IN ('running','waiting','cancellation-requested') AND EXISTS (SELECT 1 FROM kipster.attempts a WHERE a.id=r.current_attempt_id AND a.state='issued'))) ORDER BY r.thread_id,r.queue_position`, [installationId, [...this.live]])
        for (const row of rows.rows) {
          await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
          let voiceChanged=false
          if (row.state === 'preparing') {
            voiceChanged=!!(await client.query("UPDATE kipster.voice_preparations SET status='unavailable',failure='interrupted',revision=revision+1 WHERE attempt_id=$1 AND status='preparing'",[row.current_attempt_id])).rowCount
            await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [row.current_attempt_id, 'settled', 'preparing'])
            await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state=$3', [row.id, 'queued', 'preparing'])
            await client.query('UPDATE kipster.text_runs SET state=$2,current_attempt_id=NULL,revision=revision+1 WHERE id=$1', [row.id, 'queued'])
          } else {
            await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [row.current_attempt_id, 'uncertain', 'issued'])
            await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state=$3', [row.id, 'uncertain', 'issued'])
            await client.query('UPDATE kipster.text_runs SET state=$2,queue_hold=true,cancel_delivery=CASE WHEN stop_requested THEN $4 ELSE cancel_delivery END,revision=revision+1,failure=$3 WHERE id=$1', [row.id, 'recovery-needed', 'Provider outcome requires reconciliation','uncertain'])
          }
          if (row.current_attempt_id && row.state !== 'preparing') await sealAttemptMessages(client, row.current_attempt_id, 'recovery-needed')
          const current = await runRow(client, row.id)
          if (current) {
            if(voiceChanged)await publishThreadChange(client,installationId,current.caller_id,row.thread_id,current.chat_id,'message-final',current.input_message_id,await this.bumpMessage(client,current.input_message_id),await messageRecord(client,current.input_message_id),'queued',null)
            await publishThreadChange(client, installationId, current.caller_id, row.thread_id, current.chat_id, 'work-changed', row.id, await workRevision(client, row.id), await workRecord(client, row.id), row.state === 'preparing' ? 'queued' : 'recovery-needed', null)
            if (row.state !== 'preparing') await createNotification(client, installationId, current.caller_id, row.thread_id, row.id, 'recovery-needed')
            // As in settle(): an uncertain attempt cannot continue, so its open question cannot accept an answer.
            const superseded = row.state === 'preparing' ? undefined : (await client.query<{ id: string }>(`UPDATE kipster.interactions SET state='superseded',revision=revision+1 WHERE id=$1 AND attempt_id=$2 AND state='pending' RETURNING id`, [current.continuation_interaction_id, row.current_attempt_id])).rows[0]
            if (superseded) {
              const card = await interactionRecord(client, superseded.id)
              await publishThreadChange(client, installationId, current.caller_id, row.thread_id, current.chat_id, 'interaction-changed', card.id, card.revision, card, 'recovery-needed', null)
              await interactionNotificationChanged(client, card.id)
            }
          }
        }
        await wakeEligible(client, this.runtime, installationId)
        const service = new MaintenanceService(this.runtime.db, installationId)
        await service.fenceInterruptedIssued(client, { exclude: [...this.live] })
        await service.expireUnissuedClaims(client, this.runtime.jobs, { all: true })
        await service.reapIntents(client)
        if (this.maintenanceActive() && await service.learningEnabled(client)) await this.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      }
    })
    await reconcileInterruptedDelegations(this.runtime.db)
  }

  private async prepareVoice(runId:string, context:NonNullable<Awaited<ReturnType<typeof runContext>>>, attemptId:string):Promise<void> {
    const rows=(await this.runtime.db.query<{ordinal:number;artifact_id:string;source_sha256:string;status:string}>(`SELECT v.ordinal,v.artifact_id,v.source_sha256,v.status FROM kipster.voice_preparations v WHERE v.message_id=$1 ORDER BY v.ordinal`,[context.inputMessageId])).rows
    if (!rows.length) return
    const controller=new AbortController()
    this.voiceControllers.set(runId,controller)
    const deadline=setTimeout(()=>controller.abort(),120000)
    try {
      for(const item of rows){
        if(controller.signal.aborted || this.stopped) break
        if(item.status!=='pending') continue
        const claimed=await this.runtime.db.transaction(async client=>{
          const run=await this.lockedRun(client,runId,async()=>{await this.hooks.beforeVoiceClaimLock?.(runId)})
          if(!run||run.current_attempt_id!==attemptId||run.state!=='preparing'||run.stop_requested)return false
          const changed=await client.query(`UPDATE kipster.voice_preparations SET status='preparing',attempt_id=$3,provider_id=$4,revision=revision+1 WHERE message_id=$1 AND ordinal=$2 AND status='pending' AND source_sha256=$5`,[context.inputMessageId,item.ordinal,attemptId,this.runtime.transcription?.id??'unconfigured',item.source_sha256])
          if(changed.rowCount)await publishThreadChange(client,run.installation_id,run.caller_id,run.thread_id,run.chat_id,'message-final',context.inputMessageId,await this.bumpMessage(client,context.inputMessageId),await messageRecord(client,context.inputMessageId),'preparing',null)
          return !!changed.rowCount
        })
        if(!claimed)continue
        let result:{status:'succeeded'|'no-speech';text:string;provider:string}|{status:'unavailable';reason:string;provider:string}
        try {
          const file=await this.runtime.artifacts.inputForExecution(context.actor,item.artifact_id,{installationId:context.actor.installationId,callerId:context.actor.personId,context:context.context,chatId:context.chatId,threadId:context.threadId})
          const identity=(await this.runtime.db.query<{sha256:string}>(`SELECT sha256 FROM kipster.artifacts WHERE id=$1`,[item.artifact_id])).rows[0]
          if(file.availability!=='available'||identity?.sha256!==item.source_sha256) result={status:'unavailable',reason:'invalid-input',provider:this.runtime.transcription?.id??'unconfigured'}
          else if(!this.runtime.transcription) result={status:'unavailable',reason:'unavailable',provider:'unconfigured'}
          else if(!acceptsType(this.runtime.transcription,file.mimeType)) result={status:'unavailable',reason:'invalid-input',provider:this.runtime.transcription.id}
          else result=await abortableResult(controller.signal,()=>this.runtime.transcription!.transcribe({path:file.readablePath,mimeType:file.mimeType,size:file.size,signal:controller.signal}),{status:'unavailable',reason:'timeout',provider:this.runtime.transcription.id})
        } catch {result={status:'unavailable',reason:'provider-error',provider:this.runtime.transcription?.id??'unconfigured'}}
        result=normalizedTranscription(result,this.runtime.transcription?.id??'unconfigured')
        await this.runtime.db.transaction(async client=>{
          const run=await this.lockedRun(client,runId,async()=>{await this.hooks.beforeVoiceSettleLock?.(runId)})
          if(!run||run.current_attempt_id!==attemptId||run.state!=='preparing'||run.stop_requested)return
          const updated=await client.query(`UPDATE kipster.voice_preparations SET status=$4,transcript=$5,failure=$6,revision=revision+1 WHERE message_id=$1 AND ordinal=$2 AND status='preparing' AND attempt_id=$3`,[context.inputMessageId,item.ordinal,attemptId,result.status,result.status==='unavailable'?null:result.text,result.status==='unavailable'?result.reason:null])
          if(updated.rowCount)await publishThreadChange(client,run.installation_id,run.caller_id,run.thread_id,run.chat_id,'message-final',context.inputMessageId,await this.bumpMessage(client,context.inputMessageId),await messageRecord(client,context.inputMessageId),'preparing',null)
        })
      }
      if(!this.stopped)await this.runtime.db.transaction(async client=>{
        const run=await this.lockedRun(client,runId)
        if(!run||run.current_attempt_id!==attemptId||run.state!=='preparing'||run.stop_requested)return
        const remaining=await client.query("UPDATE kipster.voice_preparations SET status='unavailable',failure='timeout',provider_id=$2,revision=revision+1 WHERE message_id=$1 AND status='pending'",[context.inputMessageId,this.runtime.transcription?.id??'unconfigured'])
        if(remaining.rowCount)await publishThreadChange(client,run.installation_id,run.caller_id,run.thread_id,run.chat_id,'message-final',context.inputMessageId,await this.bumpMessage(client,context.inputMessageId),await messageRecord(client,context.inputMessageId),'preparing',null)
      })
    } finally {clearTimeout(deadline);this.voiceControllers.delete(runId)}
  }
  private async bumpMessage(client:SqlClient,messageId:string):Promise<number>{const row=(await client.query<{revision:string}>('UPDATE kipster.messages SET revision=revision+1 WHERE id=$1 RETURNING revision',[messageId])).rows[0]!;return Number(row.revision)}

  private async process(runId: string): Promise<void> {
    if (this.stopped) return
    if (!this.coordinating) return this.passWakeup(runId)
    const context = await runContext(this.runtime.db, runId)
    if (!context) return
    let paused = false, updatePaused = false
    const attempt = await this.runtime.db.transaction(async client => {
      if (await lockCapacity(client, context.actor.installationId) === 0) { paused = true; updatePaused = true; return null }
      if (!await this.mayCoordinate(client)) { paused = !this.stopped; return null }
      const row = await runRow(client, runId)
      if (!row || row.state !== 'queued') return null
      // Work runs only for a live agent in a live organization; owners are locked before the thread.
      const live = await isLive(client, row.installation_id, 'agent', context.agentId) && (context.context.kind !== 'organization' || await isLive(client, row.installation_id, 'organization', context.context.organizationId))
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
      if (!live) { await this.stopUnavailable(client, runId); return null }
      if (!await isHead(client, row)) return null
      const claim = await claimPreparation(client, runId, this.incarnation)
      if (!claim) return null
      await client.query('UPDATE kipster.text_runs SET state=$2,current_attempt_id=$3,revision=revision+1 WHERE id=$1', [runId, 'preparing', claim.id])
      await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'work-changed', runId, await workRevision(client, runId), await workRecord(client, runId), 'preparing', null)
      this.live.add(claim.id)
      return claim
    })
    if (!attempt) { if (paused) await this.passWakeup(runId, updatePaused ? 5 : 0); return }
    try { await this.prepareClaimed(runId, context, attempt) } finally { this.live.delete(attempt.id) }
  }

  /** Stops queued work whose agent or organization is no longer live, as fencing does. Caller holds the capacity and thread locks. */
  private async stopUnavailable(client: SqlClient, runId: string): Promise<void> {
    const row = await runRow(client, runId)
    if (!row || row.state !== 'queued' || row.stop_requested) return
    const stopped = await stopRun(client, row)
    await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'work-changed', runId, await workRevision(client, runId), await workRecord(client, runId), stopped.state, null)
    if (await childDelegation(client, runId)) await finishDelegation(client, this.runtime.jobs, runId, 'failed', 'Agent is not available for new work')
  }

  /**
   * Asks the adapter to cancel attempts this process drives whose run was stopped elsewhere, for
   * example by fencing, and interrupts their voice and tool work. Runs after every committed operation
   * step and every few seconds, whether or not this process coordinates.
   */
  async deliverCancellations(): Promise<void> {
    if (this.stopped) return
    if (this.handles.size) {
      const rows = await this.runtime.db.query<{ id: string }>(`SELECT r.current_attempt_id AS id FROM kipster.text_runs r
        WHERE r.current_attempt_id = ANY($1::uuid[]) AND r.state='cancellation-requested' AND r.cancel_delivery='requested'`, [[...this.handles.keys()]])
      for (const { id } of rows.rows) this.requestCancel(id)
    }
    const controlled = [...new Set([...this.voiceControllers.keys(), ...[...this.toolControllers.keys()].map(key => key.split(':')[0]!)])]
    if (!controlled.length) return
    const stopped = await this.runtime.db.query<{ id: string }>('SELECT id FROM kipster.text_runs WHERE id = ANY($1::uuid[]) AND stop_requested', [controlled])
    for (const { id } of stopped.rows) {
      this.voiceControllers.get(id)?.abort()
      for (const [key, controller] of this.toolControllers) if (key.startsWith(`${id}:`)) controller.abort()
    }
  }

  /** A paused process leaves the wakeup for whichever coordinator holds the lock. */
  private async passWakeup(runId: string, delaySeconds = 0): Promise<void> {
    await this.runtime.jobs.send(this.runtime.db, runId, delaySeconds).catch(() => undefined)
  }

  private async prepareClaimed(runId: string, context: NonNullable<Awaited<ReturnType<typeof runContext>>>, attempt: Attempt): Promise<void> {
    await this.hooks.afterClaim?.(runId)
    await this.prepareVoice(runId, context, attempt.id)
    let execution: ExecutionContext
    let recalled: readonly string[] = []
    let route: { adapter: TextExecutionAdapter; generationId?: string; incarnation?: string; installationDigest?: string; installationRoot?: string; supportedOptions?: readonly string[]; release(attemptId: string): void } | undefined
    try {
      const resolve = () => resolveSettings(this.runtime.db, this.runtime.home, context.actor, context.agentId, context.context.kind === 'organization' ? context.context.organizationId : null, this.catalog())
      let resolved = await resolve()
      if (resolved.status === 'incompatible' && resolved.settings.adapterId && await this.reprobe(resolved.settings.adapterId)) resolved = await resolve()
      if ('reason' in resolved) throw new Error('Execution configuration: ' + resolved.reason)
      if (this.adapter instanceof AdapterRegistry) route = this.adapter.selected(resolved.settings.adapterId!, attempt.id)
      else if (resolved.settings.adapterId === this.adapter.id) route = { adapter: this.adapter, release() {} }
      if (!route) throw new Error('Selected adapter unavailable')
      const unsupported = Object.keys(resolved.settings.options ?? {}).filter(key => !(route!.supportedOptions ?? []).includes(key))
      if (unsupported.length) throw new Error(`Unsupported execution option: ${unsupported.join(', ')}`)
      const history = await executionHistory(this.runtime.db, runId)
      // A removed file is left out; its message keeps the other parts.
      const input = await Promise.all(history.messages.map(async message=>({messageId:message.messageId,text:message.text,parts:(await Promise.all(message.parts.map(async (part,index)=>{
        if(part.kind==='text')return part
        if(part.kind==='removed')return null
        if(part.kind==='document')return {kind:'text' as const,text:await documentInput(this.runtime.db,part.documentId,part.revision)}
        const file=await this.runtime.artifacts.inputForExecution(context.actor,part.artifactId,{installationId:context.actor.installationId,callerId:context.actor.personId,context:context.context,chatId:context.chatId,threadId:context.threadId})
        const derived=part.purpose==='voice_note'?(await this.runtime.db.query<{status:string;transcript:string|null;provider_id:string|null;failure:string|null}>(`SELECT status,transcript,provider_id,failure FROM kipster.voice_preparations WHERE message_id=$1 AND ordinal=$2`,[message.messageId,index])).rows[0]:undefined
        return {kind:'file' as const,purpose:part.purpose,...file,...(derived?{transcription:{status:derived.status==='pending'||derived.status==='preparing'?'unavailable':derived.status,provider:derived.provider_id??'unconfigured',...(derived.transcript!==null?{text:derived.transcript}:{}),...(derived.failure?{reason:derived.failure}:{})}}:{})}
      }))).filter(part=>part!==null)})))
      const outputDirectory=await this.runtime.artifacts.outputDirectory(context.agentId,context.threadId,attempt.id)
      const organizationId=context.context.kind === 'organization' ? context.context.organizationId : null
      const triggerText=history.messages.find(message=>message.messageId===context.inputMessageId)?.text??''
      let memory: readonly string[] = []
      if (this.memory) memory = await this.memory.read(context.agentId,organizationId,context.threadId,triggerText)
      else if (this.runtime.memory) ({ excerpts: memory, memoryIds: recalled } = await this.runtime.memory.recall(context.agentId,organizationId,triggerText))
      const interactionRows = (await this.runtime.db.query<{ id:string }>("SELECT id FROM kipster.interactions WHERE run_id=$1 AND state='settled' ORDER BY created_at,id",[runId])).rows
      const settledInteractions = await Promise.all(interactionRows.map(row=>interactionRecord(this.runtime.db,row.id)))
      const interactions = settledInteractions.filter(item=>item.response).map(item=>({id:item.id,kind:item.kind,prompt:item.prompt,options:item.options,freeText:item.freeText,...(item.proposalId?{proposalId:item.proposalId}:{}),...(item.proposal?{proposal:item.proposal}:{}),response:{actorId:item.response!.actorId,answer:item.response!.answer,acceptedAt:item.response!.acceptedAt}}))
      const latest = interactions.at(-1)
      const delegationRows=(await this.runtime.db.query<{id:string;recipient_agent_id:string;request:string;state:string;result:string|null;failure:string|null}>(`SELECT id,recipient_agent_id,request,state,result,failure FROM kipster.delegations WHERE parent_run_id=$1 AND state IN ('completed','failed','cancelled','recovery-needed') ORDER BY ordinal`,[runId])).rows
      const delegationResults=delegationRows.map(row=>({id:row.id,recipientAgentId:row.recipient_agent_id,request:row.request,state:row.state,...(row.result!==null?{result:row.result}:{}),...(row.failure!==null?{failure:row.failure}:{})}))
      const administrationEnabled = await administrationRun(this.runtime.db, context.actor.installationId, runId)
      const adminReceipts = administrationEnabled ? await administrationReceipts(this.runtime.db, context.actor.installationId, context.agentId, runId) : undefined
      const tools = executionTools({ organization: organizationId !== null, memory: !!this.runtime.memory, structured: !!this.runtime.structured, vectors: !!this.runtime.vectors, administration: administrationEnabled })
      const instructions = [resolved.instructions.system, resolved.instructions.agent, resolved.instructions.soul, resolved.instructions.identity, resolved.instructions.organization, toolGuidance, skillsSection(administrationEnabled ? [adminSkill] : [])].filter(Boolean).join('\n\n')
      execution = { ...(adminReceipts ? { administrationReceipts: adminReceipts } : {}), runId, attemptId: attempt.id, attemptGeneration: attempt.generation, incarnation: attempt.incarnation, organizationId, agentId: context.agentId, workingDirectory: this.runtime.home.agent(context.agentId), outputDirectory, instructions, memory, tools, settings: { adapterId: resolved.settings.adapterId!, modelId: resolved.settings.modelId!, ...(resolved.settings.effort ? { effort: resolved.settings.effort } : {}), ...(resolved.settings.options ? { options: resolved.settings.options } : {}) }, triggerMessageId: context.inputMessageId, input, interactions, delegationResults, ...(latest ? { continuation: { kind: latest.kind, prompt: latest.prompt, ...(latest.proposalId ? { proposalId: latest.proposalId } : {}), ...(latest.proposal ? { proposal: latest.proposal } : {}) , answer: latest.response.answer } } : {}) }
    } catch (error) {
      route?.release(attempt.id)
      await this.settle(attempt, 'failed', error instanceof Error ? error.message : 'Preparation failed', true)
      return
    }
    let paused = false, updatePaused = false
    const admitted = await this.runtime.db.transaction(async client => {
      const ceiling = await lockCapacity(client, context.actor.installationId)
      const row = await runRow(client, runId)
      if (!row) return false
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
      if (row.state !== 'preparing' || row.current_attempt_id !== attempt.id || !await isHead(client, row)) return false
      const held = (await client.query<{ count: string }>('SELECT count(*) FROM kipster.owned_permits WHERE installation_id=$1', [row.installation_id])).rows[0]!
      const maintenanceDue = this.maintenanceServable()
        ? await new MaintenanceService(this.runtime.db, row.installation_id).maintenanceDue(client)
        : false
      paused = !await this.mayCoordinate(client)
      updatePaused = ceiling === 0
      if (paused || ceiling - Number(held.count) < (maintenanceDue ? 2 : 1)) {
        await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [attempt.id, 'settled', 'preparing'])
        await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state=$3', [runId, 'queued', 'preparing'])
        await client.query('UPDATE kipster.text_runs SET state=$2,current_attempt_id=NULL,revision=revision+1 WHERE id=$1', [runId, 'queued'])
        await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'work-changed', runId, await workRevision(client, runId), await workRecord(client, runId), 'queued', null)
        return false
      }
      if (!await issueAttempt(client, attempt)) return false
      if (this.runtime.memory) await new MaintenanceService(this.runtime.db, row.installation_id).recordActivity(client, context.agentId, recalled, this.runtime.clock())
      if (route?.generationId) await client.query('UPDATE kipster.attempts SET adapter_id=$2,adapter_generation_id=$3,runner_incarnation=$4,adapter_installation_digest=$5,adapter_installation_root=$6 WHERE id=$1', [attempt.id, route.adapter.id, route.generationId, route.incarnation, route.installationDigest, route.installationRoot])
      await client.query('INSERT INTO kipster.owned_permits(attempt_id,installation_id) VALUES ($1,$2)', [attempt.id, row.installation_id])
      await client.query('UPDATE kipster.execution_permits SET maintenance_counter=LEAST(maintenance_counter+1,1000000) WHERE installation_id=$1', [row.installation_id])
      await client.query('UPDATE kipster.text_runs SET state=$2,revision=revision+1 WHERE id=$1', [runId, 'running'])
      await publishThreadChange(client, row.installation_id, row.caller_id, row.thread_id, row.chat_id, 'work-changed', runId, await workRevision(client, runId), await workRecord(client, runId), 'running', null)
      return true
    })
    if (!admitted) {
      route.release(attempt.id)
      if ((paused || updatePaused) && !this.stopped) await this.passWakeup(runId, updatePaused ? 5 : 0)
      return
    }
    await this.driveIssued(runId, attempt, context, route, execution)
  }

  private async driveIssued(runId: string, attempt: Attempt, context: NonNullable<Awaited<ReturnType<typeof runContext>>>, route: { adapter: TextExecutionAdapter; release(attemptId: string): void }, execution: ExecutionContext): Promise<void> {
    await this.runtime.db.transaction(async client=>{
      const child=await childDelegation(client,runId)
      if(!child)return
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[child.originThreadId])
      const changed=await client.query<{id:string}>("UPDATE kipster.delegations SET state='running',revision=revision+1 WHERE id=$1 AND state='queued' RETURNING id",[child.id])
      if(changed.rows.length){const record=await delegationRecord(client,child.id);await publishThreadChange(client,context.actor.installationId,context.actor.personId,child.originThreadId,context.chatId,'delegation-changed',child.id,record.revision,delegationActivity(record),'running',null)}
    })
    await this.hooks.afterIssue?.(attempt.id)
    try {
      const handle = await route.adapter.execute(execution)
      this.handles.set(attempt.id, handle)
      const stoppedDuringDispatch = (await this.runtime.db.query<{ stop_requested:boolean }>('SELECT stop_requested FROM kipster.text_runs WHERE id=$1 AND current_attempt_id=$2',[runId,attempt.id])).rows[0]
      if (stoppedDuringDispatch?.stop_requested) this.requestCancel(attempt.id)
      for await (const event of coalesceDrafts(handle.events)) {
        if (event.attemptId !== attempt.id) continue
        if (event.kind === 'provider') {
          await this.recordProvider(attempt, event)
        } else if (event.kind === 'text') {
          if (event.text || event.final) await this.publishText(attempt, event, context, 'native')
        } else if (event.kind === 'ended') {
          await this.settle(attempt, 'completed', null, false)
          this.handles.delete(attempt.id)
          route.release(attempt.id)
          return
        } else if (event.kind === 'failed') {
          await this.settle(attempt, event.confirmedEnded ? 'failed' : 'recovery-needed', event.message, false)
          if (event.confirmedEnded) this.handles.delete(attempt.id)
          if (event.confirmedEnded) route.release(attempt.id)
          return
        } else if (event.kind === 'waiting') {
          // The interaction was committed by the Core host before this observation.
          continue
        }
      }
      await this.settle(attempt, 'recovery-needed', 'Provider stream ended without a terminal observation', false)
    } catch (error) {
      await this.settle(attempt, 'recovery-needed', error instanceof Error ? error.message : 'Provider outcome unknown', false)
    }
  }

  private async processMaintenanceSweep(restarted = false): Promise<void> {
    if (this.stopped || !this.coordinating) return
    // Skipping sources of agents that stopped learning can clear a reservation that held back text.
    const claim = await this.maintenanceTx(async client => {
      if (!await this.mayCoordinate(client)) return null
      return await this.maintenance.claimSleepRun(client, this.incarnation, this.maintenanceActive())
        ?? this.maintenance.claimSource(client, this.incarnation, this.maintenanceActive())
    }, result => !!result && 'skipped' in result && typeof result.skipped === 'number' && result.skipped > 0)
    if (!claim || 'refused' in claim) return
    if ('sleepRun' in claim) {
      try {
        await this.driveSleepRun(claim.sleepRun, claim.attempt)
      } catch (error) {
        await this.maintenanceTx(client => this.maintenance.failSleepRun(client, this.runtime.jobs, claim.sleepRun.runId, claim.attempt, error instanceof Error ? error.message : 'Preparation failed'))
      }
      return
    }
    try {
      await this.hooks.afterMaintenanceClaim?.(claim.source.runId)
      await this.driveMaintenanceClaim(claim.source, claim.runId, claim.attempt, restarted)
    } catch (error) {
      await this.failMaintenancePreparation(claim.source, claim.runId, claim.attempt, error instanceof Error ? error.message : 'Preparation failed')
    }
  }

  private async failMaintenancePreparation(source: MaintenanceSource, runId: string, attempt: Attempt, reason: string): Promise<void> {
    await this.maintenanceTx(client => this.maintenance.failPreparation(client, this.runtime.jobs, runId, attempt, source.runId, source.revision, reason))
  }

  private async driveMaintenanceClaim(source: MaintenanceSource, runId: string, attempt: Attempt, restarted: boolean): Promise<void> {
    const fail = (reason: string): Promise<void> => this.failMaintenancePreparation(source, runId, attempt, reason)
    const organizationId = source.contextKind === 'organization' ? source.contextId : null
    const resolve = () => resolveAgentSettings(this.runtime.db, this.runtime.home, this.runtime.bootstrap.installationId, source.agentId, organizationId, this.catalog())
    let resolved = await resolve()
    if (resolved.status === 'incompatible' && resolved.settings.adapterId && await this.reprobe(resolved.settings.adapterId)) resolved = await resolve()
    if ('reason' in resolved) return fail(`Execution configuration: ${resolved.reason}`)
    const { adapterId, modelId } = resolved.settings
    if (!adapterId || !modelId) return fail('Execution configuration: Adapter and model must be configured')
    let route: { adapter: TextExecutionAdapter; generationId?: string; installationDigest?: string; incarnation?: string; installationRoot?: string; supportedOptions?: readonly string[]; release(attemptId: string): void } | undefined
    if (this.adapter instanceof AdapterRegistry) route = this.adapter.selected(adapterId, attempt.id, 'maintenance')
    else if (this.directMaintenanceReady && adapterId === this.adapter.id) route = { adapter: this.adapter, release() {} }
    if (!route) return fail('Selected adapter unavailable for maintenance')
    const selected = route
    let issued = false
    let recaptured = false
    try {
      const unsupported = Object.keys(resolved.settings.options ?? {}).filter(key => !(selected.supportedOptions ?? []).includes(key))
      if (unsupported.length) return await fail(`Unsupported execution option: ${unsupported.join(', ')}`)
      let recoveryVersions: readonly number[] | undefined
      if (this.adapter instanceof AdapterRegistry) recoveryVersions = this.adapter.recoveryVersions(adapterId)
      else {
        const direct = selected.adapter as Partial<MaintenanceCapableAdapter>
        if (typeof direct.durableReconcile === 'function' && Array.isArray(direct.recoveryVersions) && direct.recoveryVersions.length) recoveryVersions = direct.recoveryVersions
      }
      if (!recoveryVersions?.length) return await fail('Adapter durable recovery unavailable')
      const recoveryVersion = Math.max(...recoveryVersions)
      const verified = await this.runtime.db.transaction(async client => this.maintenance.verifiedSourceTexts(client, source))
      if ('mismatch' in verified) {
        recaptured = await this.maintenanceTx(client => this.maintenance.recaptureStaleSource(client, this.runtime.jobs, runId, attempt, source, !restarted))
        return
      }
      const prompt = `${MAINTENANCE_INSTRUCTIONS_V1}\n\nFrozen source messages:\n${verified.map(entry => `--- message_id=${entry.messageId} revision=${entry.revision} parts_hash=${entry.partsHash} author_id=${entry.authorId} author_class=${entry.authorClass} position=${entry.position} ---\n${entry.text}`).join('\n')}`
      const execution: MaintenanceExecutionContext = {
        kind: 'maintenance', runId, attemptId: attempt.id, attemptGeneration: attempt.generation, incarnation: attempt.incarnation,
        organizationId, agentId: source.agentId,
        maintenance: {
          task: 'extract', sourceRunId: source.runId, sourceRevision: source.revision, contextKind: source.contextKind, contextId: source.contextId,
          instructions: prompt,
          sources: verified.map(entry => ({
            messageId: entry.messageId, position: entry.position, revision: entry.revision, partsHash: entry.partsHash,
            authorId: entry.authorId, authorClass: entry.authorClass, text: entry.text,
          })),
          settings: {
            adapterId, modelId,
            ...(resolved.settings.effort ? { effort: resolved.settings.effort } : {}),
            ...(resolved.settings.options ? { options: resolved.settings.options } : {}),
          },
        },
      }
      // Without the coordinator lock the claim is refunded unissued.
      const outcome = await this.maintenanceTx(async client => {
        const result = await this.maintenance.issueMaintenance(client, this.runtime.jobs, runId, attempt, source.runId, source.revision,
          this.incarnation, await this.mayCoordinate(client), adapterId, recoveryVersion, selected.generationId, selected.installationDigest, selected.incarnation, selected.installationRoot)
        if ('issued' in result) this.live.add(attempt.id)
        return result
      }, result => 'refused' in result).catch(error => { this.live.delete(attempt.id); throw error })
      if ('refused' in outcome) return
      issued = true
      await this.hooks.afterMaintenanceIssue?.(runId)
      await this.executeMaintenanceAttempt(selected, execution, attempt)
    } finally {
      this.live.delete(attempt.id)
      // Before issue no provider was contacted; afterwards the attempt owns the route.
      if (!issued) selected.release(attempt.id)
    }
    if (recaptured) await this.processMaintenanceSweep(true)
  }

  /** Prepares and issues one sleep run, a consolidation or an identity promotion, with the agent's own configured
   * model. Memories changed since the freeze are left out. A consolidation with no new memory left, or a promotion whose
   * identity.md changed since the freeze, fails without a model call. */
  private async driveSleepRun(sleepRun: SleepRunClaim, attempt: Attempt): Promise<void> {
    const { runId, agentId } = sleepRun
    const fail = (reason: string): Promise<void> => this.maintenanceTx(client => this.maintenance.failSleepRun(client, this.runtime.jobs, runId, attempt, reason))
    const resolve = () => resolveAgentSettings(this.runtime.db, this.runtime.home, this.runtime.bootstrap.installationId, agentId, null, this.catalog())
    let resolved = await resolve()
    if (resolved.status === 'incompatible' && resolved.settings.adapterId && await this.reprobe(resolved.settings.adapterId)) resolved = await resolve()
    if ('reason' in resolved) return fail(`Execution configuration: ${resolved.reason}`)
    const { adapterId, modelId } = resolved.settings
    if (!adapterId || !modelId) return fail('Execution configuration: Adapter and model must be configured')
    let route: { adapter: TextExecutionAdapter; generationId?: string; installationDigest?: string; incarnation?: string; installationRoot?: string; supportedOptions?: readonly string[]; release(attemptId: string): void } | undefined
    if (this.adapter instanceof AdapterRegistry) route = this.adapter.selected(adapterId, attempt.id, 'maintenance')
    else if (this.directMaintenanceReady && adapterId === this.adapter.id) route = { adapter: this.adapter, release() {} }
    if (!route) return fail('Selected adapter unavailable for maintenance')
    const selected = route
    let issued = false
    try {
      const unsupported = Object.keys(resolved.settings.options ?? {}).filter(key => !(selected.supportedOptions ?? []).includes(key))
      if (unsupported.length) return await fail(`Unsupported execution option: ${unsupported.join(', ')}`)
      const direct = selected.adapter as Partial<MaintenanceCapableAdapter>
      const recoveryVersions = this.adapter instanceof AdapterRegistry ? this.adapter.recoveryVersions(adapterId)
        : typeof direct.durableReconcile === 'function' ? direct.recoveryVersions : undefined
      if (!recoveryVersions?.length) return await fail('Adapter durable recovery unavailable')
      const settings = {
        adapterId, modelId,
        ...(resolved.settings.effort ? { effort: resolved.settings.effort } : {}),
        ...(resolved.settings.options ? { options: resolved.settings.options } : {}),
      }
      const installationId = this.runtime.bootstrap.installationId
      let maintenance: MaintenanceExecutionContext['maintenance']
      if (sleepRun.taskKind === 'identity') {
        const { input } = sleepRun
        const prompt = await this.runtime.db.transaction(client => promotionPrompt(client, this.runtime.home.identity, installationId, agentId, input))
        if (!prompt) return await fail('identity.md changed')
        maintenance = { task: 'identity', ...prompt, settings }
      } else {
        const { input } = sleepRun
        const prompt = await this.runtime.db.transaction(client => consolidationPrompt(client, installationId, agentId, input))
        if (!prompt) return await fail('inputs changed')
        maintenance = { task: 'consolidate', ...prompt, lessonsMax: CONSOLIDATION.lessons, settings }
      }
      const execution: MaintenanceExecutionContext = {
        kind: 'maintenance', runId, attemptId: attempt.id, attemptGeneration: attempt.generation, incarnation: attempt.incarnation,
        organizationId: null, agentId, maintenance,
      }
      const outcome = await this.maintenanceTx(async client => {
        const result = await this.maintenance.issueSleepRun(client, this.runtime.jobs, runId, attempt, this.incarnation, await this.mayCoordinate(client),
          adapterId, Math.max(...recoveryVersions), selected.generationId, selected.installationDigest, selected.incarnation, selected.installationRoot)
        if ('issued' in result) this.live.add(attempt.id)
        return result
      }, result => 'refused' in result).catch(error => { this.live.delete(attempt.id); throw error })
      if ('refused' in outcome) return
      issued = true
      await this.hooks.afterMaintenanceIssue?.(runId)
      await this.executeMaintenanceAttempt(selected, execution, attempt)
    } finally {
      this.live.delete(attempt.id)
      if (!issued) selected.release(attempt.id)
    }
  }

  private async executeMaintenanceAttempt(route: { adapter: TextExecutionAdapter; release(attemptId: string): void }, execution: MaintenanceExecutionContext, attempt: Attempt): Promise<void> {
    const attemptId = attempt.id
    const finish = async (mode: MaintenanceSettleMode): Promise<void> => {
      let retain = true
      try {
        const settled = await this.maintenanceTx(client => this.maintenance.settleMaintenance(client, this.runtime.jobs, attempt, this.incarnation, mode),
          result => result.outcome !== 'recovery' && result.outcome !== 'noop')
        retain = settled.outcome === 'recovery'
        await this.hooks.afterMaintenanceSettlement?.(attempt.intentId, settled.outcome)
      } finally {
        this.handles.delete(attemptId)
        // Only a settled confirmed end may drain the pinned adapter generation.
        if (retain) this.retainedRoutes.set(attemptId, () => route.release(attemptId))
        else route.release(attemptId)
      }
    }
    let handle: ExecutionHandle
    try {
      handle = await within((route.adapter as MaintenanceCapableAdapter).execute(execution), MAINTENANCE_LIMITS.executeHandshakeMs, 'Maintenance execute handshake timed out')
    } catch (error) {
      await finish({ kind: 'unknown', message: error instanceof Error ? error.message : 'Maintenance dispatch outcome unknown' })
      return
    }
    this.handles.set(attemptId, handle)
    const started = Date.now()
    let events = 0
    let receivedBytes = 0
    try {
      const iterator = handle.events[Symbol.asyncIterator]()
      while (true) {
        const remaining = MAINTENANCE_LIMITS.attemptDeadlineMs - (Date.now() - started)
        if (remaining <= 0) break
        const idleMs = Math.min(MAINTENANCE_LIMITS.idleStreamMs, remaining)
        let next: IteratorResult<ExecutionEvent>
        try {
          next = await within(iterator.next(), idleMs, 'idle')
        } catch {
          break
        }
        if (next.done) {
          await finish({ kind: 'unknown', message: 'Provider stream ended without a terminal observation' })
          return
        }
        const event = next.value
        if (event.attemptId !== attemptId) continue
        events++
        if (events > MAINTENANCE_LIMITS.maxEvents) break
        if (event.kind === 'provider') {
          await this.runtime.db.transaction(async client => { await this.maintenance.recordMaintenanceProvider(client, attempt, event) })
          await this.hooks.afterMaintenanceProvider?.(attempt.intentId)
        } else if (event.kind === 'text') {
          receivedBytes += Buffer.byteLength(event.text, 'utf8')
          if (receivedBytes > MAINTENANCE_LIMITS.maxReceivedTextBytes) break
          if (!event.final) {
            await this.runtime.db.transaction(async client => { await this.maintenance.markOutputInvalid(client, attempt, 'unexpected_stream_text') })
          } else {
            await this.runtime.db.transaction(async client => { await this.maintenance.stageMaintenanceOutput(client, attempt, event.text) })
          }
        } else if (event.kind === 'ended') {
          await finish({ kind: 'extract' })
          return
        } else if (event.kind === 'failed') {
          await finish(event.confirmedEnded ? { kind: 'failed_confirmed', message: event.message } : { kind: 'unknown', message: event.message })
          return
        } else {
          await this.runtime.db.transaction(async client => { await this.maintenance.markOutputInvalid(client, attempt, 'unsupported_event') })
        }
      }
      // Worker-side timeout or event cap: cancel within deadline, then classify.
      let confirmed = false
      try {
        const result = await within(handle.cancel(), MAINTENANCE_LIMITS.cancelAckMs, 'cancel ack timed out')
        confirmed = result.confirmedEnded === true
      } catch { confirmed = false }
      await finish(confirmed ? { kind: 'failed_confirmed', message: 'worker timeout; provider confirmed end' } : { kind: 'unknown', message: 'worker timeout without confirmed end' })
    } catch (error) {
      await finish({ kind: 'unknown', message: error instanceof Error ? error.message : 'Provider outcome unknown' })
    }
  }

  /** One timer tick; ticks never overlap. Never rejects: failures are reported and the
   * next tick retries from durable state. close() waits for a tick in progress. */
  maintenanceTick(): Promise<void> {
    if (this.stopped || !this.coordinating || this.maintenanceTicking) return Promise.resolve()
    this.maintenanceTicking = true
    const tick = this.runMaintenanceTick()
      .catch(error => this.reportMaintenanceFailure(this.runtime.bootstrap.installationId, error))
      .finally(() => { this.maintenanceTicking = false })
    this.track(tick)
    return tick
  }

  private async runMaintenanceTick(): Promise<void> {
    let pump = false
    let sweep = false
    const clean: MaintenanceService[] = []
    const ids = await this.runtime.db.query<{ installation_id: string }>('SELECT installation_id FROM kipster.bootstrap ORDER BY installation_id')
    for (const { installation_id: installationId } of ids.rows) {
      if (this.stopped || !this.coordinating) return
      const primary = installationId === this.runtime.bootstrap.installationId
      const service = primary ? this.maintenance : new MaintenanceService(this.runtime.db, installationId)
      const active = this.maintenanceActive() && await service.learningEnabled()
      // Without learning, only leftover intents, claims and preparations are settled.
      if (!active && !await service.needsUpkeep()) continue
      if (primary) { pump = true; sweep = active }
      await this.runtime.db.transaction(async client => {
        await lockCapacity(client, installationId)
        if (!await this.mayCoordinate(client)) return
        await service.reapIntents(client)
        const skipped = await service.skipNotLearning(client)
        const swept = await service.expireUnissuedClaims(client, this.runtime.jobs)
        if (skipped || swept.expired || swept.orphaned) await wakeEligible(client, this.runtime, installationId)
      })
      try {
        if (active) await service.tickScanner(this.runtime.jobs)
        // Sleep also runs without the installation switch, to record unfinished sleeps as skipped.
        if (this.maintenanceActive()) await new SleepService(this.runtime.db, installationId, this.runtime.home.identity).run(this.runtime.clock())
      } catch (error) { await this.reportMaintenanceFailure(installationId, error); continue }
      clean.push(service)
    }
    if (this.stopped) return
    for (const service of clean) await service.clearFailure()
    if (!pump) return
    await this.pumpMaintenance()
    if (sweep) await this.runtime.db.transaction(async client => { await this.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
  }

  /** Observer failures, synchronous or asynchronous, cannot stop the coordinator. */
  private async reportMaintenanceFailure(installationId: string, error: unknown): Promise<void> {
    void Promise.resolve().then(() => this.hooks.maintenanceFailed?.(error)).catch(() => undefined)
    if (this.stopped) return
    await new MaintenanceService(this.runtime.db, installationId).recordFailure(error).catch(() => undefined)
  }

  /** Execute claimed operator intents. Timer-driven; tests may call directly. */
  async pumpMaintenance(): Promise<number> {
    let executed = 0
    for (let i = 0; i < 10 && !this.stopped && this.coordinating; i++) {
      const intent = await this.runtime.db.transaction(async client => {
        await lockCapacity(client, this.runtime.bootstrap.installationId)
        return await this.mayCoordinate(client) ? this.maintenance.claimIntent(client) : null
      })
      if (!intent) break
      executed++
      await this.executeMaintenanceIntent(intent)
    }
    return executed
  }

  private async executeMaintenanceIntent(intent: { opId: string; action: string; sourceRunId: string | null; sourceRevision: number | null; runId: string | null; reason: string | null }): Promise<void> {
    if (intent.action === 'skip-source' && intent.sourceRunId) {
      await this.maintenanceTx(async client => {
        const skipped = await this.maintenance.skipSource(client, this.runtime.jobs, intent.sourceRunId!, intent.sourceRevision ?? undefined)
        await this.maintenance.completeIntent(client, intent.opId, 'done' in skipped ? 'done' : 'rejected', skipped)
        return skipped
      }, skipped => 'done' in skipped)
      return
    }
    if (intent.action === 'requeue-source' && intent.sourceRunId) {
      await this.maintenanceTx(async client => {
        const requeued = await this.maintenance.requeueSource(client, this.runtime.jobs, intent.sourceRunId!, intent.sourceRevision ?? undefined)
        await this.maintenance.completeIntent(client, intent.opId, 'done' in requeued ? 'done' : 'rejected', requeued)
      }, () => false)
      return
    }
    if ((intent.action === 'cancel' || intent.action === 'reconcile') && intent.runId) {
      await this.executeRunIntent(intent.opId, intent.action, intent.runId)
      return
    }
    await this.maintenanceTx(client => this.maintenance.completeIntent(client, intent.opId, 'rejected', { conflict: 'malformed intent target' }), () => false)
  }

  private async executeRunIntent(opId: string, action: string, runId: string): Promise<void> {
    const installationId = this.runtime.bootstrap.installationId
    const target = await this.runtime.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const run = (await client.query<{ state: string; current_attempt_id: string | null; adapter_id: string | null; recovery_ref: RecoveryReference | null }>(
        'SELECT state, current_attempt_id, adapter_id, recovery_ref FROM kipster.maintenance_runs WHERE id=$1 AND installation_id=$2',
        [runId, installationId])).rows[0]
      if (!run || !run.current_attempt_id) return null
      const attempt = (await client.query<{ generation: string; incarnation: string; state: string }>(
        'SELECT generation, incarnation, state FROM kipster.attempts WHERE id=$1', [run.current_attempt_id])).rows[0]
      if (!attempt) return null
      return { state: run.state, attemptId: run.current_attempt_id, generation: Number(attempt.generation), incarnation: attempt.incarnation, attemptState: attempt.state, adapterId: run.adapter_id, recoveryRef: run.recovery_ref }
    })
    const complete = async (state: 'done' | 'rejected', result: unknown): Promise<void> => {
      await this.maintenanceTx(client => this.maintenance.completeIntent(client, opId, state, result), () => false)
    }
    if (!target || target.state === 'completed' || target.state === 'failed') {
      await complete('rejected', { conflict: 'run terminal or missing' })
      return
    }
    if (target.state === 'preparing') {
      await complete('rejected', { conflict: 'run not issued' })
      return
    }
    if (action === 'cancel') {
      if (target.state === 'recovery-needed') {
        await this.maintenanceTx(async client => {
          await this.maintenance.settleCancelUnknown(client, runId, target.attemptId)
          await this.maintenance.completeIntent(client, opId, 'done', { unknown: 'run already uncertain' })
        }, () => false)
        return
      }
      const handle = target.incarnation === this.incarnation ? this.handles.get(target.attemptId) : undefined
      if (!handle) {
        await complete('done', { unknown: 'not owned by this coordinator' })
        return
      }
      let confirmed = false
      try {
        const result = await within(handle.cancel(), MAINTENANCE_LIMITS.cancelAckMs, 'cancel ack timed out')
        confirmed = result.confirmedEnded === true
      } catch { confirmed = false }
      const fenced = await this.maintenanceTx(async client => {
        if (confirmed) {
          const settled = await this.maintenance.settleCancelConfirmed(client, this.runtime.jobs, runId, target.attemptId, this.incarnation)
          await this.maintenance.completeIntent(client, opId, 'done', 'fenced' in settled ? { cancelled: 'confirmed' } : { unknown: 'run state changed' })
          return 'fenced' in settled
        }
        await this.maintenance.settleCancelUnknown(client, runId, target.attemptId)
        await this.maintenance.completeIntent(client, opId, 'done', { unknown: 'cancel outcome unconfirmed' })
        return false
      }, released => released)
      if (fenced) this.releaseRetainedRoute(target.attemptId)
      return
    }
    // Reconcile: read-only and freely repeatable; terminalization needs fresh confirmation.
    const live = target.incarnation === this.incarnation ? this.handles.get(target.attemptId) : undefined
    if (target.state === 'running' && live) {
      let outcome: 'active' | 'ended' | 'unknown' = 'unknown'
      try {
        outcome = await within(live.reconcile(), MAINTENANCE_LIMITS.reconcileMs, 'reconcile timed out')
      } catch { outcome = 'unknown' }
      await this.maintenanceTx(async client => {
        await this.maintenance.touchReconcile(client, runId)
        if (outcome !== 'ended') {
          await this.maintenance.completeIntent(client, opId, 'done', { unknown: outcome })
          return false
        }
        const settled = await this.maintenance.settleMaintenance(client, this.runtime.jobs,
          { id: target.attemptId, intentId: runId, generation: target.generation, incarnation: target.incarnation, state: 'issued' },
          this.incarnation, { kind: 'failed_confirmed', message: 'live reconcile reported ended' })
        await this.maintenance.completeIntent(client, opId, 'done', settled.outcome === 'noop' ? { unknown: 'run state changed' } : { ended: true })
        return settled.outcome !== 'noop'
      }, released => released)
      return
    }
    if (target.state === 'running') {
      await complete('done', { unknown: 'not owned by this coordinator' })
      return
    }
    const ref = target.recoveryRef
    const completeRef = ref && typeof ref === 'object' && ref.adapterId === target.adapterId && ref.contractMajor === 1 &&
      Number.isSafeInteger(ref.recoveryVersion) && typeof ref.stateScope === 'string' && ref.providerIds &&
      typeof ref.providerIds === 'object' && Object.keys(ref.providerIds).length ? ref as RecoveryReference : null
    let outcome: 'active' | 'ended' | 'unknown' = 'unknown'
    let evidence = 'recovery impaired'
    if (completeRef && target.adapterId) {
      try {
        if (this.adapter instanceof AdapterRegistry) {
          const result = await this.adapter.durableReconcile(target.adapterId, completeRef)
          outcome = result.outcome
          evidence = result.evidence
        } else if (this.adapter.id === target.adapterId) {
          const direct = this.adapter as Partial<MaintenanceCapableAdapter>
          if (typeof direct.durableReconcile === 'function' && recoveryCompatible(direct.recoveryVersions, direct.recoveryStateScopes, completeRef)) {
            const result = await within(direct.durableReconcile({ recoveryRef: completeRef }), MAINTENANCE_LIMITS.reconcileMs, 'reconcile timed out')
            outcome = result.outcome
            evidence = result.evidence
          } else {
            evidence = 'incompatible recovery identity'
          }
        } else {
          evidence = 'adapter unavailable'
        }
      } catch (error) {
        outcome = 'unknown'
        evidence = error instanceof Error ? error.message.slice(0, 500) : 'reconcile failed'
      }
    }
    const ended = await this.maintenanceTx(async client => {
      await this.maintenance.touchReconcile(client, runId)
      if (outcome !== 'ended') {
        await this.maintenance.completeIntent(client, opId, 'done', { unknown: evidence })
        return false
      }
      const settled = await this.maintenance.settleReconcileEnded(client, this.runtime.jobs, runId, evidence)
      await this.maintenance.completeIntent(client, opId, 'done', 'noop' in settled ? { unknown: 'run state changed' } : { ended: true, evidence })
      return !('noop' in settled)
    }, released => released)
    if (ended) this.releaseRetainedRoute(target.attemptId)
  }

  private async recordProvider(attempt: Attempt, event: Extract<ExecutionEvent, { kind: 'provider' }>): Promise<void> {
    await this.runtime.db.query(`UPDATE kipster.attempts a SET provider_metadata=provider_metadata || $5::jsonb
      FROM kipster.work_intents i,kipster.text_runs r WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4
      AND a.state='issued' AND i.id=a.intent_id AND i.state='issued' AND i.generation=a.generation
      AND r.id=i.id AND r.current_attempt_id=a.id AND r.state='running'`, [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation,
      JSON.stringify({ threadId: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}), processId: event.processId, providerStateScope: event.providerStateScope, workingDirectory: event.workingDirectory, modelId: event.modelId, ...(event.effort ? { effort: event.effort } : {}) })])
  }

  /** Explicit tool publications use the call ID as the publication identity. */
  async publishToolText(attemptId: string, callId: string, text: string, artifactIds: readonly string[] = []): Promise<{ status: 'completed'; messageId: string } | { status: 'failed'; reason: string }> {
    if (!callId || callId.length > 200 || (!text&&!artifactIds.length) || Buffer.byteLength(text) > 64 * 1024 || artifactIds.length>10 || new Set(artifactIds).size!==artifactIds.length) return { status: 'failed', reason: 'Invalid publication' }
    const row = (await this.runtime.db.query<{ intent_id: string; generation: string; incarnation: string }>('SELECT intent_id,generation,incarnation FROM kipster.attempts WHERE id=$1', [attemptId])).rows[0]
    if (!row) return { status: 'failed', reason: 'Unknown attempt' }
    const context = await runContext(this.runtime.db, row.intent_id)
    if (!context) return { status: 'failed', reason: 'Unknown run' }
    try {
      const messageId = await this.publishText({ id: attemptId, intentId: row.intent_id, generation: Number(row.generation), incarnation: row.incarnation, state: 'issued' }, { kind: 'text', attemptId, messageId: callId, text, final: true }, context, 'tool', artifactIds)
      return messageId ? { status: 'completed', messageId } : { status: 'failed', reason: 'Attempt no longer owns publication' }
    } catch (error) {
      return { status: 'failed', reason: error instanceof Error ? error.message : 'Publication failed' }
    }
  }

  async askToolInteraction(attemptId: string, callId: string, input: InteractionInput): Promise<{ status: 'pending'; interactionId: string }> {
    const record = await askInteraction(this.runtime.db, attemptId, callId, input)
    return { status: 'pending', interactionId: record.id }
  }

  async memoryTool(attemptId:string,callId:string,name:string,args:unknown):Promise<unknown> {
    if(['memory.link','memory.relationship_get','memory.relationship_list','memory.relationship_update','memory.unlink'].includes(name)){
      if(!this.runtime.relationships)throw new Error('Memory relationships unavailable')
      return this.runtime.relationships.invoke(attemptId,this.incarnation,callId,name,args)
    }
    if (!this.runtime.memory) throw new Error('Memory embedding profile is not configured')
    return this.runtime.memory.invoke(attemptId,callId,name,args,this.incarnation)
  }

  async structuredTool(attemptId:string,callId:string,args:unknown):Promise<unknown> {
    if (!this.runtime.structured) throw new Error('Task-data service is not configured')
    return this.runtime.structured.invoke(attemptId,this.incarnation,callId,args)
  }
  async vectorTool(attemptId:string,callId:string,args:unknown):Promise<unknown> {
    if (!this.runtime.vectors) throw new Error('Vector embedding profile is not configured')
    return this.runtime.vectors.invoke(attemptId,this.incarnation,callId,args)
  }

  async agentTool(attemptId:string,callId:string,name:string,args:Record<string,unknown>):Promise<unknown>{
    if(name==='agents.list'){
      if(Object.keys(args).length)throw new Error('Invalid agent discovery arguments')
      return {agents:await listAgents(this.runtime.db,attemptId,this.incarnation)}
    }
    if(name==='agents.get'){
      if(Object.keys(args).length!==1||typeof args.agentId!=='string')throw new Error('Invalid agent lookup arguments')
      return {agent:await getAgent(this.runtime.db,attemptId,this.incarnation,args.agentId)}
    }
    if(name==='agents.delegation_status'){
      if(Object.keys(args).length!==1||typeof args.delegationId!=='string')throw new Error('Invalid delegation status arguments')
      return delegationStatus(this.runtime.db,attemptId,this.incarnation,args.delegationId)
    }
    if(name==='agents.delegate'){
      if(Object.keys(args).some(key=>!['recipientId','request','artifactIds'].includes(key))||typeof args.recipientId!=='string'||typeof args.request!=='string'||args.artifactIds!==undefined&&(!Array.isArray(args.artifactIds)||args.artifactIds.some(id=>typeof id!=='string')))throw new Error('Invalid delegation arguments')
      return delegate(this.runtime.db,this.runtime.jobs,attemptId,this.incarnation,callId,args.recipientId,args.request,args.artifactIds as string[]|undefined)
    }
    throw new Error('Unsupported agent tool')
  }

  /** Administration tools of the admin agent, authorized again for the calling attempt. */
  async adminTool(attemptId: string, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const host = { db: this.runtime.db, home: this.runtime.home, jobs: this.runtime.jobs, learning: this.runtime.learning, updates: this.runtime.updates, catalog: () => this.catalog(), refreshAdapters: () => this.refreshAdapters() }
    return administrationTool(host, { installationId: this.runtime.bootstrap.installationId, attemptId, incarnation: this.incarnation }, callId, name, args)
  }

  /** Document tools. `documents.create` publishes the new document's card in the run's thread, with the call ID as its publication identity. */
  async documentTool(attemptId: string, callId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== 'documents.create') return documentTool(this.runtime.db, attemptId, this.incarnation, name, args)
    const input = documentCreation(args)
    if (!callId || callId.length > 200) throw new Error('Invalid call ID')
    const row = (await this.runtime.db.query<{ intent_id: string; generation: string; incarnation: string }>('SELECT intent_id,generation,incarnation FROM kipster.attempts WHERE id=$1 AND incarnation=$2', [attemptId, this.incarnation])).rows[0]
    const context = row ? await runContext(this.runtime.db, row.intent_id) : null
    if (!row || !context) throw new Error('Attempt no longer owns document tools')
    const attempt: Attempt = { id: attemptId, intentId: row.intent_id, generation: Number(row.generation), incarnation: row.incarnation, state: 'issued' }
    const run = { installationId: context.actor.installationId, attemptId, agentId: context.agentId, chatId: context.chatId, threadId: context.threadId, context: context.context }
    const messageId = await this.publishText(attempt, { kind: 'text', attemptId, messageId: callId, text: '', final: true }, context, 'tool', [], client => createDocumentIn(client, run, callId, input))
    if (!messageId) throw new Error('Attempt no longer owns document tools')
    return { ...await createdDocument(this.runtime.db, attemptId, callId), messageId }
  }

  async transcribeTool(attemptId:string,callId:string,artifactId:string):Promise<unknown>{
    if(!callId||callId.length>200||!/^[0-9a-f-]{36}$/i.test(artifactId))return {status:'unavailable',reason:'invalid-input'}
    const key=`${attemptId}:${callId}`
    const existing=this.toolFlights.get(key)
    if(existing)return existing.artifactId===artifactId?existing.result:{status:'unavailable',reason:'invalid-input'}
    const result=this.transcribeToolOwned(attemptId,callId,artifactId)
    this.toolFlights.set(key,{artifactId,result})
    try{return await result}finally{if(this.toolFlights.get(key)?.result===result)this.toolFlights.delete(key)}
  }

  private async transcribeToolOwned(attemptId:string,callId:string,artifactId:string):Promise<unknown>{
    const attempt=(await this.runtime.db.query<{intent_id:string;state:string}>(`SELECT intent_id,state FROM kipster.attempts WHERE id=$1 AND incarnation=$2`,[attemptId,this.incarnation])).rows[0]
    if(!attempt||attempt.state!=='issued')return {status:'unavailable',reason:'cancelled'}
    const context=await runContext(this.runtime.db,attempt.intent_id)
    if(!context)return {status:'unavailable',reason:'cancelled'}
    const claim=await this.runtime.db.transaction(async client=>{
      const run=await this.lockedRun(client,attempt.intent_id,async()=>{await this.hooks.beforeToolClaimLock?.(attempt.intent_id)})
      const currentAttempt=(await client.query<{state:string}>(`SELECT state FROM kipster.attempts WHERE id=$1 AND incarnation=$2`,[attemptId,this.incarnation])).rows[0]
      if(!run||run.current_attempt_id!==attemptId||run.stop_requested||run.state!=='running'||currentAttempt?.state!=='issued')return 'cancelled'
      const allowed=await client.query(`SELECT 1 FROM kipster.message_artifacts ma JOIN kipster.messages m ON m.id=ma.message_id WHERE ma.artifact_id=$1 AND m.thread_id=$2 LIMIT 1`,[artifactId,context.threadId])
      if(!allowed.rows.length)return 'denied'
      const prior=(await client.query<{artifact_id:string;status:string;result:unknown}>(`SELECT artifact_id,status,result FROM kipster.voice_tool_calls WHERE attempt_id=$1 AND call_id=$2`,[attemptId,callId])).rows[0]
      if(prior)return prior.artifact_id===artifactId?prior:'denied'
      await client.query(`INSERT INTO kipster.voice_tool_calls(attempt_id,call_id,artifact_id,status) VALUES ($1,$2,$3,'preparing')`,[attemptId,callId,artifactId])
      return 'claimed'
    })
    if(claim==='cancelled')return {status:'unavailable',reason:'cancelled'}
    if(claim==='denied')return {status:'unavailable',reason:'invalid-input'}
    if(claim!=='claimed')return claim.status==='settled'?claim.result:{status:'unavailable',reason:'in-progress'}
    const controller=new AbortController(),key=`${attempt.intent_id}:${callId}`
    this.toolControllers.set(key,controller)
    const timer=setTimeout(()=>controller.abort(),120000)
    let result:unknown
    try{
      const current=(await this.runtime.db.query<{state:string;stop_requested:boolean}>(`SELECT state,stop_requested FROM kipster.text_runs WHERE id=$1 AND current_attempt_id=$2`,[attempt.intent_id,attemptId])).rows[0]
      if(!current||current.state!=='running'||current.stop_requested)controller.abort()
      const file=await this.runtime.artifacts.inputForExecution(context.actor,artifactId,{installationId:context.actor.installationId,callerId:context.actor.personId,context:context.context,chatId:context.chatId,threadId:context.threadId})
      if(file.availability!=='available')result={status:'unavailable',reason:'invalid-input',provider:this.runtime.transcription?.id??'unconfigured'}
      else if(!this.runtime.transcription)result={status:'unavailable',reason:'unavailable',provider:'unconfigured'}
      else if(!acceptsType(this.runtime.transcription,file.mimeType))result={status:'unavailable',reason:'invalid-input',provider:this.runtime.transcription.id}
      else result=await abortableResult(controller.signal,()=>this.runtime.transcription!.transcribe({path:file.readablePath,mimeType:file.mimeType,size:file.size,signal:controller.signal}),{status:'unavailable',reason:'timeout',provider:this.runtime.transcription.id})
    }catch{result={status:'unavailable',reason:'provider-error',provider:this.runtime.transcription?.id??'unconfigured'}}
    finally{clearTimeout(timer);this.toolControllers.delete(key)}
    result=normalizedTranscription(result,this.runtime.transcription?.id??'unconfigured')
    const settled=await this.runtime.db.transaction(async client=>{
      const run=await this.lockedRun(client,attempt.intent_id,async()=>{await this.hooks.beforeToolSettleLock?.(attempt.intent_id)})
      const currentAttempt=(await client.query<{state:string}>(`SELECT state FROM kipster.attempts WHERE id=$1 AND incarnation=$2`,[attemptId,this.incarnation])).rows[0]
      if(!run||run.current_attempt_id!==attemptId||run.stop_requested||run.state!=='running'||currentAttempt?.state!=='issued')return false
      const updated=await client.query(`UPDATE kipster.voice_tool_calls SET status='settled',result=$4::jsonb WHERE attempt_id=$1 AND call_id=$2 AND artifact_id=$3 AND status='preparing'`,[attemptId,callId,artifactId,JSON.stringify(result)])
      return !!updated.rowCount
    })
    return settled?result:{status:'unavailable',reason:'cancelled'}
  }

  async writeArtifactTool(attemptId:string,callId:string,name:string,content:string):Promise<unknown>{return this.runtime.artifacts.writeOutput(attemptId,this.incarnation,callId,name,content)}
  async publishArtifactTool(attemptId:string,callId:string,outputId:string):Promise<unknown>{return this.runtime.artifacts.publishOutput(attemptId,this.incarnation,callId,outputId)}
  async copyArtifactTool(attemptId:string,callId:string,artifactId:string):Promise<unknown>{return this.runtime.artifacts.copyToOrganization(attemptId,this.incarnation,callId,artifactId)}

  /** `coreParts`, when given, runs in the publication's transaction and returns parts Core appends, such as a document card; the call ID alone then identifies the publication. */
  private async publishText(attempt: Attempt, event: Extract<ExecutionEvent, { kind: 'text' }>, context: NonNullable<Awaited<ReturnType<typeof runContext>>>, source: 'native'|'tool' = 'native', artifactIds: readonly string[] = [], coreParts?: (client: SqlClient) => Promise<MessagePart[]>): Promise<string | null> {
    const saved = await this.runtime.db.transaction(async client => {
      // Publications share this guard, so different threads can write concurrently.
      // Controls/recovery take it exclusively before locking multiple threads: dropping
      // the guard would permit thread -> app / app -> thread lock inversions.
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR SHARE', [context.actor.installationId])
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [context.threadId])
      const owner = await client.query(`SELECT 1 FROM kipster.text_runs r JOIN kipster.work_intents i ON i.id=r.id JOIN kipster.attempts a ON a.id=r.current_attempt_id
        WHERE r.id=$1 AND r.state IN ('running','waiting') AND r.stop_requested=false AND r.current_attempt_id=$2 AND i.state='issued' AND i.generation=$3 AND a.incarnation=$4 AND a.state='issued'`, [attempt.intentId, attempt.id, attempt.generation, attempt.incarnation])
      if (!owner.rows.length) return null
      const parts: MessagePart[]=[...(event.text?[{kind:'text' as const,text:event.text}]:[]),...artifactIds.map(artifactId=>({kind:'file' as const,artifactId,purpose:'attachment' as const}))]
      const prior = (await client.query<{ id: string; revision: string; final: boolean; parts: unknown[] }>('SELECT id,revision,final,parts FROM kipster.messages WHERE source_attempt_id=$1 AND publication_source=$2 AND publication_id=$3', [attempt.id, source, event.messageId])).rows[0]
      if (prior?.final) {
        if (!event.final || coreParts) return prior.id
        if (publicationPartsKey(prior.parts)!==publicationPartsKey(parts)) throw new Error('Publication identity conflict')
        return prior.id
      }
      for(const artifactId of artifactIds){const artifact=(await client.query<{id:string}>("SELECT id FROM kipster.artifacts WHERE id=$1 AND installation_id=$2 AND state='ready' AND ((owner_kind='agent' AND owner_id=$3) OR (owner_kind='organization' AND owner_id=$4))",[artifactId,context.actor.installationId,context.agentId,context.context.kind==='organization'?context.context.organizationId:null])).rows[0];if(!artifact)throw new Error('Artifact publication denied')}
      if (coreParts) parts.push(...await coreParts(client))
      let messageId = prior?.id ?? randomUUID()
      let revision = prior ? Number(prior.revision) + 1 : 1
      if (prior) {
        await client.query('UPDATE kipster.messages SET parts=$2::jsonb,final=$3,revision=$4 WHERE id=$1', [messageId, JSON.stringify(parts), event.final, revision])
      } else {
        const counter = (await client.query<{ next_message_position: string }>('SELECT next_message_position FROM kipster.threads WHERE id=$1', [context.threadId])).rows[0]!
        await client.query('UPDATE kipster.threads SET next_message_position=next_message_position+1 WHERE id=$1', [context.threadId])
        await client.query('INSERT INTO kipster.messages(id,thread_id,position,author_id,parts,final,source_attempt_id,publication_source,publication_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)', [messageId, context.threadId, Number(counter.next_message_position), context.agentId, JSON.stringify(parts), event.final, attempt.id, source, event.messageId])
      }
      for(const [index,artifactId] of artifactIds.entries())await client.query('INSERT INTO kipster.message_artifacts(message_id,ordinal,artifact_id,purpose) VALUES ($1,$2,$3,$4) ON CONFLICT (message_id,ordinal) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,purpose=EXCLUDED.purpose',[messageId,index+(event.text?1:0),artifactId,'attachment'])
      await client.query('UPDATE kipster.threads SET revision=revision+1 WHERE id=$1', [context.threadId])
      await publishThreadChange(client, context.actor.installationId, context.actor.personId, context.threadId, context.chatId, event.final ? 'message-final' : 'message-draft', messageId, revision, await messageRecord(client, messageId), 'running', messageId, event.final || !prior)
      return messageId
    })
    if (saved) await this.hooks.afterOutput?.(event.messageId)
    return saved
  }

  private async settle(attempt: Attempt, state: 'completed'|'failed'|'recovery-needed', failure: string | null, preparation: boolean): Promise<void> {
    const context = await runContext(this.runtime.db, attempt.intentId)
    if (!context) return
    await this.runtime.db.transaction(async client => {
      await lockCapacity(client, context.actor.installationId)
      const child=await childDelegation(client,attempt.intentId)
      if(child)await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[child.originThreadId])
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [context.threadId])
      const row = await runRow(client, attempt.intentId)
      const expected = preparation ? 'preparing' : 'running'
      if (!row || row.current_attempt_id !== attempt.id || (row.state !== expected && !(expected === 'running' && ['waiting','cancellation-requested'].includes(row.state)))) return
      const valid = await client.query(`SELECT 1 FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
        WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND a.state=$5 AND i.generation=$3 AND i.state=$5`, [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation, preparation ? 'preparing' : 'issued'])
      if (!valid.rows.length) return
      const uncertain = state === 'recovery-needed'
      const interaction = row.continuation_interaction_id ? (await client.query<{ state: string; attempt_id: string }>('SELECT state,attempt_id FROM kipster.interactions WHERE id=$1', [row.continuation_interaction_id])).rows[0] : undefined
      const yieldingInteraction = interaction?.attempt_id === attempt.id
      const children=(await client.query<{state:string}>('SELECT state FROM kipster.delegations WHERE parent_attempt_id=$1 ORDER BY created_at,id',[attempt.id])).rows
      const awaitingChildren=children.length>0
      const childrenFinished=children.every(item=>['completed','failed','cancelled','recovery-needed'].includes(item.state))
      const nextState = row.stop_requested && !uncertain ? 'cancelled' : state === 'completed' && awaitingChildren ? childrenFinished?'queued':'waiting' : state === 'completed' && yieldingInteraction ? interaction.state === 'settled' ? 'queued' : 'waiting' : state
      await sealAttemptMessages(client, attempt.id, nextState)
      await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1', [attempt.id, uncertain ? 'uncertain' : 'settled'])
      await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1', [attempt.intentId, uncertain ? 'uncertain' : nextState === 'queued' ? 'queued' : 'settled'])
      if (!uncertain) await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
      if (interaction?.state === 'pending' && !['waiting','queued'].includes(nextState)) {
        await client.query('UPDATE kipster.interactions SET state=$2,revision=revision+1 WHERE id=$1', [row.continuation_interaction_id, 'superseded'])
        const card=await interactionRecord(client,row.continuation_interaction_id!)
        await publishThreadChange(client,context.actor.installationId,context.actor.personId,context.threadId,context.chatId,'interaction-changed',card.id,card.revision,card,nextState,null)
        await interactionNotificationChanged(client,card.id)
      }
      const releaseRetryHold = nextState === 'completed' && row.retry_continue_generation !== null && row.retry_continue_generation === row.queue_generation
      await client.query('UPDATE kipster.text_runs SET state=$2,queue_hold=$3,failure=$4,retry_continue_generation=$5,cancel_delivery=CASE WHEN stop_requested THEN $6 ELSE cancel_delivery END,revision=revision+1 WHERE id=$1', [attempt.intentId, nextState, releaseRetryHold ? false : row.queue_hold || !['completed','queued','waiting'].includes(nextState), failure, releaseRetryHold || ['failed','cancelled','recovery-needed'].includes(nextState) ? null : row.retry_continue_generation,uncertain?'uncertain':'confirmed-ended'])
      if (nextState === 'completed' && this.maintenanceActive()) {
        await new MaintenanceService(this.runtime.db, context.actor.installationId).enqueueFromSettlement(client, this.runtime.jobs,
          attempt.intentId, context.agentId, context.context.kind,
          context.context.kind === 'organization' ? context.context.organizationId : context.context.installationId, context.threadId)
      }
      await client.query('UPDATE kipster.threads SET revision=revision+1 WHERE id=$1', [context.threadId])
      await publishThreadChange(client, context.actor.installationId, context.actor.personId, context.threadId, context.chatId, 'work-changed', attempt.intentId, await workRevision(client, attempt.intentId), await workRecord(client, attempt.intentId), nextState, null)
      if ((!preparation || state !== 'failed') && ['completed','failed','recovery-needed'].includes(nextState)) await createNotification(client, context.actor.installationId, context.actor.personId, context.threadId, attempt.intentId, nextState as 'completed'|'failed'|'recovery-needed')
      if (nextState === 'queued') await this.runtime.jobs.send(client, attempt.intentId)
      if(child&&!uncertain)await finishDelegation(client,this.runtime.jobs,attempt.intentId,nextState,failure)
      if (!uncertain) await wakeEligible(client, this.runtime, context.actor.installationId)
    })
    if(state==='recovery-needed')await reconcileInterruptedDelegations(this.runtime.db)
    await finishRunDocuments(this.runtime.db, attempt.intentId).catch(() => undefined)
  }

  private async fenceOwnedOnClose(): Promise<void> {
    await this.runtime.db.transaction(async client => {
      const ids = await client.query<{ installation_id: string }>('SELECT installation_id FROM kipster.bootstrap ORDER BY installation_id')
      for (const { installation_id: installationId } of ids.rows) {
        await lockCapacity(client, installationId)
        const rows = await client.query<{ id: string; thread_id: string; state: string; current_attempt_id: string }>(`SELECT r.id,r.thread_id,r.state,r.current_attempt_id FROM kipster.text_runs r
          JOIN kipster.attempts a ON a.id=r.current_attempt_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
          WHERE c.installation_id=$1 AND a.incarnation=$2 AND r.state IN ('preparing','running','waiting','cancellation-requested') AND a.state IN ('preparing','issued') ORDER BY r.thread_id,r.queue_position`, [installationId, this.incarnation])
        for (const row of rows.rows) {
          await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [row.thread_id])
          let voiceChanged=false
          if (row.state === 'preparing') {
            voiceChanged=!!(await client.query("UPDATE kipster.voice_preparations SET status='unavailable',failure='interrupted',revision=revision+1 WHERE attempt_id=$1 AND status='preparing'",[row.current_attempt_id])).rowCount
            await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [row.current_attempt_id, 'settled', 'preparing'])
            await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state=$3', [row.id, 'queued', 'preparing'])
            await client.query('UPDATE kipster.text_runs SET state=$2,current_attempt_id=NULL,revision=revision+1 WHERE id=$1', [row.id, 'queued'])
          } else {
            await client.query('UPDATE kipster.attempts SET state=$2 WHERE id=$1 AND state=$3', [row.current_attempt_id, 'uncertain', 'issued'])
            await client.query('UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state=$3', [row.id, 'uncertain', 'issued'])
            await client.query('UPDATE kipster.text_runs SET state=$2,queue_hold=true,cancel_delivery=CASE WHEN stop_requested THEN $4 ELSE cancel_delivery END,revision=revision+1,failure=$3 WHERE id=$1', [row.id, 'recovery-needed', 'Provider outcome requires reconciliation','uncertain'])
          }
          if (row.current_attempt_id && row.state !== 'preparing') await sealAttemptMessages(client, row.current_attempt_id, 'recovery-needed')
          const current = await runRow(client, row.id)
          if (current) {
            if(voiceChanged)await publishThreadChange(client,installationId,current.caller_id,row.thread_id,current.chat_id,'message-final',current.input_message_id,await this.bumpMessage(client,current.input_message_id),await messageRecord(client,current.input_message_id),'queued',null)
            await publishThreadChange(client, installationId, current.caller_id, row.thread_id, current.chat_id, 'work-changed', row.id, await workRevision(client, row.id), await workRecord(client, row.id), row.state === 'preparing' ? 'queued' : 'recovery-needed', null)
            if (row.state === 'running') await createNotification(client, installationId, current.caller_id, row.thread_id, row.id, 'recovery-needed')
          }
        }
        await wakeEligible(client, this.runtime, installationId)
        const service = new MaintenanceService(this.runtime.db, installationId)
        await service.fenceInterruptedIssued(client, { incarnation: this.incarnation })
        await service.expireUnissuedClaims(client, this.runtime.jobs, { all: true, incarnation: this.incarnation })
        await service.reapIntents(client)
      }
    })
    await reconcileInterruptedDelegations(this.runtime.db)
  }

  private async bounded(operation: Promise<unknown>, milliseconds: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([operation.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds) })])
    } finally { if (timer) clearTimeout(timer) }
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.stopAdapterUpdates?.()
    this.wakeRelock?.()
    if (this.maintenanceTimer) { clearInterval(this.maintenanceTimer); this.maintenanceTimer = null }
    if (this.cancellationTimer) { clearInterval(this.cancellationTimer); this.cancellationTimer = null }
    if (this.startPromise) await this.startPromise.catch(() => undefined)
    for(const controller of this.voiceControllers.values())controller.abort()
    for(const controller of this.toolControllers.values())controller.abort()
    if (!this.started) return
    this.coordinating = false
    try {
      await this.fenceOwnedOnClose()
      await this.bounded(Promise.allSettled([this.runtime.jobs.stopWork(), this.operations.stop(), this.adapter.close(), ...this.active]), 2000)
    } finally {
      const lock = this.lock
      this.lock = null
      await lock?.release()
    }
  }
}
