import { createHash, randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import type { Attempt } from '../work/public.js'
import { isLive } from '../identity/public.js'
import { MEMORY_STRENGTH, deleteMemories, refreshRecalled, reinforce } from './strength.js'
import { applyConsolidation, parseConsolidation, type ConsolidationInput, type ConsolidationReport } from './consolidation.js'
import { applyPromotion, parsePromotion, type IdentityWriter, type PromotionInput, type PromotionReport } from './promotion.js'

/** Fixed sweep-hint job identity. Duplicates are safe: every path re-checks state. */
export const MAINTENANCE_SWEEP_JOB_ID = '00000000-0000-4000-8000-00000000000f'

/** Fixed maintenance limits shared by scheduling, extraction and recovery. */
export const MAINTENANCE_LIMITS = {
  fairnessThreshold: 8,
  counterMax: 1000000,
  claimLeaseMs: 5 * 60 * 1000,
  intentLeaseMs: 2 * 60 * 1000,
  intentReapsMax: 3,
  triesTotalMax: 5,
  prepFailedMax: 3,
  issuedMax: 2,
  requeueCyclesMax: 3,
  prepFailedDelayMs: [30 * 1000, 5 * 60 * 1000],
  issuedRetryDelayMs: 10 * 60 * 1000,
  contentionBackoffMs: 10 * 1000,
  executeHandshakeMs: 30 * 1000,
  attemptDeadlineMs: 10 * 60 * 1000,
  idleStreamMs: 120 * 1000,
  maxEvents: 200,
  maxReceivedTextBytes: 64 * 1024,
  outputJsonMaxBytes: 16 * 1024,
  cancelAckMs: 30 * 1000,
  reconcileMs: 15 * 1000,
  manifestInputMax: 1,
  manifestAgentMax: 8,
  manifestPerMessageBytes: 8 * 1024,
  manifestTotalBytes: 32 * 1024,
  outputCandidatesMax: 8,
  claimTextMax: 500,
  subjectMax: 200,
  excerptMax: 500,
  provenancePerCommit: 8,
  provenancePerMemory: 32,
  scannerTickMs: 60 * 1000,
  epochMs: 15 * 60 * 1000,
  scannerPagesPerTick: 10,
  scannerValidatePage: 50,
  repairInsertsPerEpoch: 50,
  pageTxMs: 8000,
  statementMs: 5000,
  lockMs: 1500,
  scannerWorkerDeadlineMs: 120 * 1000,
} as const

export const MAINTENANCE_INSTRUCTIONS_V1 = [
  'You extract durable memory candidates from frozen conversation evidence.',
  'Rules: output strict JSON only, at most 8 candidates. Each candidate needs kind (fact, observation, episode), text (1-500 chars, exact claim wording), subject (1-200 chars), author_id, author_class (human, agent, unknown), and 1 or more citations.',
  'Each citation needs message_id, revision, parts_hash and an excerpt of at most 500 chars copied exactly from the cited message. Cite only the supplied messages; every citation must match a supplied message id, revision, parts hash and author exactly.',
  'Never invent message ids, revisions, hashes, authors or excerpts. An empty candidate array is valid when nothing is worth retaining.',
  'A candidate may include importance, from 0.2 (minor) to 1 (essential); it defaults to 0.5.',
  'Set explicit to true only when a human message asks the agent to remember something or to adopt a standing instruction, such as "remember..." or "from now on..."; otherwise set it to false.',
  'Output schema: {"candidates": [{"kind": "fact", "text": "...", "subject": "...", "author_id": "...", "author_class": "human", "importance": 0.5, "explicit": false, "citations": [{"message_id": "...", "revision": 1, "parts_hash": "...", "excerpt": "..."}]}]}.',
].join('\n')

const only = (values: readonly (string | number)[]) => values.length ? { enum: [...new Set(values)] } : {}
/** JSON Schema for extraction output, limited to the supplied citation references. Every property is required, so
 * strict structured output accepts it; `importance` is nullable and null means the default. */
export function extractionOutputSchema(sources: readonly { messageId: string; revision: number; partsHash: string; authorId: string }[]): Record<string, unknown> {
  const citation = { type: 'object', additionalProperties: false, required: ['message_id', 'revision', 'parts_hash', 'excerpt'], properties: { message_id: { type: 'string', ...only(sources.map(source => source.messageId)) }, revision: { type: 'integer', ...only(sources.map(source => source.revision)) }, parts_hash: { type: 'string', ...only(sources.map(source => source.partsHash)) }, excerpt: { type: 'string' } } }
  const candidate = { type: 'object', additionalProperties: false, required: ['kind', 'text', 'subject', 'author_id', 'author_class', 'importance', 'explicit', 'citations'], properties: { kind: { type: 'string', enum: ['fact', 'observation', 'episode'] }, text: { type: 'string' }, subject: { type: 'string' }, author_id: { type: 'string', ...only(sources.map(source => source.authorId)) }, author_class: { type: 'string', enum: ['human', 'agent', 'unknown'] }, importance: { type: ['number', 'null'], minimum: 0, maximum: 1 }, explicit: { type: 'boolean' }, citations: { type: 'array', minItems: 1, items: citation } } }
  return { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', maxItems: MAINTENANCE_LIMITS.outputCandidatesMax, items: candidate } } }
}

export type MaintenanceSourceStatus = 'ready' | 'claimed' | 'issued' | 'recovery' | 'committed' | 'skipped' | 'fenced' | 'superseded' | 'source_deleted'
export type MaintenanceRunState = 'queued' | 'preparing' | 'running' | 'recovery-needed' | 'completed' | 'failed'
/** A maintenance run extracts one conversation source, or runs one model step of a sleep: consolidation or identity promotion. */
export type MaintenanceTaskKind = 'extract' | 'consolidate' | 'identity'
/** A claimed sleep run and its frozen input. */
export type SleepRunClaim = { runId: string; agentId: string } & ({ taskKind: 'consolidate'; input: ConsolidationInput } | { taskKind: 'identity'; input: PromotionInput })

export interface ManifestEntry {
  message_id: string
  position: number
  revision: number
  parts_sha256: string
  author_id: string
  author_class: 'human' | 'agent' | 'unknown'
}
export interface EvidenceManifest {
  version: 1
  entries: ManifestEntry[]
  excluded_over_cap: number
  delegation?: { delegation_id: string; sender: string; recipient: string }
}
export interface MaintenanceSource {
  runId: string
  revision: number
  manifestHash: string
  manifest: EvidenceManifest | null
  manifestPurged: boolean
  agentId: string
  contextKind: 'installation' | 'organization'
  contextId: string
  sourceThreadId: string | null
  status: MaintenanceSourceStatus
  statusReason: string | null
  reserved: boolean
  invalidated: boolean
  triesTotal: number
  prepFailedTries: number
  issuedTries: number
  cycles: number
  nextEligibleAt: string
}
export interface MaintenanceRun {
  id: string
  taskKind: MaintenanceTaskKind
  /** The extracted source; null for a sleep run. */
  sourceRunId: string | null
  sourceRevision: number | null
  agentId: string
  state: MaintenanceRunState
  currentAttemptId: string | null
  failureClass: string | null
  failure: string | null
  permitRetained: boolean
  reservationReason: string | null
  adapterId: string | null
  recoveryRefMissing: boolean
  recoveryImpaired: boolean
}
export type MaintenanceSettleMode = { kind: 'extract' } | { kind: 'no_output' } | { kind: 'failed_confirmed'; message: string } | { kind: 'unknown'; message: string }
export interface CandidateCitation {
  messageId: string
  revision: number
  partsHash: string
  excerpt: string
}
export interface ExtractionCandidate {
  kind: 'fact' | 'observation' | 'episode'
  text: string
  subject: string
  authorId: string
  authorClass: 'human' | 'agent' | 'unknown'
  importance?: number
  /** A human asked the agent to remember this or to adopt it as a standing instruction. Only human candidates can be explicit. */
  explicit?: boolean
  citations: CandidateCitation[]
}
export interface VerifiedSourceText {
  messageId: string
  position: number
  revision: number
  partsHash: string
  authorId: string
  authorClass: 'human' | 'agent' | 'unknown'
  text: string
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry)).join(',') + '}'
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Manifest value is not serializable')
  return encoded
}
/** Identity text: NFC with leading/trailing whitespace trimmed only. */
export function normalizeIdentityText(value: string): string {
  return value.normalize('NFC').trim()
}
const hasControls = (value: string): boolean => /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const invalidJsonString = (value: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\0/u.test(value)
function canStoreJson(value: unknown): boolean {
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string' && invalidJsonString(current)) return false
    if (Array.isArray(current)) pending.push(...current)
    else if (current && typeof current === 'object') for (const [key, entry] of Object.entries(current)) pending.push(key, entry)
  }
  return true
}
function validIdentityText(value: string, maxChars: number): boolean {
  if (!value || invalidJsonString(value) || hasControls(value)) return false
  const normalized = normalizeIdentityText(value)
  return normalized.length > 0 && [...normalized].length <= maxChars && Buffer.byteLength(value, 'utf8') <= 8192
}
export function manifestHashFor(manifest: EvidenceManifest): string {
  return sha256(canonical({ version: manifest.version, entries: manifest.entries, delegation: manifest.delegation ?? null }))
}
function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts.flatMap(part => part && typeof part === 'object' && (part as { kind?: unknown }).kind === 'text' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n')
}
/** Operator view of staged output: counts and a digest, never candidate text, excerpts or lessons. */
function stagedSummary(staged: unknown): { invalid: string } | { candidates: number; sha256: string } | { sha256: string } | null {
  if (!staged || typeof staged !== 'object') return null
  const value = staged as { invalid?: unknown; candidates?: unknown; result?: unknown }
  if (typeof value.invalid === 'string') return { invalid: value.invalid }
  if (value.result !== undefined) return { sha256: sha256(canonical(value.result)) }
  const candidates = Array.isArray(value.candidates) ? value.candidates : []
  return { candidates: candidates.length, sha256: sha256(canonical(candidates)) }
}
interface SourceRow {
  run_id: string; source_revision: string; manifest_hash: string; manifest: EvidenceManifest | null; manifest_purged: boolean
  agent_id: string; context_kind: 'installation' | 'organization'; context_id: string; source_thread_id: string | null
  status: MaintenanceSourceStatus; status_reason: string | null; reserved: boolean; invalidated: boolean
  claim_lease_until: string | null; claim_incarnation: string | null; lease_expired?: boolean
  tries_total: string; prep_failed_tries: string; issued_tries: string; cycles: string; next_eligible_at: string
  evidence_overflow: boolean
}
function sourceWire(row: SourceRow): MaintenanceSource {
  return {
    runId: row.run_id, revision: Number(row.source_revision), manifestHash: row.manifest_hash, manifest: row.manifest,
    manifestPurged: row.manifest_purged, agentId: row.agent_id, contextKind: row.context_kind, contextId: row.context_id,
    sourceThreadId: row.source_thread_id, status: row.status, statusReason: row.status_reason, reserved: row.reserved,
    invalidated: row.invalidated, triesTotal: Number(row.tries_total), prepFailedTries: Number(row.prep_failed_tries),
    issuedTries: Number(row.issued_tries), cycles: Number(row.cycles), nextEligibleAt: new Date(row.next_eligible_at).toISOString(),
  }
}

/** Queued sleep runs of installation `installationParam` whose sleep still runs and whose agent learns. */
function queuedSleepRun(installationParam: string): string {
  return `SELECT r.id, r.agent_id, r.task_kind, r.input, r.created_at FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps s ON s.id = r.sleep_id
    WHERE r.installation_id = ${installationParam} AND r.task_kind <> 'extract' AND r.state = 'queued' AND s.state = 'running'
      AND ${learningCondition('r.agent_id')}`
}

/** SQL condition that holds while the agent in `agentColumn` learns: it is live and its installation and agent switches are both on. */
export function learningCondition(agentColumn: string): string {
  return `EXISTS (SELECT 1 FROM kipster.agents la JOIN kipster.installations li ON li.id = la.installation_id
    WHERE la.id = ${agentColumn} AND la.learning_enabled AND li.learning_enabled AND kipster.live_agent(la.id))`
}

/** SQL condition that holds while an execution of the agent in `agentColumn` is in flight: preparing, running,
 * cancelling, awaiting recovery, or waiting on a human while its attempt still holds a permit. */
export function agentWorking(agentColumn: string): string {
  return `EXISTS (SELECT 1 FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
    LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
    WHERE COALESCE(d.recipient_agent_id, c.agent_id)=${agentColumn}
      AND (r.state IN ('preparing','running','cancellation-requested','recovery-needed')
        OR (r.state='waiting' AND EXISTS (SELECT 1 FROM kipster.owned_permits p WHERE p.attempt_id=r.current_attempt_id))))`
}

export async function agentLearns(client: SqlClient, agentId: string): Promise<boolean> {
  return (await client.query(`SELECT 1 WHERE ${learningCondition('$1::uuid')}`, [agentId])).rows.length > 0
}

/** Tables and transitions for maintenance. Learning switches gate enqueue, claim, issue and commit;
 * the dispatcher owns scheduling. */
export class MaintenanceService {
  /** `identity` writes the Learned section when a promotion settles; without it a promotion fails without writing. */
  constructor(readonly db: Postgres, readonly installationId: string, private readonly identity?: IdentityWriter) {}

  async learningEnabled(client: SqlClient = this.db): Promise<boolean> {
    const row = (await client.query<{ learning_enabled: boolean }>('SELECT learning_enabled FROM kipster.installations WHERE id=$1', [this.installationId])).rows[0]
    return row?.learning_enabled === true
  }

  /** Freeze the refs-only evidence manifest for a completed run. No message text stored. */
  async captureManifest(client: SqlClient, sourceRunId: string): Promise<{ manifest: EvidenceManifest; hash: string } | { empty: true }> {
    const run = (await client.query<{ input_message_id: string; thread_id: string }>(
      'SELECT input_message_id, thread_id FROM kipster.text_runs WHERE id=$1', [sourceRunId])).rows[0]
    if (!run) throw new Error('Source run not found')
    const sizes = (await client.query<{ id: string; position: string; revision: string; author_id: string; bytes: string; input: boolean }>(
      `SELECT m.id, m.position, m.revision, m.author_id, octet_length(m.parts::text) AS bytes, m.id = $2 AS input
       FROM kipster.messages m LEFT JOIN kipster.attempts a ON a.id = m.source_attempt_id
       WHERE m.thread_id = $3 AND (m.id = $2 OR (a.intent_id = $1 AND m.final = true))
       ORDER BY m.id = $2 DESC, m.position`, [sourceRunId, run.input_message_id, run.thread_id])).rows
    const entries: ManifestEntry[] = []
    let excluded = 0
    let total = 0
    let agentCount = 0
    for (const size of sizes) {
      const bytes = Number(size.bytes)
      if (!size.input && agentCount >= MAINTENANCE_LIMITS.manifestAgentMax) { excluded++; continue }
      if (bytes > MAINTENANCE_LIMITS.manifestPerMessageBytes || total + bytes > MAINTENANCE_LIMITS.manifestTotalBytes) { excluded++; continue }
      const full = (await client.query<{ parts: unknown; revision: string; author_id: string }>(
        'SELECT parts, revision, author_id FROM kipster.messages WHERE id=$1', [size.id])).rows[0]!
      const person = (await client.query('SELECT 1 FROM kipster.people WHERE id=$1 AND installation_id=$2', [full.author_id, this.installationId])).rows.length
      const agent = person ? 0 : (await client.query('SELECT 1 FROM kipster.agents WHERE id=$1 AND installation_id=$2', [full.author_id, this.installationId])).rows.length
      entries.push({
        message_id: size.id, position: Number(size.position), revision: Number(full.revision),
        parts_sha256: sha256(canonical(full.parts)), author_id: full.author_id,
        author_class: person ? 'human' : agent ? 'agent' : 'unknown',
      })
      total += bytes
      if (!size.input) agentCount++
    }
    if (!entries.length) return { empty: true }
    const delegation = (await client.query<{ id: string; sender_agent_id: string; recipient_agent_id: string }>(
      'SELECT id, sender_agent_id, recipient_agent_id FROM kipster.delegations WHERE child_run_id=$1', [sourceRunId])).rows[0]
    const manifest: EvidenceManifest = {
      version: 1, entries, excluded_over_cap: excluded,
      ...(delegation ? { delegation: { delegation_id: delegation.id, sender: delegation.sender_agent_id, recipient: delegation.recipient_agent_id } } : {}),
    }
    return { manifest, hash: manifestHashFor(manifest) }
  }

