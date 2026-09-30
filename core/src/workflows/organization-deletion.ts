import type { Runtime } from '../runtime.js'
import type { SqlClient } from '../platform/postgres/public.js'
import { tombstoneOrganization, type Operation } from '../modules/administration/public.js'
import { removeThreads } from '../modules/conversations/public.js'
import type { MaintenanceService } from '../modules/memory/public.js'
import { dropOwnerTaskData } from '../modules/structured/public.js'
import { deleteOwnerCollections } from '../modules/vectors/public.js'
import { lockInstallation } from '../modules/work/public.js'
import type { OperationStep, StepOutcome } from './operations.js'

/** Rows handled per step batch. */
export const ORGANIZATION_DELETION_BATCH = { threads: 5, copies: 20, forget: 500, memories: 200, collections: 10, files: 50 } as const

export type ForgetOutcome = 'forgotten' | 'unsupported' | 'unavailable'
export interface OrganizationDeletionHost {
  readonly runtime: Runtime
  readonly maintenance: MaintenanceService
  /** Asks the adapter that ran the provider threads to forget them; a null adapter ID is the direct adapter. Returns the adapter's ID too. */
  forgetProviderState(adapterId: string | null, threadIds: readonly string[]): Promise<{ outcome: ForgetOutcome; adapterId: string | null }>
}

// All organization-context threads, including delegated child threads. Parameters: installation, organization.
const organizationThreads = `SELECT t.id FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE c.installation_id=$1 AND c.context_kind='organization' AND c.context_id=$2`

const reasons: Record<Exclude<ForgetOutcome, 'forgotten'>, string> = {
  unsupported: 'The adapter cannot forget provider state',
  unavailable: 'The adapter is not registered',
}

/**
 * The steps of `organization.delete`; global agents and their independent resources survive.
 * Each step is safe to repeat, so a restart continues where the operation stopped.
 */
