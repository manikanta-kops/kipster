import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../platform/postgres/public.js'
import type { Jobs } from '../platform/jobs/public.js'
import { authorizeAdministration, type AgentCaller, type TrustedActor } from '../modules/identity/public.js'
import { archiveAgent, deleteAgent, deleteOrganization, AgentNotArchivedError } from '../modules/administration/public.js'
import { askInteraction, type InteractionRecord } from '../modules/work/public.js'

type Action = 'agent.archive' | 'agent.delete' | 'organization.delete'
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

/** The human answer and the bound lifecycle transition commit together, including the cleanup job. */
export async function applyAdminApproval(client: SqlClient, jobs: Jobs, actor: TrustedActor, card: InteractionRecord): Promise<void> {
  const binding = (await client.query<{ action: Action; target_id: string; options: { copyFilesToOrganizations: boolean }; operation_id: string; result: unknown }>(
    'SELECT * FROM kipster.admin_approvals WHERE interaction_id=$1 AND installation_id=$2 FOR UPDATE', [card.id, actor.installationId])).rows[0]
  if (!binding || binding.result) return
  const transaction = { transaction: async <T>(work: (client: SqlClient) => Promise<T>): Promise<T> => work(client) }
  const result = binding.action === 'agent.archive' ? await archiveAgent(transaction, jobs, actor, binding.target_id, binding.operation_id)
    : binding.action === 'agent.delete' ? await deleteAgent(transaction, jobs, actor, binding.target_id, binding.operation_id, binding.options)
      : await deleteOrganization(transaction, jobs, actor, binding.target_id, binding.operation_id)
  await client.query('UPDATE kipster.admin_approvals SET result=$2::jsonb WHERE interaction_id=$1', [card.id, JSON.stringify(result)])
}
