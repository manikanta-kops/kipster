import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { permissionSettingsWrite, type PermissionMode, type PermissionSettings, type PermissionSettingsWrite } from '../../protocol/admin.js'

/** Every installation starts in `auto`. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'
type Row = { revision: string; mode: PermissionMode }

async function view(db: Postgres | SqlClient, installationId: string, row: Row | undefined): Promise<PermissionSettings> {
  const allowed = await db.query<{ id: string; label: string; created_at: Date }>('SELECT id, label, created_at FROM kipster.approval_grants WHERE installation_id=$1 AND thread_id IS NULL ORDER BY created_at, id', [installationId])
  return { version: 1, revision: row ? Number(row.revision) : 0, mode: row?.mode ?? DEFAULT_PERMISSION_MODE, alwaysAllowed: allowed.rows.map(grant => ({ id: grant.id, label: grant.label, createdAt: grant.created_at.toISOString() })) }
}
const current = async (db: Postgres | SqlClient, installationId: string): Promise<Row | undefined> =>
  (await db.query<Row>('SELECT revision, mode FROM kipster.permission_settings WHERE installation_id=$1', [installationId])).rows[0]

/** The mode every text execution of the installation runs with. Core's own read, without caller authorization. */
export async function permissionModeFor(db: Postgres | SqlClient, installationId: string): Promise<PermissionMode> {
  return (await current(db, installationId))?.mode ?? DEFAULT_PERMISSION_MODE
}

/** The installation's permission mode and always-allowed actions. */
export async function readPermissions(db: Postgres | SqlClient, caller: AdminCaller): Promise<PermissionSettings> {
  await authorizeAdministration(db, caller)
  return view(db, caller.installationId, await current(db, caller.installationId))
}

/** Locks the settings row, applies `change`, and when it changed anything takes the next revision and publishes it. */
async function change(client: SqlClient, installationId: string, apply: (row: Row) => Promise<boolean>): Promise<PermissionSettings> {
  await client.query('INSERT INTO kipster.permission_settings(installation_id, revision, mode) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING', [installationId, DEFAULT_PERMISSION_MODE])
  let row = (await client.query<Row>('SELECT revision, mode FROM kipster.permission_settings WHERE installation_id=$1 FOR UPDATE', [installationId])).rows[0]!
  if (!await apply(row)) return view(client, installationId, row)
  row = (await client.query<Row>('UPDATE kipster.permission_settings SET revision=revision+1 WHERE installation_id=$1 RETURNING revision, mode', [installationId])).rows[0]!
  const { version: _, ...record } = await view(client, installationId, row)
  await publishAppEvent(client, installationId, 'permissions-changed', installationId, record.revision, record)
  return { version: 1, ...record }
}

/**
 * Saves the mode in the caller's transaction and publishes `permissions-changed` when it differs. Saving the current
 * mode changes nothing. The next execution of every kip uses the saved mode; running executions keep theirs.
 */
export async function savePermissions(client: SqlClient, caller: AdminCaller, mode: PermissionMode): Promise<PermissionSettings> {
  await authorizeAdministration(client, caller, true)
  return change(client, caller.installationId, async row => {
    if (row.mode === mode) return false
    await client.query('UPDATE kipster.permission_settings SET mode=$2 WHERE installation_id=$1', [caller.installationId, mode])
    return true
  })
}

/** Validates and saves a permission change from the protocol: a mode, always-allowed actions to remove, or both. */
export async function writePermissions(db: Postgres, caller: AdminCaller, value: PermissionSettingsWrite): Promise<PermissionSettings> {
  const input = permissionSettingsWrite.parse(value)
  if (input.mode === undefined && input.removeAlwaysAllowed === undefined) throw new TypeError('Invalid permission change: set a mode or remove always-allowed actions')
  return db.transaction(async client => {
    if (input.mode !== undefined) await savePermissions(client, caller, input.mode)
    else await authorizeAdministration(client, caller, true)
    const removed = input.removeAlwaysAllowed ?? []
    return change(client, caller.installationId, async () => (await client.query('DELETE FROM kipster.approval_grants WHERE installation_id=$1 AND thread_id IS NULL AND id = ANY($2::uuid[])', [caller.installationId, removed.filter(id => /^[0-9a-f-]{36}$/i.test(id))])).rowCount! > 0)
  })
}

/**
 * Records a grant chosen on an approval card, inside the answer's transaction. A thread grant covers that
 * conversation; a grant without a thread is always allowed and joins the installation's permission settings.
 */
export async function saveApprovalGrant(client: SqlClient, installationId: string, threadId: string | null, key: string, label: string): Promise<void> {
  const insert = () => client.query(`INSERT INTO kipster.approval_grants(id, installation_id, thread_id, key, label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [randomUUID(), installationId, threadId, key, label])
  if (threadId) { await insert(); return }
  await change(client, installationId, async () => (await insert()).rowCount! > 0)
}

/** The grant keys an execution in this thread may act on without asking. */
export async function approvalGrantKeys(db: Postgres | SqlClient, installationId: string, threadId: string): Promise<string[]> {
  return (await db.query<{ key: string }>('SELECT key FROM kipster.approval_grants WHERE installation_id=$1 AND (thread_id IS NULL OR thread_id=$2) ORDER BY key', [installationId, threadId])).rows.map(row => row.key)
}