export function organizationDeletionSteps(host: OrganizationDeletionHost): OperationStep[] {
  const { runtime } = host
  const organization = (operation: Operation): [string, string] => [operation.installationId, operation.targetId]
  const step = (name: string, run: (client: SqlClient, operation: Operation) => Promise<StepOutcome>): OperationStep => ({ name, run })
  return [
    // 1. Nothing may still write: the work in its chats, the work it delegated from them, and its memory tasks.
    step('wait-for-work', async (client, operation) => {
      const counts = (await client.query<{ runs: number; tasks: number }>(`WITH removed AS (${organizationThreads})
        SELECT (SELECT count(*)::int FROM kipster.text_runs r
            WHERE (r.thread_id IN (SELECT id FROM removed) OR r.id IN (SELECT d.child_run_id FROM kipster.delegations d JOIN kipster.text_runs p ON p.id=d.parent_run_id WHERE p.thread_id IN (SELECT id FROM removed)))
              AND (r.state IN ('queued','preparing','running','waiting','cancellation-requested','recovery-needed')
                OR EXISTS (SELECT 1 FROM kipster.owned_permits o JOIN kipster.attempts a ON a.id=o.attempt_id WHERE a.intent_id=r.id))) AS runs,
          (SELECT count(*)::int FROM kipster.maintenance_runs m JOIN kipster.maintenance_sources s ON s.run_id=m.source_run_id AND s.source_revision=m.source_revision WHERE m.installation_id=$1 AND s.context_kind='organization' AND s.context_id=$2 AND m.state IN ('queued','preparing','running','recovery-needed')) AS tasks`,
        organization(operation))).rows[0]!
      if (counts.runs || counts.tasks) return { status: 'wait', reason: `Waiting for the organization's work to end: ${counts.runs} runs and ${counts.tasks} memory tasks` }
      return { status: 'done' }
    }),

    // 3. Provider state of the removed conversations and of its memory tasks, collected before their rows go.
    step('forget-provider-state', async (client, operation) => {
      const rows = (await client.query<{ adapter_id: string | null; thread_id: string }>(`WITH removed AS (${organizationThreads})
        SELECT a.adapter_id, a.provider_metadata->>'threadId' AS thread_id FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id
          WHERE r.thread_id IN (SELECT id FROM removed) AND a.provider_metadata ? 'threadId'
        UNION SELECT a.adapter_id, a.provider_metadata->>'threadId' FROM kipster.attempts a JOIN kipster.maintenance_runs m ON m.id=a.intent_id
          WHERE m.installation_id=$1 AND EXISTS (SELECT 1 FROM kipster.maintenance_sources s WHERE s.run_id=m.source_run_id AND s.source_revision=m.source_revision AND s.context_kind='organization' AND s.context_id=$2) AND a.provider_metadata ? 'threadId'
        UNION SELECT m.adapter_id, m.recovery_ref->'providerIds'->>'threadId' FROM kipster.maintenance_runs m
          WHERE m.installation_id=$1 AND EXISTS (SELECT 1 FROM kipster.maintenance_sources s WHERE s.run_id=m.source_run_id AND s.source_revision=m.source_revision AND s.context_kind='organization' AND s.context_id=$2) AND m.recovery_ref->'providerIds' ? 'threadId'
        ORDER BY 1, 2`, organization(operation))).rows
      const byAdapter = new Map<string | null, string[]>()
      for (const row of rows) byAdapter.set(row.adapter_id, [...byAdapter.get(row.adapter_id) ?? [], row.thread_id])
      let forgotten = 0
      const residue: { adapterId: string | null; reason: string; threadIds: string[] }[] = []
      for (const [adapterId, threadIds] of byAdapter) {
        for (let start = 0; start < threadIds.length; start += ORGANIZATION_DELETION_BATCH.forget) {
          const chunk = threadIds.slice(start, start + ORGANIZATION_DELETION_BATCH.forget)
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
      const [installationId, organizationId] = organization(operation)
      await lockInstallation(client, installationId)
      const batch = (await client.query<{ id: string }>(`SELECT t.id FROM kipster.threads t WHERE t.id IN (${organizationThreads}) ORDER BY t.internal, t.id LIMIT $3`,
        [installationId, organizationId, ORGANIZATION_DELETION_BATCH.threads])).rows.map(row => row.id)
      await removeThreads(client, installationId, batch, async (threadId, messageIds) => {
        for (const messageId of messageIds) await host.maintenance.purgeMessageEvidence(client, messageId)
        await host.maintenance.purgeThreadContext(client, threadId)
      })
      if (batch.length === ORGANIZATION_DELETION_BATCH.threads) return { status: 'more' }
      await client.query("DELETE FROM kipster.direct_chats c WHERE c.installation_id=$1 AND c.context_kind='organization' AND c.context_id=$2 AND NOT EXISTS (SELECT 1 FROM kipster.threads t WHERE t.chat_id=c.id)", [installationId, organizationId])
      return { status: 'done' }
    }),

    // 5. Organization-owned and organization-homed memory; global agent learning state survives.
    step('delete-memory', async (client, operation) => {
      const [installationId, organizationId] = organization(operation)
      await lockInstallation(client, installationId)
      if (await host.maintenance.deleteOrganizationMemories(client, organizationId, ORGANIZATION_DELETION_BATCH.memories) === ORGANIZATION_DELETION_BATCH.memories) return { status: 'more' }
      await host.maintenance.purgeOrganizationContext(client, organizationId)
      await host.maintenance.purgeOrganizationRuns(client, organizationId)
      return { status: 'done' }
    }),

    // 6. Its vector collections and its task-data schema.
    step('delete-vectors-and-task-data', async (client, operation) => {
      const [installationId, organizationId] = organization(operation)
      if (await deleteOwnerCollections(client, installationId, { kind: 'organization', ownerId: organizationId }, ORGANIZATION_DELETION_BATCH.collections) === ORGANIZATION_DELETION_BATCH.collections) return { status: 'more' }
      await dropOwnerTaskData(client, { kind: 'organization', ownerId: organizationId })
      return { status: 'done' }
    }),

    // 7. Its files, bytes before rows. Surviving messages that showed one get its organization copy or a removed part.
    step('delete-files', async (client, operation) => {
      const [installationId, organizationId] = organization(operation)
      await lockInstallation(client, installationId)
      const removed = await runtime.artifacts.removeOwnedFiles(client, installationId, { kind: 'organization', id: organizationId }, ORGANIZATION_DELETION_BATCH.files)
      return removed === ORGANIZATION_DELETION_BATCH.files ? { status: 'more' } : { status: 'done' }
    }),

    // 8. Organization home, instructions and files.
    step('remove-home', async (_client, operation) => {
      await runtime.home.removeOrganization(operation.targetId, operation.id)
      return { status: 'done' }
    }),

    // 9. Affiliations and settings; retain the bootstrap-safe named tombstone.
    step('tombstone', async (client, operation) => {
      await tombstoneOrganization(client, runtime.jobs, ...organization(operation))
      return { status: 'done' }
    }),
  ]
}
