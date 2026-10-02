import { array, boolean, boundedInteger, boundedString, integer, literal, nonempty, nullable, object, optional, record, string, union, utcTimestamp, type Infer, type Schema } from './schema.js'

export const updateChannel = union(literal('stable'), literal('next'))
export const updateMode = union(literal('automatic'), literal('notify'))
export type UpdateChannel = Infer<typeof updateChannel>
export type UpdateMode = Infer<typeof updateMode>

/** Response readers retain an unknown value as a neutral fallback, never as permission to act. */
function fallback<const T extends readonly string[]>(...values: T): Schema<T[number] | 'unknown'> {
  return { describe: () => union(...values.map(literal), string()).describe(), parse(value, path = '$') {
    const parsed = string().parse(value, path)
    return values.includes(parsed) ? parsed as T[number] : 'unknown'
  } }
}
function preserve<T extends object>(schema: Schema<T>): Schema<T & Record<string, unknown>> {
  return { describe: () => schema.describe(), parse: (value, path) => ({ ...record().parse(value, path), ...schema.parse(value, path) }) }
}

export const channelFileAsset = preserve(object({ name: nonempty(), url: nonempty(), size: integer(), sha256: nonempty() }, false))
/** Channel entries, including additive metadata, pass through to clients unchanged. */
export const channelEntry = preserve(object({
  package: nonempty(), version: nonempty(), prerelease: boolean(), notes: string(), publishedAt: utcTimestamp(),
  files: array(channelFileAsset), protocolRange: optional(preserve(object({ current: boundedInteger(1, 1000000), oldest: boundedInteger(1, 1000000) }, false))),
}, false))
export type ChannelEntry = Infer<typeof channelEntry>
export const updateBackup = object({ id: nonempty(), coreVersion: nonempty(), createdAt: utcTimestamp() }, false)
export type UpdateBackup = Infer<typeof updateBackup>
export const updateSettings = object({ version: literal(1), channel: fallback('stable', 'next'), mode: fallback('automatic', 'notify') }, false)
export const updateSettingsWrite = object({ version: literal(1), operationId: boundedString(1, 200), channel: updateChannel, mode: updateMode })
export type UpdateSettingsWrite = Infer<typeof updateSettingsWrite>
export const updateCheck = object({ version: literal(1) })
export const updateInstall = object({ version: literal(1), operationId: boundedString(1, 200), target: boundedString(1, 200), pin: optional(boolean()), backupId: optional(nonempty()), confirmDataLoss: optional(boolean()) })
export type UpdateInstall = Infer<typeof updateInstall>
export const updateUnpin = object({ version: literal(1), operationId: boundedString(1, 200) })
export type UpdateUnpin = Infer<typeof updateUnpin>
export const updateStatus = object({
  version: literal(1), channel: fallback('stable', 'next'), mode: fallback('automatic', 'notify'), checkedAt: nullable(utcTimestamp()),
  window: object({ start: literal('02:00'), end: literal('05:00') }, false),
  core: object({
    version: nonempty(), pinned: nullable(nonempty()), available: nullable(channelEntry),
    state: fallback('idle', 'checking', 'scheduled', 'installing', 'failed'), step: nullable(string()), error: nullable(string()),
    lastResult: nullable(object({ from: nonempty(), to: nonempty(), outcome: fallback('installed', 'rolled-back', 'failed'), at: utcTimestamp() }, false)),
    backups: array(updateBackup),
  }, false),
}, false)
export type UpdateStatus = Infer<typeof updateStatus>

/** Core writes this outbox payload; the updater independently verifies the requested release. */
export const updaterRequest = object({
  version: literal(1), id: nonempty(), action: union(literal('install'), literal('restore')), target: nonempty(), backupId: optional(nonempty()),
  reason: union(literal('manual'), literal('automatic')), requestedAt: utcTimestamp(),
})
export type UpdaterRequest = Infer<typeof updaterRequest>
/** An unrecognized updater state is refused so Core cannot accidentally resume execution. */
export const updaterStatusFile = object({
  version: literal(1), requestId: nonempty(), state: union(literal('running'), literal('done'), literal('failed'), literal('rolled-back')),
  step: nullable(union(literal('downloading'), literal('verifying'), literal('backing-up'), literal('installing'), literal('migrating'), literal('restarting'), literal('checking'), literal('restoring'))),
  from: nonempty(), to: nonempty(), error: nullable(string()), updatedAt: utcTimestamp(), backups: array(updateBackup),
}, false)
export type UpdaterStatusFile = Infer<typeof updaterStatusFile>