  /** Unified identity rule shared by settlement, scanner and requeue paths. Nothing is captured for an agent that is not learning. */
  async allocateSource(client: SqlClient, jobs: Jobs, sourceRunId: string, agentId: string, contextKind: 'installation' | 'organization', contextId: string, sourceThreadId: string | null, hint = true): Promise<{ revision: number; hash: string; created: boolean } | { empty: true } | { disabled: true }> {
    if (!await agentLearns(client, agentId)) return { disabled: true }
    const frozen = await this.captureManifest(client, sourceRunId)
    if ('empty' in frozen) return frozen
    const insertNew = async (): Promise<{ revision: number; hash: string; created: boolean } | null> => {
      const locked = (await client.query<{ source_revision: string }>(
        'SELECT source_revision FROM kipster.maintenance_sources WHERE run_id=$1 ORDER BY source_revision FOR UPDATE', [sourceRunId])).rows
      const raced = (await client.query<{ source_revision: string }>(
        'SELECT source_revision FROM kipster.maintenance_sources WHERE run_id=$1 AND manifest_hash=$2', [sourceRunId, frozen.hash])).rows[0]
      if (raced) return { revision: Number(raced.source_revision), hash: frozen.hash, created: false }
      const revision = locked.length ? Math.max(...locked.map(row => Number(row.source_revision))) + 1 : 1
      // ON CONFLICT keeps the transaction healthy: losers re-select below.
      const inserted = await client.query(
        `INSERT INTO kipster.maintenance_sources(installation_id, run_id, source_revision, manifest_hash, manifest, agent_id, context_kind, context_id, source_thread_id, status)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'ready') ON CONFLICT DO NOTHING`,
        [this.installationId, sourceRunId, revision, frozen.hash, JSON.stringify(frozen.manifest), agentId, contextKind, contextId, sourceThreadId])
      if (!inserted.rowCount) return null
      if (locked.length) {
        await client.query(
          `UPDATE kipster.maintenance_sources SET status='superseded', status_reason='manifest superseded', updated_at=now()
           WHERE run_id=$1 AND source_revision<>$2 AND status NOT IN ('committed','skipped','fenced','superseded','source_deleted','issued','recovery')`,
          [sourceRunId, revision])
        await client.query(
          `UPDATE kipster.maintenance_sources SET invalidated=true, updated_at=now() WHERE run_id=$1 AND source_revision<>$2 AND status IN ('issued','recovery')`,
          [sourceRunId, revision])
      }
      if (hint) await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return { revision, hash: frozen.hash, created: true }
    }
    const hit = (await client.query<{ source_revision: string; status: string }>(
      'SELECT source_revision, status FROM kipster.maintenance_sources WHERE run_id=$1 AND manifest_hash=$2', [sourceRunId, frozen.hash])).rows[0]
    if (hit) {
      // Content edited away and back again was never extracted: its superseded revision becomes eligible again.
      if (hit.status === 'superseded') {
        const revived = await client.query(`UPDATE kipster.maintenance_sources SET status='ready', status_reason=NULL, reserved=false, claim_lease_until=NULL,
          claim_incarnation=NULL, next_eligible_at=now(), updated_at=now() WHERE run_id=$1 AND source_revision=$2 AND status='superseded'`, [sourceRunId, hit.source_revision])
        if (revived.rowCount && hint) await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      }
      return { revision: Number(hit.source_revision), hash: frozen.hash, created: false }
    }
    return (await insertNew()) ?? (await insertNew()) ?? (() => { throw new Error('Source allocation conflict') })()
  }

  /** Settlement hook. Caller holds the capacity lock in the committing transaction. */
  async enqueueFromSettlement(client: SqlClient, jobs: Jobs, sourceRunId: string, agentId: string, contextKind: 'installation' | 'organization', contextId: string, sourceThreadId: string): Promise<{ revision: number; hash: string } | null> {
    const allocated = await this.allocateSource(client, jobs, sourceRunId, agentId, contextKind, contextId, sourceThreadId)
    if (!('revision' in allocated)) return null
    return { revision: allocated.revision, hash: allocated.hash }
  }

