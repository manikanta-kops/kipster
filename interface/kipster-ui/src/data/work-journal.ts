import Dexie, { type Table } from 'dexie'
import type { WorkOperation, WorkReceipt } from './work'
export interface WorkIntent {
  id: string
  scope: string
  revision: string
  operation: WorkOperation
  state: 'reserved' | 'sending' | 'uncertain' | 'accepted' | 'rejected'
  updatedAt: number
  receipt?: WorkReceipt
}
const db = new Dexie('kipster-work-commands') as Dexie & {
  intents: Table<WorkIntent, string>
}
db.version(1).stores({ intents: '&id,scope' })
export const workJournal = {
  list: (scope: string): Promise<WorkIntent[]> =>
    db.intents.where('scope').equals(scope).toArray(),
  async reserve(scope: string, operation: WorkOperation) {
    const item: WorkIntent = {
      id: operation.operationId,
      scope,
      operation: structuredClone(operation),
      revision: crypto.randomUUID(),
      state: 'reserved',
      updatedAt: Date.now(),
    }
    await db.intents.add(item)
    return item
  },
  /** Forgets a command Core refused; nothing about it is left to reconcile. */
  async dismiss(expected: WorkIntent) {
    await db.transaction('rw', db.intents, async () => {
      const current = await db.intents.get(expected.id)
      if (current?.scope === expected.scope && current.state === 'rejected')
        await db.intents.delete(expected.id)
    })
  },
  async transition(
    expected: WorkIntent,
    state: WorkIntent['state'],
    receipt?: WorkReceipt,
  ) {
    return db.transaction('rw', db.intents, async () => {
      const current = await db.intents.get(expected.id)
      if (
        !current ||
        current.scope !== expected.scope ||
        current.revision !== expected.revision ||
        current.state !== expected.state ||
        ['accepted', 'rejected'].includes(current.state)
      )
        return undefined
      const next: WorkIntent = {
        ...current,
        revision: crypto.randomUUID(),
        state,
        updatedAt: Date.now(),
        receipt: receipt ?? current.receipt,
      }
      await db.intents.put(next)
      return next
    })
  },
}
