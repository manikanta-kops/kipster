import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { authorizeAdministration, type AdminAuthority, type AdminCaller } from '../identity/public.js'
import { claimOperation, operationKey } from '../administration/public.js'
import { publishAppEvent } from '../synchronization/public.js'
import { channelEntry, updateInstall, updatePluginsInstall, updateSettingsWrite, updateUnpin, updaterRequest, updaterStatusFile, type ChannelEntry, type PluginsUpdateStatus, type UpdateChannel, type UpdateMode, type UpdateInstall, type UpdatePluginsInstall, type UpdateSettingsWrite, type UpdateStatus, type UpdateUnpin, type UpdaterRequest, type UpdaterStatusFile } from '../../protocol/updates.js'
import { pluginsPackageName, type PluginServerControl, type PluginServerStatus } from '../../plugins/supervisor.js'
import { installPlugins as installRelease, installedPlugins, pluginsArchive, prunePlugins, switchPlugins } from '../../plugins/install.js'
import { compareVersions } from '../../platform/semver/public.js'
import { MAX_UPDATE_FILE_BYTES, readUpdateFile, writeUpdateFile } from './files.js'

export { compareVersions } from '../../platform/semver/public.js'
export const DEFAULT_CHANNEL_URL = 'https://updates.kipster.app/v1/'
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000
export const UPDATE_PICKUP_TIMEOUT_MS = 10 * 60 * 1000
const INVALID_UPDATER_STATUS = 'Updater status is invalid or unreadable; inspect updates/status.json'

export type UpdateRefusalCode = 'update-unmanaged' | 'update-in-progress' | 'update-already-installed' | 'update-backup-required' | 'update-backup-mismatch' | 'update-confirmation-required' | 'update-not-available'
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
type Status = Mutable<Omit<UpdateStatus, 'core' | 'plugins'>> & { core: Mutable<UpdateStatus['core']>; plugins?: Mutable<PluginsUpdateStatus> }
type Channel = { core: ChannelEntry | null; plugins: ChannelEntry | null; pluginsError: string | null }
const failure = (error: unknown) => error instanceof Error ? error.message : String(error)
/**
 * Whether the plugins release `version` can be offered: newer than the running plugins (anything is when none can be read)
 * and at or above the newest that ran with the plugin data, since the plugin server refuses anything older.
 */
const newerPlugins = (version: string, running: string | null, highest: string | null) =>
  (running === null || compareVersions(version, running) > 0) && (highest === null || compareVersions(version, highest) >= 0)

/** Installation-wide update policy and the durable handoff to the independently supervised updater. */
export class UpdatesService {
  readonly directory: string
  private readonly baseUrl: string
  private readonly clock: () => Date
  private readonly managed: boolean
  private serial: Promise<void> = Promise.resolve()
  private stopped = false
  private watcher: FSWatcher | undefined
  private startup: ReturnType<typeof setTimeout> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private fetchAbort: AbortController | undefined
  private readonly plugins: PluginServerControl | undefined
  private pluginInstall: Promise<void> | undefined
  private readonly pluginAbort = new AbortController()

  /** With `plugins`, the check also covers `@kipster/plugins` and Core installs its releases itself, restarting only the plugin server. */
  constructor(private readonly db: Postgres, readonly installationId: string, home: string, readonly coreVersion: string,
    private readonly options: { channelUrl?: string; managed?: boolean; clock?: () => Date; onError?: (error: Error) => void; plugins?: PluginServerControl } = {}) {
    compareVersions(coreVersion, coreVersion)
    this.directory = join(home, 'updates')
    this.baseUrl = channelBaseUrl(options.channelUrl ?? DEFAULT_CHANNEL_URL)
    this.clock = options.clock ?? (() => new Date())
    this.managed = options.managed ?? false
    this.plugins = options.plugins
  }

