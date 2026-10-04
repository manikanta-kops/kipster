import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { permissionSettingsWrite, type PermissionMode, type PermissionSettings, type PermissionSettingsWrite } from '../../protocol/admin.js'

/** Every installation starts in `auto`. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'
type Row = { revision: string; mode: PermissionMode }
const view = (row: Row | undefined): PermissionSettings => ({ version: 1, revision: row ? Number(row.revision) : 0, mode: row?.mode ?? DEFAULT_PERMISSION_MODE })

/** The mode every text execution of the installation runs with. Core's own read, without caller authorization. */
export async function permissionModeFor(db: Postgres | SqlClient, installationId: string): Promise<PermissionMode> {
  return (await db.query<Row>('SELECT revision, mode FROM kipster.permission_settings WHERE installation_id=$1', [installationId])).rows[0]?.mode ?? DEFAULT_PERMISSION_MODE
}

/** The installation's permission mode. */
export async function readPermissions(db: Postgres | SqlClient, caller: AdminCaller): Promise<PermissionSettings> {
  await authorizeAdministration(db, caller)
  return view((await db.query<Row>('SELECT revision, mode FROM kipster.permission_settings WHERE installation_id=$1', [caller.installationId])).rows[0])
}

/**
 * Saves the mode in the caller's transaction and publishes `permissions-changed` when it differs. Saving the current
 * mode changes nothing. The next execution of every kip uses the saved mode; running executions keep theirs.
 */
export async function savePermissions(client: SqlClient, caller: AdminCaller, mode: PermissionMode): Promise<PermissionSettings> {
  await authorizeAdministration(client, caller, true)
  await client.query('INSERT INTO kipster.permission_settings(installation_id, revision, mode) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING', [caller.installationId, DEFAULT_PERMISSION_MODE])
  const current = (await client.query<Row>('SELECT revision, mode FROM kipster.permission_settings WHERE installation_id=$1 FOR UPDATE', [caller.installationId])).rows[0]!
  if (current.mode === mode) return view(current)
  const saved = (await client.query<Row>('UPDATE kipster.permission_settings SET mode=$2, revision=revision+1 WHERE installation_id=$1 RETURNING revision, mode', [caller.installationId, mode])).rows[0]!
  const { version: _, ...record } = view(saved)
  await publishAppEvent(client, caller.installationId, 'permissions-changed', caller.installationId, record.revision, record)
  return view(saved)
}

/** Validates and saves a permission mode change from the protocol. */
export async function writePermissions(db: Postgres, caller: AdminCaller, value: PermissionSettingsWrite): Promise<PermissionSettings> {
  const input = permissionSettingsWrite.parse(value)
  return db.transaction(client => savePermissions(client, caller, input.mode))
}
