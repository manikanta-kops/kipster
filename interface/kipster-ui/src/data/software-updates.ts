import { useSyncExternalStore } from 'react'
import {
  updateCheck,
  updateInstall,
  updateSettingsWrite,
  updateUnpin,
} from '@kipster/core/protocol'
import { appVersion } from '../app/version.ts'
import {
  nativeSoftwareUpdater,
  type DownloadedAppUpdate,
  type SoftwareUpdater,
} from '../platform/software-updater.ts'
import {
  appProtocol,
  compatibility,
  type ProtocolRange,
} from './compatibility.ts'
import { TextHttpError, record } from './response.ts'
import {
  acceptsAppUpdate,
  appUpdateEndpoint,
  compareVersions,
  knownUpdateSettings,
  parseReleaseCatalog,
  parseUpdateSettings,
  parseUpdateStatus,
  updateRoot,
  type ChannelEntry,
  type InstallUpdate,
  type ReleaseCatalog,
  type UpdateSettings,
  type UpdateStatus,
} from './software-update-contract.ts'

export type AppSoftwareUpdate = {
  version: string
  pinned: string | null
  available: ChannelEntry | null
  state:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'failed'
    | 'unavailable'
  checkedAt: string | null
  error: string | null
  message: string | null
}
export type SoftwareUpdateSnapshot = {
  settings: UpdateSettings
  status: UpdateStatus | null
  app: AppSoftwareUpdate
  releases: ReleaseCatalog | null
  protocol: ProtocolRange | null
  backendUnsupported: boolean
  reconnecting: boolean
  busy: boolean
  error: string | null
}
const pinKey = 'kipster-app-update-pin'
const hours12 = 12 * 60 * 60 * 1000
export const manualBackendUpdateInstructions =
  'This backend is updated manually. On its host, install a compatible Core release and restart the service, then check again.'
