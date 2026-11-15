import type { Postgres } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../identity/public.js'
import { personSettingsWrite, type OnboardingState, type PersonSettings, type PersonSettingsWrite } from '../../protocol/admin.js'

/** The owner's name, which kip prompts show as `Name (the person)`. */
export async function readPerson(db: Postgres, caller: AdminCaller): Promise<PersonSettings> {
  const { ownerId } = await authorizeAdministration(db, caller)
  const row = (await db.query<{ display_name: string }>('SELECT display_name FROM kipster.people WHERE id=$1', [ownerId])).rows[0]!
  return { version: 1, name: row.display_name }
}

/** Saves the owner's name without surrounding spaces; the next kip turn uses it. */
export async function writePerson(db: Postgres, caller: AdminCaller, value: PersonSettingsWrite): Promise<PersonSettings> {
  const name = personSettingsWrite.parse(value).name.trim()
  return db.transaction(async client => {
    const { ownerId } = await authorizeAdministration(client, caller, true)
    await client.query('UPDATE kipster.people SET display_name=$2 WHERE id=$1', [ownerId, name])
    return { version: 1, name }
  })
}

const onboarding = (completedAt: Date | null): OnboardingState => ({ version: 1, completed: completedAt !== null, completedAt: completedAt?.toISOString() ?? null })

/** Whether the person finished first-run onboarding, and when. */
export async function readOnboarding(db: Postgres, caller: AdminCaller): Promise<OnboardingState> {
  await authorizeAdministration(db, caller)
  const row = (await db.query<{ onboarding_completed_at: Date | null }>('SELECT onboarding_completed_at FROM kipster.installations WHERE id=$1', [caller.installationId])).rows[0]!
  return onboarding(row.onboarding_completed_at)
}

/** Records that onboarding is finished. The first time is kept; a later call returns it. */
export async function completeOnboarding(db: Postgres, caller: AdminCaller): Promise<OnboardingState> {
  return db.transaction(async client => {
    await authorizeAdministration(client, caller, true)
    const row = (await client.query<{ onboarding_completed_at: Date }>(`UPDATE kipster.installations SET onboarding_completed_at=COALESCE(onboarding_completed_at, now())
      WHERE id=$1 RETURNING onboarding_completed_at`, [caller.installationId])).rows[0]!
    return onboarding(row.onboarding_completed_at)
  })
}
