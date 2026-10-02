import { check, record } from './response.ts'
import { isProtocolRange, type ProtocolRange } from './compatibility.ts'

// Shared with Core's update API. Keep these wire shapes unchanged until Core exports them.
export type UpdateChannel = 'stable' | 'next'
export type UpdateMode = 'automatic' | 'notify'
export type UpdateSettings = {
  version: 1
  channel: UpdateChannel
  mode: UpdateMode
}
export type ChannelEntry = {
  package: string
  version: string
  prerelease: boolean
  notes: string
  publishedAt: string
  files: { name: string; url: string; size: number; sha256: string }[]
  protocolRange?: ProtocolRange
  protocol?: number
  updater?: { platform: string; url: string; signature: string } | null
}
export type UpdateStatus = UpdateSettings & {
  checkedAt: string | null
  window: { start: '02:00'; end: '05:00' }
  core: {
    version: string
    pinned: string | null
    available: ChannelEntry | null
    state: 'idle' | 'checking' | 'scheduled' | 'installing' | 'failed'
    step: string | null
    error: string | null
    lastResult: {
      from: string
      to: string
      outcome: 'installed' | 'rolled-back' | 'failed'
      at: string
    } | null
    backups: { id: string; coreVersion: string; createdAt: string }[]
  }
}
export type InstallUpdate = {
  version: 1
  operationId: string
  target: string
  pin?: boolean
  backupId?: string
  confirmDataLoss?: boolean
}
export type ReleaseCatalog = {
  schemaVersion: 1
  packages: Record<string, ChannelEntry[]>
}
export const updateRoot = 'https://updates.kipster.app/v1/'

function semver(value: string) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    )
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part)))
    throw new Error('Invalid release version')
  return { numbers: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') }
}

/** Semver precedence, including numeric prereleases and ignored build metadata. */
export function compareVersions(left: string, right: string): number {
  const a = semver(left),
    b = semver(right)
  for (let i = 0; i < 3; i++)
    if (a.numbers[i] !== b.numbers[i])
      return a.numbers[i] > b.numbers[i] ? 1 : -1
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function appUpdateEndpoint(
  channel: UpdateChannel,
  pinned: string | null,
): string {
  if (pinned) semver(pinned)
  if (channel !== 'stable' && channel !== 'next')
    throw new Error('Unknown update channel')
  return `${updateRoot}app/${encodeURIComponent(pinned ?? channel)}.json`
}

export function acceptsAppUpdate(
  current: string,
  target: string,
  pin: string | null,
): boolean {
  const order = compareVersions(target, current)
  return pin ? target === pin && order !== 0 : order > 0
}

export function parseChannelEntry(value: unknown): ChannelEntry {
  check(
    record(value) &&
      typeof value.package === 'string' &&
      typeof value.version === 'string' &&
      typeof value.prerelease === 'boolean' &&
      typeof value.notes === 'string' &&
      typeof value.publishedAt === 'string' &&
      Array.isArray(value.files),
  )
  semver(value.version)
  for (const file of value.files)
    check(
      record(file) &&
        typeof file.name === 'string' &&
        typeof file.url === 'string' &&
        typeof file.size === 'number' &&
        typeof file.sha256 === 'string',
    )
  check(
    value.protocolRange === undefined || isProtocolRange(value.protocolRange),
  )
  check(
    value.protocol === undefined ||
      (Number.isSafeInteger(value.protocol) && (value.protocol as number) >= 0),
  )
  check(
    value.updater === undefined ||
      value.updater === null ||
      (record(value.updater) &&
        typeof value.updater.platform === 'string' &&
        typeof value.updater.url === 'string' &&
        typeof value.updater.signature === 'string'),
  )
  return value as ChannelEntry
}

const nullableText = (value: unknown) =>
  value === null || typeof value === 'string'
export function parseUpdateSettings(value: unknown): UpdateSettings {
  check(
    record(value) &&
      value.version === 1 &&
      typeof value.channel === 'string' &&
      typeof value.mode === 'string',
  )
  return value as UpdateSettings
}
export function knownUpdateSettings(value: UpdateSettings): boolean {
  return (
    ['stable', 'next'].includes(value.channel) &&
    ['automatic', 'notify'].includes(value.mode)
  )
}
export function parseUpdateStatus(value: unknown): UpdateStatus {
  parseUpdateSettings(value)
  check(
    record(value) &&
      nullableText(value.checkedAt) &&
      record(value.window) &&
      typeof value.window.start === 'string' &&
      typeof value.window.end === 'string' &&
      record(value.core),
  )
  const core = value.core
  check(
    typeof core.version === 'string' &&
      nullableText(core.pinned) &&
      typeof core.state === 'string' &&
      nullableText(core.step) &&
      nullableText(core.error) &&
      Array.isArray(core.backups),
  )
  if (core.available !== null) parseChannelEntry(core.available)
  if (core.lastResult !== null) {
    const result = core.lastResult
    check(
      record(result) &&
        typeof result.from === 'string' &&
        typeof result.to === 'string' &&
        typeof result.outcome === 'string' &&
        typeof result.at === 'string',
    )
  }
  for (const backup of core.backups)
    check(
      record(backup) &&
        typeof backup.id === 'string' &&
        typeof backup.coreVersion === 'string' &&
        typeof backup.createdAt === 'string',
    )
  return value as UpdateStatus
}

export function parseReleaseCatalog(value: unknown): ReleaseCatalog {
  check(record(value) && value.schemaVersion === 1 && record(value.packages))
  const packages: ReleaseCatalog['packages'] = {}
  for (const [name, entries] of Object.entries(value.packages)) {
    check(Array.isArray(entries))
    packages[name] = entries
      .map(parseChannelEntry)
      .filter((entry) => entry.package === name)
      .sort((a, b) => compareVersions(b.version, a.version))
  }
  return { schemaVersion: 1, packages }
}
