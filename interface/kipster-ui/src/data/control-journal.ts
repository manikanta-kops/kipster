import Dexie, { type Table } from 'dexie'
import type { ControlOperation, ControlReceipt } from './settings'
export interface ControlIntent {
  id: string
  scope: string
  revision: string
  operation: ControlOperation
  state: 'reserved' | 'sending' | 'uncertain' | 'accepted' | 'rejected'
  updatedAt: number
  receipt?: ControlReceipt
}
const db = new Dexie('kipster-settings-inbox-commands') as Dexie & {
  intents: Table<ControlIntent, string>
}
db.version(1).stores({ intents: '&id,scope' })
export const controlJournal = {
  list: (scope: string): Promise<ControlIntent[]> =>
    db.intents.where('scope').equals(scope).toArray(),
  async reserve(scope: string, operation: ControlOperation) {
    const item: ControlIntent = {
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
  async transition(
    expected: ControlIntent,
    state: ControlIntent['state'],
    receipt?: ControlReceipt,
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
      const next: ControlIntent = {
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
