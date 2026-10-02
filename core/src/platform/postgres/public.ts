import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

type QueryResult<T> = { rows: T[]; rowCount: number | null }
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>>
}
interface PoolClient extends SqlClient {
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void
  off(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): void
  release(error?: Error): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'end', listener: () => void): void
  off(event: 'error', listener: (error: Error) => void): void
  off(event: 'end', listener: () => void): void
}
interface Pool extends SqlClient {
  connect(): Promise<PoolClient>
  end(): Promise<void>
  on(event: 'error', listener: (error: Error & { client?: unknown }) => void): void
  on(event: 'connect' | 'remove', listener: (client: object) => void): void
}
const require = createRequire(import.meta.url)
const { Pool: PgPool } = require('pg') as { Pool: new (config: { connectionString: string; max?: number; connectionTimeoutMillis?: number; keepAlive?: boolean; keepAliveInitialDelayMillis?: number }) => Pool }
const closeWaitMs = 5000

/** A held coordinator lock. `pid` is the lock session's backend, for checking in SQL that the lock is still held. */
export interface CoordinatorLock { readonly pid: number; release(): Promise<void>; discard(): void }

/** Safe to show at startup: an incompatible applied migration history and its recovery action. */
export class MigrationHistoryError extends Error {
  constructor(message: string) { super(message); this.name = 'MigrationHistoryError' }
}