  async textDemand(client: SqlClient): Promise<boolean> {
    // One lock-free SELECT under the held capacity lock; no queue_hold gate.
    const found = (await client.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM kipster.text_runs r JOIN kipster.threads t ON t.id = r.thread_id JOIN kipster.direct_chats c ON c.id = t.chat_id
         WHERE c.installation_id = $1 AND r.state = 'preparing')
       OR EXISTS (
         SELECT 1 FROM kipster.text_runs r JOIN kipster.threads t ON t.id = r.thread_id JOIN kipster.direct_chats c ON c.id = t.chat_id
         WHERE c.installation_id = $1 AND r.state = 'queued'
           AND NOT EXISTS (
             SELECT 1 FROM kipster.text_runs a WHERE a.thread_id = r.thread_id AND a.id <> r.id
               AND a.state IN ('preparing','running','waiting','cancellation-requested','recovery-needed'))
           AND r.id = (
             SELECT h.id FROM kipster.text_runs h WHERE h.thread_id = r.thread_id
               AND NOT (h.state IN ('completed','cancelled','failed') AND h.queue_hold = false)
             ORDER BY h.queue_position LIMIT 1))
       LIMIT 1`, [this.installationId])).rows.length
    return found > 0
  }

  async counter(client: SqlClient): Promise<number> {
    const row = (await client.query<{ maintenance_counter: string }>(
      'SELECT maintenance_counter FROM kipster.execution_permits WHERE installation_id=$1', [this.installationId])).rows[0]
    return Number(row?.maintenance_counter ?? 0)
  }

  /** Due (reservation) check for text admission. Caller holds the capacity lock. */
  async maintenanceDue(client: SqlClient): Promise<boolean> {
    // The owner exclusion covers issued runs only (running, recovery-needed):
    // a claimed, unissued source keeps its reservation due.
    const due = (await client.query(
      `SELECT 1 WHERE (EXISTS (
         SELECT 1 FROM kipster.maintenance_sources
         WHERE installation_id = $1 AND ${learningCondition('agent_id')}
           AND ((status = 'ready' AND tries_total < $3 AND prep_failed_tries < $4 AND issued_tries < $5 AND next_eligible_at <= now())
             OR (status = 'claimed' AND claim_lease_until > now())))
         OR EXISTS (${queuedSleepRun('$1')}))
       AND NOT EXISTS (
         SELECT 1 FROM kipster.maintenance_runs WHERE installation_id = $1 AND state IN ('running','recovery-needed'))
       AND (SELECT maintenance_counter FROM kipster.execution_permits WHERE installation_id = $1) >= $2
       LIMIT 1`, [this.installationId, MAINTENANCE_LIMITS.fairnessThreshold, MAINTENANCE_LIMITS.triesTotalMax, MAINTENANCE_LIMITS.prepFailedMax, MAINTENANCE_LIMITS.issuedMax])).rows.length
    return due > 0
  }

  /** Skips pending sources of agents that are not learning. Caller holds the capacity lock. */
  async skipNotLearning(client: SqlClient): Promise<number> {
    return (await client.query(
      `UPDATE kipster.maintenance_sources s SET status='skipped', status_reason='learning_disabled', reserved=false, updated_at=now()
       WHERE s.installation_id=$1 AND s.status='ready' AND NOT ${learningCondition('s.agent_id')}`, [this.installationId])).rowCount ?? 0
  }

  /** Claim one admissible source. Caller holds the capacity lock. No lock held across preparation.
   * Pending sources of agents that are not learning are skipped first; a refusal reports how many. */
  async claimSource(client: SqlClient, incarnation: string, memoryAvailable: boolean): Promise<{ source: MaintenanceSource; runId: string; attempt: Attempt } | { refused: string; skipped: number }> {
    if (!memoryAvailable) return { refused: 'memory_unavailable', skipped: 0 }
    if ((await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 AND update_request_id IS NOT NULL', [this.installationId])).rows.length) return { refused: 'update_in_progress', skipped: 0 }
    const skipped = await this.skipNotLearning(client)
    const owner = (await client.query(
      `SELECT 1 FROM kipster.maintenance_runs WHERE installation_id=$1 AND state IN ('preparing','running','recovery-needed') LIMIT 1`,
      [this.installationId])).rows.length
    if (owner) return { refused: 'busy', skipped }
    const demand = await this.textDemand(client)
    const count = await this.counter(client)
    if (demand && count < MAINTENANCE_LIMITS.fairnessThreshold) return { refused: 'text_demand', skipped }
    const pick = (await client.query<SourceRow>(
      `SELECT * FROM kipster.maintenance_sources WHERE installation_id=$1 AND status='ready'
         AND next_eligible_at <= now() AND tries_total < $2 AND prep_failed_tries < $3 AND issued_tries < $4
       ORDER BY next_eligible_at, run_id, source_revision LIMIT 1 FOR UPDATE`,
      [this.installationId, MAINTENANCE_LIMITS.triesTotalMax, MAINTENANCE_LIMITS.prepFailedMax, MAINTENANCE_LIMITS.issuedMax])).rows[0]
    if (!pick) return { refused: 'none_ready', skipped }
    const reserved = count >= MAINTENANCE_LIMITS.fairnessThreshold
    const resumed = (await client.query<{ id: string }>(
      `SELECT id FROM kipster.maintenance_runs WHERE source_run_id=$1 AND source_revision=$2 AND state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [pick.run_id, pick.source_revision])).rows[0]
    const runId = resumed?.id ?? randomUUID()
    const updated = (await client.query<SourceRow>(
      `UPDATE kipster.maintenance_sources SET status='claimed', reserved=$3, claim_lease_until=now()+($4::text||' milliseconds')::interval,
         claim_incarnation=$5, tries_total=tries_total+1, updated_at=now()
       WHERE run_id=$1 AND source_revision=$2 AND status='ready' RETURNING *`,
      [pick.run_id, pick.source_revision, reserved, String(MAINTENANCE_LIMITS.claimLeaseMs), incarnation])).rows[0]
    if (!updated) return { refused: 'claim_raced', skipped }
    if (!resumed) await client.query(`INSERT INTO kipster.work_intents(id, installation_id, state) VALUES ($1,$2,'queued')`, [runId, this.installationId])
    const intent = (await client.query<{ generation: string }>('SELECT generation FROM kipster.work_intents WHERE id=$1 FOR UPDATE', [runId])).rows[0]!
    const generation = Number(intent.generation) + 1
    const attemptId = randomUUID()
    await client.query(`UPDATE kipster.work_intents SET state='preparing', generation=$2 WHERE id=$1`, [runId, generation])
    await client.query(`INSERT INTO kipster.attempts(id, intent_id, generation, incarnation, state) VALUES ($1,$2,$3,$4,'preparing')`,
      [attemptId, runId, generation, incarnation])
    if (resumed) await client.query(`UPDATE kipster.maintenance_runs SET state='preparing', current_attempt_id=$2, updated_at=now() WHERE id=$1`, [runId, attemptId])
    else await client.query(`INSERT INTO kipster.maintenance_runs(id, installation_id, source_run_id, source_revision, agent_id, state, current_attempt_id)
      VALUES ($1,$2,$3,$4,$5,'preparing',$6)`, [runId, this.installationId, pick.run_id, pick.source_revision, pick.agent_id, attemptId])
    const attempt: Attempt = { id: attemptId, intentId: runId, generation, incarnation, state: 'preparing' }
    return { source: sourceWire(updated), runId, attempt }
  }

  /** Issue a claimed run into its permit. Caller holds the capacity lock. A source whose agent stopped learning is skipped. */
  async issueMaintenance(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, sourceRunId: string, sourceRevision: number, incarnation: string, coordinating: boolean, adapterId: string, recoveryVersion: number, generationId?: string, digest?: string, runnerIncarnation?: string, installationRoot?: string): Promise<{ issued: true } | { refused: string }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null }>(
      'SELECT state, current_attempt_id FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
    const fenced = (await client.query<{ attempt_state: string; intent_state: string }>(
      `SELECT a.state AS attempt_state, i.state AS intent_state FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND i.generation=$3 FOR UPDATE OF a, i`,
      [attempt.id, runId, attempt.generation, incarnation])).rows[0]
    const source = (await client.query<SourceRow>(
      `SELECT *, (claim_lease_until IS NULL OR claim_lease_until <= now()) AS lease_expired
       FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE`, [sourceRunId, sourceRevision])).rows[0]
    const endUnissued = async (prepFailed: boolean, delayMs: number | null, failure: string, terminal: 'fenced' | 'skipped' | null, refundClaim: boolean): Promise<void> => {
      await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [attempt.id])
      await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state='preparing'`, [runId])
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, updated_at=now() WHERE id=$1`, [runId, failure])
      if (terminal) {
        await client.query(`UPDATE kipster.maintenance_sources SET status=$4, status_reason=$3, claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now()
          WHERE run_id=$1 AND source_revision=$2`, [sourceRunId, sourceRevision, failure, terminal])
      } else {
        await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false, claim_lease_until=NULL, claim_incarnation=NULL,
            tries_total=${refundClaim ? 'GREATEST(tries_total-1,0)' : 'tries_total'},
            prep_failed_tries=prep_failed_tries+${prepFailed ? 1 : 0}, next_eligible_at=${delayMs === null ? 'now()' : `now()+(${delayMs}||' milliseconds')::interval`}, updated_at=now()
          WHERE run_id=$1 AND source_revision=$2`, [sourceRunId, sourceRevision])
        if (delayMs !== null) await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID, Math.ceil(delayMs / 1000))
      }
    }
    if (!run || run.state !== 'preparing' || run.current_attempt_id !== attempt.id || !fenced || fenced.attempt_state !== 'preparing' || fenced.intent_state !== 'preparing' || !source || source.status !== 'claimed') {
      return { refused: 'cas_mismatch' }
    }
    if (!coordinating) {
      await endUnissued(false, null, 'coordinator lock lost before issue', null, true)
      return { refused: 'not_coordinating' }
    }
    if (!await agentLearns(client, source.agent_id)) {
      await endUnissued(false, null, 'learning_disabled', 'skipped', false)
      return { refused: 'learning_disabled' }
    }
    if (source.context_kind === 'organization' && !await isLive(client, this.installationId, 'organization', source.context_id)) {
      await endUnissued(false, null, 'organization unavailable', 'skipped', false)
      return { refused: 'organization_unavailable' }
    }
    if (source.lease_expired) {
      const failed = Number(source.prep_failed_tries) + 1
      const fence = failed >= MAINTENANCE_LIMITS.prepFailedMax
      const delay = fence ? null : MAINTENANCE_LIMITS.prepFailedDelayMs[failed - 1]!
      await endUnissued(true, delay, fence ? 'preparation tries exhausted' : 'claim lease expired', fence ? 'fenced' : null, false)
      if (fence) await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return { refused: 'lease_expired' }
    }
    // This preparing run may issue only when no other run owns maintenance.
    const other = (await client.query(
      `SELECT 1 FROM kipster.maintenance_runs WHERE installation_id=$1 AND id<>$2 AND state IN ('preparing','running','recovery-needed') LIMIT 1`,
      [this.installationId, runId])).rows.length
    if (other) {
      await endUnissued(false, MAINTENANCE_LIMITS.contentionBackoffMs, 'contention deferred', null, true)
      return { refused: 'contention' }
    }
    const ceiling = (await client.query<{ ceiling: string }>(
      'SELECT CASE WHEN update_request_id IS NULL THEN ceiling ELSE 0 END AS ceiling FROM kipster.execution_permits WHERE installation_id=$1', [this.installationId])).rows[0]!
    const held = (await client.query<{ count: string }>(
      'SELECT count(*) FROM kipster.owned_permits WHERE installation_id=$1', [this.installationId])).rows[0]!
    if (Number(held.count) >= Number(ceiling.ceiling)) {
      await endUnissued(false, MAINTENANCE_LIMITS.contentionBackoffMs, 'contention deferred', null, true)
      return { refused: 'no_permit' }
    }
    const budgeted = (await client.query(
      `UPDATE kipster.maintenance_sources SET issued_tries=issued_tries+1, updated_at=now()
       WHERE run_id=$1 AND source_revision=$2 AND status='claimed' AND issued_tries < $3`, [sourceRunId, sourceRevision, MAINTENANCE_LIMITS.issuedMax])).rowCount
    if (!budgeted) {
      await endUnissued(false, null, 'issued budget exhausted', 'fenced', false)
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return { refused: 'issued_exhausted' }
    }
    if (!await this.issueRun(client, runId, attempt, incarnation, adapterId, recoveryVersion, generationId, digest, runnerIncarnation, installationRoot)) return { refused: 'cas_mismatch' }
    await client.query(
      `UPDATE kipster.maintenance_sources SET status='issued', claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now()
       WHERE run_id=$1 AND source_revision=$2`, [sourceRunId, sourceRevision])
    return { issued: true }
  }

  /** Issues a prepared run into a permit: the attempt, its intent and the run become issued and running. */
  private async issueRun(client: SqlClient, runId: string, attempt: Attempt, incarnation: string, adapterId: string, recoveryVersion: number, generationId?: string, digest?: string, runnerIncarnation?: string, installationRoot?: string): Promise<boolean> {
    await client.query(`UPDATE kipster.work_intents SET state='issued' WHERE id=$1 AND generation=$2 AND state='preparing'`, [runId, attempt.generation])
    const issuedAttempt = (await client.query(
      `UPDATE kipster.attempts SET state='issued', adapter_id=$5, adapter_generation_id=$6, runner_incarnation=$7, adapter_installation_digest=$8, adapter_installation_root=$9 WHERE id=$1 AND intent_id=$2 AND generation=$3 AND incarnation=$4 AND state='preparing'`,
      [attempt.id, runId, attempt.generation, incarnation, adapterId, generationId ?? null, runnerIncarnation ?? null, digest ?? null, installationRoot ?? null])).rowCount
    if (!issuedAttempt) return false
    await client.query('INSERT INTO kipster.owned_permits(attempt_id, installation_id) VALUES ($1,$2)', [attempt.id, this.installationId])
    await client.query('UPDATE kipster.execution_permits SET maintenance_counter=0 WHERE installation_id=$1', [this.installationId])
    await client.query(
      `UPDATE kipster.maintenance_runs SET state='running', adapter_id=$2, recovery_ref=$3::jsonb,
         issued_at=now(), deadline_at=now()+($4||' milliseconds')::interval, updated_at=now() WHERE id=$1`,
      [runId, adapterId, JSON.stringify({
        adapterId, contractMajor: 1, recoveryVersion,
        ...(generationId ? { generationId } : {}), ...(digest ? { digest } : {}), providerIds: {},
      }), String(MAINTENANCE_LIMITS.attemptDeadlineMs)])
    return true
  }

  /** Whether another maintenance run of the installation is being prepared, runs or awaits recovery. */
  private async otherRunActive(client: SqlClient, runId: string | null): Promise<boolean> {
    return (await client.query(
      `SELECT 1 FROM kipster.maintenance_runs WHERE installation_id=$1 AND id IS DISTINCT FROM $2::uuid AND state IN ('preparing','running','recovery-needed') LIMIT 1`,
      [this.installationId, runId])).rows.length > 0
  }

  /** Claims the oldest queued sleep run whose sleep still runs and whose agent learns. Returns null when there is none,
   * so the caller claims a source instead. It shares the single maintenance slot and the fairness rule with
   * extraction. Caller holds the capacity lock. */
  async claimSleepRun(client: SqlClient, incarnation: string, memoryAvailable: boolean): Promise<{ sleepRun: SleepRunClaim; attempt: Attempt } | { refused: string } | null> {
    if ((await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 AND update_request_id IS NOT NULL', [this.installationId])).rows.length) return { refused: 'update_in_progress' }
    if (!memoryAvailable) return null
    const pick = (await client.query<{ id: string; agent_id: string; task_kind: 'consolidate' | 'identity'; input: ConsolidationInput & PromotionInput }>(
      `${queuedSleepRun('$1')} ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF r`, [this.installationId])).rows[0]
    if (!pick) return null
    if (await this.otherRunActive(client, null)) return { refused: 'busy' }
    if (await this.textDemand(client) && await this.counter(client) < MAINTENANCE_LIMITS.fairnessThreshold) return { refused: 'text_demand' }
    const intent = (await client.query<{ generation: string }>('SELECT generation FROM kipster.work_intents WHERE id=$1 FOR UPDATE', [pick.id])).rows[0]!
    const generation = Number(intent.generation) + 1
    const attemptId = randomUUID()
    await client.query(`UPDATE kipster.work_intents SET state='preparing', generation=$2 WHERE id=$1`, [pick.id, generation])
    await client.query(`INSERT INTO kipster.attempts(id, intent_id, generation, incarnation, state) VALUES ($1,$2,$3,$4,'preparing')`, [attemptId, pick.id, generation, incarnation])
    await client.query(`UPDATE kipster.maintenance_runs SET state='preparing', current_attempt_id=$2, updated_at=now() WHERE id=$1`, [pick.id, attemptId])
    return { sleepRun: { runId: pick.id, agentId: pick.agent_id, taskKind: pick.task_kind, input: pick.input }, attempt: { id: attemptId, intentId: pick.id, generation, incarnation, state: 'preparing' } }
  }

  /** Ends a sleep run attempt that was prepared but not issued: back to the queue, or failed. */
  private async unissuedSleepRun(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, next: { queued: true; delayMs?: number } | { failure: string }): Promise<void> {
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [attempt.id])
    await client.query(`UPDATE kipster.work_intents SET state=$2 WHERE id=$1 AND state='preparing'`, [runId, 'queued' in next ? 'queued' : 'settled'])
    if ('queued' in next) {
      await client.query(`UPDATE kipster.maintenance_runs SET state='queued', current_attempt_id=NULL, updated_at=now() WHERE id=$1`, [runId])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID, next.delayMs ? Math.ceil(next.delayMs / 1000) : undefined)
    } else {
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, updated_at=now() WHERE id=$1`, [runId, next.failure.slice(0, 2000)])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    }
  }

  /** Preparation of a sleep run failed before issue. The run fails and its sleep moves on; the next sleep tries again.
   * Caller holds the capacity lock. */
  async failSleepRun(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, reason: string): Promise<void> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null }>(
      'SELECT state, current_attempt_id FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
    if (!run || run.state !== 'preparing' || run.current_attempt_id !== attempt.id) return
    await this.unissuedSleepRun(client, jobs, runId, attempt, { failure: reason })
  }

  /** Issues a prepared sleep run. It is issued only while its sleep runs and its agent learns. Caller holds the capacity lock. */
  async issueSleepRun(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, incarnation: string, coordinating: boolean, adapterId: string, recoveryVersion: number, generationId?: string, digest?: string, runnerIncarnation?: string, installationRoot?: string): Promise<{ issued: true } | { refused: string }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; agent_id: string; sleep_running: boolean }>(
      `SELECT r.state, r.current_attempt_id, r.agent_id, COALESCE(s.state='running', false) AS sleep_running
       FROM kipster.maintenance_runs r LEFT JOIN kipster.memory_sleeps s ON s.id=r.sleep_id WHERE r.id=$1 FOR UPDATE OF r`, [runId])).rows[0]
    const fenced = (await client.query<{ attempt_state: string; intent_state: string }>(
      `SELECT a.state AS attempt_state, i.state AS intent_state FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND i.generation=$3 FOR UPDATE OF a, i`,
      [attempt.id, runId, attempt.generation, incarnation])).rows[0]
    if (!run || run.state !== 'preparing' || run.current_attempt_id !== attempt.id || fenced?.attempt_state !== 'preparing' || fenced.intent_state !== 'preparing') return { refused: 'cas_mismatch' }
    if (!coordinating) {
      await this.unissuedSleepRun(client, jobs, runId, attempt, { queued: true })
      return { refused: 'not_coordinating' }
    }
    if (!await agentLearns(client, run.agent_id) || !run.sleep_running) {
      await this.unissuedSleepRun(client, jobs, runId, attempt, { failure: run.sleep_running ? 'learning_disabled' : 'sleep ended' })
      return { refused: 'learning_disabled' }
    }
    const ceiling = (await client.query<{ ceiling: string }>('SELECT CASE WHEN update_request_id IS NULL THEN ceiling ELSE 0 END AS ceiling FROM kipster.execution_permits WHERE installation_id=$1', [this.installationId])).rows[0]!
    const held = (await client.query<{ count: string }>('SELECT count(*) FROM kipster.owned_permits WHERE installation_id=$1', [this.installationId])).rows[0]!
    if (await this.otherRunActive(client, runId) || Number(held.count) >= Number(ceiling.ceiling)) {
      await this.unissuedSleepRun(client, jobs, runId, attempt, { queued: true, delayMs: MAINTENANCE_LIMITS.contentionBackoffMs })
      return { refused: 'contention' }
    }
    if (!await this.issueRun(client, runId, attempt, incarnation, adapterId, recoveryVersion, generationId, digest, runnerIncarnation, installationRoot)) return { refused: 'cas_mismatch' }
    return { issued: true }
  }

  /** Persist provider metadata on receipt. Attempt-fenced; silent no-op on mismatch. */
  async recordMaintenanceProvider(client: SqlClient, attempt: Attempt, event: { threadId: string; turnId?: string; processId: number; providerStateScope: string; workingDirectory: string; modelId: string; effort?: string }): Promise<void> {
    // Run before attempt, as in issue, settlement and close fencing.
    await client.query('SELECT 1 FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [attempt.intentId])
    await client.query(
      `UPDATE kipster.attempts a SET provider_metadata = provider_metadata || $5::jsonb
       FROM kipster.work_intents i, kipster.maintenance_runs r
       WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND a.state='issued'
         AND i.id=a.intent_id AND i.state='issued' AND i.generation=a.generation
         AND r.id=i.id AND r.current_attempt_id=a.id AND r.state='running'`,
      [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation, JSON.stringify({
        threadId: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}), processId: event.processId,
        providerStateScope: event.providerStateScope, workingDirectory: event.workingDirectory, modelId: event.modelId,
        ...(event.effort ? { effort: event.effort } : {}),
      })])
    await client.query(
      `UPDATE kipster.maintenance_runs r SET recovery_ref = COALESCE(r.recovery_ref,'{}'::jsonb) || $5::jsonb, updated_at=now()
       FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE r.id=$2 AND r.current_attempt_id=$1 AND r.state='running'
         AND a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND a.state='issued' AND i.state='issued'`,
      [attempt.id, attempt.intentId, attempt.generation, attempt.incarnation, JSON.stringify({
        stateScope: event.providerStateScope,
        providerIds: { threadId: event.threadId, ...(event.turnId ? { turnId: event.turnId } : {}), processId: event.processId },
      })])
  }

  /** Mark staged output invalid from an unsupported stream event. First marker wins. */
  async markOutputInvalid(client: SqlClient, attempt: Attempt, reason: string): Promise<{ invalid: string }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; staged_output: unknown }>(
      'SELECT state, current_attempt_id, staged_output FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [attempt.intentId])).rows[0]
    if (!run || run.state !== 'running' || run.current_attempt_id !== attempt.id) return { invalid: 'run_not_running' }
    const prior = run.staged_output as { invalid?: string } | null
    if (prior?.invalid) return { invalid: prior.invalid }
    await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
      [attempt.intentId, JSON.stringify({ invalid: reason })])
    return { invalid: reason }
  }

  /** Stage the single final text event. Commits nothing; acknowledges no outcome. */
  async stageMaintenanceOutput(client: SqlClient, attempt: Attempt, text: string): Promise<{ staged: true } | { invalid: string }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; staged_output: unknown; task_kind: string }>(
      'SELECT state, current_attempt_id, staged_output, task_kind FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [attempt.intentId])).rows[0]
    if (!run || run.state !== 'running' || run.current_attempt_id !== attempt.id) return { invalid: 'run_not_running' }
    const prior = run.staged_output as { candidates?: unknown; invalid?: string } | null
    if (prior?.invalid) return { invalid: prior.invalid }
    if (prior && !prior.invalid) {
      await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
        [attempt.intentId, JSON.stringify({ invalid: 'multiple_final_results' })])
      return { invalid: 'multiple_final_results' }
    }
    if (Buffer.byteLength(text, 'utf8') > MAINTENANCE_LIMITS.outputJsonMaxBytes) {
      await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
        [attempt.intentId, JSON.stringify({ invalid: 'output_too_large' })])
      return { invalid: 'output_too_large' }
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (run.task_kind !== 'extract') {
      // Sleep run output is validated against the frozen input at settlement.
      const valid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && canStoreJson(parsed)
      await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
        [attempt.intentId, JSON.stringify(valid ? { result: parsed } : { invalid: 'malformed_output' })])
      return valid ? { staged: true } : { invalid: 'malformed_output' }
    }
    const candidates = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as { candidates?: unknown }).candidates : null
    if (!Array.isArray(candidates) || candidates.length > MAINTENANCE_LIMITS.outputCandidatesMax || !canStoreJson(candidates)) {
      await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
        [attempt.intentId, JSON.stringify({ invalid: 'malformed_output' })])
      return { invalid: 'malformed_output' }
    }
    await client.query(`UPDATE kipster.maintenance_runs SET staged_output=$2::jsonb, updated_at=now() WHERE id=$1`,
      [attempt.intentId, JSON.stringify({ candidates })])
    return { staged: true }
  }

  private validateCandidates(raw: unknown[], manifest: EvidenceManifest, texts: Map<string, string>): { candidates: ExtractionCandidate[] } | { invalid: string } {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const byId = new Map(manifest.entries.map(entry => [entry.message_id, entry]))
    const candidates: ExtractionCandidate[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { invalid: 'malformed_output' }
      const row = item as Record<string, unknown>
      if (row.kind !== 'fact' && row.kind !== 'observation' && row.kind !== 'episode') return { invalid: 'malformed_output' }
      if (typeof row.text !== 'string' || !validIdentityText(row.text, MAINTENANCE_LIMITS.claimTextMax)) return { invalid: 'malformed_output' }
      if (typeof row.subject !== 'string' || !validIdentityText(row.subject, MAINTENANCE_LIMITS.subjectMax)) return { invalid: 'malformed_output' }
      if (typeof row.author_id !== 'string' || !uuid.test(row.author_id)) return { invalid: 'malformed_output' }
      if (row.author_class !== 'human' && row.author_class !== 'agent' && row.author_class !== 'unknown') return { invalid: 'malformed_output' }
      if (row.importance !== undefined && row.importance !== null && (typeof row.importance !== 'number' || !(row.importance >= 0 && row.importance <= 1))) return { invalid: 'malformed_output' }
      if (row.explicit !== undefined && typeof row.explicit !== 'boolean') return { invalid: 'malformed_output' }
      if (!Array.isArray(row.citations) || !row.citations.length) return { invalid: 'malformed_output' }
      const citations: CandidateCitation[] = []
      for (const citation of row.citations) {
        if (!citation || typeof citation !== 'object' || Array.isArray(citation)) return { invalid: 'malformed_output' }
        const cite = citation as Record<string, unknown>
        if (typeof cite.message_id !== 'string' || !Number.isSafeInteger(cite.revision) || Number(cite.revision) < 1) return { invalid: 'malformed_output' }
        if (typeof cite.parts_hash !== 'string' || !cite.parts_hash) return { invalid: 'malformed_output' }
        if (typeof cite.excerpt !== 'string' || !cite.excerpt.length || [...cite.excerpt].length > MAINTENANCE_LIMITS.excerptMax) return { invalid: 'malformed_output' }
        const entry = byId.get(cite.message_id)
        const text = texts.get(cite.message_id)
        if (!entry || text === undefined) return { invalid: 'citation_not_in_manifest' }
        if (entry.revision !== cite.revision || entry.parts_sha256 !== cite.parts_hash) return { invalid: 'citation_revision_mismatch' }
        if (entry.author_id !== row.author_id || entry.author_class !== row.author_class) return { invalid: 'citation_author_mismatch' }
        if (!text.includes(cite.excerpt)) return { invalid: 'citation_excerpt_mismatch' }
        citations.push({ messageId: cite.message_id, revision: Number(cite.revision), partsHash: cite.parts_hash, excerpt: cite.excerpt })
      }
      candidates.push({
        kind: row.kind, text: normalizeIdentityText(row.text), subject: normalizeIdentityText(row.subject),
        authorId: (row.author_id as string).toLowerCase(), authorClass: row.author_class, citations,
        ...(typeof row.importance === 'number' ? { importance: row.importance } : {}),
        ...(row.explicit === true && row.author_class === 'human' ? { explicit: true } : {}),
      })
    }
    return { candidates }
  }

  private candidateKey(candidate: ExtractionCandidate, ownerId: string, contextKind: string, contextId: string): { textHash: string; subjectHash: string; flat: string } {
    const textHash = sha256(candidate.text)
    const subjectHash = sha256(candidate.subject)
    const flat = [ownerId, candidate.kind, textHash, candidate.authorClass, candidate.authorId, contextKind, contextId, subjectHash].join('|')
    return { textHash, subjectHash, flat }
  }

  async settleMaintenance(client: SqlClient, jobs: Jobs, attempt: Attempt, incarnation: string, mode: MaintenanceSettleMode): Promise<{ outcome: 'committed'; created: number; duplicates: number; suppressedCorrected: number; overflowed: boolean } | { outcome: 'consolidated'; report: ConsolidationReport } | { outcome: 'promoted'; report: PromotionReport } | { outcome: 'failed'; retryScheduled: boolean; reason: string } | { outcome: 'fenced'; reason: string } | { outcome: 'recovery' } | { outcome: 'noop' }> {
    const located = (await client.query<{ source_run_id: string; source_revision: string; source_thread_id: string | null; task_kind: string }>(
      `SELECT r.source_run_id, r.source_revision, s.source_thread_id, r.task_kind FROM kipster.maintenance_runs r
       LEFT JOIN kipster.maintenance_sources s ON s.run_id = r.source_run_id AND s.source_revision = r.source_revision
       WHERE r.id = $1`, [attempt.intentId])).rows[0]
    if (!located) return { outcome: 'noop' }
    if (located.task_kind !== 'extract') return this.settleSleepRun(client, jobs, attempt, incarnation, mode)
    if (located.source_thread_id) await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [located.source_thread_id])
    const run = (await client.query<{ state: string; current_attempt_id: string | null; agent_id: string; staged_output: unknown }>(
      'SELECT state, current_attempt_id, agent_id, staged_output FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [attempt.intentId])).rows[0]
    const fenced = (await client.query<{ attempt_state: string; intent_state: string }>(
      `SELECT a.state AS attempt_state, i.state AS intent_state FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND i.generation=$3 FOR UPDATE OF a, i`,
      [attempt.id, attempt.intentId, attempt.generation, incarnation])).rows[0]
    const source = (await client.query<SourceRow>(
      'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [located.source_run_id, located.source_revision])).rows[0]
    if (!run || run.state !== 'running' || run.current_attempt_id !== attempt.id || !fenced || fenced.attempt_state !== 'issued' || fenced.intent_state !== 'issued' || !source || source.status !== 'issued') {
      return { outcome: 'noop' }
    }
    const release = async (): Promise<void> => {
      await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [attempt.id])
      await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [attempt.intentId])
      await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
    }
    const fenceTerminal = async (reason: string): Promise<{ outcome: 'fenced'; reason: string }> => {
      await release()
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [attempt.intentId, reason])
      await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason=$3, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
        [located.source_run_id, located.source_revision, reason])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return { outcome: 'fenced', reason }
    }
    const boundedFailure = async (reason: string, failureClass = 'invalid_output'): Promise<{ outcome: 'failed'; retryScheduled: boolean; reason: string } | { outcome: 'fenced'; reason: string }> => {
      await client.query('UPDATE kipster.maintenance_runs SET failure_class=$2 WHERE id=$1', [attempt.intentId, failureClass])
      if (Number(source.issued_tries) < MAINTENANCE_LIMITS.issuedMax) {
        await release()
        await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [attempt.intentId, reason])
        await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false,
            next_eligible_at=now()+($3||' milliseconds')::interval, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
          [located.source_run_id, located.source_revision, String(MAINTENANCE_LIMITS.issuedRetryDelayMs)])
        await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID, Math.ceil(MAINTENANCE_LIMITS.issuedRetryDelayMs / 1000))
        return { outcome: 'failed', retryScheduled: true, reason }
      }
      return fenceTerminal(reason)
    }
    if (mode.kind === 'unknown') {
      await client.query(`UPDATE kipster.attempts SET state='uncertain' WHERE id=$1`, [attempt.id])
      await client.query(`UPDATE kipster.work_intents SET state='uncertain' WHERE id=$1`, [attempt.intentId])
      const ref = (await client.query<{ recovery_ref: { providerIds?: Record<string, unknown> } | null }>(
        'SELECT recovery_ref FROM kipster.maintenance_runs WHERE id=$1', [attempt.intentId])).rows[0]?.recovery_ref
      const impaired = !ref || !ref.providerIds || !Object.keys(ref.providerIds).length
      await client.query(`UPDATE kipster.maintenance_runs SET state='recovery-needed', failure_class='unknown_end', failure=$2,
        permit_retained=true, reservation_reason='provider end unconfirmed', recovery_impaired=$3, staged_output=NULL, updated_at=now() WHERE id=$1`,
        [attempt.intentId, mode.message.slice(0, 2000), impaired])
      await client.query(`UPDATE kipster.maintenance_sources SET status='recovery', status_reason='provider end unconfirmed', updated_at=now()
        WHERE run_id=$1 AND source_revision=$2`, [located.source_run_id, located.source_revision])
      return { outcome: 'recovery' }
    }
    const ref = (await client.query<{ recovery_ref: { providerIds?: Record<string, unknown> } | null }>(
      'SELECT recovery_ref FROM kipster.maintenance_runs WHERE id=$1', [attempt.intentId])).rows[0]?.recovery_ref
    await client.query(`UPDATE kipster.maintenance_runs SET recovery_ref_missing=$2, updated_at=now() WHERE id=$1`,
      [attempt.intentId, !ref || !ref.providerIds || !Object.keys(ref.providerIds).length])
    if (source.invalidated) return fenceTerminal('source invalidated before commit')
    // Commit fences: agent and organization live, learning on, run completed, messages unchanged. Author may be gone.
    if (!await isLive(client, this.installationId, 'agent', run.agent_id)) return fenceTerminal('agent unavailable')
    if (source.context_kind === 'organization' && !await isLive(client, this.installationId, 'organization', source.context_id)) return fenceTerminal('organization unavailable')
    if (!await agentLearns(client, run.agent_id)) return fenceTerminal('learning_disabled')
    if (mode.kind === 'failed_confirmed') return boundedFailure(`provider failed: ${mode.message}`.slice(0, 2000), 'provider_failure')
    const sourceRun = (await client.query<{ state: string }>('SELECT state FROM kipster.text_runs WHERE id=$1', [located.source_run_id])).rows[0]
    if (!sourceRun || sourceRun.state !== 'completed') return fenceTerminal('source run no longer completed')
    const wired = sourceWire(source)
    const verified = await this.verifiedSourceTexts(client, wired)
    if ('mismatch' in verified) {
      await release()
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [attempt.intentId, 'stale manifest'])
      await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason='stale manifest', updated_at=now()
        WHERE run_id=$1 AND source_revision=$2`, [located.source_run_id, located.source_revision])
      await this.allocateSource(client, jobs, located.source_run_id, wired.agentId, wired.contextKind, wired.contextId, wired.sourceThreadId ?? located.source_thread_id!)
      return { outcome: 'fenced', reason: 'stale manifest' }
    }
    const staged = run.staged_output as { candidates?: unknown[]; invalid?: string } | null
    if (mode.kind === 'no_output' || !staged || staged.invalid) {
      return boundedFailure(staged?.invalid ?? 'zero_final_result')
    }
    const validated = this.validateCandidates(staged.candidates ?? [], wired.manifest!, new Map(verified.map(text => [text.messageId, text.text])))
    if ('invalid' in validated) return boundedFailure(validated.invalid)
    return this.commitCandidates(client, jobs, attempt, wired, validated.candidates)
  }

  /** Settles a sleep run attempt. Its commit fence requires the run's sleep to still run and its agent to learn and
   * exist; the validated result then applies in this transaction: a consolidation changes memories, a promotion
   * writes the Learned section of identity.md. An unknown end keeps the permit for reconciliation; any answer, valid
   * or not, ends the run. */
  private async settleSleepRun(client: SqlClient, jobs: Jobs, attempt: Attempt, incarnation: string, mode: MaintenanceSettleMode): Promise<{ outcome: 'consolidated'; report: ConsolidationReport } | { outcome: 'promoted'; report: PromotionReport } | { outcome: 'failed'; retryScheduled: boolean; reason: string } | { outcome: 'fenced'; reason: string } | { outcome: 'recovery' } | { outcome: 'noop' }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; agent_id: string; task_kind: string; staged_output: unknown; input: ConsolidationInput & PromotionInput; sleep_id: string | null; sleep_running: boolean; recovery_ref: { providerIds?: Record<string, unknown> } | null }>(
      `SELECT r.state, r.current_attempt_id, r.agent_id, r.task_kind, r.staged_output, r.input, r.sleep_id, r.recovery_ref, COALESCE(s.state='running', false) AS sleep_running
       FROM kipster.maintenance_runs r LEFT JOIN kipster.memory_sleeps s ON s.id=r.sleep_id WHERE r.id=$1 FOR UPDATE OF r`, [attempt.intentId])).rows[0]
    const fenced = (await client.query<{ attempt_state: string; intent_state: string }>(
      `SELECT a.state AS attempt_state, i.state AS intent_state FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.generation=$3 AND a.incarnation=$4 AND i.generation=$3 FOR UPDATE OF a, i`,
      [attempt.id, attempt.intentId, attempt.generation, incarnation])).rows[0]
    if (!run || run.state !== 'running' || run.current_attempt_id !== attempt.id || fenced?.attempt_state !== 'issued' || fenced.intent_state !== 'issued') return { outcome: 'noop' }
    const impaired = !run.recovery_ref?.providerIds || !Object.keys(run.recovery_ref.providerIds).length
    if (mode.kind === 'unknown') {
      await client.query(`UPDATE kipster.attempts SET state='uncertain' WHERE id=$1`, [attempt.id])
      await client.query(`UPDATE kipster.work_intents SET state='uncertain' WHERE id=$1`, [attempt.intentId])
      await client.query(`UPDATE kipster.maintenance_runs SET state='recovery-needed', failure_class='unknown_end', failure=$2,
        permit_retained=true, reservation_reason='provider end unconfirmed', recovery_impaired=$3, staged_output=NULL, updated_at=now() WHERE id=$1`,
        [attempt.intentId, mode.message.slice(0, 2000), impaired])
      return { outcome: 'recovery' }
    }
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [attempt.id])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [attempt.intentId])
    await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    const end = async <T extends 'failed' | 'fenced'>(outcome: T, reason: string, failureClass: string | null = null) => {
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, failure_class=$3, recovery_ref_missing=$4, staged_output=NULL, updated_at=now() WHERE id=$1`,
        [attempt.intentId, reason.slice(0, 2000), failureClass, impaired])
      return outcome === 'failed' ? { outcome: 'failed' as const, retryScheduled: false, reason } : { outcome: 'fenced' as const, reason }
    }
    if (!await isLive(client, this.installationId, 'agent', run.agent_id)) return end('fenced', 'agent unavailable')
    if (!await agentLearns(client, run.agent_id)) return end('fenced', 'learning_disabled')
    if (!run.sleep_running) return end('fenced', 'sleep ended')
    if (mode.kind === 'failed_confirmed') return end('failed', `provider failed: ${mode.message}`, 'provider_failure')
    const staged = run.staged_output as { result?: unknown; invalid?: string } | null
    if (mode.kind === 'no_output' || !staged || staged.invalid) return end('failed', staged?.invalid ?? 'zero_final_result', 'invalid_output')
    if (run.task_kind === 'identity') {
      const output = parsePromotion(staged.result)
      if ('invalid' in output) return end('failed', output.invalid, 'invalid_output')
      if (!this.identity) return end('failed', 'identity files unavailable')
      const report = await applyPromotion(client, this.identity, run.agent_id, run.input, output.section)
      if ('conflict' in report) return end('failed', 'identity.md changed')
      if ('failure' in report) return end('failed', report.failure)
      await client.query(`UPDATE kipster.memory_sleeps SET report=report || jsonb_build_object('promotion', $2::jsonb) WHERE id=$1`, [run.sleep_id, JSON.stringify(report)])
      await client.query(`UPDATE kipster.maintenance_runs SET state='completed', recovery_ref_missing=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [attempt.intentId, impaired])
      return { outcome: 'promoted', report }
    }
    const output = parseConsolidation(staged.result, run.input)
    if ('invalid' in output) return end('failed', output.invalid, 'invalid_output')
    const report = await applyConsolidation(client, this.installationId, run.agent_id, attempt.id, run.input, output)
    if ('fenced' in report) return end('fenced', report.fenced)
    await client.query(`UPDATE kipster.memory_sleeps SET report=report || jsonb_build_object('consolidation', $2::jsonb) WHERE id=$1`, [run.sleep_id, JSON.stringify(report)])
    await client.query(`UPDATE kipster.maintenance_runs SET state='completed', recovery_ref_missing=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [attempt.intentId, impaired])
    return { outcome: 'consolidated', report }
  }

  private async commitCandidates(client: SqlClient, jobs: Jobs, attempt: Attempt, source: MaintenanceSource, candidates: ExtractionCandidate[]): Promise<{ outcome: 'committed'; created: number; duplicates: number; suppressedCorrected: number; overflowed: boolean } | { outcome: 'fenced'; reason: string }> {
    const runId = attempt.intentId
    const fenceTerminal = async (reason: string): Promise<{ outcome: 'fenced'; reason: string }> => {
      await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [attempt.id])
      await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [runId])
      await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, staged_output=NULL, updated_at=now() WHERE id=$1`, [runId, reason])
      await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason=$3, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
        [source.runId, source.revision, reason])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return { outcome: 'fenced', reason }
    }
    const profile = (await client.query<{ generation: string }>(
      'SELECT generation FROM kipster.memory_profiles WHERE installation_id=$1 FOR SHARE', [this.installationId])).rows[0]
    if (!profile) return fenceTerminal('embedding profile unavailable')
    // Same key within one output collapses to the lowest ordinal.
    const seen = new Map<string, number>()
    const ordered = candidates.map((candidate, ordinal) => ({ candidate, ordinal: ordinal + 1 }))
      .filter(({ candidate }) => {
        const key = this.candidateKey(candidate, source.agentId, source.contextKind, source.contextId).flat
        if (seen.has(key)) return false
        seen.set(key, 1)
        return true
      })
    // Manual corrections also lock memory rows. Acquire existing targets in
    // UUID order before processing provider ordinals, preserving deterministic
    // output priority without reversing the shared profile -> memory lock order.
    const targetIds: string[] = []
    for (const { candidate } of ordered) {
      const key = this.candidateKey(candidate, source.agentId, source.contextKind, source.contextId)
      const target = (await client.query<{ memory_id: string }>(
        `SELECT memory_id FROM kipster.maintenance_candidate_claims
         WHERE owner_id=$1 AND kind=$2 AND text_sha256=$3 AND author_class=$4 AND author_id=$5 AND context_kind=$6 AND context_id=$7 AND subject_sha256=$8`,
        [source.agentId, candidate.kind, key.textHash, candidate.authorClass, candidate.authorId, source.contextKind, source.contextId, key.subjectHash])).rows[0]
      if (target) targetIds.push(target.memory_id)
    }
    if (targetIds.length) await client.query('SELECT id FROM kipster.memory_records WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [targetIds])
    // A fence on any candidate discards every earlier insert: nothing commits partially.
    await client.query('SAVEPOINT maintenance_commit')
    const abort = async (reason: string): Promise<{ outcome: 'fenced'; reason: string }> => {
      await client.query('ROLLBACK TO SAVEPOINT maintenance_commit')
      return fenceTerminal(reason)
    }
    let created = 0
    let duplicates = 0
    let suppressedCorrected = 0
    let overflowed = false
    let commitReceipts = 0
    const memoryCounts = new Map<string, number>()
    const supported = new Set<string>()
    const orgId = source.contextKind === 'organization' ? source.contextId : null
    const note = `maintenance ${source.runId} r${source.revision}`.slice(0, 200)
    const flagOverflow = async (claimId: string): Promise<void> => {
      overflowed = true
      await client.query(`UPDATE kipster.maintenance_candidate_claims SET status='evidence_overflow' WHERE id=$1 AND status='active'`, [claimId])
      await client.query(`UPDATE kipster.maintenance_sources SET evidence_overflow=true WHERE run_id=$1 AND source_revision=$2`, [source.runId, source.revision])
    }
    const attachEvidence = async (claimId: string, memoryId: string, candidate: ExtractionCandidate): Promise<void> => {
      let existing = memoryCounts.get(memoryId)
      if (existing === undefined) {
        existing = Number((await client.query<{ count: string }>(
          'SELECT count(*) FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId])).rows[0]!.count)
        memoryCounts.set(memoryId, existing)
      }
      for (const citation of candidate.citations) {
        if (commitReceipts >= MAINTENANCE_LIMITS.provenancePerCommit || memoryCounts.get(memoryId)! >= MAINTENANCE_LIMITS.provenancePerMemory) {
          await flagOverflow(claimId)
          return
        }
        const inserted = (await client.query(
          `INSERT INTO kipster.memory_provenance(id, memory_id, source_organization_id, source_thread_id, author_id, subject, note,
             source_message_id, source_message_revision, source_parts_hash, excerpt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [randomUUID(), memoryId, orgId, source.sourceThreadId, candidate.authorId, candidate.subject, note,
            citation.messageId, citation.revision, citation.partsHash, citation.excerpt])).rowCount
        if (inserted) {
          commitReceipts++
          memoryCounts.set(memoryId, memoryCounts.get(memoryId)! + 1)
          supported.add(memoryId)
        }
      }
    }
    for (const { candidate, ordinal } of ordered) {
      const key = this.candidateKey(candidate, source.agentId, source.contextKind, source.contextId)
      let claim = (await client.query<{ id: string; memory_id: string; recorded_memory_revision: string; creating_provenance_id: string | null; context_tombstoned: boolean }>(
        `SELECT id, memory_id, recorded_memory_revision, creating_provenance_id, context_tombstoned
         FROM kipster.maintenance_candidate_claims
         WHERE owner_id=$1 AND kind=$2 AND text_sha256=$3 AND author_class=$4 AND author_id=$5 AND context_kind=$6 AND context_id=$7 AND subject_sha256=$8`,
        [source.agentId, candidate.kind, key.textHash, candidate.authorClass, candidate.authorId, source.contextKind, source.contextId, key.subjectHash])).rows[0]
      const manualOverlap = async (): Promise<boolean> => {
        const rows = (await client.query<{ text: string }>(
          `SELECT m.text FROM kipster.memory_records m WHERE m.scope='agent' AND m.owner_id=$1 AND m.kind=$2 AND md5(m.text)=md5($3)
           AND NOT EXISTS (SELECT 1 FROM kipster.maintenance_candidate_claims c WHERE c.memory_id=m.id)`,
          [source.agentId, candidate.kind, candidate.text])).rows
        return rows.some(row => row.text === candidate.text)
      }
      if (!claim) {
        const memoryId = randomUUID()
        await client.query(
          `INSERT INTO kipster.memory_records(id, installation_id, scope, owner_id, kind, text, source_hash, origin, importance, home_organization_id)
           VALUES ($1,$2,'agent',$3,$4,$5,$6,'learned',$7,$8)`,
          [memoryId, this.installationId, source.agentId, candidate.kind, candidate.text, sha256(candidate.text),
            candidate.explicit ? 1 : Math.max(MEMORY_STRENGTH.minImportance, candidate.importance ?? MEMORY_STRENGTH.learnedImportance),
            candidate.explicit ? null : orgId])
        await client.query('INSERT INTO kipster.memory_sources(memory_id, revision, text, source_hash) VALUES ($1,1,$2,$3)',
          [memoryId, candidate.text, sha256(candidate.text)])
        await client.query(`INSERT INTO kipster.memory_index_intents(memory_id, source_revision, source_hash, generation, status) VALUES ($1,1,$2,$3,'pending')`,
          [memoryId, sha256(candidate.text), profile.generation])
        const creatingId = randomUUID()
        const first = candidate.citations[0]!
        await client.query(
          `INSERT INTO kipster.memory_provenance(id, memory_id, source_organization_id, source_thread_id, author_id, subject, note,
             source_message_id, source_message_revision, source_parts_hash, excerpt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
          [creatingId, memoryId, orgId, source.sourceThreadId, candidate.authorId, candidate.subject, note,
            first.messageId, first.revision, first.partsHash, first.excerpt])
        memoryCounts.set(memoryId, 1)
        commitReceipts++
        const claimId = randomUUID()
        const inserted = (await client.query(
          `INSERT INTO kipster.maintenance_candidate_claims(id, owner_id, kind, text_sha256, author_class, author_id, context_kind, context_id,
             subject_sha256, memory_id, recorded_memory_revision, creating_provenance_id, status, source_run_id, source_revision, ordinal, manual_text_overlap)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,'active',$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
          [claimId, source.agentId, candidate.kind, key.textHash, candidate.authorClass, candidate.authorId, source.contextKind, source.contextId,
            key.subjectHash, memoryId, creatingId, source.runId, source.revision, ordinal, await manualOverlap()])).rowCount
        if (!inserted) {
          // Lost a race: re-read and attach as duplicate evidence.
          await client.query('DELETE FROM kipster.memory_index_intents WHERE memory_id=$1', [memoryId])
          await client.query('DELETE FROM kipster.memory_provenance WHERE memory_id=$1', [memoryId])
          await client.query('DELETE FROM kipster.memory_sources WHERE memory_id=$1', [memoryId])
          await client.query('DELETE FROM kipster.memory_records WHERE id=$1', [memoryId])
          memoryCounts.delete(memoryId)
          commitReceipts--
          claim = (await client.query<{ id: string; memory_id: string; recorded_memory_revision: string; creating_provenance_id: string | null; context_tombstoned: boolean }>(
            `SELECT id, memory_id, recorded_memory_revision, creating_provenance_id, context_tombstoned
             FROM kipster.maintenance_candidate_claims
             WHERE owner_id=$1 AND kind=$2 AND text_sha256=$3 AND author_class=$4 AND author_id=$5 AND context_kind=$6 AND context_id=$7 AND subject_sha256=$8`,
            [source.agentId, candidate.kind, key.textHash, candidate.authorClass, candidate.authorId, source.contextKind, source.contextId, key.subjectHash])).rows[0]
          if (!claim) return abort('duplicate claim race unresolved')
        } else {
          created++
          supported.add(memoryId)
          await attachEvidence(claimId, memoryId, candidate)
          continue
        }
      }
      if (claim.context_tombstoned) return abort('claim context tombstoned')
      const live = (await client.query<{ text: string; revision: string }>(
        `SELECT text, revision FROM kipster.memory_records WHERE id=$1 AND scope='agent' AND owner_id=$2 AND installation_id=$3 FOR NO KEY UPDATE`,
        [claim.memory_id, source.agentId, this.installationId])).rows[0]
      if (!live) return abort('claim_target_missing')
      const creating = claim.creating_provenance_id ? (await client.query<{ subject: string | null }>(
        'SELECT subject FROM kipster.memory_provenance WHERE id=$1', [claim.creating_provenance_id])).rows[0] : undefined
      if (!creating) return abort('claim_target_missing')
      const revSame = Number(live.revision) === Number(claim.recorded_memory_revision)
      const bytesSame = live.text === candidate.text
      if (!revSame && !bytesSame) {
        suppressedCorrected++
        continue
      }
      // An explicit request makes an already learned claim global and essential, as if it had formed that way.
      if (candidate.explicit) await client.query('UPDATE kipster.memory_records SET home_organization_id=NULL, importance=1 WHERE id=$1', [claim.memory_id])
      await attachEvidence(claim.id, claim.memory_id, candidate)
      duplicates++
    }
    await reinforce(client, [...supported])
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [attempt.id])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [runId])
    await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attempt.id])
    await client.query(`UPDATE kipster.maintenance_runs SET state='completed', staged_output=NULL, updated_at=now() WHERE id=$1`, [runId])
    await client.query(`UPDATE kipster.maintenance_sources SET status='committed', status_reason=NULL, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
      [source.runId, source.revision])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { outcome: 'committed', created, duplicates, suppressedCorrected, overflowed }
  }

  /** Preparation failed before issue. Caller holds the capacity lock. */
  async failPreparation(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, sourceRunId: string, sourceRevision: number, reason: string): Promise<{ ready: true; fenced: boolean }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null }>(
      'SELECT state, current_attempt_id FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
    const source = (await client.query<SourceRow>(
      'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [sourceRunId, sourceRevision])).rows[0]
    if (!run || run.state !== 'preparing' || run.current_attempt_id !== attempt.id || !source || source.status !== 'claimed') return { ready: true, fenced: false }
    const failed = Number(source.prep_failed_tries) + 1
    const fence = failed >= MAINTENANCE_LIMITS.prepFailedMax
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [attempt.id])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state='preparing'`, [runId])
    await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, updated_at=now() WHERE id=$1`, [runId, reason.slice(0, 2000)])
    if (fence) {
      await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason=$3, claim_lease_until=NULL, claim_incarnation=NULL,
        prep_failed_tries=$4, updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [sourceRunId, sourceRevision, 'preparation tries exhausted', failed])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    } else {
      const delay = MAINTENANCE_LIMITS.prepFailedDelayMs[failed - 1]!
      await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false, claim_lease_until=NULL, claim_incarnation=NULL,
        prep_failed_tries=$3, next_eligible_at=now()+($4||' milliseconds')::interval, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
        [sourceRunId, sourceRevision, failed, String(delay)])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID, Math.ceil(delay / 1000))
    }
    return { ready: true, fenced: fence }
  }

  /** Preparation found a stale manifest: recapture a new revision once, otherwise fence. Caller holds the capacity lock. */
  async recaptureStaleSource(client: SqlClient, jobs: Jobs, runId: string, attempt: Attempt, source: MaintenanceSource, recapture: boolean): Promise<boolean> {
    const run = (await client.query(
      `SELECT 1 FROM kipster.maintenance_runs WHERE id=$1 AND state='preparing' AND current_attempt_id=$2 FOR UPDATE`, [runId, attempt.id])).rows.length
    if (!run) return false
    const current = (await client.query<{ status: string; manifest_purged: boolean }>(
      'SELECT status, manifest_purged FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [source.runId, source.revision])).rows[0]
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [attempt.id])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state='preparing'`, [runId])
    await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, updated_at=now() WHERE id=$1`,
      [runId, recapture ? 'stale manifest recaptured' : 'stale manifest'])
    if (!current || current.status !== 'claimed') return false
    let reason = 'stale manifest'
    if (recapture && !current.manifest_purged) {
      const allocated = await this.allocateSource(client, jobs, source.runId, source.agentId, source.contextKind, source.contextId, source.sourceThreadId)
      if ('created' in allocated && allocated.created) return true
      if ('disabled' in allocated) reason = 'learning_disabled'
    }
    // The current content matches an earlier revision or none at all: this revision can never commit.
    await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason=$3, claim_lease_until=NULL,
      claim_incarnation=NULL, updated_at=now() WHERE run_id=$1 AND source_revision=$2 AND status='claimed'`, [source.runId, source.revision, reason])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return false
  }

  /** Fence issued runs abandoned by a dead process. Permits retained; never auto-released. Caller holds the capacity lock. */
  async fenceInterruptedIssued(client: SqlClient, scope: { incarnation?: string; exclude?: readonly string[] } = {}): Promise<number> {
    const abandoned = (await client.query<{ id: string; current_attempt_id: string; source_run_id: string; source_revision: string }>(
      `SELECT r.id, r.current_attempt_id, r.source_run_id, r.source_revision
       FROM kipster.maintenance_runs r JOIN kipster.attempts a ON a.id = r.current_attempt_id
       WHERE r.installation_id = $1 AND r.state = 'running' AND a.state = 'issued'
         AND ($2::uuid IS NULL OR a.incarnation = $2) AND a.id <> ALL($3::uuid[]) FOR UPDATE OF r`,
      [this.installationId, scope.incarnation ?? null, scope.exclude ?? []])).rows
    for (const row of abandoned) {
      await client.query(`UPDATE kipster.attempts SET state='uncertain' WHERE id=$1 AND state='issued'`, [row.current_attempt_id])
      await client.query(`UPDATE kipster.work_intents SET state='uncertain' WHERE id=$1 AND state='issued'`, [row.id])
      await client.query(`UPDATE kipster.maintenance_runs SET state='recovery-needed', failure_class='unknown_end',
        failure='coordinator process lost before confirmed end', permit_retained=true,
        reservation_reason='provider end unconfirmed', staged_output=NULL, updated_at=now() WHERE id=$1`, [row.id])
      await client.query(`UPDATE kipster.maintenance_sources SET status='recovery', status_reason='coordinator process lost', updated_at=now()
        WHERE run_id=$1 AND source_revision=$2`, [row.source_run_id, row.source_revision])
    }
    return abandoned.length
  }

  /** Sweep expired unissued claims plus orphaned preparing runs. Caller holds the capacity lock. */
  async expireUnissuedClaims(client: SqlClient, jobs: Jobs, scope: { all?: boolean; incarnation?: string } = {}): Promise<{ expired: number; orphaned: number }> {
    let expired = 0
    let orphaned = 0
    const stale = (await client.query<{ run_id: string; source_revision: string }>(
      `SELECT run_id, source_revision FROM kipster.maintenance_sources
       WHERE installation_id=$1 AND status='claimed' AND ($2 OR claim_lease_until <= now())
         AND ($3::uuid IS NULL OR claim_incarnation = $3) ORDER BY run_id LIMIT 20 FOR UPDATE SKIP LOCKED`,
      [this.installationId, scope.all === true, scope.incarnation ?? null])).rows
    for (const item of stale) {
      const run = (await client.query<{ id: string; current_attempt_id: string | null }>(
        `SELECT r.id, r.current_attempt_id FROM kipster.maintenance_runs r
         WHERE r.source_run_id=$1 AND r.source_revision=$2 AND r.state='preparing' FOR UPDATE OF r`,
        [item.run_id, item.source_revision])).rows[0]
      const attempt = run?.current_attempt_id ? (await client.query<{ generation: string; incarnation: string }>(
        'SELECT generation, incarnation FROM kipster.attempts WHERE id=$1 AND state=$2', [run.current_attempt_id, 'preparing'])).rows[0] : undefined
      if (!run?.current_attempt_id || !attempt) {
        // A claim without a live preparation can never issue: return it to ready.
        await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false, claim_lease_until=NULL,
          claim_incarnation=NULL, updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [item.run_id, item.source_revision])
        await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
        expired++
        continue
      }
      if (scope.all) {
        // A coordinator interruption is not a failed preparation. Keep the
        // charged lifetime claim, and let the next claim recompute admission.
        await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [run.current_attempt_id])
        await client.query(`UPDATE kipster.work_intents SET state='queued' WHERE id=$1 AND state='preparing'`, [run.id])
        await client.query(`UPDATE kipster.maintenance_runs SET state='queued', current_attempt_id=NULL, updated_at=now() WHERE id=$1`, [run.id])
        await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false, claim_lease_until=NULL,
          claim_incarnation=NULL, next_eligible_at=now(), updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [item.run_id, item.source_revision])
        await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      } else {
        await this.failPreparation(client, jobs, run.id,
          { id: run.current_attempt_id, intentId: run.id, generation: Number(attempt.generation), incarnation: attempt.incarnation, state: 'preparing' },
          item.run_id, Number(item.source_revision), 'claim lease expired')
      }
      expired++
    }
    const orphans = (await client.query<{ id: string; current_attempt_id: string | null }>(
      `SELECT r.id, r.current_attempt_id FROM kipster.maintenance_runs r
       JOIN kipster.maintenance_sources s ON s.run_id=r.source_run_id AND s.source_revision=r.source_revision
       LEFT JOIN kipster.attempts a ON a.id=r.current_attempt_id
       WHERE r.installation_id=$1 AND r.state='preparing' AND s.status<>'claimed'
         AND ($2::uuid IS NULL OR a.incarnation = $2) LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
      [this.installationId, scope.incarnation ?? null])).rows
    for (const orphan of orphans) {
      if (orphan.current_attempt_id) {
        await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [orphan.current_attempt_id])
      }
      await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state='preparing'`, [orphan.id])
      await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure='source left claimed state', updated_at=now() WHERE id=$1`, [orphan.id])
      orphaned++
    }
    // A sleep run preparation that was interrupted or outlived the claim lease returns to the queue.
    const preparing = (await client.query<{ id: string; current_attempt_id: string | null }>(
      `SELECT r.id, r.current_attempt_id FROM kipster.maintenance_runs r LEFT JOIN kipster.attempts a ON a.id=r.current_attempt_id
       WHERE r.installation_id=$1 AND r.task_kind<>'extract' AND r.state='preparing'
         AND ($2 OR r.updated_at <= now()-($4::text||' milliseconds')::interval) AND ($3::uuid IS NULL OR a.incarnation=$3)
       ORDER BY r.id LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
      [this.installationId, scope.all === true, scope.incarnation ?? null, String(MAINTENANCE_LIMITS.claimLeaseMs)])).rows
    for (const run of preparing) {
      if (run.current_attempt_id) await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [run.current_attempt_id])
      await client.query(`UPDATE kipster.work_intents SET state='queued' WHERE id=$1 AND state='preparing'`, [run.id])
      await client.query(`UPDATE kipster.maintenance_runs SET state='queued', current_attempt_id=NULL, updated_at=now() WHERE id=$1`, [run.id])
      expired++
    }
    if (orphaned || preparing.length) await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { expired, orphaned }
  }

  /** Operator cancel on a live run: confirmed end fences without restart. Caller holds the capacity lock. */
  async settleCancelConfirmed(client: SqlClient, jobs: Jobs, runId: string, attemptId: string, incarnation: string): Promise<{ fenced: true } | { conflict: true } | { noop: true }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; source_run_id: string; source_revision: string }>(
      'SELECT state, current_attempt_id, source_run_id, source_revision FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
    if (!run) return { noop: true }
    if (run.state === 'completed' || run.state === 'failed') return { conflict: true }
    if (run.state !== 'running' || run.current_attempt_id !== attemptId) return { noop: true }
    const live = (await client.query(
      `SELECT 1 FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.incarnation=$3 AND a.state='issued' AND i.state='issued' FOR UPDATE OF a, i`,
      [attemptId, runId, incarnation])).rows.length
    if (!live) return { noop: true }
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [attemptId])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [runId])
    await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [attemptId])
    await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure='operator cancelled', staged_output=NULL, updated_at=now() WHERE id=$1`, [runId])
    await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason='operator cancelled', updated_at=now()
      WHERE run_id=$1 AND source_revision=$2`, [run.source_run_id, run.source_revision])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { fenced: true }
  }

  /** Operator cancel without confirmation, or cancel on an uncertain run: retain. Caller holds the capacity lock. */
  async settleCancelUnknown(client: SqlClient, runId: string, attemptId: string): Promise<{ recovery: true } | { noop: true }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; source_run_id: string; source_revision: string }>(
      'SELECT state, current_attempt_id, source_run_id, source_revision FROM kipster.maintenance_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0]
    if (!run || run.current_attempt_id !== attemptId || (run.state !== 'running' && run.state !== 'recovery-needed')) return { noop: true }
    if (run.state === 'recovery-needed') return { recovery: true }
    await client.query(`UPDATE kipster.attempts SET state='uncertain' WHERE id=$1 AND state='issued'`, [attemptId])
    await client.query(`UPDATE kipster.work_intents SET state='uncertain' WHERE id=$1 AND state='issued'`, [runId])
    await client.query(`UPDATE kipster.maintenance_runs SET state='recovery-needed', failure_class='unknown_end', failure='cancel outcome unconfirmed',
      permit_retained=true, reservation_reason='provider end unconfirmed', staged_output=NULL, updated_at=now() WHERE id=$1`, [runId])
    await client.query(`UPDATE kipster.maintenance_sources SET status='recovery', status_reason='cancel outcome unconfirmed', updated_at=now()
      WHERE run_id=$1 AND source_revision=$2`, [run.source_run_id, run.source_revision])
    return { recovery: true }
  }

  /** Reconcile reporting ended with provider evidence: release into retry/fence accounting. Caller holds the capacity lock. */
  async settleReconcileEnded(client: SqlClient, jobs: Jobs, runId: string, evidence: string): Promise<{ failed: true; retryScheduled: boolean } | { fenced: true } | { noop: true }> {
    const run = (await client.query<{ state: string; current_attempt_id: string | null; source_run_id: string; source_revision: string; task_kind: string; sleep_running: boolean }>(
      `SELECT r.state, r.current_attempt_id, r.source_run_id, r.source_revision, r.task_kind, COALESCE(s.state='running', false) AS sleep_running
       FROM kipster.maintenance_runs r LEFT JOIN kipster.memory_sleeps s ON s.id=r.sleep_id WHERE r.id=$1 FOR UPDATE OF r`, [runId])).rows[0]
    if (!run || run.state !== 'recovery-needed' || !run.current_attempt_id) return { noop: true }
    const uncertain = (await client.query(
      `SELECT 1 FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id
       WHERE a.id=$1 AND a.intent_id=$2 AND a.state='uncertain' AND i.state='uncertain' FOR UPDATE OF a, i`,
      [run.current_attempt_id, runId])).rows.length
    if (!uncertain) return { noop: true }
    if (run.task_kind !== 'extract') {
      // The answer was lost with the attempt: while the sleep runs, the run is asked again, at most once more.
      const issued = Number((await client.query<{ count: string }>('SELECT count(*) FROM kipster.attempts WHERE intent_id=$1 AND adapter_id IS NOT NULL', [runId])).rows[0]!.count)
      const retry = run.sleep_running && issued < MAINTENANCE_LIMITS.issuedMax
      await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [run.current_attempt_id])
      await client.query(`UPDATE kipster.work_intents SET state=$2 WHERE id=$1`, [runId, retry ? 'queued' : 'settled'])
      await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [run.current_attempt_id])
      await client.query(`UPDATE kipster.maintenance_runs SET state=$2, current_attempt_id=CASE WHEN $2='queued' THEN NULL ELSE current_attempt_id END,
        failure=$3, permit_retained=false, updated_at=now() WHERE id=$1`, [runId, retry ? 'queued' : 'failed', `reconciled ended: ${evidence}`.slice(0, 2000)])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
      return retry ? { failed: true, retryScheduled: true } : { fenced: true }
    }
    const source = (await client.query<{ issued_tries: string; invalidated: boolean }>(
      'SELECT issued_tries, invalidated FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [run.source_run_id, run.source_revision])).rows[0]
    if (!source) return { noop: true }
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1`, [run.current_attempt_id])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1`, [runId])
    await client.query('DELETE FROM kipster.owned_permits WHERE attempt_id=$1', [run.current_attempt_id])
    await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure=$2, permit_retained=false, updated_at=now() WHERE id=$1`,
      [runId, `reconciled ended: ${evidence}`.slice(0, 2000)])
    if (!source.invalidated && Number(source.issued_tries) < MAINTENANCE_LIMITS.issuedMax) {
      await client.query(`UPDATE kipster.maintenance_sources SET status='ready', reserved=false,
          next_eligible_at=now()+($3||' milliseconds')::interval, updated_at=now() WHERE run_id=$1 AND source_revision=$2`,
        [run.source_run_id, run.source_revision, String(MAINTENANCE_LIMITS.issuedRetryDelayMs)])
      await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID, Math.ceil(MAINTENANCE_LIMITS.issuedRetryDelayMs / 1000))
      return { failed: true, retryScheduled: true }
    }
    await client.query(`UPDATE kipster.maintenance_sources SET status='fenced', status_reason=CASE WHEN invalidated THEN 'source invalidated before reconciliation' ELSE 'reconciled ended after issued budget' END, updated_at=now()
      WHERE run_id=$1 AND source_revision=$2`, [run.source_run_id, run.source_revision])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { fenced: true }
  }

  async touchReconcile(client: SqlClient, runId: string): Promise<void> {
    await client.query('UPDATE kipster.maintenance_runs SET last_reconcile_attempt=now(), updated_at=now() WHERE id=$1', [runId])
  }

  /** Append an idempotent operator intent. The only write the shipped entry performs. */
  async requestAction(opId: string, action: 'skip-source' | 'requeue-source' | 'cancel' | 'reconcile', target: { sourceRunId?: string; sourceRevision?: number; runId?: string }, reason?: string): Promise<{ opId: string; state: string; duplicate: boolean }> {
    if (!opId || opId.length > 200) throw new Error('Invalid operation ID')
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new Error('Invalid reason')
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if ((action === 'skip-source' || action === 'requeue-source') && (!target.sourceRunId || !uuid.test(target.sourceRunId))) throw new Error('Source target required')
    if (target.sourceRevision !== undefined && (!Number.isSafeInteger(target.sourceRevision) || target.sourceRevision < 1)) throw new Error('Invalid source revision')
    if ((action === 'cancel' || action === 'reconcile') && (!target.runId || !uuid.test(target.runId))) throw new Error('Run target required')
    return this.db.transaction(async client => {
      if (target.runId && !(await client.query('SELECT 1 FROM kipster.maintenance_runs WHERE id=$1 AND installation_id=$2', [target.runId, this.installationId])).rows.length) {
        throw new Error('Maintenance run not found')
      }
      const inserted = (await client.query(
        `INSERT INTO kipster.maintenance_operator_intents(installation_id, op_id, action, source_run_id, source_revision, maintenance_run_id, reason, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT DO NOTHING RETURNING op_id`,
        [this.installationId, opId, action, target.sourceRunId ?? null, target.sourceRevision ?? null, target.runId ?? null, reason ?? null])).rows[0]
      if (inserted) return { opId, state: 'pending', duplicate: false }
      const prior = (await client.query<{ action: string; state: string }>(
        'SELECT action, state FROM kipster.maintenance_operator_intents WHERE installation_id=$1 AND op_id=$2', [this.installationId, opId])).rows[0]!
      if (prior.action !== action) throw new Error('Operation ID reused with different action')
      return { opId, state: prior.state, duplicate: true }
    })
  }

  /** Claim the oldest pending intent for execution. Caller holds the capacity lock. */
  async claimIntent(client: SqlClient): Promise<{ opId: string; action: string; sourceRunId: string | null; sourceRevision: number | null; runId: string | null; reason: string | null } | null> {
    const intent = (await client.query<{ op_id: string; action: string; source_run_id: string | null; source_revision: string | null; maintenance_run_id: string | null; reason: string | null }>(
      `SELECT op_id, action, source_run_id, source_revision, maintenance_run_id, reason
       FROM kipster.maintenance_operator_intents WHERE installation_id=$1 AND state='pending'
       ORDER BY created_at, op_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [this.installationId])).rows[0]
    if (!intent) return null
    await client.query(`UPDATE kipster.maintenance_operator_intents SET state='executing',
      lease_until=now()+($3||' milliseconds')::interval, executions=executions+1, updated_at=now()
      WHERE installation_id=$1 AND op_id=$2`, [this.installationId, intent.op_id, String(MAINTENANCE_LIMITS.intentLeaseMs)])
    return {
      opId: intent.op_id, action: intent.action, sourceRunId: intent.source_run_id,
      sourceRevision: intent.source_revision === null ? null : Number(intent.source_revision),
      runId: intent.maintenance_run_id, reason: intent.reason,
    }
  }

  /** Reap lease-expired executing intents: pending at most 3 times, then orphaned. */
  async reapIntents(client: SqlClient): Promise<{ reaped: number; orphaned: number }> {
    const expired = (await client.query<{ op_id: string; executions: string }>(
      `SELECT op_id, executions FROM kipster.maintenance_operator_intents
       WHERE installation_id=$1 AND state='executing' AND lease_until <= now() FOR UPDATE SKIP LOCKED`, [this.installationId])).rows
    let reaped = 0
    let orphaned = 0
    for (const intent of expired) {
      if (Number(intent.executions) <= MAINTENANCE_LIMITS.intentReapsMax) {
        await client.query(`UPDATE kipster.maintenance_operator_intents SET state='pending', lease_until=NULL, updated_at=now()
          WHERE installation_id=$1 AND op_id=$2`, [this.installationId, intent.op_id])
        reaped++
      } else {
        await client.query(`UPDATE kipster.maintenance_operator_intents SET state='orphaned', result=$3::jsonb, updated_at=now()
          WHERE installation_id=$1 AND op_id=$2`, [this.installationId, intent.op_id, JSON.stringify({ orphaned: 'execution lease expired repeatedly' })])
        orphaned++
      }
    }
    return { reaped, orphaned }
  }

  async completeIntent(client: SqlClient, opId: string, state: 'done' | 'rejected', result: unknown): Promise<boolean> {
    const updated = (await client.query(
      `UPDATE kipster.maintenance_operator_intents SET state=$3, result=$4::jsonb, lease_until=NULL, updated_at=now()
       WHERE installation_id=$1 AND op_id=$2 AND state='executing'`, [this.installationId, opId, state, JSON.stringify(result ?? null)])).rowCount
    return !!updated
  }

  /** Skip a pending source. Single transaction; naturally idempotent on reissue. */
  async skipSource(client: SqlClient, jobs: Jobs, sourceRunId: string, sourceRevision?: number): Promise<{ done: true } | { conflict: string }> {
    const source = sourceRevision === undefined
      ? (await client.query<SourceRow>(
        `SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND status NOT IN ('superseded','source_deleted')
         ORDER BY source_revision DESC LIMIT 1 FOR UPDATE`, [sourceRunId])).rows[0]
      : (await client.query<SourceRow>(
        'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [sourceRunId, sourceRevision])).rows[0]
    if (!source || source.status === 'superseded' || source.status === 'source_deleted') return { conflict: 'source not skippable' }
    if (source.status === 'skipped') return { done: true }
    if (source.status === 'committed' || source.status === 'fenced') return { conflict: `source already ${source.status}` }
    if (source.status === 'issued' || source.status === 'recovery') return { conflict: 'source has an active or uncertain attempt' }
    if (source.status === 'claimed') {
      const run = (await client.query<{ id: string; current_attempt_id: string | null }>(
        `SELECT id, current_attempt_id FROM kipster.maintenance_runs
         WHERE source_run_id=$1 AND source_revision=$2 AND state='preparing' FOR UPDATE`, [source.run_id, source.source_revision])).rows[0]
      if (run) {
        if (run.current_attempt_id) await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'`, [run.current_attempt_id])
        await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state='preparing'`, [run.id])
        await client.query(`UPDATE kipster.maintenance_runs SET state='failed', failure='source skipped', updated_at=now() WHERE id=$1`, [run.id])
      }
    }
    await client.query(`UPDATE kipster.maintenance_sources SET status='skipped', status_reason='operator skipped',
      claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [source.run_id, source.source_revision])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { done: true }
  }

  /** Requeue a terminal non-uncertain source with a recomputed manifest. Single transaction. The revision
   * matching the current content is requeued; `alreadyQueued` reports that it was pending and nothing changed. */
  async requeueSource(client: SqlClient, jobs: Jobs, sourceRunId: string, sourceRevision?: number): Promise<{ done: true; revision: number; alreadyQueued?: true } | { conflict: string }> {
    const source = sourceRevision === undefined
      ? (await client.query<SourceRow>(
        `SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND status NOT IN ('superseded','source_deleted')
         ORDER BY source_revision DESC LIMIT 1 FOR UPDATE`, [sourceRunId])).rows[0]
      : (await client.query<SourceRow>(
        'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 FOR UPDATE', [sourceRunId, sourceRevision])).rows[0]
    if (!source) return { conflict: 'source not found' }
    if (source.status !== 'committed' && source.status !== 'skipped' && source.status !== 'fenced') return { conflict: 'source is not terminal' }
    if (!await agentLearns(client, source.agent_id)) return { conflict: 'learning disabled' }
    if (Number(source.cycles) >= MAINTENANCE_LIMITS.requeueCyclesMax) return { conflict: 'requeue cycles exhausted' }
    const threadId = source.source_thread_id ?? (await client.query<{ thread_id: string }>(
      'SELECT thread_id FROM kipster.text_runs WHERE id=$1', [sourceRunId])).rows[0]?.thread_id
    if (!threadId) return { conflict: 'source run missing' }
    const frozen = await this.captureManifest(client, sourceRunId)
    if ('empty' in frozen) return { conflict: 'manifest empty' }
    const current = (await client.query<SourceRow>(
      'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND manifest_hash=$2 FOR UPDATE', [sourceRunId, frozen.hash])).rows[0]
    if (!current) {
      const allocated = await this.allocateSource(client, jobs, sourceRunId, source.agent_id, source.context_kind, source.context_id, threadId)
      if (!('revision' in allocated)) return { conflict: 'manifest empty' }
      if (allocated.created) {
        await client.query(`UPDATE kipster.maintenance_sources SET cycles=$3 WHERE run_id=$1 AND source_revision=$2`,
          [sourceRunId, allocated.revision, Number(source.cycles) + 1])
      }
      return { done: true, revision: allocated.revision }
    }
    const revision = Number(current.source_revision)
    if (current.status === 'ready' || current.status === 'claimed') return { done: true, revision, alreadyQueued: true }
    if (!['committed', 'skipped', 'fenced', 'superseded'].includes(current.status)) return { conflict: `revision ${revision} matching the current content is ${current.status}` }
    if (Number(current.cycles) >= MAINTENANCE_LIMITS.requeueCyclesMax) return { conflict: 'requeue cycles exhausted' }
    await client.query(`UPDATE kipster.maintenance_sources SET status='ready', status_reason=NULL, reserved=false, invalidated=false,
      claim_lease_until=NULL, claim_incarnation=NULL, tries_total=0, prep_failed_tries=0, issued_tries=0, cycles=cycles+1,
      next_eligible_at=now(), evidence_overflow=false, updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [sourceRunId, revision])
    await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID)
    return { done: true, revision }
  }

  /** Re-read manifest messages and hash-verify before building extraction input. */
  async verifiedSourceTexts(client: SqlClient, source: MaintenanceSource): Promise<VerifiedSourceText[] | { mismatch: true }> {
    if (!source.manifest) return { mismatch: true }
    const texts: VerifiedSourceText[] = []
    for (const entry of source.manifest.entries) {
      const row = (await client.query<{ parts: unknown; revision: string; author_id: string }>(
        'SELECT parts, revision, author_id FROM kipster.messages WHERE id=$1', [entry.message_id])).rows[0]
      if (!row || Number(row.revision) !== entry.revision || row.author_id !== entry.author_id || sha256(canonical(row.parts)) !== entry.parts_sha256) return { mismatch: true }
      if (Buffer.byteLength(canonical(row.parts), 'utf8') > MAINTENANCE_LIMITS.manifestPerMessageBytes) return { mismatch: true }
      texts.push({
        messageId: entry.message_id, position: entry.position, revision: entry.revision, partsHash: entry.parts_sha256,
        authorId: entry.author_id, authorClass: entry.author_class, text: partsText(row.parts),
      })
    }
    return texts
  }

  private async sourceAttribution(client: SqlClient, sourceRunId: string): Promise<{ agentId: string; contextKind: 'installation' | 'organization'; contextId: string; threadId: string } | null> {
    const row = (await client.query<{ agent_id: string; context_kind: 'installation' | 'organization'; context_id: string; thread_id: string }>(
      `SELECT COALESCE(d.recipient_agent_id, c.agent_id) AS agent_id, c.context_kind, c.context_id, r.thread_id
       FROM kipster.text_runs r JOIN kipster.threads t ON t.id = r.thread_id JOIN kipster.direct_chats c ON c.id = t.chat_id
       LEFT JOIN kipster.delegations d ON d.child_run_id = r.id WHERE r.id = $1`, [sourceRunId])).rows[0]
    if (!row) return null
    return { agentId: row.agent_id, contextKind: row.context_kind, contextId: row.context_id, threadId: row.thread_id }
  }

  /** One repair-only scanner tick over existing sources: at most 10 pages, per-page transactions with timeouts. */
  async tickScanner(jobs: Jobs, now: () => number = Date.now): Promise<{ pages: number; validated: number; repaired: number; hinted: boolean }> {
    const started = now()
    let pages = 0
    let validated = 0
    let repaired = 0
    while (pages < MAINTENANCE_LIMITS.scannerPagesPerTick && now() - started < MAINTENANCE_LIMITS.scannerWorkerDeadlineMs) {
      const page = await this.db.transaction(async client => {
        await client.query(`SET LOCAL statement_timeout='${MAINTENANCE_LIMITS.statementMs}ms'`)
        await client.query(`SET LOCAL lock_timeout='${MAINTENANCE_LIMITS.lockMs}ms'`)
        await client.query(`SET LOCAL transaction_timeout='${MAINTENANCE_LIMITS.pageTxMs}ms'`)
        // Serialize source allocation with settlement/issue before taking any source lock.
        await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
        await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])
        await client.query(`INSERT INTO kipster.maintenance_scheduler(installation_id) VALUES ($1) ON CONFLICT DO NOTHING`, [this.installationId])
        const state = (await client.query<{ last_run_id: string | null; last_source_revision: string | null; repair_inserts_used: number }>(
          'SELECT last_run_id, last_source_revision, repair_inserts_used FROM kipster.maintenance_scheduler WHERE installation_id=$1 FOR UPDATE', [this.installationId])).rows[0]!
        const lockOrigin = async (runId: string) => {
          const origin = (await client.query<{ thread_id: string; origin_thread_id: string | null }>(
            `SELECT r.thread_id, d.origin_thread_id FROM kipster.text_runs r LEFT JOIN kipster.delegations d ON d.child_run_id=r.id WHERE r.id=$1`, [runId])).rows[0]
          if (origin?.origin_thread_id) await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [origin.origin_thread_id])
          if (origin) await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE', [origin.thread_id])
          await client.query('SELECT 1 FROM kipster.text_runs WHERE id=$1 FOR UPDATE', [runId])
          await client.query('SELECT 1 FROM kipster.maintenance_runs WHERE source_run_id=$1 ORDER BY id FOR UPDATE', [runId])
        }
        const batch = (await client.query<{ run_id: string; source_revision: string }>(
          `SELECT run_id, source_revision FROM kipster.maintenance_sources WHERE installation_id=$1 AND status<>'superseded'
             AND ($2::uuid IS NULL OR (run_id,source_revision)>($2::uuid,$3::bigint)) ORDER BY run_id,source_revision LIMIT $4`,
          [this.installationId, state.last_run_id, state.last_source_revision ?? 0, MAINTENANCE_LIMITS.scannerValidatePage])).rows
        let repairedPage = 0
        for (const row of batch) {
          await lockOrigin(row.run_id)
          // Lock all revisions in allocation order; use the shared max-plus-one allocator.
          await client.query('SELECT 1 FROM kipster.maintenance_sources WHERE run_id=$1 ORDER BY source_revision FOR UPDATE', [row.run_id])
          const current = (await client.query<SourceRow>('SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2', [row.run_id, row.source_revision])).rows[0]!
          if (current.status === 'source_deleted' || current.status === 'superseded' || !current.manifest) continue
          const frozen = await this.captureManifest(client, row.run_id)
          if ('empty' in frozen || frozen.hash === current.manifest_hash) continue
          // Invalidating active work never changes its permit or recovery identity.
          if (current.status === 'issued' || current.status === 'recovery') {
            await client.query(`UPDATE kipster.maintenance_sources SET invalidated=true, updated_at=now() WHERE run_id=$1 AND source_revision=$2`, [row.run_id, row.source_revision])
          }
          const hit = (await client.query<{ status: string }>('SELECT status FROM kipster.maintenance_sources WHERE run_id=$1 AND manifest_hash=$2', [row.run_id, frozen.hash])).rows[0]
          if ((hit && hit.status !== 'superseded') || state.repair_inserts_used + repairedPage >= MAINTENANCE_LIMITS.repairInsertsPerEpoch) continue
          const origin = await this.sourceAttribution(client, row.run_id)
          if (!origin) continue
          const result = await this.allocateSource(client, jobs, row.run_id, origin.agentId, origin.contextKind, origin.contextId, origin.threadId, false)
          if ('created' in result && (result.created || hit)) repairedPage++
        }
        const complete = batch.length < MAINTENANCE_LIMITS.scannerValidatePage
        const last = batch.at(-1)
        await client.query(`UPDATE kipster.maintenance_scheduler SET epoch_id=epoch_id+$2, last_run_id=$3, last_source_revision=$4,
          repair_inserts_used=$5, updated_at=now() WHERE installation_id=$1`,
          [this.installationId, complete ? 1 : 0, complete ? null : last!.run_id,
            complete ? null : last!.source_revision, complete ? 0 : state.repair_inserts_used + repairedPage])
        return { checked: batch.length, repaired: repairedPage, epochComplete: complete }
      })
      pages++
      validated += page.checked
      repaired += page.repaired
      // One tick cannot silently spend the next epoch's repair budget.
      if (page.epochComplete) break
    }
    const hinted = repaired > 0
    if (hinted) await this.db.transaction(async client => { await jobs.send(client, MAINTENANCE_SWEEP_JOB_ID) })
    return { pages, validated, repaired, hinted }
  }

  async inspectSource(sourceRunId: string, sourceRevision?: number): Promise<(MaintenanceSource & { runs: MaintenanceRun[]; claims: { id: string; kind: string; memoryId: string; status: string }[] }) | null> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const source = sourceRevision === undefined
        ? (await client.query<SourceRow>(
          `SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND installation_id=$2 AND status NOT IN ('superseded','source_deleted')
           ORDER BY source_revision DESC LIMIT 1`, [sourceRunId, this.installationId])).rows[0]
        : (await client.query<SourceRow>(
          'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2 AND installation_id=$3',
          [sourceRunId, sourceRevision, this.installationId])).rows[0]
      if (!source) return null
      const runs = (await client.query<{ id: string; source_run_id: string; source_revision: string; agent_id: string; state: MaintenanceRunState; current_attempt_id: string | null; failure_class: string | null; failure: string | null; permit_retained: boolean; reservation_reason: string | null; adapter_id: string | null; recovery_ref_missing: boolean; recovery_impaired: boolean }>(
        `SELECT id, source_run_id, source_revision, agent_id, state, current_attempt_id, failure_class, failure,
           permit_retained, reservation_reason, adapter_id, recovery_ref_missing, recovery_impaired
         FROM kipster.maintenance_runs WHERE source_run_id=$1 AND source_revision=$2 ORDER BY created_at, id`,
        [source.run_id, source.source_revision])).rows.map(row => ({
        id: row.id, taskKind: 'extract' as const, sourceRunId: row.source_run_id, sourceRevision: Number(row.source_revision), agentId: row.agent_id, state: row.state,
        currentAttemptId: row.current_attempt_id, failureClass: row.failure_class, failure: row.failure, permitRetained: row.permit_retained,
        reservationReason: row.reservation_reason, adapterId: row.adapter_id,
        recoveryRefMissing: row.recovery_ref_missing, recoveryImpaired: row.recovery_impaired,
      }))
      const claims = (await client.query<{ id: string; kind: string; memory_id: string; status: string }>(
        'SELECT id, kind, memory_id, status FROM kipster.maintenance_candidate_claims WHERE source_run_id=$1 AND source_revision=$2 ORDER BY ordinal, id',
        [source.run_id, source.source_revision])).rows.map(row => ({ id: row.id, kind: row.kind, memoryId: row.memory_id, status: row.status }))
      return { ...sourceWire(source), runs, claims }
    })
  }

  async listSources(status?: MaintenanceSourceStatus, limit = 50): Promise<MaintenanceSource[]> {
    const bounded = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 50
    const rows = (await this.db.query<SourceRow>(
      status
        ? `SELECT * FROM kipster.maintenance_sources WHERE installation_id=$1 AND status=$2 ORDER BY run_id, source_revision LIMIT $3`
        : `SELECT * FROM kipster.maintenance_sources WHERE installation_id=$1 ORDER BY run_id, source_revision LIMIT $2`,
      status ? [this.installationId, status, bounded] : [this.installationId, bounded])).rows
    return rows.map(sourceWire)
  }

  async inspectRun(runId: string): Promise<(MaintenanceRun & { source: MaintenanceSource | null; staged: ReturnType<typeof stagedSummary>; attempts: { id: string; state: string; generation: number }[] }) | null> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const run = (await client.query<{ id: string; task_kind: MaintenanceTaskKind; source_run_id: string | null; source_revision: string | null; agent_id: string; state: MaintenanceRunState; current_attempt_id: string | null; failure_class: string | null; failure: string | null; permit_retained: boolean; reservation_reason: string | null; adapter_id: string | null; recovery_ref_missing: boolean; recovery_impaired: boolean; staged_output: unknown }>(
        `SELECT id, task_kind, source_run_id, source_revision, agent_id, state, current_attempt_id, failure_class, failure,
           permit_retained, reservation_reason, adapter_id, recovery_ref_missing, recovery_impaired, staged_output
         FROM kipster.maintenance_runs WHERE id=$1 AND installation_id=$2`, [runId, this.installationId])).rows[0]
      if (!run) return null
      const source = (await client.query<SourceRow>(
        'SELECT * FROM kipster.maintenance_sources WHERE run_id=$1 AND source_revision=$2', [run.source_run_id, run.source_revision])).rows[0]
      const attempts = (await client.query<{ id: string; state: string; generation: string }>(
        'SELECT id, state, generation FROM kipster.attempts WHERE intent_id=$1 ORDER BY generation', [runId])).rows
        .map(row => ({ id: row.id, state: row.state, generation: Number(row.generation) }))
      return {
        id: run.id, taskKind: run.task_kind, sourceRunId: run.source_run_id, sourceRevision: run.source_revision === null ? null : Number(run.source_revision), agentId: run.agent_id, state: run.state,
        currentAttemptId: run.current_attempt_id, failureClass: run.failure_class, failure: run.failure, permitRetained: run.permit_retained,
        reservationReason: run.reservation_reason, adapterId: run.adapter_id,
        recoveryRefMissing: run.recovery_ref_missing, recoveryImpaired: run.recovery_impaired,
        source: source ? sourceWire(source) : null, staged: stagedSummary(run.staged_output), attempts,
      }
    })
  }

  async maintenanceStatus(): Promise<{ sources: Record<string, number>; runs: Record<string, number>; intents: Record<string, number>; scheduler: { epochId: number; lastError: string | null; lastErrorAt: string | null } | null; counter: number }> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const sources: Record<string, number> = {}
      for (const row of (await client.query<{ status: string; count: string }>(
        'SELECT status, count(*) FROM kipster.maintenance_sources WHERE installation_id=$1 GROUP BY status', [this.installationId])).rows) sources[row.status] = Number(row.count)
      const runs: Record<string, number> = {}
      for (const row of (await client.query<{ state: string; count: string }>(
        'SELECT state, count(*) FROM kipster.maintenance_runs WHERE installation_id=$1 GROUP BY state', [this.installationId])).rows) runs[row.state] = Number(row.count)
      const intents: Record<string, number> = {}
      for (const row of (await client.query<{ state: string; count: string }>(
        'SELECT state, count(*) FROM kipster.maintenance_operator_intents WHERE installation_id=$1 GROUP BY state', [this.installationId])).rows) intents[row.state] = Number(row.count)
      const scheduler = (await client.query<{ epoch_id: string; last_error: string | null; last_error_at: string | null }>(
        'SELECT epoch_id, last_error, last_error_at FROM kipster.maintenance_scheduler WHERE installation_id=$1', [this.installationId])).rows[0]
      const counter = Number((await client.query<{ maintenance_counter: string }>(
        'SELECT maintenance_counter FROM kipster.execution_permits WHERE installation_id=$1', [this.installationId])).rows[0]?.maintenance_counter ?? 0)
      return {
        sources, runs, intents,
        scheduler: scheduler ? {
          epochId: Number(scheduler.epoch_id), lastError: scheduler.last_error,
          lastErrorAt: scheduler.last_error_at ? new Date(scheduler.last_error_at).toISOString() : null,
        } : null,
        counter,
      }
    })
  }

  /** Records the latest background failure for operator status. */
  async recordFailure(error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    await this.db.query(`INSERT INTO kipster.maintenance_scheduler(installation_id, last_error, last_error_at) VALUES ($1,$2,now())
      ON CONFLICT (installation_id) DO UPDATE SET last_error=EXCLUDED.last_error, last_error_at=EXCLUDED.last_error_at`, [this.installationId, message])
  }

  /** Clears the recorded failure after a tick completes without one. */
  async clearFailure(): Promise<void> {
    await this.db.query(`UPDATE kipster.maintenance_scheduler SET last_error=NULL, last_error_at=NULL
      WHERE installation_id=$1 AND last_error_at IS NOT NULL`, [this.installationId])
  }

  /** Whether a disabled coordinator still has intents, claims, preparations, unlearned sources or sleeps to settle. */
  async needsUpkeep(): Promise<boolean> {
    const row = (await this.db.query<{ needed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM kipster.maintenance_operator_intents WHERE installation_id=$1 AND state IN ('pending','executing'))
         OR EXISTS (SELECT 1 FROM kipster.maintenance_runs WHERE installation_id=$1 AND state='preparing')
         OR EXISTS (SELECT 1 FROM kipster.maintenance_sources WHERE installation_id=$1 AND status='claimed')
         OR EXISTS (SELECT 1 FROM kipster.maintenance_sources s WHERE s.installation_id=$1 AND s.status='ready' AND NOT ${learningCondition('s.agent_id')})
         OR EXISTS (SELECT 1 FROM kipster.memory_sleeps s JOIN kipster.agents g ON g.id=s.agent_id
           WHERE g.installation_id=$1 AND s.state='running' AND NOT ${learningCondition('s.agent_id')}) AS needed`,
      [this.installationId])).rows[0]
    return row?.needed === true
  }

  /** Counts the agent's active day and refreshes the memories recalled into an execution being issued. The day counter
   * advances at most once per UTC calendar day and only while the agent learns. Caller holds the capacity lock. */
  async recordActivity(client: SqlClient, agentId: string, recalled: readonly string[], now: Date): Promise<void> {
    await client.query(`INSERT INTO kipster.memory_activity(agent_id, active_on)
      SELECT $1, $2::date WHERE ${learningCondition('$1::uuid')}
      ON CONFLICT (agent_id) DO UPDATE SET active_days=memory_activity.active_days+1, active_on=EXCLUDED.active_on
        WHERE memory_activity.active_on < EXCLUDED.active_on`, [agentId, now.toISOString().slice(0, 10)])
    await refreshRecalled(client, agentId, recalled)
  }

  /** Deletion hook: call before deleting a message. Excerpts are purged; message id and hash remain. */
  async purgeMessageEvidence(client: SqlClient, messageId: string): Promise<number> {
    const updated = (await client.query(
      `UPDATE kipster.memory_provenance SET excerpt=NULL, source_message_deleted=true
       WHERE source_message_id=$1 AND source_message_deleted=false`, [messageId])).rowCount
    await client.query(`UPDATE kipster.maintenance_runs r SET staged_output=NULL, updated_at=now() FROM kipster.maintenance_sources s
      WHERE s.run_id=r.source_run_id AND s.source_revision=r.source_revision AND r.staged_output IS NOT NULL
        AND s.manifest @> jsonb_build_object('entries', jsonb_build_array(jsonb_build_object('message_id', $1::text)))`, [messageId])
    return updated ?? 0
  }

  /** Deletion hook: call before deleting a thread. Sources are tombstoned; active attempts keep permits. */
  async purgeThreadContext(client: SqlClient, threadId: string): Promise<void> {
    await client.query(`UPDATE kipster.memory_provenance SET excerpt=NULL, source_thread_deleted=true WHERE source_thread_id=$1`, [threadId])
    const runs = (await client.query<{ id: string }>('SELECT id FROM kipster.text_runs WHERE thread_id=$1', [threadId])).rows
    for (const run of runs) {
      await client.query('UPDATE kipster.maintenance_runs SET staged_output=NULL, updated_at=now() WHERE source_run_id=$1 AND staged_output IS NOT NULL', [run.id])
      await client.query(`UPDATE kipster.maintenance_sources SET status='source_deleted', status_reason='thread deleted', manifest=NULL,
        manifest_purged=true, claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now()
        WHERE run_id=$1 AND status NOT IN ('issued','recovery','source_deleted')`, [run.id])
      await client.query(`UPDATE kipster.maintenance_sources SET invalidated=true, manifest=NULL, manifest_purged=true, updated_at=now()
        WHERE run_id=$1 AND status IN ('issued','recovery')`, [run.id])
    }
  }

  /** Deletion hook: call first in the transaction that deletes an organization. It takes the capacity lock, so it
   * orders after any extraction commit in flight and before new ones. Learned memories homed in the organization are
   * deleted; every other memory survives with its provenance detached, and remaining claims are tombstoned. */
  async purgeOrganizationContext(client: SqlClient, organizationId: string): Promise<void> {
    await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])
    for (;;) {
      const homed = (await client.query<{ id: string }>(
        `SELECT id FROM kipster.memory_records WHERE installation_id=$1 AND scope='agent' AND home_organization_id=$2 ORDER BY id LIMIT $3 FOR UPDATE`,
        [this.installationId, organizationId, MEMORY_STRENGTH.forgetBatch])).rows.map(row => row.id)
      await deleteMemories(client, homed)
      if (homed.length < MEMORY_STRENGTH.forgetBatch) break
    }
    await client.query(`UPDATE kipster.memory_provenance SET excerpt=NULL, source_organization_deleted=true WHERE source_organization_id=$1`, [organizationId])
    await client.query(`UPDATE kipster.maintenance_candidate_claims SET context_tombstoned=true
      WHERE context_kind='organization' AND context_id=$1 AND context_tombstoned=false`, [organizationId])
    const runs = (await client.query<{ id: string }>(
      `SELECT r.id FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
       WHERE c.context_kind='organization' AND c.context_id=$1`, [organizationId])).rows
    for (const run of runs) {
      await client.query('UPDATE kipster.maintenance_runs SET staged_output=NULL, updated_at=now() WHERE source_run_id=$1 AND staged_output IS NOT NULL', [run.id])
      await client.query(`UPDATE kipster.maintenance_sources SET status='source_deleted', status_reason='organization deleted', manifest=NULL,
        manifest_purged=true, claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now()
        WHERE run_id=$1 AND status NOT IN ('issued','recovery','source_deleted')`, [run.id])
      await client.query(`UPDATE kipster.maintenance_sources SET invalidated=true, manifest=NULL, manifest_purged=true, updated_at=now()
        WHERE run_id=$1 AND status IN ('issued','recovery')`, [run.id])
    }
  }

  /** Deletes up to `limit` of the agent's memories with their links, sources, receipts and index state, so a large
   * brain can be removed in bounded transactions before `purgeAgentBrain`. Returns how many were deleted. Caller holds
   * the capacity lock. */
  async deleteAgentMemories(client: SqlClient, agentId: string, limit: number): Promise<number> {
    const memories = (await client.query<{ id: string }>(
      `SELECT id FROM kipster.memory_records WHERE installation_id=$1 AND scope='agent' AND owner_id=$2 ORDER BY id LIMIT $3 FOR UPDATE`,
      [this.installationId, agentId, limit])).rows.map(row => row.id)
    await deleteMemories(client, memories)
    return memories.length
  }

  /** Organization-owned memories and agent memories homed here are removed in bounded batches. */
  async deleteOrganizationMemories(client: SqlClient, organizationId: string, limit: number): Promise<number> {
    const rows = (await client.query<{ id: string }>(`SELECT id FROM kipster.memory_records WHERE installation_id=$1
      AND ((scope='organization' AND owner_id=$2) OR home_organization_id=$2) ORDER BY id LIMIT $3 FOR UPDATE`,
      [this.installationId, organizationId, limit])).rows
    await deleteMemories(client, rows.map(row => row.id))
    return rows.length
  }

  /** Removes settled organization-context extraction records after their provider state was forgotten. */
  async purgeOrganizationRuns(client: SqlClient, organizationId: string): Promise<void> {
    const runs = (await client.query<{ id: string }>(`SELECT m.id FROM kipster.maintenance_runs m JOIN kipster.maintenance_sources s ON s.run_id=m.source_run_id AND s.source_revision=m.source_revision WHERE m.installation_id=$1
      AND s.context_kind='organization' AND s.context_id=$2 AND m.state IN ('completed','failed')`, [this.installationId, organizationId])).rows
    for (const { id } of runs) {
      await client.query('DELETE FROM kipster.maintenance_operator_intents WHERE maintenance_run_id=$1', [id])
      await client.query('DELETE FROM kipster.maintenance_runs WHERE id=$1', [id])
      await client.query('DELETE FROM kipster.memory_tool_receipts WHERE attempt_id IN (SELECT id FROM kipster.attempts WHERE intent_id=$1)', [id])
      await client.query('UPDATE kipster.memory_relationship_changes SET attempt_id=NULL WHERE attempt_id IN (SELECT id FROM kipster.attempts WHERE intent_id=$1)', [id])
      await client.query('DELETE FROM kipster.attempts WHERE intent_id=$1', [id])
      await client.query('DELETE FROM kipster.work_intents WHERE id=$1', [id])
    }
    await client.query("DELETE FROM kipster.maintenance_sources WHERE installation_id=$1 AND context_kind='organization' AND context_id=$2 AND status NOT IN ('issued','recovery')", [this.installationId, organizationId])
    const links = (await client.query<{ id: string }>("SELECT id FROM kipster.memory_relationships WHERE installation_id=$1 AND owner_kind='organization' AND owner_id=$2", [this.installationId, organizationId])).rows.map(row => row.id)
    for (const table of ['memory_relationship_evidence','memory_relationship_changes']) await client.query(`DELETE FROM kipster.${table} WHERE relationship_id=ANY($1::uuid[])`, [links])
    await client.query('DELETE FROM kipster.memory_relationships WHERE id=ANY($1::uuid[])', [links])
    await client.query("DELETE FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind='organization' AND owner_id=$2", [this.installationId, organizationId])
  }

  /** Deletion hook for an agent brain: memories and their links, relationships it owns, extraction claims and
   * sources, finished maintenance runs, the day counter, promotions and sleeps. Active or uncertain execution
   * evidence is retained until confirmed end; the brain wipe sets no invalidation, so in-flight output fences at
   * the live-agent check. Change the agent's lifecycle in the same transaction. */
  async purgeAgentBrain(client: SqlClient, agentId: string): Promise<{ removedRuns: number; retainedRuns: number }> {
    const active = (await client.query<{ id: string }>(
      `SELECT id FROM kipster.maintenance_runs WHERE agent_id=$1 AND installation_id=$2 AND state IN ('running','recovery-needed')`,
      [agentId, this.installationId])).rows.map(row => row.id)
    if (active.length) await client.query('UPDATE kipster.maintenance_runs SET staged_output=NULL, updated_at=now() WHERE id=ANY($1::uuid[])', [active])
    // Memories and links go first: links written during sleep cite the attempt of the run that made them.
    await client.query('DELETE FROM kipster.maintenance_candidate_claims WHERE owner_id=$1', [agentId])
    const memories = (await client.query<{ id: string }>(
      `SELECT id FROM kipster.memory_records WHERE scope='agent' AND owner_id=$1 AND installation_id=$2 ORDER BY id`, [agentId, this.installationId])).rows
    await deleteMemories(client, memories.map(memory => memory.id))
    const removable = (await client.query<{ id: string }>(
      `SELECT id FROM kipster.maintenance_runs WHERE agent_id=$1 AND installation_id=$2 AND state IN ('queued','preparing','completed','failed')`,
      [agentId, this.installationId])).rows.map(row => row.id)
    for (const runId of removable) {
      await client.query('DELETE FROM kipster.maintenance_operator_intents WHERE maintenance_run_id=$1', [runId])
      await client.query('DELETE FROM kipster.maintenance_runs WHERE id=$1', [runId])
      await client.query('DELETE FROM kipster.memory_tool_receipts WHERE attempt_id IN (SELECT id FROM kipster.attempts WHERE intent_id=$1)', [runId])
      await client.query('DELETE FROM kipster.attempts WHERE intent_id=$1', [runId])
      await client.query('DELETE FROM kipster.work_intents WHERE id=$1', [runId])
    }
    await client.query(`DELETE FROM kipster.maintenance_sources WHERE agent_id=$1 AND installation_id=$2 AND status NOT IN ('issued','recovery')`,
      [agentId, this.installationId])
    // Links the agent owns between memories it does not own.
    const owned = (await client.query<{ id: string }>(`SELECT id FROM kipster.memory_relationships WHERE installation_id=$1 AND owner_kind='agent' AND owner_id=$2`,
      [this.installationId, agentId])).rows.map(row => row.id)
    await client.query('DELETE FROM kipster.memory_relationship_evidence WHERE relationship_id=ANY($1::uuid[])', [owned])
    await client.query('DELETE FROM kipster.memory_relationship_changes WHERE relationship_id=ANY($1::uuid[])', [owned])
    await client.query('DELETE FROM kipster.memory_relationships WHERE id=ANY($1::uuid[])', [owned])
    await client.query(`DELETE FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind='agent' AND owner_id=$2`, [this.installationId, agentId])
    await client.query('DELETE FROM kipster.memory_activity WHERE agent_id=$1', [agentId])
    await client.query('DELETE FROM kipster.memory_promotions WHERE agent_id=$1', [agentId])
    await client.query('DELETE FROM kipster.memory_sleeps WHERE agent_id=$1', [agentId])
    return { removedRuns: removable.length, retainedRuns: active.length }
  }
}


