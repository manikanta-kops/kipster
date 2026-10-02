import {
  compareVersions,
  parseChannelEntry,
  parseUpdateStatus,
  type ChannelEntry,
  type UpdateStatus,
} from '../data/software-update-contract.ts'
import { appProtocol, type ProtocolRange } from '../data/compatibility.ts'
import { body, fields, json, record, text, WireError } from './wire.ts'

const now = () => new Date().toISOString()
const clone = <T>(value: T): T => structuredClone(value)
export function createFakeUpdates(options: {
  emit: (
    type: string,
    data: unknown,
    resourceId: string,
    revision: number,
  ) => void
  release: () => { coreVersion: string; protocol: ProtocolRange }
  installed: (release: { coreVersion: string; protocol: ProtocolRange }) => void
  disconnect: (ms: number) => void
}) {
  const entry = (
    pkg: string,
    version: string,
    protocol = appProtocol,
    signed = true,
  ): ChannelEntry => ({
    package: pkg,
    version,
    prerelease: version.includes('-'),
    notes: `Kipster ${version}\nSmall improvements and fixes.`,
    publishedAt: '2026-10-02T09:00:00Z',
    files: [],
    ...(pkg === '@kipster/core'
      ? { protocolRange: { oldest: protocol, current: protocol } }
      : {
          protocol,
          updater: signed
            ? {
                platform: 'darwin-aarch64',
                url: `https://example.invalid/Kipster-${version}.app.tar.gz`,
                signature: 'demo-signature',
              }
            : null,
        }),
  })
  const releases = {
    schemaVersion: 1 as const,
    packages: {
      '@kipster/core': [
        entry('@kipster/core', '0.9.0-next.1', appProtocol + 1),
        entry('@kipster/core', '0.8.0'),
        entry('@kipster/core', '0.7.0'),
        entry('@kipster/core', '0.6.0'),
        entry('@kipster/core', '0.5.0'),
      ],
      '@kipster/ui': [
        entry('@kipster/ui', '0.9.0-next.1', appProtocol + 1),
        entry('@kipster/ui', '0.8.0'),
        entry('@kipster/ui', '0.7.0', Math.max(0, appProtocol - 1)),
        entry('@kipster/ui', '0.6.0', appProtocol, false),
        entry('@kipster/ui', '0.0.0'),
      ],
    },
  }
  let revision = 0
  let status: UpdateStatus
  let app: {
    version: string
    pinned: string | null
    available: ChannelEntry | null
    state: string
    checkedAt: string | null
    error: string | null
    message: string | null
  }
  let from: string
  let target: string | null
  const operations = new Map<string, { input: string; response: unknown }>()
  const installs: unknown[] = []
  function reset() {
    status = {
      version: 1,
      channel: 'stable',
      mode: 'automatic',
      checkedAt: null,
      window: { start: '02:00', end: '05:00' },
      core: {
        version: options.release().coreVersion,
        pinned: null,
        available: null,
        state: 'idle',
        step: null,
        error: null,
        lastResult: null,
        backups: [],
      },
    }
    app = {
      version: '0.0.0',
      pinned: null,
      available: null,
      state: 'idle',
      checkedAt: null,
      error: null,
      message: null,
    }
    from = status.core.version
    target = null
    operations.clear()
    installs.length = 0
  }
  reset()
  const latest = (pkg: '@kipster/core' | '@kipster/ui') =>
    releases.packages[pkg].find(
      (release) => status.channel === 'next' || !release.prerelease,
    )!
  const changed = () =>
    options.emit('updates-changed', status, 'software-updates', ++revision)
  const appChanged = () =>
    options.emit(
      'demo-app-updates-changed',
      app,
      'app-software-updates',
      ++revision,
    )
  const snapshot = () => {
    status.core.version = options.release().coreVersion
    return clone(status)
  }
  const inspect = () => ({
    status: snapshot(),
    app: clone(app),
    releases: clone(releases),
    installs: clone(installs),
  })
  function settle(
    outcome: 'installed' | 'rolled-back' | 'failed',
    version?: string,
  ) {
    const to =
      version ??
      target ??
      status.core.available?.version ??
      latest('@kipster/core').version
    if (outcome === 'installed') {
      const release = releases.packages['@kipster/core'].find(
        (entry) => entry.version === to,
      )
      options.installed({
        coreVersion: to,
        protocol: release?.protocolRange ?? options.release().protocol,
      })
      status.core.version = to
      status.core.available = null
      status.core.state = 'idle'
      status.core.error = null
    } else {
      status.core.state = outcome === 'failed' ? 'failed' : 'idle'
      status.core.error =
        outcome === 'failed'
          ? 'The update could not be installed. Try again.'
          : null
    }
    status.core.step = null
    status.core.lastResult = { from, to, outcome, at: now() }
  }
  function control(input: Record<string, unknown>) {
    const action = input.action
    if (action === 'check-app') {
      app.checkedAt = now()
      appChanged()
      return clone(app)
    }
    if (action === 'download-app') {
      const release = input.target
        ? releases.packages['@kipster/ui'].find(
            (entry) => entry.version === input.target,
          )
        : latest('@kipster/ui')
      if (!release?.updater) throw new Error('Invalid app release')
      app.available = release
      app.state = 'ready'
      app.checkedAt = now()
      app.error = null
      if (input.pin) app.pinned = release.version
      appChanged()
      return clone(app)
    }
    if (action === 'restart-app') {
      if (!app.available || app.state !== 'ready')
        throw new Error('Invalid app update state')
      app.version = app.available.version
      app.available = null
      app.state = 'idle'
      appChanged()
      return clone(app)
    }
    if (action === 'unpin-app') {
      app.pinned = null
      const release = latest('@kipster/ui')
      app.available =
        compareVersions(release.version, app.version) > 0 ? release : null
      app.state = app.available ? 'ready' : 'idle'
      app.checkedAt = now()
      app.error = null
      app.message = null
      appChanged()
      return clone(app)
    }
    if (input.channel === 'stable' || input.channel === 'next')
      status.channel = input.channel
    if (input.mode === 'automatic' || input.mode === 'notify')
      status.mode = input.mode
    if (input.state !== undefined) {
      const state = text(input.state)
      status.core.version = options.release().coreVersion
      from = status.core.version
      if (
        [
          'available',
          'scheduled',
          'checking',
          'installing',
          'disconnect',
          'failed',
          'rolled-back',
          'pinned',
        ].includes(state)
      ) {
        status.core.available = latest('@kipster/core')
        target = status.core.available.version
      }
      status.checkedAt = now()
      status.core.error = null
      status.core.lastResult = null
      status.core.step = null
      if (state === 'idle') {
        status.core.state = 'idle'
        status.core.available = null
      } else if (state === 'available') status.core.state = 'idle'
      else if (state === 'scheduled' || state === 'checking')
        status.core.state = state
      else if (state === 'installing' || state === 'disconnect') {
        status.core.state = 'installing'
        status.core.step =
          typeof input.step === 'string' ? input.step : 'Installing packages'
      } else if (state === 'pinned') {
        status.core.state = 'idle'
        status.core.pinned = status.core.version
      } else if (state === 'backups') {
        status.core.state = 'idle'
        status.core.backups = [
          { id: 'backup-0.6.0', coreVersion: '0.6.0', createdAt: now() },
        ]
      } else if (['installed', 'rolled-back', 'failed'].includes(state))
        settle(
          state as 'installed' | 'rolled-back' | 'failed',
          typeof input.target === 'string' ? input.target : undefined,
        )
      else throw new Error('Invalid update state')
    }
    if (input.core) {
      const core = record(input.core)
      status = parseUpdateStatus({
        ...status,
        core: { ...status.core, ...core },
      })
      if (typeof core.version === 'string')
        options.installed({ ...options.release(), coreVersion: core.version })
    }
    if (input.backups)
      status.core.backups = clone(
        input.backups,
      ) as UpdateStatus['core']['backups']
    if (input.app) {
      const patch = record(input.app)
      if (patch.available) parseChannelEntry(patch.available)
      app = { ...app, ...patch }
      if (
        typeof patch.state === 'string' &&
        ['ready', 'downloading', 'checking', 'failed'].includes(patch.state)
      )
        app.checkedAt = now()
      if (
        ['ready', 'downloading', 'checking', 'failed'].includes(app.state) &&
        !app.available
      )
        app.available = latest('@kipster/ui')
      appChanged()
    }
    parseUpdateStatus(status)
    changed()
    if (input.state === 'disconnect')
      options.disconnect(
        typeof input.disconnectMs === 'number' ? input.disconnectMs : 1500,
      )
    return inspect()
  }
  async function handle(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname
    if (
      path !== '/v1/settings/updates' &&
      ![
        '/v1/updates',
        '/v1/updates/check',
        '/v1/updates/install',
        '/v1/updates/unpin',
      ].includes(path)
    )
      return undefined
    if (request.method === 'GET' && path === '/v1/settings/updates')
      return json({ version: 1, channel: status.channel, mode: status.mode })
    if (request.method === 'GET' && path === '/v1/updates')
      return json(snapshot())
    const input = await body(request)
    if (request.method === 'POST' && path === '/v1/updates/check') {
      fields(input, ['version'])
      status.checkedAt = now()
      status.core.version = options.release().coreVersion
      const release = latest('@kipster/core')
      status.core.available =
        compareVersions(release.version, status.core.version) > 0
          ? release
          : null
      status.core.state =
        status.core.available &&
        !status.core.pinned &&
        status.mode === 'automatic'
          ? 'scheduled'
          : 'idle'
      changed()
      return json(snapshot())
    }
    const operationId = text(input.operationId)
    const signature = JSON.stringify({ path, method: request.method, input })
    const previous = operations.get(operationId)
    if (previous) {
      if (previous.input !== signature)
        throw new WireError(
          409,
          'conflict',
          'Operation ID was already used with different update fields',
        )
      return json(clone(previous.response))
    }
    let response: unknown
    if (request.method === 'PUT' && path === '/v1/settings/updates') {
      fields(
        input,
        ['version', 'operationId', 'channel', 'mode'],
        ['channel', 'mode'],
      )
      if (
        !['stable', 'next'].includes(String(input.channel)) ||
        !['automatic', 'notify'].includes(String(input.mode))
      )
        throw new Error('Invalid update settings')
      status.channel = input.channel as UpdateStatus['channel']
      status.mode = input.mode as UpdateStatus['mode']
      if (status.core.available) {
        const entry = latest('@kipster/core')
        status.core.available =
          compareVersions(entry.version, status.core.version) > 0 ? entry : null
      }
      changed()
      response = { version: 1, channel: status.channel, mode: status.mode }
    } else if (request.method === 'POST' && path === '/v1/updates/unpin') {
      fields(input, ['version', 'operationId'])
      status.core.pinned = null
      changed()
      response = snapshot()
    } else if (request.method === 'POST' && path === '/v1/updates/install') {
      fields(
        input,
        [
          'version',
          'operationId',
          'target',
          'pin',
          'backupId',
          'confirmDataLoss',
        ],
        ['target'],
      )
      const release = releases.packages['@kipster/core'].find(
        (entry) => entry.version === input.target,
      )
      if (!release) throw new Error('Invalid backend release')
      if (input.pin !== undefined && typeof input.pin !== 'boolean')
        throw new Error('Invalid pin')
      if (
        input.confirmDataLoss !== undefined &&
        typeof input.confirmDataLoss !== 'boolean'
      )
        throw new Error('Invalid confirmation')
      from = options.release().coreVersion
      if (
        compareVersions(release.version, from) < 0 &&
        (!input.confirmDataLoss ||
          !status.core.backups.some(
            (backup) =>
              backup.id === input.backupId &&
              backup.coreVersion === release.version,
          ))
      )
        throw new WireError(
          409,
          'confirmation-required',
          'An older backend needs a matching backup and explicit data-loss confirmation',
        )
      if (status.core.state === 'installing')
        throw new WireError(409, 'conflict', 'An update is already installing')
      target = release.version
      status.core.state = 'installing'
      status.core.step = 'Verifying release'
      status.core.available = release
      status.core.error = null
      status.core.lastResult = null
      if (input.pin) status.core.pinned = release.version
      installs.push(clone(input))
      changed()
      response = snapshot()
    } else throw new WireError(404, 'not-found', 'Route not found')
    operations.set(operationId, { input: signature, response: clone(response) })
    return json(response)
  }
  return { control, inspect, snapshot, handle, reset }
}