export class Postgres {
  private readonly pool: Pool
  private readonly connections = new Set<object>()
  private drained: (() => void) | null = null
  private closed = false
  private readonly listeners = new Set<() => void>()
  /** `onError` observes connections lost while idle, for example on a server restart. The pool
   * discards them and later queries reconnect; observer failures are ignored. */
  constructor(connectionString: string, max = 10, connectionTimeoutMillis?: number, onError?: (error: Error) => void | Promise<void>) {
    // Keepalive bounds how long a silently dropped connection, such as the coordinator lock session, goes unnoticed.
    this.pool = new PgPool({ connectionString, max, keepAlive: true, keepAliveInitialDelayMillis: 10000, ...(connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis }) })
    this.pool.on('connect', client => { this.connections.add(client) })
    this.pool.on('remove', client => {
      this.connections.delete(client)
      if (!this.connections.size) this.drained?.()
    })
    this.pool.on('error', error => {
      delete error.client
      void Promise.resolve().then(() => onError?.(error)).catch(() => undefined)
    })
  }
  query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    if (this.closed) throw new Error('Postgres is closed')
    return this.pool.query<T>(sql, values)
  }
  async transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Postgres is closed')
    const { client, release } = await this.checkout()
    let broken: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch (failure) { broken = failure instanceof Error ? failure : new Error('PostgreSQL rollback failed') }
      throw error
    } finally {
      release(broken)
    }
  }
  /** A session-owned advisory lock. A dead process releases it with its connection. If the lock
   * connection fails while held, the lock is gone: `onLost` is called once and release becomes a no-op.
   * `discard` drops a lock found not held, without waiting on its connection. */
  async acquireCoordinatorLock(onLost?: (error: Error) => void): Promise<CoordinatorLock> {
    if (this.closed) throw new Error('Postgres is closed')
    const client = await this.pool.connect()
    let held = false
    let done = false
    const lost = (error: Error): void => {
      if (done) return
      done = true
      client.release(error)
      if (held) try { onLost?.(error) } catch { /* observer failures are ignored */ }
    }
    const ended = (): void => { lost(new Error('Coordinator lock connection ended')) }
    const detach = (): void => { client.off('error', lost); client.off('end', ended) }
    client.on('error', lost)
    client.on('end', ended)
    try {
      const result = await client.query<{ acquired: boolean; pid: number }>('SELECT pg_try_advisory_lock($1,$2) AS acquired, pg_backend_pid() AS pid', [78315, 6])
      if (!result.rows[0]?.acquired) throw new Error('Text coordinator already active')
      held = true
      return {
        pid: result.rows[0].pid,
        discard: () => { lost(new Error('Coordinator lock is no longer held')) },
        release: async () => {
          if (done) return
          done = true
          let failure: Error | undefined
          try { await client.query('SELECT pg_advisory_unlock($1,$2)', [78315, 6]) } catch (error) {
            failure = error instanceof Error ? error : new Error('Coordinator unlock failed')
            throw error
          } finally { detach(); client.release(failure) }
        },
      }
    } catch (error) {
      if (!done) { done = true; detach(); client.release() }
      throw error
    }
  }
  /** One dedicated session per subscription, with reconnect and a catch-up signal.
   * Notifications are hints; callers must read durable state after each wake. */
  async listen(channel: string, notify: (payload: string | null) => void): Promise<() => void> {
    if (!/^[a-z_]+$/.test(channel) || this.closed) throw new Error('Invalid notification subscription')
    let stopped = false
    let discard: (() => void) | undefined
    let retry: NodeJS.Timeout | undefined
    const signal = (payload: string | null) => { try { notify(payload) } catch { /* observer only */ } }
    const connect = async (): Promise<void> => {
      if (stopped || this.closed) return
      let client: PoolClient
      try { client = await this.pool.connect() } catch {
        if (!stopped) retry = setTimeout(() => { void connect() }, 1000)
        return
      }
      if (stopped) { client.release(); return }
      let released = false
      const message = (event: { channel: string; payload?: string }) => {
        if (event.channel === channel) signal(event.payload ?? null)
      }
      const lose = (error = new Error('Notification connection ended')) => {
        if (released) return
        released = true
        client.off('notification', message)
        client.off('error', lose)
        client.off('end', lose)
        client.release(error)
        discard = undefined
        if (!stopped) {
          signal(null)
          retry = setTimeout(() => { void connect() }, 1000)
        }
      }
      discard = () => lose()
      client.on('error', lose)
      client.on('end', lose)
      client.on('notification', message)
      try {
        await client.query(`LISTEN ${channel}`)
        if (!released && !stopped) signal(null)
      } catch (error) { lose(error instanceof Error ? error : new Error('LISTEN failed')) }
    }
    const close = () => {
      stopped = true
      clearTimeout(retry)
      discard?.()
      this.listeners.delete(close)
    }
    this.listeners.add(close)
    await connect()
    return close
  }
  async migrate(migrations: readonly { version: string; sql: string }[]): Promise<void> {
    const { client, release } = await this.checkout()
    try {
      await client.query('SELECT pg_advisory_lock($1, $2)', [78315, 4])
      await client.query('CREATE SCHEMA IF NOT EXISTS kipster')
      await client.query('CREATE TABLE IF NOT EXISTS kipster.schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      const files = migrations.map(item => item.version)
      if (new Set(files).size !== files.length || files.some((file, index) => index > 0 && file <= files[index - 1]!)) throw new Error('Migrations must be unique and ordered')
      const applied = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM kipster.schema_migrations ORDER BY version')
      const known = new Set(files)
      for (const row of applied.rows) if (!known.has(row.version)) throw new MigrationHistoryError(`This database was upgraded by a newer Kipster Core (migration ${row.version}). Install that version or restore a backup.`)
      for (const [index, row] of applied.rows.entries()) {
        if (files[index] !== row.version) throw new MigrationHistoryError(`This database has an incomplete or out-of-order migration history (migration ${row.version}; expected ${files[index]}). Install a Core version matching this database or restore a backup.`)
      }
      const done = new Map(applied.rows.map(row => [row.version, row.checksum]))
      for (const migration of migrations) {
        const file = migration.version
        const checksum = createHash('sha256').update(migration.sql).digest('hex')
        if (done.has(file)) {
          if (done.get(file) !== checksum) throw new MigrationHistoryError(`This database's applied migration ${file} differs from this Kipster Core. Install the Core version that applied it or restore a backup. For schema fixes, add a new migration instead of editing ${file.slice(0, 3)}.`)
          continue
        }
        await client.query('BEGIN')
        try {
          await client.query(migration.sql)
          await client.query('INSERT INTO kipster.schema_migrations(version, checksum) VALUES ($1,$2)', [file, checksum])
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK')
          throw error
        }
      }
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', [78315, 4]) } finally { release() }
    }
  }
  /** Resolves once pooled sockets have closed, or after a bounded wait for an unresponsive server. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const close of this.listeners) close()
    const drained = new Promise<void>(resolve => { this.drained = resolve })
    await this.pool.end()
    if (!this.connections.size) return
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, closeWaitMs); timer.unref() })
    try { await Promise.race([drained, bound]) } finally { clearTimeout(timer) }
  }
  /** Checks out a client whose connection failure is recorded rather than emitted unhandled. */
  private async checkout(): Promise<{ client: PoolClient; release(error?: Error): void }> {
    const client = await this.pool.connect()
    let failure: Error | undefined
    const onError = (error: Error) => { failure = error }
    client.on('error', onError)
    return {
      client,
      release(error?: Error) {
        client.off('error', onError)
        client.release(error ?? failure)
      },
    }
  }
}
