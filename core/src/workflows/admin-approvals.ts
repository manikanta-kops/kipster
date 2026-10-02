import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../platform/postgres/public.js'
import type { Jobs } from '../platform/jobs/public.js'
import { authorizeAdministration, type AgentCaller, type TrustedActor } from '../modules/identity/public.js'
import { archiveAgent, deleteAgent, deleteOrganization, AgentNotArchivedError } from '../modules/administration/public.js'
import { askInteraction, type InteractionRecord } from '../modules/work/public.js'

type Action = 'agent.archive' | 'agent.delete' | 'organization.delete'
/** A Core version to install, or with a backup, to restore. */
export interface InstallRequest { target: string; pin?: boolean | undefined; backupId?: string | undefined; confirmDataLoss?: boolean | undefined }
/** The provider supplies IDs and the copy option only; Core authors and durably binds the card. */
export async function requestAdminApproval(db: Postgres, caller: AgentCaller, callId: string, action: Action, targetId: string, copyFilesToOrganizations = false): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/i.test(targetId)) throw new Error('Invalid target ID')
  const organization = action === 'organization.delete'
  const table = organization ? 'organizations' : 'agents'
  const target = (await db.query<{ display_name: string }>(`SELECT display_name FROM kipster.${table} WHERE installation_id=$1 AND id=$2`, [caller.installationId, targetId])).rows[0]
  if (!target) throw new Error('Target not found')
  const operationId = `${caller.attemptId}:${callId}`
  const effect = action === 'agent.archive' ? 'Archive this agent and stop its work. Chats, memory and files stay; the agent can be restored.'
    : organization ? 'Permanently remove this organization’s chats, shared resources and organization-homed learning. Global agents and independently owned resources stay.'
      : `Permanently remove this archived agent’s chats, memory, files and provider sessions. Organization publications stay. ${copyFilesToOrganizations ? 'Copy files shown in organization chats into those organizations.' : 'Do not make additional organization file copies.'}`
  const card = await askInteraction(db, caller.attemptId, callId, {
    kind: 'approval', prompt: `${action === 'agent.archive' ? 'Archive' : 'Permanently delete'} ${target.display_name}?`,
    proposalId: randomUUID(), proposal: `${organization ? 'Organization' : 'Agent'}: ${target.display_name}\nID: ${targetId}\n${effect}`,
  }, async (client, interactionId) => {
    // askInteraction already checked the live attempt before switching it to waiting.
    await authorizeAdministration(client, caller, true)
    const row = (await client.query<{ lifecycle: string; provisioned: boolean }>(`SELECT lifecycle, provisioned FROM kipster.${table} WHERE installation_id=$1 AND id=$2 FOR UPDATE`, [caller.installationId, targetId])).rows[0]
    if (!row?.provisioned) throw new Error('Target not found')
    if (!organization && (await client.query("SELECT 1 FROM kipster.agent_roles WHERE agent_id=$1 AND role='root-admin'", [targetId])).rows.length) throw new Error('Archive or deletion of the admin agent denied')
    if (action === 'agent.delete' && row.lifecycle !== 'archived') throw new AgentNotArchivedError()
    if (action !== 'agent.delete' && row.lifecycle !== 'active') throw new Error('Target is no longer active')
    await client.query(`INSERT INTO kipster.admin_approvals(interaction_id,installation_id,action,target_id,target_name,options,operation_id)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [interactionId, caller.installationId, action, targetId, target.display_name, JSON.stringify({ copyFilesToOrganizations }), operationId])
  })
  return { status: card.state, interactionId: card.id, operationId }
}

/**
 * Asks the owner to approve installing or restoring a Core version. `currentVersion` is the running Core. Installing
 * restarts Kipster, so it waits for the owner like a deletion; the install itself starts after the answer commits.
 */
export async function requestInstallApproval(db: Postgres, caller: AgentCaller, callId: string, install: InstallRequest, currentVersion: string): Promise<unknown> {
  const operationId = `${caller.attemptId}:${callId}`
  const restore = install.backupId !== undefined
  const card = await askInteraction(db, caller.attemptId, callId, {
    kind: 'approval', prompt: `${restore ? 'Restore' : 'Install'} Kipster Core ${install.target}?`,
    proposalId: randomUUID(),
    proposal: `Kipster Core: ${currentVersion} → ${install.target}\n${restore ? `Restore backup ${install.backupId}. Data written since that backup is lost.` : install.pin === false ? 'Keep following the update channel afterwards.' : 'Stay on this version until unpinned.'}\nKipster restarts; running work pauses and continues afterwards.`,
  }, async (client, interactionId) => {
    await authorizeAdministration(client, caller, true)
    await client.query(`INSERT INTO kipster.admin_approvals(interaction_id,installation_id,action,target_id,target_name,options,operation_id)
      VALUES ($1,$2,'update.install',$2,$3,$4::jsonb,$5)`, [interactionId, caller.installationId, `Kipster Core ${install.target}`, JSON.stringify(install), operationId])
  })
  return { status: card.state, interactionId: card.id, operationId }
}

/** The approved install of an answered card that has not started yet, with the operation ID that makes starting it idempotent. */
export async function approvedInstall(db: Postgres, actor: TrustedActor, interactionId: string): Promise<{ operationId: string; install: InstallRequest } | null> {
  const row = (await db.query<{ options: InstallRequest; operation_id: string }>(`SELECT a.options, a.operation_id FROM kipster.admin_approvals a JOIN kipster.interactions i ON i.id=a.interaction_id
    WHERE a.interaction_id=$1 AND a.installation_id=$2 AND a.action='update.install' AND a.result IS NULL AND i.state='settled' AND i.answer->>'kind'='approve'`, [interactionId, actor.installationId])).rows[0]
  return row ? { operationId: row.operation_id, install: row.options } : null
}

/** Records how the approved install request ended: the update status, or why Core refused it. */
export async function recordInstall(db: Postgres, interactionId: string, result: unknown): Promise<void> {
  await db.query('UPDATE kipster.admin_approvals SET result=$2::jsonb WHERE interaction_id=$1 AND result IS NULL', [interactionId, JSON.stringify(result)])
}

/** The human answer and the bound lifecycle transition commit together, including the cleanup job. */
export async function applyAdminApproval(client: SqlClient, jobs: Jobs, actor: TrustedActor, card: InteractionRecord): Promise<void> {
  const binding = (await client.query<{ action: Action; target_id: string; options: { copyFilesToOrganizations: boolean }; operation_id: string; result: unknown }>(
    'SELECT * FROM kipster.admin_approvals WHERE interaction_id=$1 AND installation_id=$2 FOR UPDATE', [card.id, actor.installationId])).rows[0]
  // An install starts after the answer commits; see `approvedInstall`.
  if (!binding || binding.result || (binding.action as string) === 'update.install') return
  const transaction = { transaction: async <T>(work: (client: SqlClient) => Promise<T>): Promise<T> => work(client) }
  const result = binding.action === 'agent.archive' ? await archiveAgent(transaction, jobs, actor, binding.target_id, binding.operation_id)
    : binding.action === 'agent.delete' ? await deleteAgent(transaction, jobs, actor, binding.target_id, binding.operation_id, binding.options)
      : await deleteOrganization(transaction, jobs, actor, binding.target_id, binding.operation_id)
  await client.query('UPDATE kipster.admin_approvals SET result=$2::jsonb WHERE interaction_id=$1', [card.id, JSON.stringify(result)])
}
