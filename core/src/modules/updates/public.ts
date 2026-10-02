import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { TrustedActor } from '../identity/public.js'
import { claimOperation } from '../administration/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { channelEntry, updateInstall, updateSettingsWrite, updateUnpin, updaterRequest, updaterStatusFile, type UpdateChannel, type UpdateMode, type UpdateInstall, type UpdateSettingsWrite, type UpdateStatus, type UpdateUnpin, type UpdaterRequest, type UpdaterStatusFile } from '../../protocol/updates.js'
import { compareVersions } from './semver.js'
import { MAX_UPDATE_FILE_BYTES, readUpdateFile, writeUpdateFile } from './files.js'

export { compareVersions } from './semver.js'
export const DEFAULT_CHANNEL_URL = 'https://updates.kipster.app/v1/'
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
const INVALID_UPDATER_STATUS = 'Updater status is invalid or unreadable; inspect updates/status.json'

export type UpdateRefusalCode = 'update-in-progress' | 'update-already-installed' | 'update-backup-required' | 'update-backup-mismatch' | 'update-confirmation-required'
export class UpdateRefusedError extends Error {
  constructor(readonly code: UpdateRefusalCode, message: string) { super(message); this.name = 'UpdateRefusedError' }
}

export function channelBaseUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid updates.channelUrl: use an absolute HTTP(S) base URL without credentials, query or fragment')
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url.href
}

type Row = { channel: UpdateChannel; mode: UpdateMode; pinned: string | null; status: Partial<UpdateStatus>; updater_status: UpdaterStatusFile | null; revision: string }
type Locked = { row: Row; requestId: string | null }
type Settings = { version: 1; channel: UpdateChannel; mode: UpdateMode }
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type Status = Mutable<Omit<UpdateStatus, 'core'>> & { core: Mutable<UpdateStatus['core']> }

/** Installation-wide update policy and the durable handoff to the independently supervised updater. */
export class UpdatesService {
  readonly directory: string
  private readonly baseUrl: string
  private readonly clock: () => Date
  private serial: Promise<void> = Promise.resolve()
  private stopped = false
  private watcher: FSWatcher | undefined
  private startup: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private fetchAbort: AbortController | undefined

  constructor(private readonly db: Postgres, readonly installationId: string, home: string, readonly coreVersion: string,
    private readonly options: { channelUrl?: string; clock?: () => Date; onError?: (error: Error) => void } = {}) {
    compareVersions(coreVersion, coreVersion)
    this.directory = join(home, 'updates')
    this.baseUrl = channelBaseUrl(options.channelUrl ?? DEFAULT_CHANNEL_URL)
    this.clock = options.clock ?? (() => new Date())
  }

