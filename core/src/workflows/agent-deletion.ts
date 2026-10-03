import type { Runtime } from '../runtime.js'
import type { SqlClient } from '../platform/postgres/public.js'
import { tombstoneAgent, type Operation } from '../modules/administration/public.js'
import { removeThreads } from '../modules/conversations/public.js'
import { removeThreadDocuments } from '../modules/documents/public.js'
import type { MaintenanceService } from '../modules/memory/public.js'
import { dropOwnerTaskData } from '../modules/structured/public.js'
import { deleteOwnerCollections } from '../modules/vectors/public.js'
import { lockInstallation } from '../modules/work/public.js'
import type { OperationStep, StepOutcome } from './operations.js'

/** Rows handled per step batch. */
export const AGENT_DELETION_BATCH = { threads: 5, copies: 20, forget: 500, memories: 200, collections: 10, files: 50 } as const

export type ForgetOutcome = 'forgotten' | 'unsupported' | 'unavailable'
export interface AgentDeletionHost {
  readonly runtime: Runtime
  readonly maintenance: MaintenanceService
  /** Asks the adapter that ran the provider threads to forget them; a null adapter ID is the direct adapter. Returns the adapter's ID too. */
  forgetProviderState(adapterId: string | null, threadIds: readonly string[]): Promise<{ outcome: ForgetOutcome; adapterId: string | null }>
}

// The threads removed with the agent: those of its chats, and those in other agents' chats where it
// ran work delegated to it. Parameters: $1 installation, $2 agent.
const agentThreads = `SELECT t.id FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE c.installation_id=$1 AND c.agent_id=$2
  UNION SELECT r.thread_id FROM kipster.delegations d JOIN kipster.text_runs r ON r.id=d.child_run_id WHERE d.installation_id=$1 AND d.recipient_agent_id=$2`

const reasons: Record<Exclude<ForgetOutcome, 'forgotten'>, string> = {
  unsupported: 'The adapter cannot forget provider state',
  unavailable: 'The adapter is not registered',
}

/**
 * The steps of `agent.delete`, which permanently deletes an archived agent that is now `deleting`.
 * Each step is safe to repeat, so a restart continues where the operation stopped.
 */
