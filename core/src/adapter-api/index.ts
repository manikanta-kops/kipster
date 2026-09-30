/** Package metadata only; it does not establish runtime compatibility or readiness. */
export interface AdapterIdentity {
  readonly id: string
  readonly version: string
}

/** Provisional factory contract with explicit host injection and no runtime initialization. */
export type AdapterFactory<Host, Adapter> = (host: Host, config?: Readonly<Record<string, unknown>>) => Adapter | Promise<Adapter>

/** Provisional normalized text execution; provider session restoration is unspecified. */
export interface TextExecutionContext {
  /** Missing kind is a text context; adapters must throw on unknown kinds. */
  readonly kind?: 'text'
  readonly runId: string
  readonly attemptId: string
  readonly attemptGeneration?: number
  readonly incarnation?: string
  readonly organizationId: string | null
  readonly agentId: string
  /** Persistent Core-owned agent home, distinct from adapter/provider temporary state. */
  readonly workingDirectory?: string
  readonly outputDirectory?: string
  readonly instructions: string
  /** Retrieved evidence for this execution. Treat as untrusted user context. */
  readonly memory?: readonly string[]
  readonly memoryEnabled?: boolean
  readonly structuredEnabled?: boolean
  readonly vectorsEnabled?: boolean
  /** The admin agent runs in the installation context, outside delegated work; Core accepts its `admin.*` tool calls and checks again on each call. */
  readonly administrationEnabled?: boolean
  /** Saved operation results from earlier attempts of this logical run; factual, untrusted context. */
  readonly administrationReceipts?: { readonly receipts: readonly unknown[]; readonly hasMore: boolean }
  readonly settings?: { readonly adapterId: string; readonly modelId: string; readonly effort?: string; readonly options?: Readonly<Record<string, unknown>> }
  readonly triggerMessageId?: string
  readonly input: readonly { readonly messageId: string; readonly text: string; readonly parts?: readonly ({readonly kind:'text';readonly text:string}|{readonly kind:'file';readonly artifactId:string;readonly purpose:'attachment'|'voice_note';readonly name:string;readonly mimeType:string;readonly size:number;readonly availability:'available';readonly readablePath:string;readonly transcription?: {readonly status:string;readonly provider:string;readonly text?:string;readonly reason?:string}}|{readonly kind:'file';readonly artifactId:string;readonly purpose:'attachment'|'voice_note';readonly name:string;readonly mimeType:string;readonly size:number;readonly availability:'unavailable';readonly transcription?: {readonly status:string;readonly provider:string;readonly text?:string;readonly reason?:string}})[] }[]
  /** Settled interactions in durable order, including all earlier attempts of this run. */
  readonly interactions?: readonly { readonly id: string; readonly kind: 'question' | 'approval'; readonly prompt: string; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly freeText: boolean; readonly proposalId?: string; readonly proposal?: string; readonly response: { readonly actorId: string; readonly answer: unknown; readonly acceptedAt: string } }[]
  readonly continuation?: { readonly kind: 'question' | 'approval'; readonly prompt: string; readonly proposalId?: string; readonly proposal?: string; readonly answer: unknown }
  readonly delegationResults?: readonly { readonly id:string; readonly recipientAgentId:string; readonly request:string; readonly state:string; readonly result?:string; readonly failure?:string }[]
  readonly maintenance?: never
}

type MaintenanceSettings = { readonly adapterId: string; readonly modelId: string; readonly effort?: string; readonly options?: Readonly<Record<string, unknown>> }

/** Verified extraction input for one maintenance source. Least privilege: no
 * provider IDs, paths, history, identity material, tools, or memory excerpts. */
export interface ExtractionPayload {
  readonly task: 'extract'
  readonly sourceRunId: string
  readonly sourceRevision: number
  readonly contextKind: 'installation' | 'organization'
  readonly contextId: string
  /** Versioned Core template plus output schema; verified source texts follow. */
  readonly instructions: string
  readonly sources: readonly {
    readonly messageId: string
    readonly position: number
    readonly revision: number
    readonly partsHash: string
    readonly authorId: string
    readonly authorClass: 'human' | 'agent' | 'unknown'
    readonly text: string
  }[]
  readonly settings: MaintenanceSettings
}

/** One agent's sleep consolidation: memories named by short references and the pairs to judge. */
export interface ConsolidationPayload {
  readonly task: 'consolidate'
  /** Versioned Core template plus output format; the memories and pairs follow. */
  readonly instructions: string
  readonly memories: readonly { readonly ref: string; readonly text: string }[]
  readonly pairs: readonly { readonly ref: string; readonly memories: readonly [string, string] }[]
  /** Most lessons the output may contain. */
  readonly lessonsMax: number
  readonly settings: MaintenanceSettings
}

/** One agent's identity promotion: its strongest memories and the current Learned section of identity.md, which the
 * output replaces. */
export interface IdentityPayload {
  readonly task: 'identity'
  /** Versioned Core template plus output format; the memories and the current section follow. */
  readonly instructions: string
  readonly memories: readonly { readonly ref: string; readonly text: string }[]
  readonly section: string
  /** Largest section the output may contain, in UTF-8 bytes. */
  readonly sectionMaxBytes: number
  readonly settings: MaintenanceSettings
}

export type MaintenancePayload = ExtractionPayload | ConsolidationPayload | IdentityPayload

