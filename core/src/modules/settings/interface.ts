import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { interfacePreferencesWrite, type InterfacePreferences, type InterfacePreferencesWrite } from '../../protocol/admin.js'

type Choice = Exclude<keyof InterfacePreferences, 'version' | 'revision'>
const columns: Record<Choice, string> = {
  palette: 'palette', theme: 'theme', desktopNotifications: 'desktop_notifications', notifyNeeds: 'notify_needs',
  notifyFailures: 'notify_failures', notifyReplies: 'notify_replies', inAppBanners: 'in_app_banners', dockBadge: 'dock_badge',
}
const choices = Object.keys(columns) as Choice[]
type Row = { revision: string } & Record<string, string | boolean | null>
const view = (row: Row | undefined): InterfacePreferences => ({
  version: 1, revision: row ? Number(row.revision) : 0, ...Object.fromEntries(choices.map(choice => [choice, row?.[columns[choice]] ?? null])),
}) as InterfacePreferences
const list = choices.map(choice => columns[choice]).join(', ')
const select = `SELECT revision, ${list} FROM kipster.interface_preferences WHERE installation_id=$1`

/** The installation's interface choices. Choices never saved are null. */
export async function readInterfacePreferences(db: Postgres | SqlClient, caller: AdminCaller): Promise<InterfacePreferences> {
  await authorizeAdministration(db, caller)
  return view((await db.query<Row>(select, [caller.installationId])).rows[0])
}

/** Saves the given choices and publishes `interface-changed` when one differs. Saving the current values changes nothing. */
export async function writeInterfacePreferences(db: Postgres, caller: AdminCaller, value: InterfacePreferencesWrite): Promise<InterfacePreferences> {
  const input = interfacePreferencesWrite.parse(value)
  if (choices.every(choice => input[choice] === undefined)) throw new Error('Invalid interface preferences: no change given')
  return db.transaction(async client => {
    await authorizeAdministration(client, caller, true)
    await client.query('INSERT INTO kipster.interface_preferences(installation_id, revision) VALUES ($1, 0) ON CONFLICT DO NOTHING', [caller.installationId])
    const current = view((await client.query<Row>(`${select} FOR UPDATE`, [caller.installationId])).rows[0]!)
    const next = choices.map(choice => input[choice] ?? current[choice])
    if (choices.every((choice, index) => next[index] === current[choice])) return current
    const saved = (await client.query<Row>(`UPDATE kipster.interface_preferences SET ${choices.map((choice, index) => `${columns[choice]}=$${index + 2}`).join(', ')}, revision=revision+1
      WHERE installation_id=$1 RETURNING revision, ${list}`, [caller.installationId, ...next])).rows[0]!
    const { version: _, ...record } = view(saved)
    await publishAppEvent(client, caller.installationId, 'interface-changed', caller.installationId, record.revision, record)
    return view(saved)
  })
}