export function agentDeletionSteps(host: AgentDeletionHost): OperationStep[] {
  const { runtime } = host
  const agent = (operation: Operation): [string, string] => [operation.installationId, operation.targetId]
  const step = (name: string, run: (client: SqlClient, operation: Operation) => Promise<StepOutcome>): OperationStep => ({ name, run })
  return [
    // 1. Nothing may still write: the work in its chats, the work it delegated from them, and its memory tasks.
    step('wait-for-work', async (client, operation) => {
      const counts = (await client.query<{ runs: number; tasks: number }>(`WITH removed AS (${agentThreads})
        SELECT (SELECT count(*)::int FROM kipster.text_runs r
            WHERE (r.thread_id IN (SELECT id FROM removed) OR r.id IN (SELECT d.child_run_id FROM kipster.delegations d JOIN kipster.text_runs p ON p.id=d.parent_run_id WHERE p.thread_id IN (SELECT id FROM removed)))
              AND (r.state IN ('queued','preparing','running','waiting','cancellation-requested','recovery-needed')
                OR EXISTS (SELECT 1 FROM kipster.owned_permits o JOIN kipster.attempts a ON a.id=o.attempt_id WHERE a.intent_id=r.id))) AS runs,
          (SELECT count(*)::int FROM kipster.maintenance_runs WHERE installation_id=$1 AND agent_id=$2 AND state IN ('queued','preparing','running','recovery-needed')) AS tasks`,
        agent(operation))).rows[0]!
      if (counts.runs || counts.tasks) return { status: 'wait', reason: `Waiting for the agent's work to end: ${counts.runs} runs and ${counts.tasks} memory tasks` }
      return { status: 'done' }
    }),

    // 2. Optionally, each of its files that appeared in an organization's chats is copied into that organization.
    step('copy-files', async (client, operation) => {
      if (operation.options.copyFilesToOrganizations !== true) return { status: 'done' }
      const pending = (await client.query<{ source_id: string; organization_id: string; copy_id: string }>(`SELECT * FROM (
          SELECT DISTINCT a.id AS source_id, c.context_id AS organization_id, md5($3 || ':' || a.id || ':' || c.context_id)::uuid AS copy_id
          FROM kipster.artifacts a JOIN kipster.message_artifacts ma ON ma.artifact_id=a.id JOIN kipster.messages m ON m.id=ma.message_id
            JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
          WHERE a.installation_id=$1 AND a.owner_kind='agent' AND a.owner_id=$2 AND a.state='ready'
            AND c.context_kind='organization' AND kipster.live_organization(c.context_id)
            AND NOT EXISTS (SELECT 1 FROM kipster.artifacts o WHERE o.source_id=a.id AND o.owner_kind='organization' AND o.owner_id=c.context_id AND o.state='ready')
        ) candidates WHERE NOT EXISTS (SELECT 1 FROM kipster.artifacts o WHERE o.id=candidates.copy_id)
        ORDER BY source_id, organization_id LIMIT $4`, [...agent(operation), operation.id, AGENT_DELETION_BATCH.copies])).rows
      for (const item of pending) await runtime.artifacts.copyIntoOrganization(client, item.source_id, item.organization_id, item.copy_id)
      if (pending.length === AGENT_DELETION_BATCH.copies) return { status: 'more' }
      const copies = (await client.query<{ copied: number; unavailable: number }>(`SELECT count(*) FILTER (WHERE o.state='ready')::int AS copied, count(*) FILTER (WHERE o.state='failed')::int AS unavailable
        FROM kipster.artifacts o JOIN kipster.artifacts a ON a.id=o.source_id
        WHERE a.installation_id=$1 AND a.owner_kind='agent' AND a.owner_id=$2 AND o.id=md5($3 || ':' || a.id || ':' || o.owner_id)::uuid`, [...agent(operation), operation.id])).rows[0]!
      return { status: 'done', result: { files: copies } }
    }),

    // 3. Provider state of the removed conversations and of its memory tasks, collected before their rows go.
    step('forget-provider-state', async (client, operation) => {
      const rows = (await client.query<{ adapter_id: string | null; thread_id: string }>(`WITH removed AS (${agentThreads})
        SELECT a.adapter_id, a.provider_metadata->>'threadId' AS thread_id FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id
          WHERE r.thread_id IN (SELECT id FROM removed) AND a.provider_metadata ? 'threadId'
        UNION SELECT a.adapter_id, a.provider_metadata->>'threadId' FROM kipster.attempts a JOIN kipster.maintenance_runs m ON m.id=a.intent_id
          WHERE m.installation_id=$1 AND m.agent_id=$2 AND a.provider_metadata ? 'threadId'
        UNION SELECT m.adapter_id, m.recovery_ref->'providerIds'->>'threadId' FROM kipster.maintenance_runs m
          WHERE m.installation_id=$1 AND m.agent_id=$2 AND m.recovery_ref->'providerIds' ? 'threadId'
        ORDER BY 1, 2`, agent(operation))).rows
      const byAdapter = new Map<string | null, string[]>()
      for (const row of rows) byAdapter.set(row.adapter_id, [...byAdapter.get(row.adapter_id) ?? [], row.thread_id])
      let forgotten = 0
      const residue: { adapterId: string | null; reason: string; threadIds: string[] }[] = []
      for (const [adapterId, threadIds] of byAdapter) {
        for (let start = 0; start < threadIds.length; start += AGENT_DELETION_BATCH.forget) {
          const chunk = threadIds.slice(start, start + AGENT_DELETION_BATCH.forget)
          const forget = await host.forgetProviderState(adapterId, chunk)
          if (forget.outcome === 'forgotten') forgotten += chunk.length
          else residue.push({ adapterId: forget.adapterId, reason: reasons[forget.outcome], threadIds: chunk })
        }
      }
      return { status: 'done', result: { providerState: { forgotten, residue } } }
    }),

    // 4. Its chats, a few threads at a time. Links from other threads into them are cleared first,
    //    and surviving delegation records keep the agent's name through its tombstone.
    step('delete-chats', async (client, operation) => {
      const [installationId, agentId] = agent(operation)
      await lockInstallation(client, installationId)
      const batch = (await client.query<{ id: string }>(`SELECT t.id FROM kipster.threads t WHERE t.id IN (${agentThreads}) ORDER BY t.internal, t.id LIMIT $3`,
        [installationId, agentId, AGENT_DELETION_BATCH.threads])).rows.map(row => row.id)
      await removeThreads(client, installationId, batch, async (threadId, messageIds) => {
        for (const messageId of messageIds) await host.maintenance.purgeMessageEvidence(client, messageId)
        await host.maintenance.purgeThreadContext(client, threadId)
        await removeThreadDocuments(client, installationId, threadId)
      })
      if (batch.length === AGENT_DELETION_BATCH.threads) return { status: 'more' }
      await client.query('DELETE FROM kipster.direct_chats c WHERE c.installation_id=$1 AND c.agent_id=$2 AND NOT EXISTS (SELECT 1 FROM kipster.threads t WHERE t.chat_id=c.id)', [installationId, agentId])
      return { status: 'done' }
    }),

    // 5. Its memory and learning state.
    step('delete-memory', async (client, operation) => {
      const [installationId, agentId] = agent(operation)
      await lockInstallation(client, installationId)
      if (await host.maintenance.deleteAgentMemories(client, agentId, AGENT_DELETION_BATCH.memories) === AGENT_DELETION_BATCH.memories) return { status: 'more' }
      await host.maintenance.purgeAgentBrain(client, agentId)
      return { status: 'done' }
    }),

    // 6. Its vector collections and its task-data schema.
    step('delete-vectors-and-task-data', async (client, operation) => {
      const [installationId, agentId] = agent(operation)
      if (await deleteOwnerCollections(client, installationId, { kind: 'agent', ownerId: agentId }, AGENT_DELETION_BATCH.collections) === AGENT_DELETION_BATCH.collections) return { status: 'more' }
      await dropOwnerTaskData(client, { kind: 'agent', ownerId: agentId })
      return { status: 'done' }
    }),

    // 7. Its files, bytes before rows. Surviving messages that showed one get its organization copy or a removed part.
    step('delete-files', async (client, operation) => {
      const [installationId, agentId] = agent(operation)
      await lockInstallation(client, installationId)
      const removed = await runtime.artifacts.removeOwnedFiles(client, installationId, { kind: 'agent', id: agentId }, AGENT_DELETION_BATCH.files)
      return removed === AGENT_DELETION_BATCH.files ? { status: 'more' } : { status: 'done' }
    }),

    // 8. Its home, with its identity files, their backups and its outputs.
    step('remove-home', async (_client, operation) => {
      await runtime.home.removeAgent(operation.targetId, operation.id)
      return { status: 'done' }
    }),

    // 9. Memberships, appearances and settings; the row stays as a `deleted` tombstone with its name.
    step('tombstone', async (client, operation) => {
      await tombstoneAgent(client, runtime.jobs, ...agent(operation))
      return { status: 'done' }
    }),
  ]
}