const errorText = (error: unknown) =>
  error instanceof TextHttpError && error.code === 'update-unmanaged'
    ? `${manualBackendUpdateInstructions} ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)

export class SoftwareUpdatesClient {
  readonly endpoint: string
  constructor(endpoint: string) {
    this.endpoint = endpoint
  }
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(this.endpoint + path, {
      method,
      cache: 'no-store',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const value = await response.json().catch(() => ({}))
      throw new TextHttpError(
        value.message ?? 'Updates are unavailable. Try again.',
        response.status === 404 ? 'not-found' : (value.code ?? 'unavailable'),
      )
    }
    return response.json()
  }
  async status(signal?: AbortSignal) {
    return parseUpdateStatus(
      await this.request('/v1/updates', 'GET', undefined, signal),
    )
  }
  async settings(signal?: AbortSignal) {
    return parseUpdateSettings(
      await this.request('/v1/settings/updates', 'GET', undefined, signal),
    )
  }
  async save(settings: UpdateSettings) {
    return parseUpdateSettings(
      await this.request(
        '/v1/settings/updates',
        'PUT',
        updateSettingsWrite.parse({
          ...settings,
          operationId: crypto.randomUUID(),
        }),
      ),
    )
  }
  async check() {
    return parseUpdateStatus(
      await this.request(
        '/v1/updates/check',
        'POST',
        updateCheck.parse({ version: 1 }),
      ),
    )
  }
  async install(input: Omit<InstallUpdate, 'version' | 'operationId'>) {
    return parseUpdateStatus(
      await this.request(
        '/v1/updates/install',
        'POST',
        updateInstall.parse({
          version: 1,
          operationId: crypto.randomUUID(),
          ...input,
        }),
      ),
    )
  }
  async unpin() {
    return parseUpdateStatus(
      await this.request(
        '/v1/updates/unpin',
        'POST',
        updateUnpin.parse({
          version: 1,
          operationId: crypto.randomUUID(),
        }),
      ),
    )
  }
}

/** One workspace-owned software updater; the app's conversation change feed is separate. */
export class SoftwareUpdates {
  readonly client: SoftwareUpdatesClient
  private listeners = new Set<() => void>()
  private downloaded: DownloadedAppUpdate | null = null
  private generation = 0
  private active = false
  private polling: ReturnType<typeof setTimeout> | undefined
  private quitOff: (() => void) | undefined
  private native: SoftwareUpdater | null
  private policyKey: string
  private value: SoftwareUpdateSnapshot
  private appChecking: Promise<void> | null = null

  constructor(
    endpoint: string,
    native: SoftwareUpdater | null = nativeSoftwareUpdater(),
  ) {
    this.client = new SoftwareUpdatesClient(endpoint)
    this.native = native
    this.policyKey = `kipster-update-policy:${endpoint}`
    let settings: UpdateSettings = {
      version: 1,
      channel: 'stable',
      mode: 'automatic',
    }
    let pinned: string | null = null
    try {
      const saved = localStorage.getItem(this.policyKey)
      if (saved) {
        const parsed = parseUpdateSettings(JSON.parse(saved))
        if (knownUpdateSettings(parsed)) settings = parsed
      }
      pinned = localStorage.getItem(pinKey)
      if (pinned) compareVersions(pinned, pinned)
    } catch {
      pinned = null
    }
    this.value = {
      settings,
      status: null,
      protocol: null,
      releases: null,
      backendUnsupported: false,
      reconnecting: false,
      busy: false,
      error: null,
      app: {
        version: appVersion,
        pinned,
        available: null,
        state: 'idle',
        checkedAt: null,
        error: null,
        message: null,
      },
    }
  }
  snapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private patch(patch: Partial<SoftwareUpdateSnapshot>) {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private patchApp(patch: Partial<AppSoftwareUpdate>) {
    this.patch({ app: { ...this.value.app, ...patch } })
  }
  private cacheSettings(settings: UpdateSettings) {
    this.patch({ settings })
    if (!knownUpdateSettings(settings)) return
    try {
      localStorage.setItem(this.policyKey, JSON.stringify(settings))
    } catch {
      this.patch({
        error: 'Update preferences could not be cached on this device.',
      })
    }
  }
  setBootstrap(versions: { coreVersion: string; protocol: ProtocolRange }) {
    this.patch({ protocol: versions.protocol })
    this.armInBackground()
  }
  acceptStatus(raw: unknown) {
    try {
      const status = parseUpdateStatus(raw)
      const previous = this.value.settings
      if (previous.channel !== status.channel) this.invalidateApp()
      this.cacheSettings({
        version: 1,
        channel: status.channel,
        mode: status.mode,
      })
      this.patch({
        status,
        backendUnsupported: false,
        reconnecting:
          status.core.managed &&
          status.core.state === 'installing' &&
          this.value.reconnecting,
      })
      if (previous.channel !== status.channel)
        void this.recheckApp().catch((error) => this.appFailure(error))
      this.armInBackground()
      if (
        (status.core.managed && status.core.state === 'installing') ||
        status.core.state === 'checking'
      )
        this.poll()
    } catch (error) {
      this.patch({ error: errorText(error) })
    }
  }
  acceptDemoApp(raw: unknown) {
    if (__KIPSTER_DEMO__ && record(raw)) {
      this.patchApp({
        ...(raw as Partial<AppSoftwareUpdate>),
        pinned: this.value.app.pinned,
      })
    }
  }
  async refresh(signal?: AbortSignal) {
    try {
      const status = await this.client.status(signal)
      if (signal?.aborted) return
      this.patch({ error: null })
      this.acceptStatus(status)
      if (__KIPSTER_DEMO__) {
        const demo = await this.client.request(
          '/__demo/updates',
          'GET',
          undefined,
          signal,
        )
        if (record(demo)) {
          this.acceptDemoApp(demo.app)
          this.patch({ releases: parseReleaseCatalog(demo.releases) })
        }
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof TextHttpError && error.code === 'not-found')
        this.patch({ backendUnsupported: true })
      else if (
        this.value.status?.core.managed &&
        this.value.status.core.state === 'installing'
      )
        this.patch({ reconnecting: true })
      else this.patch({ error: errorText(error) })
    }
  }
  start() {
    this.active = true
    const abort = new AbortController()
    void (async () => {
      await this.refresh(abort.signal)
      if (abort.signal.aborted) return
      if (this.native) {
        const off = await this.native.onQuit(() => this.installApp(false))
        if (abort.signal.aborted) {
          off()
          return
        }
        this.quitOff = off
      }
      await this.checkApp()
    })().catch((error) => {
      if (!abort.signal.aborted)
        this.patchApp({ state: 'failed', error: errorText(error) })
    })
    const timer = setInterval(() => {
      void this.checkApp().catch((error) => this.appFailure(error))
    }, hours12)
    return () => {
      this.active = false
      abort.abort()
      clearInterval(timer)
      clearTimeout(this.polling)
      this.quitOff?.()
      this.invalidateApp()
    }
  }
  connectionLost() {
    if (
      this.value.status?.core.managed &&
      this.value.status.core.state === 'installing'
    )
      this.patch({ reconnecting: true })
  }
  connectionRestored() {
    void this.refresh()
  }
  private poll() {
    clearTimeout(this.polling)
    if (this.active)
      this.polling = setTimeout(() => {
        void this.refresh().then(() => {
          if (this.value.reconnecting) this.poll()
        })
      }, 1500)
  }
  async run(action: () => Promise<void>) {
    if (this.value.busy) return
    this.patch({ busy: true, error: null })
    try {
      await action()
    } catch (error) {
      this.patch({ error: errorText(error) })
    } finally {
      this.patch({ busy: false })
    }
  }
  async saveSettings(settings: UpdateSettings) {
    const previous = this.value.settings
    const saved = await this.client.save(settings)
    if (previous.channel !== saved.channel) this.invalidateApp()
    this.cacheSettings(saved)
    await this.refresh()
    if (previous.channel !== settings.channel) await this.recheckApp()
    await this.arm()
  }
  async checkNow() {
    const results = await Promise.allSettled([
      this.value.backendUnsupported
        ? Promise.resolve()
        : this.client.check().then((status) => this.acceptStatus(status)),
      __KIPSTER_DEMO__
        ? this.client
            .request('/__demo/updates', 'POST', { action: 'check-app' })
            .then((app) => this.acceptDemoApp(app))
        : this.checkApp(),
    ])
    for (const result of results)
      if (result.status === 'rejected') throw result.reason
  }
  async installBackend(input: Omit<InstallUpdate, 'version' | 'operationId'>) {
    const previous = this.value.status
    if (previous?.core.managed === false)
      throw new TextHttpError(
        'Software installation requires a managed updater on this host',
        'update-unmanaged',
      )
    if (previous)
      this.patch({
        status: {
          ...previous,
          core: {
            ...previous.core,
            state: 'installing',
            step: 'Starting update',
            error: null,
          },
        },
      })
    await this.arm()
    try {
      this.acceptStatus(await this.client.install(input))
    } catch (error) {
      // A restart may close the accepted install's response. Query authoritative state.
      if (error instanceof TextHttpError && error.code !== 'unavailable') {
        this.patch({ status: previous, reconnecting: false })
        if (error.code === 'update-unmanaged') await this.refresh()
        await this.arm()
        throw error
      }
      this.patch({ reconnecting: true })
    }
    this.poll()
  }
  async unpinBackend() {
    this.acceptStatus(await this.client.unpin())
    await this.arm()
  }
  private savePin(value: string | null) {
    if (value) {
      compareVersions(value, value)
      localStorage.setItem(pinKey, value)
    } else localStorage.removeItem(pinKey)
    this.patchApp({ pinned: value })
  }
  async unpinApp() {
    this.savePin(null)
    this.invalidateApp()
    if (__KIPSTER_DEMO__)
      this.acceptDemoApp(
        await this.client.request('/__demo/updates', 'POST', {
          action: 'unpin-app',
        }),
      )
    else await this.recheckApp()
  }
  async loadReleases() {
    if (__KIPSTER_DEMO__) {
      await this.refresh()
      return
    }
    const response = await fetch(updateRoot + 'releases.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok)
      throw new Error('Release history is unavailable. Try again.')
    this.patch({ releases: parseReleaseCatalog(await response.json()) })
  }
  checkApp(): Promise<void> {
    if (this.appChecking) return this.appChecking
    this.appChecking = this.performAppCheck().finally(() => {
      this.appChecking = null
    })
    return this.appChecking
  }
  private invalidateApp() {
    ++this.generation
    void this.downloaded?.close().catch(() => {})
    this.downloaded = null
    this.patchApp({ state: 'idle', available: null, error: null })
    void this.native?.arm(false, false).catch((error) => this.appFailure(error))
  }
  private async recheckApp() {
    await this.appChecking
    await this.checkApp()
  }
  private async performAppCheck() {
    if (__KIPSTER_DEMO__) return
    if (!this.native || !(await this.native.available())) {
      this.patchApp({
        state: 'unavailable',
        message: 'Updates are not available in this build',
      })
      return
    }
    if (!knownUpdateSettings(this.value.settings)) {
      this.patchApp({
        state: 'unavailable',
        message: 'This app does not support the backend’s update policy.',
      })
      return
    }
    const generation = ++this.generation
    const { channel } = this.value.settings,
      { pinned } = this.value.app
    this.patchApp({ state: 'checking', error: null, message: null })
    let update: DownloadedAppUpdate | null = null
    try {
      await this.loadReleases()
      if (generation !== this.generation) return
      const candidates =
        this.value.releases?.packages['@kipster/ui']?.filter(
          (entry) =>
            entry.updater?.platform === 'darwin-aarch64' &&
            (pinned
              ? entry.version === pinned
              : channel === 'next' || !entry.prerelease),
        ) ?? []
      if (!candidates.length) {
        this.patchApp({
          state: 'idle',
          available: null,
          checkedAt: new Date().toISOString(),
          message: 'No signed app releases are available on this channel yet.',
        })
        await this.native.arm(false, false)
        return
      }
      update = await this.native.check(appUpdateEndpoint(channel, pinned))
      if (generation !== this.generation) {
        await update?.close()
        return
      }
      const checkedAt = new Date().toISOString()
      if (
        !update ||
        !acceptsAppUpdate(this.value.app.version, update.version, pinned)
      ) {
        await update?.close()
        await this.downloaded?.close()
        this.downloaded = null
        this.patchApp({ state: 'idle', available: null, checkedAt })
        await this.native.arm(false, false)
        return
      }
      const entry = this.value.releases?.packages['@kipster/ui']?.find(
        (entry) =>
          entry.version === update!.version &&
          entry.updater?.platform === 'darwin-aarch64',
      )
      if (!entry || entry.protocol === undefined)
        throw new Error(
          'The signed app’s release details are unavailable. Check again before installing.',
        )
      if (this.downloaded?.version === update.version) {
        await update.close()
        this.patchApp({ state: 'ready', available: entry, checkedAt })
        await this.arm()
        return
      }
      await this.downloaded?.close()
      this.downloaded = null
      await this.native.arm(false, false)
      this.patchApp({ state: 'downloading', available: entry, checkedAt })
      await update.download()
      if (generation !== this.generation) {
        await update.close()
        return
      }
      this.downloaded = update
      this.patchApp({ state: 'ready' })
      await this.arm()
    } catch (error) {
      await update?.close().catch(() => {})
      if (generation === this.generation) {
        await this.native.arm(false, false).catch(() => {})
        this.patchApp({ state: 'failed', error: errorText(error) })
      }
    }
  }
  async chooseAppVersion(version: string) {
    this.savePin(version)
    this.invalidateApp()
    if (__KIPSTER_DEMO__)
      this.acceptDemoApp(
        await this.client.request('/__demo/updates', 'POST', {
          action: 'download-app',
          target: version,
          pin: true,
        }),
      )
    else await this.recheckApp()
  }
  async updateApp() {
    if (backendMustUpdateFirst(this.value))
      throw new Error('Update the backend first, then update this app.')
    if (__KIPSTER_DEMO__)
      this.acceptDemoApp(
        await this.client.request('/__demo/updates', 'POST', {
          action: 'download-app',
        }),
      )
    else if (this.value.app.state !== 'ready') await this.checkApp()
    else await this.installApp(true)
  }
  private async arm() {
    const { app, settings, protocol } = this.value
    const compatible =
      app.available?.protocol !== undefined &&
      !!protocol &&
      compatibility(protocol, app.available.protocol) === 'compatible'
    await this.native?.arm(
      app.state === 'ready',
      settings.mode === 'automatic' &&
        compatible &&
        !backendMustUpdateFirst(this.value),
    )
  }
  private appFailure(error: unknown) {
    this.patchApp({ state: 'failed', error: errorText(error) })
  }
  private armInBackground() {
    void this.arm().catch((error) => this.appFailure(error))
  }
  async installApp(restart: boolean) {
    if (backendMustUpdateFirst(this.value)) {
      await this.native?.finish(false)
      return
    }
    if (__KIPSTER_DEMO__) {
      this.acceptDemoApp(
        await this.client.request('/__demo/updates', 'POST', {
          action: 'restart-app',
        }),
      )
      return
    }
    this.patchApp({ state: 'installing', error: null })
    try {
      if (!this.downloaded || !this.native)
        throw new Error('Check for an app update first.')
      await this.downloaded.install()
      await this.native.finish(restart)
    } catch (error) {
      this.appFailure(error)
      await this.native?.arm(false, false).catch(() => {})
      if (!restart) await this.native?.finish(false)
      else throw error
    }
  }
}

export function backendMustUpdateFirst(value: SoftwareUpdateSnapshot): boolean {
  const core = value.status?.core
  if (core?.managed === false) return false
  if (value.reconnecting || core?.state === 'installing') return true
  if (!core?.available) return false
  try {
    return compareVersions(core.available.version, core.version) > 0
  } catch {
    return false
  }
}
export function softwareUpdatePill(value: SoftwareUpdateSnapshot): {
  label: string
  state: 'thinking' | 'failed' | 'recovery' | 'done' | 'queued'
} | null {
  const core = value.status?.core.managed ? value.status.core : undefined
  if (core && (value.reconnecting || core.state === 'installing'))
    return { label: 'Updating backend', state: 'thinking' }
  if (
    core?.state === 'failed' ||
    core?.lastResult?.outcome === 'failed' ||
    value.app.state === 'failed'
  )
    return { label: 'Update failed', state: 'failed' }
  if (core?.lastResult?.outcome === 'rolled-back')
    return { label: 'Update rolled back', state: 'recovery' }
  if (backendMustUpdateFirst(value))
    return { label: 'Backend update available', state: 'queued' }
  if (value.app.state === 'ready')
    return { label: 'Restart to update', state: 'done' }
  return null
}
export function useSoftwareUpdates(updates: SoftwareUpdates) {
  return useSyncExternalStore(
    updates.subscribe,
    updates.snapshot,
    updates.snapshot,
  )
}
export { appProtocol }
