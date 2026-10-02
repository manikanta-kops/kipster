import {
  channelEntry,
  updateSettings,
  updateStatus,
  type ChannelEntry as CoreChannelEntry,
  type UpdateChannel,
  type UpdateMode,
  type UpdateStatus,
} from '@kipster/core/protocol'
import { check, incompatible, record } from './response.ts'
import { isProtocolRange } from './compatibility.ts'

export type {
  UpdateChannel,
  UpdateMode,
  UpdateInstall as InstallUpdate,
  UpdateStatus,
} from '@kipster/core/protocol'
export type UpdateSettings = ReturnType<typeof updateSettings.parse>
/** App catalog metadata is additive to Core's shared channel entry. */
export type ChannelEntry = CoreChannelEntry & {
  protocol?: number
  updater?: { platform: string; url: string; signature: string } | null
}
export type ReleaseCatalog = {
  schemaVersion: 1
  packages: Record<string, ChannelEntry[]>
}
export const updateRoot = 'https://updates.kipster.app/v1/'

function parseResponse<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value)
  } catch (error) {
    if (error instanceof TypeError) incompatible()
    throw error
  }
}

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
  const parsed = parseResponse(channelEntry, value)
  semver(parsed.version)
  check(
    parsed.protocolRange === undefined || isProtocolRange(parsed.protocolRange),
  )
  check(
    parsed.protocol === undefined ||
      (Number.isSafeInteger(parsed.protocol) &&
        (parsed.protocol as number) >= 0),
  )
  check(
    parsed.updater === undefined ||
      parsed.updater === null ||
      (record(parsed.updater) &&
        typeof parsed.updater.platform === 'string' &&
        typeof parsed.updater.url === 'string' &&
        typeof parsed.updater.signature === 'string'),
  )
  return parsed as ChannelEntry
}

export function parseUpdateSettings(value: unknown): UpdateSettings {
  return parseResponse(updateSettings, value)
}
export function knownUpdateSettings(
  value: UpdateSettings,
): value is UpdateSettings & { channel: UpdateChannel; mode: UpdateMode } {
  return (
    ['stable', 'next'].includes(value.channel) &&
    ['automatic', 'notify'].includes(value.mode)
  )
}
export function parseUpdateStatus(value: unknown): UpdateStatus {
  return parseResponse(updateStatus, value)
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
