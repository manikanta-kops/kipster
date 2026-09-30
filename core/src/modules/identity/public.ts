import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { RefusedError } from '../../platform/errors/public.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Bootstrap { installationId: string; ownerId: string; organizationId: string; rootAgentId: string }
export interface TrustedActor { installationId: string; personId: string }
/** A tool call of the admin agent, bound to the attempt that makes it. */
export interface AgentCaller { installationId: string; attemptId: string; incarnation: string }
/** Who may administer the installation: its owner, or the admin agent from a live attempt. */
export type AdminCaller = TrustedActor | AgentCaller
/** The authorized caller: its operation-key identity and the owner it acts for. */
export interface AdminAuthority { actorKind: 'person' | 'agent'; actorId: string; ownerId: string }

export const isAgentCaller = (caller: AdminCaller): caller is AgentCaller => 'attemptId' in caller

export type OwnerKind = 'agent' | 'organization'

/**
 * Whether an agent or organization of the installation may take new work: it is provisioned and
 * active (`kipster.live_agent` / `kipster.live_organization`). A writer passes `lock`: the row then
 * stays locked FOR KEY SHARE until its transaction ends. A lifecycle change locks the row FOR
 * UPDATE, so a write either commits before the change, and is then stopped or cleaned up, or sees
 * the change and is refused. Writers lock owners after the capacity lock and before the thread and
 * run rows they write. Reads, including read-only transactions, pass `lock: false`.
 */
export async function isLive(client: SqlClient, installationId: string, kind: OwnerKind, id: string, lock = true): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return false
  const table = kind === 'agent' ? 'agents' : 'organizations'
  if (!lock) return (await client.query(`SELECT 1 FROM kipster.${table} WHERE id=$1 AND installation_id=$2 AND kipster.live_${kind}(id)`, [id, installationId])).rows.length > 0
  const found = await client.query(`SELECT 1 FROM kipster.${table} WHERE id=$1 AND installation_id=$2 FOR KEY SHARE`, [id, installationId])
  if (!found.rows.length) return false
  // A separate statement reads the row as it is after any lifecycle change the lock waited for.
  return (await client.query<{ live: boolean }>(`SELECT kipster.live_${kind}($1) AS live`, [id])).rows[0]!.live
}

/** Refuses new work for an agent that is not live: an archived agent as `agent-archived`, any other with `message`. */
export async function refuseAgent(client: SqlClient, installationId: string, agentId: string, message: string): Promise<never> {
  const archived = uuid.test(agentId) && (await client.query('SELECT 1 FROM kipster.agents WHERE id=$1 AND installation_id=$2 AND /* lifecycle visibility */ provisioned AND lifecycle=$3', [agentId, installationId, 'archived'])).rows.length > 0
  throw archived ? new RefusedError('agent-archived', 'Agent is archived') : new Error(message)
}

export async function trustedOwner(db: Postgres): Promise<TrustedActor> {
  const row = (await db.query<{ installation_id: string; owner_id: string }>('SELECT installation_id, owner_id FROM kipster.bootstrap')).rows[0]
  if (!row) throw new Error('Installation is not bootstrapped')
  return { installationId: row.installation_id, personId: row.owner_id }
}

export async function requireOrganizationMember(db: Postgres, actor: TrustedActor, organizationId: string): Promise<void> {
  const result = await db.query('SELECT 1 FROM kipster.human_memberships m JOIN kipster.organizations o ON o.id=m.organization_id JOIN kipster.bootstrap b ON b.installation_id=o.installation_id AND b.owner_id=m.person_id WHERE m.person_id=$1 AND m.organization_id=$2 AND o.installation_id=$3', [actor.personId, organizationId, actor.installationId])
  if (!result.rows.length) throw new Error('Organization access denied')
}

// A run the admin agent may administer from: its own chat in the installation context, not delegated work.
const administrationRunSql = `FROM kipster.text_runs r JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
  LEFT JOIN kipster.delegations d ON d.child_run_id=r.id`
const administrationRunAllowed = `c.context_kind='installation' AND d.id IS NULL AND EXISTS (SELECT 1 FROM kipster.agent_roles x JOIN kipster.agents g ON g.id=x.agent_id
  WHERE x.agent_id=c.agent_id AND x.role='root-admin' AND g.installation_id=c.installation_id AND kipster.live_agent(g.id))`

/** Whether the run is the live admin agent's own work in the installation context, which may use the administration tools. */
export async function administrationRun(db: Postgres | SqlClient, installationId: string, runId: string): Promise<boolean> {
  return (await db.query(`SELECT 1 ${administrationRunSql} WHERE r.id=$1 AND c.installation_id=$2 AND ${administrationRunAllowed}`, [runId, installationId])).rows.length > 0
}

/**
 * Authorizes an administration call. The owner is checked against the installation. An agent call
 * must come from the current, issued attempt of a running run, not stopping, that the live admin
 * agent executes in its own installation chat; delegated work and a run waiting on a person are
 * refused. With `lock`, the caller's transaction takes the installation's execution lock and
 * share-locks the run, so a Stop, an interaction or a newer attempt either commits first and the
 * call is refused, or waits until the call commits.
 */
export async function authorizeAdministration(db: Postgres | SqlClient, caller: AdminCaller, lock = false): Promise<AdminAuthority> {
  const owner = (await db.query<{ owner_id: string }>('SELECT owner_id FROM kipster.bootstrap WHERE installation_id=$1', [caller.installationId])).rows[0]
  if (!isAgentCaller(caller)) {
    if (owner?.owner_id !== caller.personId) throw new Error('Owner access denied')
    return { actorKind: 'person', actorId: caller.personId, ownerId: caller.personId }
  }
  if (!owner || !uuid.test(caller.attemptId)) throw new Error('Administration access denied')
  if (lock && !(await db.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [caller.installationId])).rows.length) throw new Error('Missing administration execution guard')
  const row = (await db.query<{ agent_id: string; allowed: boolean; run_state: string; stop_requested: boolean; current_attempt_id: string; attempt_state: string; intent_state: string; generation: string; intent_generation: string; incarnation: string }>(
    `SELECT c.agent_id, ${administrationRunAllowed} AS allowed, r.state AS run_state, r.stop_requested, r.current_attempt_id,
       a.state AS attempt_state, i.state AS intent_state, a.generation, i.generation AS intent_generation, a.incarnation
     ${administrationRunSql} JOIN kipster.work_intents i ON i.id=r.id JOIN kipster.attempts a ON a.intent_id=i.id
     WHERE a.id=$1 AND c.installation_id=$2 ${lock ? 'FOR SHARE OF r, i, a' : ''}`, [caller.attemptId, caller.installationId])).rows[0]
  if (!row || !row.allowed) throw new Error('Administration access denied')
  const live = row.run_state === 'running' && !row.stop_requested && row.current_attempt_id === caller.attemptId &&
    row.attempt_state === 'issued' && row.intent_state === 'issued' && row.generation === row.intent_generation && row.incarnation === caller.incarnation
  if (!live) throw new Error('Attempt no longer owns administration tools')
  return { actorKind: 'agent', actorId: row.agent_id, ownerId: owner.owner_id }
}