  private report(error: unknown): void { try { this.options.onError?.(error instanceof Error ? error : new Error(String(error))) } catch { /* Observer failures do not stop recovery. */ } }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(() => { if (this.stopped) throw new Error('Updates service is closed'); return work() })
    this.serial = result.then(() => undefined, () => undefined)
    return result
  }
  /** The owner, or the admin agent from a live attempt. */
  private async authorize(actor: AdminCaller): Promise<AdminAuthority> {
    if (actor.installationId !== this.installationId) throw new Error('Owner access denied')
    return authorizeAdministration(this.db, actor)
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
      core: { version: this.coreVersion, managed: this.managed, pinned: row.pinned, available, state: core?.state ?? 'idle', step: core?.step ?? null,
        error: core?.error ?? null, lastResult: core?.lastResult ?? null, backups: core?.backups ?? [] },
      ...(this.plugins ? { plugins: this.pluginsView(row) } : {}) }
  }
  private pluginsView(row: Row): Mutable<PluginsUpdateStatus> {
    const saved = row.status.plugins, version = this.plugins!.packageVersion
    const available = saved?.available && newerPlugins(saved.available.version, version, this.highestPlugins) ? saved.available : null
    return { version, available, state: saved?.state ?? 'idle', error: saved?.error ?? null, lastResult: saved?.lastResult ?? null }
  }
  private waitingState(status: UpdateStatus): 'idle' | 'scheduled' {
    return this.managed && status.mode === 'automatic' && status.core.pinned === null && status.core.available !== null && !status.core.error
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
      // A check or plugins install that ended with Core; the plugin server runs the newest complete installation.
      if (status.plugins && (status.plugins.state === 'checking' || status.plugins.state === 'installing')) status.plugins.state = 'idle'
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
    clearTimeout(this.startup); clearInterval(this.timer); this.watcher?.close(); this.fetchAbort?.abort(); this.pluginAbort.abort()
    await this.serial
    await this.pluginInstall
  }
  async get(actor: AdminCaller): Promise<UpdateStatus> {
    await this.authorize(actor)
    return this.current()
  }
  private async current(): Promise<Status> {
    const row = (await this.db.query<Row>('SELECT channel,mode,pinned,status,updater_status,revision FROM kipster.update_settings WHERE installation_id=$1', [this.installationId])).rows[0]
    if (!row) throw new Error('Update settings not found')
    return this.view(row)
  }
  async settings(actor: AdminCaller): Promise<Settings> {
    const status = await this.get(actor)
    return { version: 1, channel: status.channel as UpdateChannel, mode: status.mode as UpdateMode }
  }
  /** Authorizes again in the writing transaction, so a Stop of the admin agent's run either commits first or waits. */
  private async operation(client: SqlClient, actor: AdminCaller, authority: AdminAuthority, operationId: string, kind: string, request: object) {
    await authorizeAdministration(client, actor, true)
    return claimOperation(client, operationKey(actor, authority, operationId), kind, { kind: 'installation', id: this.installationId }, {}, { ...request })
  }
  private async complete(client: SqlClient, operationId: string, result: object): Promise<void> {
    await client.query("UPDATE kipster.admin_operations SET state='succeeded',result=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1", [operationId, JSON.stringify(result)])
  }
  async setSettings(actor: AdminCaller, value: UpdateSettingsWrite): Promise<Settings> {
    const input = updateSettingsWrite.parse(value)
    const authority = await this.authorize(actor)
    return this.queue(async () => this.db.transaction(async client => {
      const { operation, claimed } = await this.operation(client, actor, authority, input.operationId, 'updates.settings', input)
      if (!claimed) return operation.result as Settings
      const { row, requestId } = await this.lock(client)
      const changedChannel = row.channel !== input.channel
      row.channel = input.channel; row.mode = input.mode
      const status = this.view(row)
      if (changedChannel) { status.checkedAt = null; status.core.available = null; if (!requestId) status.core.error = null }
      if (changedChannel && status.plugins) { status.plugins.available = null; if (status.plugins.state === 'checking') status.plugins.state = 'idle' }
      if (!requestId) status.core.state = this.waitingState(status)
      await this.save(client, row, status)
      const result: Settings = { version: 1, channel: row.channel, mode: row.mode }
      await this.complete(client, operation.id, result)
      return result
    }).then(async result => { await this.automaticPlugins(); return result }))
  }

  async check(actor?: AdminCaller): Promise<UpdateStatus> {
    if (actor) await this.authorize(actor)
    return this.queue(async () => { await this.refreshInternal(); await this.checkInternal(); await this.scheduleInternal(); await this.automaticPlugins(); await this.deliverInternal(); return this.current() })
  }
  private async fetchChannel(channel: UpdateChannel): Promise<Channel> {
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
      const valid = (entry: ChannelEntry) => entry.files.length > 0 && entry.files.every(file => /^https?:$/.test(new URL(file.url).protocol) && /^[a-f0-9]{64}$/.test(file.sha256) && file.size >= 1)
        && entry.prerelease === entry.version.split('+')[0]!.includes('-') && !(channel === 'stable' && entry.prerelease)
      let core: ChannelEntry | null = null
      if (Object.hasOwn(catalog.packages, '@kipster/core')) {
        const entry = channelEntry.parse(catalog.packages['@kipster/core'])
        if (entry.package !== '@kipster/core' || !entry.protocolRange || entry.protocolRange.oldest > entry.protocolRange.current || !valid(entry)) throw new Error('Invalid Core channel entry')
        core = compareVersions(entry.version, this.coreVersion) > 0 ? entry : null
      }
      // A bad plugins entry fails only the plugins part of the check.
      let plugins: ChannelEntry | null = null, pluginsError: string | null = null
      if (this.plugins && Object.hasOwn(catalog.packages, pluginsPackageName)) {
        try {
          const entry = channelEntry.parse(catalog.packages[pluginsPackageName])
          compareVersions(entry.version, entry.version)
          if (entry.package !== pluginsPackageName || !valid(entry)) throw new Error()
          pluginsArchive(entry)
          plugins = entry
        } catch { pluginsError = 'Update check failed: Invalid plugins channel entry' }
      }
      return { core, plugins, pluginsError }
    } finally { clearTimeout(timeout); if (this.fetchAbort === abort) this.fetchAbort = undefined }
  }
  private async checkInternal(): Promise<void> {
    let channel: UpdateChannel = 'stable'
    let priorError: string | null = null
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      channel = row.channel
      const status = this.view(row)
      priorError = status.core.error
      if (!requestId) { status.core.state = 'checking'; if (status.core.error !== INVALID_UPDATER_STATUS) status.core.error = null }
      if (status.plugins && status.plugins.state !== 'installing') status.plugins.state = 'checking'
      await this.save(client, row, status)
    })
    let available: UpdateStatus['core']['available'] = null, error: string | null = null, plugins: Channel | undefined
    try { plugins = await this.fetchChannel(channel); available = plugins.core } catch (failure) { error = `Update check failed: ${failure instanceof Error ? failure.message : 'Network error'}` }
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
        else if (!error && priorFailure) { status.core.state = 'failed'; status.core.error = priorError ?? row.updater_status?.error ?? 'The previous update did not complete' }
        else status.core.state = error ? 'idle' : this.waitingState(status)
      }
      if (status.plugins) this.checkedPlugins(status.plugins, error ?? plugins!.pluginsError, error ? undefined : plugins!.plugins)
      await this.save(client, row, status)
    })
  }
  /** The plugins part of a finished check. `entry` is undefined when the channel could not be read. */
  private checkedPlugins(status: Mutable<PluginsUpdateStatus>, error: string | null, entry: ChannelEntry | null | undefined): void {
    if (entry !== undefined) status.available = entry && newerPlugins(entry.version, status.version, this.highestPlugins) ? entry : null
    if (status.state === 'installing') return
    const priorFailure = status.lastResult && status.lastResult.outcome !== 'installed' && status.lastResult.to === status.available?.version
    status.state = priorFailure ? 'failed' : 'idle'
    if (error) status.error = error
    else if (!priorFailure) status.error = null
  }

  async tick(): Promise<void> {
    return this.queue(async () => {
      await this.refreshInternal()
      const status = await this.current()
      if (status.checkedAt === null || this.clock().getTime() - Date.parse(status.checkedAt) >= UPDATE_CHECK_INTERVAL_MS) await this.checkInternal()
      await this.scheduleInternal()
      await this.automaticPlugins()
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
    if (this.stopped || !this.managed) return
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      const status = this.view(row), hour = this.clock().getHours()
      if (requestId || this.waitingState(status) !== 'scheduled' || hour < 2 || hour >= 5) return
      // The capacity lock makes this idle check and the admission gate one atomic transition.
      // Include unissued preparations and uncertain executions, not just provider-running text.
      const busy = await client.query(`SELECT 1 WHERE EXISTS (SELECT 1 FROM kipster.owned_permits WHERE installation_id=$1)
        OR EXISTS (SELECT 1 FROM kipster.work_intents WHERE installation_id=$1 AND state IN ('preparing','issued','uncertain'))`, [this.installationId])
      if (busy.rows.length) return
      await this.acceptRequest(client, row, { version: 1, id: randomUUID(), action: 'install', target: status.core.available!.version, reason: 'automatic', requestedAt: this.clock().toISOString(),
        settings: { channel: row.channel, mode: row.mode, pinned: row.pinned } })
    })
  }
  /** Refuses a request that `install` refuses whatever the update state, so nobody is asked to approve an install that cannot start. */
  checkInstall(value: Pick<UpdateInstall, 'target' | 'backupId' | 'confirmDataLoss'>): void {
    const order = compareVersions(value.target, this.coreVersion)
    if (!this.managed) throw new UpdateRefusedError('update-unmanaged', 'Software installation requires a managed updater on this host')
    if (order === 0) throw new UpdateRefusedError('update-already-installed', 'The target Core version is already installed')
    if (order < 0 && !value.backupId) throw new UpdateRefusedError('update-backup-required', 'Restoring an older Core requires a backup taken on that version')
    if (order < 0 && value.confirmDataLoss !== true) throw new UpdateRefusedError('update-confirmation-required', 'Restoring this backup loses data written since it was taken; confirmDataLoss must be true')
    if (order > 0 && (value.backupId !== undefined || value.confirmDataLoss === true)) throw new TypeError('Invalid backup or data-loss confirmation for an upgrade')
  }
  async install(actor: AdminCaller, value: UpdateInstall): Promise<UpdateStatus> {
    const input = updateInstall.parse(value)
    compareVersions(input.target, this.coreVersion)
    const authority = await this.authorize(actor)
    if (!this.managed) throw new UpdateRefusedError('update-unmanaged', 'Software installation requires a managed updater on this host')
    return this.queue(async () => {
      await this.refreshInternal()
      await this.db.transaction(async client => {
        const { operation, claimed } = await this.operation(client, actor, authority, input.operationId, 'updates.install', input)
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
        row.pinned = order < 0 || input.pin !== false ? input.target : null
        const status = await this.acceptRequest(client, row, { version: 1, id: operation.id, action: order < 0 ? 'restore' : 'install', target: input.target,
          ...(order < 0 ? { backupId: input.backupId! } : {}), reason: 'manual', requestedAt: this.clock().toISOString(),
          settings: { channel: row.channel, mode: row.mode, pinned: row.pinned } })
        await this.complete(client, operation.id, status)
      })
      await this.deliverInternal()
      return this.current()
    })
  }
  async unpin(actor: AdminCaller, value: UpdateUnpin): Promise<UpdateStatus> {
    const input = updateUnpin.parse(value)
    const authority = await this.authorize(actor)
    return this.queue(async () => {
      await this.db.transaction(async client => {
        const { operation, claimed } = await this.operation(client, actor, authority, input.operationId, 'updates.unpin', input)
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

  /** The running `@kipster/plugins` version, or null when the host runs no plugin server or its package cannot be read. */
  get pluginsVersion(): string | null { return this.plugins?.packageVersion ?? null }
  private get highestPlugins(): string | null { return this.plugins?.highestVersion ?? null }
  /** Refuses what `installPlugins` refuses whatever the update state, so nobody is asked to approve an install that cannot start. */
  checkPluginsInstall(value: Pick<UpdatePluginsInstall, 'target'>): void {
    compareVersions(value.target, value.target)
    if (!this.managed) throw new UpdateRefusedError('update-unmanaged', 'Software installation requires a managed updater on this host')
    if (!this.plugins) throw new UpdateRefusedError('update-not-available', 'This host runs no plugin server')
    const running = this.plugins.packageVersion
    if (running !== null && compareVersions(value.target, running) === 0) throw new UpdateRefusedError('update-already-installed', `Kipster Plugins ${running} is already installed`)
    if (running !== null && compareVersions(value.target, running) < 0) throw new UpdateRefusedError('update-not-available', `Kipster Plugins ${running} runs; an older version cannot be installed`)
    const highest = this.highestPlugins
    if (highest !== null && compareVersions(value.target, highest) < 0) throw new UpdateRefusedError('update-not-available', `Kipster Plugins ${highest} already ran with this plugin data; an older version cannot be installed`)
  }
  /**
   * Starts installing the selected channel's `@kipster/plugins` release named by `target`. It returns once the install
   * is accepted, with plugins `installing`; the result arrives as an `updates-changed` event. Core keeps running.
   */
  async installPlugins(actor: AdminCaller, value: UpdatePluginsInstall): Promise<UpdateStatus> {
    const input = updatePluginsInstall.parse(value)
    compareVersions(input.target, input.target)
    const authority = await this.authorize(actor)
    if (!this.managed) throw new UpdateRefusedError('update-unmanaged', 'Software installation requires a managed updater on this host')
    if (!this.plugins) throw new UpdateRefusedError('update-not-available', 'This host runs no plugin server')
    return this.queue(async () => {
      let entry: ChannelEntry | undefined
      await this.db.transaction(async client => {
        const { operation, claimed } = await this.operation(client, actor, authority, input.operationId, 'updates.plugins_install', input)
        if (!claimed) return
        const { row, requestId } = await this.lock(client)
        const status = this.view(row), plugins = status.plugins!
        if (requestId || plugins.state === 'installing' || this.pluginInstall) throw new UpdateRefusedError('update-in-progress', 'An update is already in progress')
        this.checkPluginsInstall(input)
        if (plugins.available?.version !== input.target) throw new UpdateRefusedError('update-not-available', `Kipster Plugins ${input.target} is not the ${row.channel} channel's release; check for updates first`)
        entry = plugins.available
        plugins.state = 'installing'; plugins.error = null
        await this.save(client, row, status)
        await this.complete(client, operation.id, status)
      })
      if (entry) this.startPlugins(entry)
      return this.current()
    })
  }
  /** In automatic mode a managed host installs a newer plugins release right away, but retries a failed release only when asked. */
  private async automaticPlugins(): Promise<void> {
    if (this.stopped || !this.managed || !this.plugins || this.pluginInstall) return
    let entry: ChannelEntry | undefined
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      const status = this.view(row), plugins = status.plugins!
      if (row.mode !== 'automatic' || requestId || !plugins.available || plugins.state === 'installing') return
      if (plugins.lastResult && plugins.lastResult.outcome !== 'installed' && plugins.lastResult.to === plugins.available.version) return
      entry = plugins.available
      plugins.state = 'installing'; plugins.error = null
      await this.save(client, row, status)
    })
    if (entry) this.startPlugins(entry)
  }
  private startPlugins(entry: ChannelEntry): void {
    this.pluginInstall = this.runPlugins(entry).catch(error => this.report(error)).finally(() => { this.pluginInstall = undefined })
  }
  /** The next status that ends a plugin server start, or stopped when Core closes first. */
  private async settle(): Promise<PluginServerStatus> {
    const control = this.plugins!, signal = this.pluginAbort.signal
    if (signal.aborted) return { state: 'stopped' }
    const settled = control.settled()
    await control.restart()
    let stop!: () => void
    const stopped = new Promise<PluginServerStatus>(resolve => { stop = () => resolve({ state: 'stopped' }); signal.addEventListener('abort', stop, { once: true }) })
    try { return await Promise.race([settled, stopped]) } finally { signal.removeEventListener('abort', stop) }
  }
  /**
   * Installs the release beside the running one, points `current` at it and restarts only the plugin server. When the
   * new server does not become ready, `current` goes back and the previous version runs again, unless the new server
   * already started: then the plugin server refuses the older version and plugins stay off until a fixed release.
   */
  private async runPlugins(entry: ChannelEntry): Promise<void> {
    const control = this.plugins!, from = control.packageVersion
    const finish = async (result: Partial<PluginsUpdateStatus>) => {
      if (this.stopped) return
      await this.db.transaction(async client => {
        const { row } = await this.lock(client)
        const status = this.view(row)
        Object.assign(status.plugins!, result)
        await this.save(client, row, status)
      })
    }
    const result = (outcome: 'installed' | 'rolled-back' | 'failed') => ({ from, to: entry.version, outcome, at: this.clock().toISOString() })
    let installation: string, previous: string | null
    try {
      installation = await installRelease(control.directory, entry, this.pluginAbort.signal)
      previous = await installedPlugins(control.directory)
      await switchPlugins(control.directory, installation)
    } catch (error) {
      await finish({ state: 'failed', error: `Kipster Plugins ${entry.version} could not be installed: ${failure(error)}`, lastResult: result('failed') })
      return
    }
    let reason: string
    try {
      const started = await this.settle()
      if (started.state === 'stopped') return
      if (started.state === 'ready' && control.packageVersion === entry.version) {
        await prunePlugins(control.directory, [installation, previous]).catch(error => this.report(error))
        await finish({ state: 'idle', error: null, lastResult: result('installed') })
        return
      }
      reason = 'reason' in started ? started.reason : `the plugin server runs ${control.packageVersion ?? 'an unreadable package'}`
    } catch (error) { reason = failure(error) }
    await switchPlugins(control.directory, previous)
    const restored = await this.settle()
    if (restored.state === 'stopped') return
    await prunePlugins(control.directory, [previous]).catch(error => this.report(error))
    const after = restored.state === 'ready' ? `${control.packageVersion ?? 'the previous version'} runs again` : `plugins are off: ${'reason' in restored ? restored.reason : restored.state}`
    await finish({ state: 'failed', error: `Kipster Plugins ${entry.version} did not start (${reason}); ${after}`, lastResult: result('rolled-back') })
  }

  private async deliverInternal(): Promise<void> {
    if (this.stopped || !this.managed) return
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
        await client.query('UPDATE kipster.update_requests SET delivered=true,delivered_at=$2 WHERE id=$1', [requestId, this.clock().toISOString()])
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
    await this.readStatusInternal(startup)
    await this.expirePickupInternal()
  }
  private async expirePickupInternal(): Promise<void> {
    await this.db.transaction(async client => {
      const { row, requestId } = await this.lock(client)
      if (!requestId || row.updater_status?.requestId === requestId) return
      const pending = (await client.query<{ request: UpdaterRequest; delivered_at: Date | null }>(`SELECT request,delivered_at FROM kipster.update_requests
        WHERE installation_id=$1 AND id::text=$2 AND delivered AND NOT terminal FOR UPDATE`, [this.installationId, requestId])).rows[0]
      const now = this.clock()
      if (!pending?.delivered_at || now.getTime() - pending.delivered_at.getTime() < UPDATE_PICKUP_TIMEOUT_MS) return
      const status = this.view(row)
      status.core.state = 'failed'; status.core.step = null; status.core.error = 'The updater did not start'
      status.core.lastResult = { from: this.coreVersion, to: pending.request.target, outcome: 'failed', at: now.toISOString() }
      await client.query('UPDATE kipster.execution_permits SET update_request_id=NULL WHERE installation_id=$1', [this.installationId])
      await client.query('UPDATE kipster.update_requests SET terminal=true WHERE id=$1', [requestId])
      await this.save(client, row, status)
    })
  }
  private async readStatusInternal(startup: boolean): Promise<void> {
    let file: UpdaterStatusFile
    let restoredRequest: UpdaterRequest | undefined
    try {
      const value = await readUpdateFile(join(this.directory, 'status.json'))
      if (value === undefined) return
      file = updaterStatusFile.parse(value)
      compareVersions(file.from ?? file.to, file.to)
      for (const backup of file.backups) compareVersions(backup.coreVersion, backup.coreVersion)
      if (new Set(file.backups.map(backup => backup.id)).size !== file.backups.length) throw new TypeError('Duplicate update backup IDs')
      if (file.to === this.coreVersion && (startup || file.state !== 'running')) {
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
      if (!requestId && !recoveringRestore && row.status.core?.lastResult && Date.parse(file.updatedAt) < Date.parse(row.status.core.lastResult.at)) return
      if (!recoveringRestore && previous && (((previous.requestId === file.requestId || !requestId) && Date.parse(file.updatedAt) < Date.parse(previous.updatedAt))
        || (previous.requestId === file.requestId && previous.state !== 'running' && file.state === 'running'))) return
      const restoredSettings = file.state !== 'running' && (recoveringRestore || previous?.state === 'running') ? restoredRequest?.settings : undefined
      const changedChannel = restoredSettings !== undefined && row.channel !== restoredSettings.channel
      if (restoredSettings) { row.channel = restoredSettings.channel; row.mode = restoredSettings.mode; row.pinned = restoredSettings.pinned }
      const status = this.view(row)
      if (changedChannel) { status.checkedAt = null; status.core.available = null }
      status.core.backups = file.backups; status.core.error = file.error
      if (file.state === 'running') {
        status.core.state = 'installing'; status.core.step = file.step
        await client.query('UPDATE kipster.execution_permits SET update_request_id=$2 WHERE installation_id=$1', [this.installationId, file.requestId])
      } else {
        status.core.state = file.state === 'done' ? 'idle' : 'failed'; status.core.step = null
        // First installation has no previous version or update result. Keep the
        // public response compatible with clients that require lastResult.from.
        status.core.lastResult = file.from === null ? null : { from: file.from, to: file.to, outcome: file.state === 'done' ? 'installed' : file.state === 'rolled-back' ? 'rolled-back' : 'failed', at: file.updatedAt }
        await client.query('UPDATE kipster.execution_permits SET update_request_id=NULL WHERE installation_id=$1', [this.installationId])
        await client.query('UPDATE kipster.update_requests SET terminal=true,delivered=true WHERE installation_id=$1 AND id::text=$2', [this.installationId, file.requestId])
      }
      await client.query('UPDATE kipster.update_settings SET updater_status=$2::jsonb WHERE installation_id=$1', [this.installationId, JSON.stringify(file)])
      await this.save(client, row, status)
    })
  }
}