  private report(error: unknown): void { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))) } catch { /* Observer failures do not stop recovery. */ } }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => { if (this.stopped) throw new Error('Updates service is closed'); return work() })
    this.serial = result.then(() => undefined, () => undefined)
    return result
  }
  private async authorize(actor: TrustedActor): Promise<void> {
    if (actor.installationId !== this.installationId || !(await this.db.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [this.installationId, actor.personId])).rows.length) throw new Error('Owner access denied')
  }
  private async lock(client: SqlClient): Promise<Locked> {
    await client.query('INSERT INTO kipster.execution_permits(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
    const gate = (await client.query<{ update_request_id: string | null }>('SELECT update_request_id FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [this.installationId])).rows[0]!
    await client.query('INSERT INTO kipster.update_settings(installation_id) VALUES ($1) ON CONFLICT DO NOTHING', [this.installationId])
    const row = (await client.query<Row>('SELECT channel,mode,pinned,status,updater_status,revision FROM kipster.update_settings WHERE installation_id=$1 FOR UPDATE', [this.installationId])).rows[0]!
    return { row, requestId: gate.update_request_id }
  }
  private view(row: Row): Status {
    const core = row.status.core
    const available = core?.available && compareVersions(core.available.version, this.coreVersion) > 0 ? core.available : null
    return { version: 1, channel: row.channel, mode: row.mode, checkedAt: row.status.checkedAt ?? null, window: { start: '02:00', end: '05:00' },
      core: { version: this.coreVersion, pinned: row.pinned, available, state: core?.state ?? 'idle', step: core?.step ?? null,
        error: core?.error ?? null, lastResult: core?.lastResult ?? null, backups: core?.backups ?? [] } }
  }
  private waitingState(status: UpdateStatus): 'idle' | 'scheduled' {
    return status.mode === 'automatic' && status.core.pinned === null && status.core.available !== null && !status.core.error
      && status.core.lastResult?.to !== status.core.available.version ? 'scheduled' : 'idle'
  }
  private async save(client: SqlClient, row: Row, status: UpdateStatus, publish = true): Promise<void> {
    if (isDeepStrictEqual(row.status, status)) return
    const revision = Number(row.revision) + 1
    await client.query('UPDATE kipster.update_settings SET channel=$2,mode=$3,pinned=$4,status=$5::jsonb,revision=$6 WHERE installation_id=$1',
      [this.installationId, row.channel, row.mode, row.pinned, JSON.stringify(status), revision])
    if (publish) await publishAppEvent(client, this.installationId, 'updates-changed', this.installationId, revision, status)
  }

  /** Read the updater's restart-safe outcome before execution admission starts. No network I/O. */
  async initialize(): Promise<void> {
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      const status = this.view(row)
      if (requestId && status.core.state !== 'installing') status.core.state = 'scheduled'
      else if (!requestId && status.core.state === 'checking') status.core.state = this.waitingState(status)
      await this.save(client, row, status, Object.keys(row.status).length > 0)
    })
    await this.refreshInternal(true)
    await this.deliverInternal()
  }

  /** Host composition starts the delayed check and the watcher; library runtimes can drive tick explicitly. */
  async start(options: { startupDelayMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
    if (this.timer || this.stopped) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      this.watcher = watch(this.directory, (_event, name) => {
        if (name === null || name.toString() === 'status.json') void this.refresh().catch(error => this.report(error))
      })
      this.watcher.on('error', error => this.report(error))
      this.watcher.unref()
    } catch (error) { this.report(error) } // The periodic read also recovers missed/unsupported watch events.
    this.startup = setTimeout(() => { void this.check().catch(error => this.report(error)) }, options.startupDelayMs ?? 5000)
    this.startup.unref()
    this.timer = setInterval(() => { void this.tick().catch(error => this.report(error)) }, options.pollIntervalMs ?? 60000)
    this.timer.unref()
  }
  async close(): Promise<void> {
    this.stopped = true
    clearTimeout(this.startup); clearInterval(this.timer); this.watcher?.close(); this.fetchAbort?.abort()
    await this.serial
  }
  async get(actor: TrustedActor): Promise<UpdateStatus> {
    await this.authorize(actor)
    return this.current()
  }
  private async current(): Promise<Status> {
    const row = (await this.db.query<Row>('SELECT channel,mode,pinned,status,updater_status,revision FROM kipster.update_settings WHERE installation_id=$1', [this.installationId])).rows[0]
    if (!row) throw new Error('Update settings not found')
    return this.view(row)
  }
  async settings(actor: TrustedActor): Promise<Settings> {
    const status = await this.get(actor)
    return { version: 1, channel: status.channel as UpdateChannel, mode: status.mode as UpdateMode }
  }
  private operation(client: SqlClient, actor: TrustedActor, operationId: string, kind: string, request: object) {
    return claimOperation(client, { installationId: this.installationId, actorKind: 'person', actorId: actor.personId, operationId }, kind,
      { kind: 'installation', id: this.installationId }, {}, { ...request })
  }
  private async complete(client: SqlClient, operationId: string, result: object): Promise<void> {
    await client.query("UPDATE kipster.admin_operations SET state='succeeded',result=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1", [operationId, JSON.stringify(result)])
  }
  async setSettings(actor: TrustedActor, value: UpdateSettingsWrite): Promise<Settings> {
    const input = updateSettingsWrite.parse(value)
    await this.authorize(actor)
    return this.queue(async () => this.db.transaction(async client => {
      const { operation, claimed } = await this.operation(client, actor, input.operationId, 'updates.settings', input)
      if (!claimed) return operation.result as Settings
      const { row, requestId } = await this.lock(client)
      const changedChannel = row.channel !== input.channel
      row.channel = input.channel; row.mode = input.mode
      const status = this.view(row)
      if (changedChannel) { status.checkedAt = null; status.core.available = null; if (!requestId) status.core.error = null }
      if (!requestId) status.core.state = this.waitingState(status)
      await this.save(client, row, status)
      const result: Settings = { version: 1, channel: row.channel, mode: row.mode }
      await this.complete(client, operation.id, result)
      return result
    }))
  }

  async check(actor?: TrustedActor): Promise<UpdateStatus> {
    if (actor) await this.authorize(actor)
    return this.queue(async () => { await this.refreshInternal(); await this.checkInternal(); await this.scheduleInternal(); await this.deliverInternal(); return this.current() })
  }
  private async fetchChannel(channel: UpdateChannel): Promise<UpdateStatus['core']['available']> {
    const abort = new AbortController()
    this.fetchAbort = abort
    const timeout = setTimeout(() => abort.abort(), 10000)
    try {
      const response = await fetch(new URL(`${channel}.json`, this.baseUrl), { signal: abort.signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`Channel returned HTTP ${response.status}`)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Channel response has no body')
      const bytes: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_UPDATE_FILE_BYTES) throw new Error('Channel file exceeds 1 MiB')
          bytes.push(value)
        }
      } finally { await reader.cancel().catch(() => undefined) }
      const catalog = JSON.parse(Buffer.concat(bytes).toString('utf8')) as { schemaVersion?: unknown; packages?: Record<string, unknown> }
      if (!catalog || catalog.schemaVersion !== 1 || !catalog.packages || typeof catalog.packages !== 'object' || Array.isArray(catalog.packages)) throw new Error('Invalid channel catalog')
      if (!Object.hasOwn(catalog.packages, '@kipster/core')) return null
      const entry = channelEntry.parse(catalog.packages['@kipster/core'])
      if (entry.package !== '@kipster/core' || !entry.protocolRange || entry.protocolRange.oldest > entry.protocolRange.current || !entry.files.length
        || entry.files.some(file => !/^https?:$/.test(new URL(file.url).protocol) || !/^[a-f0-9]{64}$/.test(file.sha256) || file.size < 1)
        || entry.prerelease !== entry.version.split('+')[0]!.includes('-') || (channel === 'stable' && entry.prerelease)) throw new Error('Invalid Core channel entry')
      return compareVersions(entry.version, this.coreVersion) > 0 ? entry : null
    } finally { clearTimeout(timeout); if (this.fetchAbort === abort) this.fetchAbort = undefined }
  }
  private async checkInternal(): Promise<void> {
    let channel: UpdateChannel = 'stable'
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      channel = row.channel
      const status = this.view(row)
      if (!requestId) { status.core.state = 'checking'; if (status.core.error !== INVALID_UPDATER_STATUS) status.core.error = null }
      await this.save(client, row, status)
    })
    let available: UpdateStatus['core']['available'] = null, error: string | null = null
    try { available = await this.fetchChannel(channel) } catch (failure) { error = `Update check failed: ${failure instanceof Error ? failure.message : 'Network error'}` }
    if (this.stopped) return
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      if (row.channel !== channel) return
      const status = this.view(row)
      status.checkedAt = this.clock().toISOString()
      if (!error) status.core.available = available
      if (!requestId) {
        const invalidUpdater = status.core.error === INVALID_UPDATER_STATUS
        status.core.error = error ?? (invalidUpdater ? INVALID_UPDATER_STATUS : null)
        const priorFailure = status.core.lastResult && status.core.lastResult.outcome !== 'installed' && status.core.lastResult.to === available?.version
        if (!error && invalidUpdater) status.core.state = 'failed'
        else if (!error && priorFailure) { status.core.state = 'failed'; status.core.error = row.updater_status?.error ?? 'The previous update did not complete' }
        else status.core.state = error ? 'idle' : this.waitingState(status)
      }
      await this.save(client, row, status)
    })
  }

  async tick(): Promise<void> {
    return this.queue(async () => {
      await this.refreshInternal()
      const status = await this.current()
      if (status.checkedAt === null || this.clock().getTime() - Date.parse(status.checkedAt) >= UPDATE_CHECK_INTERVAL_MS) await this.checkInternal()
      await this.scheduleInternal()
      await this.deliverInternal()
    })
  }
  private async acceptRequest(client: SqlClient, row: Row, request: UpdaterRequest): Promise<Status> {
    await client.query('INSERT INTO kipster.update_requests(id,installation_id,request) VALUES ($1,$2,$3::jsonb)', [request.id, this.installationId, JSON.stringify(request)])
    await client.query('UPDATE kipster.execution_permits SET update_request_id=$2 WHERE installation_id=$1', [this.installationId, request.id])
    const status = this.view(row)
    status.core.state = 'scheduled'; status.core.step = null; status.core.error = null
    await this.save(client, row, status)
    return status
  }
  private async scheduleInternal(): Promise<void> {
    if (this.stopped) return
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      const status = this.view(row), hour = this.clock().getHours()
      if (requestId || this.waitingState(status) !== 'scheduled' || hour < 2 || hour >= 5) return
      // The capacity lock makes this idle check and the admission gate one atomic transition.
      // Include unissued preparations and uncertain executions, not just provider-running text.
      const busy = await client.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM kipster.owned_permits WHERE installation_id=$1)
        OR EXISTS (SELECT 1 FROM kipster.work_intents WHERE installation_id=$1 AND state IN ('preparing','issued','uncertain'))`, [this.installationId])
      if (busy.rows.length) return
      await this.acceptRequest(client, row, { version: 1, id: randomUUID(), action: 'install', target: status.core.available!.version, reason: 'automatic', requestedAt: this.clock().toISOString() })
    })
  }
  async install(actor: TrustedActor, value: UpdateInstall): Promise<UpdateStatus> {
    const input = updateInstall.parse(value)
    compareVersions(input.target, this.coreVersion)
    await this.authorize(actor)
    return this.queue(async () => {
      await this.refreshInternal()
      await this.db.transaction(async client => {
        const { operation, claimed } = await this.operation(client, actor, input.operationId, 'updates.install', input)
        if (!claimed) return
        const { row, requestId } = await this.lock(client)
        if (requestId) throw new UpdateRefusedError('update-in-progress', 'An update request is already in progress')
        const order = compareVersions(input.target, this.coreVersion)
        if (order === 0) throw new UpdateRefusedError('update-already-installed', 'The target Core version is already installed')
        if (order < 0) {
          if (!input.backupId) throw new UpdateRefusedError('update-backup-required', 'Restoring an older Core requires a backup taken on that version')
          const backup = this.view(row).core.backups.find(item => item.id === input.backupId)
          if (!backup || backup.coreVersion !== input.target) throw new UpdateRefusedError('update-backup-mismatch', 'The backup must exist and match the target Core version')
          if (input.confirmDataLoss !== true) throw new UpdateRefusedError('update-confirmation-required', 'Restoring this backup loses data written since it was taken; confirmDataLoss must be true')
        } else if (input.backupId !== undefined || input.confirmDataLoss === true) throw new TypeError('Invalid backup or data-loss confirmation for an upgrade')
        row.pinned = input.pin === false ? null : input.target
        const status = await this.acceptRequest(client, row, { version: 1, id: operation.id, action: order < 0 ? 'restore' : 'install', target: input.target,
          ...(order < 0 ? { backupId: input.backupId! } : {}), reason: 'manual', requestedAt: this.clock().toISOString() })
        await this.complete(client, operation.id, status)
      })
      await this.deliverInternal()
      return this.current()
    })
  }
  async unpin(actor: TrustedActor, value: UpdateUnpin): Promise<UpdateStatus> {
    const input = updateUnpin.parse(value)
    await this.authorize(actor)
    return this.queue(async () => {
      await this.db.transaction(async client => {
        const { operation, claimed } = await this.operation(client, actor, input.operationId, 'updates.unpin', input)
        if (!claimed) return
        const { row, requestId } = await this.lock(client)
        row.pinned = null
        const status = this.view(row)
        if (!requestId && status.core.state !== 'failed') status.core.state = this.waitingState(status)
        await this.save(client, row, status)
        await this.complete(client, operation.id, status)
      })
      await this.scheduleInternal(); await this.deliverInternal()
      return this.current()
    })
  }

  private async deliverInternal(): Promise<void> {
    if (this.stopped) return
    let deliveryId: string | null = null
    try {
      await this.db.transaction(async client => {
        const { row, requestId } = await this.lock(client)
        if (!requestId) return
        const pending = (await client.query<{ request: UpdaterRequest }>(`SELECT request FROM kipster.update_requests
          WHERE installation_id=$1 AND id::text=$2 AND NOT delivered AND NOT terminal FOR UPDATE`, [this.installationId, requestId])).rows[0]
        if (!pending) return
        deliveryId = requestId
        // Serialize delivery with result ingestion, including a second Core process recovering the outbox.
        await writeUpdateFile(this.directory, 'request.json', pending.request)
        await client.query('UPDATE kipster.update_requests SET delivered=true WHERE id=$1', [requestId])
        const status = this.view(row)
        if (status.core.error === 'The accepted update request could not be written; Core will retry the handoff') {
          status.core.error = null
          await this.save(client, row, status)
        }
      })
    } catch (error) {
      await this.db.transaction(async client => {
        const { row, requestId } = await this.lock(client)
        if (!deliveryId || requestId !== deliveryId) return
        const status = this.view(row)
        status.core.error = 'The accepted update request could not be written; Core will retry the handoff'
        await this.save(client, row, status)
      })
      this.report(error)
    }
  }
  async refresh(): Promise<void> { return this.queue(() => this.refreshInternal()) }
  private async refreshInternal(startup = false): Promise<void> {
    let file: UpdaterStatusFile
    let restoredRequest: UpdaterRequest | undefined
    try {
      const value = await readUpdateFile(join(this.directory, 'status.json'))
      if (value === undefined) return
      file = updaterStatusFile.parse(value)
      compareVersions(file.from, file.to)
      for (const backup of file.backups) compareVersions(backup.coreVersion, backup.coreVersion)
      if (new Set(file.backups.map(backup => backup.id)).size !== file.backups.length) throw new TypeError('Duplicate update backup IDs')
      if (startup && file.to === this.coreVersion) {
        // A restore can replace the database with an old, still-gated snapshot. The request file
        // survives that restore and identifies the current operation before dispatch can start.
        const request = await readUpdateFile(join(this.directory, 'request.json'))
        if (request !== undefined) {
          const parsed = updaterRequest.parse(request)
          if (parsed.id === file.requestId && parsed.action === 'restore' && parsed.target === this.coreVersion) restoredRequest = parsed
        }
      }
    } catch (error) {
      await this.db.transaction(async client => {
        const { row } = await this.lock(client)
        const status = this.view(row)
        status.core.error = INVALID_UPDATER_STATUS
        status.core.state = 'failed'; status.core.step = null
        await this.save(client, row, status)
      })
      this.report(error)
      return
    }
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      const previous = row.updater_status
      const recoveringRestore = restoredRequest !== undefined && previous?.requestId !== file.requestId
      if (requestId && requestId !== file.requestId && !recoveringRestore) return // An old result cannot settle a newer request.
      if (!recoveringRestore && previous && (((previous.requestId === file.requestId || !requestId) && Date.parse(file.updatedAt) < Date.parse(previous.updatedAt))
        || (previous.requestId === file.requestId && previous.state !== 'running' && file.state === 'running'))) return
      const status = this.view(row)
      status.core.backups = file.backups; status.core.error = file.error
      if (file.state === 'running') {
        status.core.state = 'installing'; status.core.step = file.step
        await client.query('UPDATE kipster.execution_permits SET update_request_id=$2 WHERE installation_id=$1', [this.installationId, file.requestId])
      } else {
        status.core.state = file.state === 'done' ? 'idle' : 'failed'; status.core.step = null
        status.core.lastResult = { from: file.from, to: file.to, outcome: file.state === 'done' ? 'installed' : file.state === 'rolled-back' ? 'rolled-back' : 'failed', at: file.updatedAt }
        await client.query('UPDATE kipster.execution_permits SET update_request_id=NULL WHERE installation_id=$1', [this.installationId])
        await client.query('UPDATE kipster.update_requests SET terminal=true,delivered=true WHERE installation_id=$1 AND id::text=$2', [this.installationId, file.requestId])
      }
      await client.query('UPDATE kipster.update_settings SET updater_status=$2::jsonb WHERE installation_id=$1', [this.installationId, JSON.stringify(file)])
      await this.save(client, row, status)
    })
  }
}
