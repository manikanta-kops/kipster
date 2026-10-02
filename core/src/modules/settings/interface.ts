import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { interfacePreferencesWrite, type InterfacePreferences, type InterfacePreferencesWrite } from '../../protocol/admin.js'

interface Row { revision: string; palette: string | null; theme: string | null; desktop_notifications: boolean | null }
const view = (row: Row | undefined): InterfacePreferences => ({
  version: 1, revision: row ? Number(row.revision) : 0, palette: row?.palette ?? null, theme: row?.theme ?? null, desktopNotifications: row?.desktop_notifications ?? null,
})
const select = 'SELECT revision, palette, theme, desktop_notifications FROM kipster.interface_preferences WHERE installation_id=$1'

/** The installation's interface choices. Choices never saved are null. */
export async function readInterfacePreferences(db: Postgres | SqlClient, caller: AdminCaller): Promise<InterfacePreferences> {
  await authorizeAdministration(db, caller)
  return view((await db.query<Row>(select, [caller.installationId])).rows[0])
}

/** Saves the given choices and publishes `interface-changed` when one differs. Saving the current values changes nothing. */
export async function writeInterfacePreferences(db: Postgres, caller: AdminCaller, value: InterfacePreferencesWrite): Promise<InterfacePreferences> {
  const input = interfacePreferencesWrite.parse(value)
  if (input.palette === undefined && input.theme === undefined && input.desktopNotifications === undefined) throw new Error('Invalid interface preferences: no change given')
  return db.transaction(async client => {
    await authorizeAdministration(client, caller, true)
    await client.query('INSERT INTO kipster.interface_preferences(installation_id, revision) VALUES ($1, 0) ON CONFLICT DO NOTHING', [caller.installationId])
    const current = (await client.query<Row>(`${select} FOR UPDATE`, [caller.installationId])).rows[0]!
    const next = { palette: input.palette ?? current.palette, theme: input.theme ?? current.theme, desktop_notifications: input.desktopNotifications ?? current.desktop_notifications }
    if (next.palette === current.palette && next.theme === current.theme && next.desktop_notifications === current.desktop_notifications) return view(current)
    const saved = (await client.query<Row>(`UPDATE kipster.interface_preferences SET palette=$2, theme=$3, desktop_notifications=$4, revision=revision+1
      WHERE installation_id=$1 RETURNING revision, palette, theme, desktop_notifications`, [caller.installationId, next.palette, next.theme, next.desktop_notifications])).rows[0]!
    const { version: _, ...record } = view(saved)
    await publishAppEvent(client, caller.installationId, 'interface-changed', caller.installationId, record.revision, record)
    return view(saved)
  })
}
