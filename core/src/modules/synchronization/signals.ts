import type { Postgres } from '../../platform/postgres/public.js'

/** One LISTEN session shared by all HTTP servers using this Core database. */
const hubs = new WeakMap<Postgres, { ready: Promise<Signals>; users: number }>()
class Signals {
  readonly subscribers = new Map<string, Set<() => void>>()
  close: () => void = () => undefined
  wake(key: string | null): void {
    for (const [stream, callbacks] of this.subscribers) {
      if (key === null || key === stream) for (const callback of callbacks) callback()
    }
  }
  subscribe(key: string, callback: () => void): () => void {
    const callbacks = this.subscribers.get(key) ?? new Set<() => void>()
    this.subscribers.set(key, callbacks)
    callbacks.add(callback)
    return () => { callbacks.delete(callback); if (!callbacks.size) this.subscribers.delete(key) }
  }
}
export async function eventSignals(db: Postgres): Promise<{ subscribe: Signals['subscribe']; close(): void }> {
  let entry = hubs.get(db)
  if (!entry) {
    const signals = new Signals()
    entry = { users: 0, ready: db.listen('kipster_events', key => signals.wake(key)).then(close => { signals.close = close; return signals }) }
    hubs.set(db, entry)
  }
  entry.users++
  const signals = await entry.ready
  let closed = false
  return { subscribe: signals.subscribe.bind(signals), close() {
    if (closed) return
    closed = true
    if (--entry.users === 0) { signals.close(); hubs.delete(db) }
  } }
}