export interface MaintenanceExecutionContext {
  readonly kind: 'maintenance'
  readonly runId: string
  readonly attemptId: string
  readonly attemptGeneration?: number
  readonly incarnation?: string
  readonly organizationId: string | null
  readonly agentId: string
  readonly maintenance: MaintenancePayload
  readonly input?: never
  readonly workingDirectory?: never
  readonly outputDirectory?: never
  readonly instructions?: never
  readonly memory?: never
  readonly triggerMessageId?: never
  readonly interactions?: never
  readonly continuation?: never
  readonly delegationResults?: never
}

/** Text context, unchanged for existing adapters. Adapters treat a missing kind as text and throw on unknown kinds. */
export type ExecutionContext = TextExecutionContext
/** Additive context for adapters that explicitly support maintenance. */
export type AdapterExecutionContext = TextExecutionContext | MaintenanceExecutionContext

/** Versioned opaque recovery identity for durable reconciliation after process loss. */
export interface RecoveryReference {
  readonly adapterId: string
  readonly contractMajor: 1
  readonly recoveryVersion: number
  readonly stateScope: string
  readonly generationId?: string
  readonly digest?: string
  /** Opaque provider blob; never parsed when the identity is incompatible. */
  readonly providerIds: Readonly<Record<string, unknown>>
}

export interface DurableReconcileResult {
  readonly outcome: 'active' | 'ended' | 'unknown'
  readonly evidence: string
  readonly generationMismatch: boolean
}

/** Declared-compatibility gate shared by registry and direct-adapter paths. */
export function recoveryCompatible(declaredVersions: readonly number[] | undefined, declaredScopes: readonly string[] | undefined, ref: Pick<RecoveryReference, 'recoveryVersion' | 'stateScope'>): boolean {
  return !!declaredVersions?.includes(ref.recoveryVersion) && !!declaredScopes?.includes(ref.stateScope)
}

/** Direct (non-registry) adapters serving maintenance implement this shape. */
export interface MaintenanceCapableAdapter extends TextExecutionAdapter {
  execute(context: AdapterExecutionContext): Promise<ExecutionHandle>
  readonly recoveryVersions: readonly number[]
  readonly recoveryStateScopes: readonly string[]
  durableReconcile(request: { readonly recoveryRef: RecoveryReference }): Promise<DurableReconcileResult>
}
export interface AdapterHost {
  /** Private directory Core reserves for this adapter's own state. It persists across restarts; the adapter creates it when needed. */
  readonly dataDirectory?: string
  now(): string
  /** Authenticated by Core and correlated to the originating attempt. */
  invokeTool(request: { readonly attemptId: string; readonly callId: string; readonly name: string; readonly arguments: unknown }): Promise<unknown>
}
export interface AdapterCatalog {
  readonly models: readonly { readonly id: string; readonly efforts?: readonly string[] }[]
  /** The model, and optionally its effort, used when neither the agent nor its organization chooses one. It must be listed in `models`. */
  readonly defaultModel?: { readonly id: string; readonly effort?: string }
  readonly supportedOptions?: readonly string[]
  readonly capabilities: { readonly text: true; readonly publication: boolean; readonly cancellation: boolean; readonly steering: false; readonly nativeResume: false; readonly maintenance?: boolean }
}
export interface AdapterReadiness {
  readonly ready: boolean
  readonly reason?: string
  readonly catalog: AdapterCatalog
  /** Declared durable-recovery compatibility. Absent means no durable recovery. */
  readonly recoveryVersions?: readonly number[]
  readonly recoveryStateScopes?: readonly string[]
}
export type ExecutionEvent =
  | { readonly kind: 'provider'; readonly attemptId: string; readonly threadId: string; readonly turnId?: string; readonly processId: number; readonly providerStateScope: string; readonly workingDirectory: string; readonly modelId: string; readonly effort?: string }
  /** Full accumulated text for a stable messageId. Core may coalesce drafts: only the
   * latest matters. Send nothing for this ID after final=true; distinct messages use
   * distinct IDs. Final content is authoritative, not an appended fragment. */
  | { readonly kind: 'text'; readonly attemptId: string; readonly messageId: string; readonly text: string; readonly final: boolean }
  | { readonly kind: 'waiting'; readonly attemptId: string; readonly for: 'question' | 'approval' | 'child'; readonly interactionId: string }
  | { readonly kind: 'ended'; readonly attemptId: string; readonly confirmed: true }
  | { readonly kind: 'failed'; readonly attemptId: string; readonly confirmedEnded: boolean; readonly message: string }
export interface ExecutionHandle {
  readonly events: AsyncIterable<ExecutionEvent>
  /** Acknowledgement is not proof that the provider stopped. */
  cancel(): Promise<{ readonly acknowledged: boolean; readonly confirmedEnded: boolean }>
  /** Return serializable evidence for reconciliation after a lost result. */
  reconcile(): Promise<'active' | 'ended' | 'unknown'>
}
export interface TextExecutionAdapter extends AdapterIdentity {
  readonly contractMajor: 1
  readiness?(): Promise<AdapterReadiness>
  execute(context: ExecutionContext): Promise<ExecutionHandle>
  /** Durable provider reconciliation by versioned recovery reference. Absent means maintenance is unsupported. */
  durableReconcile?(request: { readonly recoveryRef: RecoveryReference }): Promise<DurableReconcileResult>
  /**
   * Optional. Removes the state the provider keeps for these provider thread IDs, such as session
   * files, after the conversations they served were permanently deleted. The IDs are those reported
   * in `provider` events. Unknown IDs are not an error, and a repeated call must be safe. Without it,
   * Core reports the IDs as provider state it could not remove.
   */
  forgetProviderState?(request: { readonly threadIds: readonly string[] }): Promise<void>
  close(): Promise<void>
}
export type TextAdapterFactory = AdapterFactory<AdapterHost, TextExecutionAdapter>
