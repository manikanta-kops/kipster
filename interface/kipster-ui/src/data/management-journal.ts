import Dexie, { type Table } from 'dexie'
import type { WorkspaceCommand } from './management'

export interface PendingManagement {
  scope: string
  revision?: string
  journalId: string
  command: WorkspaceCommand
  label: string
  state: 'unknown' | 'rejected'
  message: string
}
const db = new Dexie('kipster-management') as Dexie & {
  commands: Table<PendingManagement, string>
}
db.version(1).stores({ commands: '&scope' })
export const managementJournal = {
  async read(scope: string) {
    const value = await db.commands.get(scope)
    if (!value) return null
    const [, installationId, callerId] = JSON.parse(scope) as string[]
    if (
      value.scope !== scope ||
      typeof value.journalId !== 'string' ||
      typeof value.command?.commandId !== 'string' ||
      value.command.installationId !== installationId ||
      value.command.callerId !== callerId ||
      !value.command.operation?.type ||
      !['unknown', 'rejected'].includes(value.state)
    )
      throw new Error(
        'Saved management recovery data is incompatible. New commands are disabled.',
      )
    return value
  },
  /** Reserve only an empty slot; every subsequent transition must match its exact predecessor. */
  async transition(
    scope: string,
    expected: PendingManagement | null,
    next: PendingManagement | null,
  ) {
    return db.transaction('rw', db.commands, async () => {
      const current = (await db.commands.get(scope)) ?? null
      const matches =
        expected === null
          ? current === null
          : current !== null &&
            current.journalId === expected.journalId &&
            current.revision === expected.revision &&
            current.command.commandId === expected.command.commandId &&
            current.state === expected.state
      if (!matches) return { applied: false, current }
      const updated = next ? { ...next, revision: crypto.randomUUID() } : null
      if (updated) await db.commands.put(updated)
      else await db.commands.delete(scope)
      return { applied: true, current: updated }
    })
  },
}