/**
 * Fences the maintenance of an agent or organization that stopped being live: its queued runs, and runs
 * claimed but not yet issued, end as failed, and its pending and claimed sources are skipped. Issued
 * sources are invalidated and sleeps are ended durably, so restoring the agent cannot revive their
 * output. Issued runs retain their permits until provider end is confirmed. Caller holds the capacity lock.
 */
export async function fenceMaintenance(client: SqlClient, installationId: string, owner: { agentId: string } | { organizationId: string }, reason: string): Promise<number> {
  const agent = 'agentId' in owner
  const sources = agent ? 's.agent_id = $2' : `s.context_kind = 'organization' AND s.context_id = $2`
  const id = agent ? owner.agentId : owner.organizationId
  await client.query(`UPDATE kipster.maintenance_sources s SET invalidated=true, updated_at=now()
    WHERE s.installation_id=$1 AND s.status IN ('issued','recovery') AND ${sources}`, [installationId, id])
  if (agent) await client.query(`UPDATE kipster.memory_sleeps s SET state='skipped', finished_at=now(),
    report=s.report || jsonb_build_object('reason', $3::text) FROM kipster.agents a
    WHERE a.id=s.agent_id AND a.installation_id=$1 AND s.agent_id=$2 AND s.state='running'`, [installationId, id, reason])
  const failed = (await client.query<{ id: string; current_attempt_id: string | null }>(
    `UPDATE kipster.maintenance_runs r SET state='failed', failure=$3, updated_at=now()
     WHERE r.installation_id=$1 AND r.state IN ('queued','preparing') AND (${agent ? 'r.agent_id = $2' : 'false'} OR EXISTS (
       SELECT 1 FROM kipster.maintenance_sources s WHERE s.run_id=r.source_run_id AND s.source_revision=r.source_revision AND ${sources}))
     RETURNING r.id, r.current_attempt_id`, [installationId, id, reason])).rows
  if (failed.length) {
    await client.query(`UPDATE kipster.attempts SET state='settled' WHERE id=ANY($1::uuid[]) AND state='preparing'`, [failed.flatMap(run => run.current_attempt_id ? [run.current_attempt_id] : [])])
    await client.query(`UPDATE kipster.work_intents SET state='settled' WHERE id=ANY($1::uuid[]) AND state IN ('queued','preparing')`, [failed.map(run => run.id)])
  }
  await client.query(`UPDATE kipster.maintenance_sources s SET status='skipped', status_reason=$3, reserved=false, claim_lease_until=NULL, claim_incarnation=NULL, updated_at=now()
    WHERE s.installation_id=$1 AND s.status IN ('ready','claimed') AND ${sources}`, [installationId, id, reason])
  return failed.length
}
