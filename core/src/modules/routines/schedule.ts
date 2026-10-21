/** Time triggers of a routine and when they next fire. Times are wall-clock times in the routine's time zone. */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type Trigger =
  | { type: 'once'; at: string }
  | { type: 'every'; minutes: number; from?: string; until?: string; days?: Weekday[] }
  | { type: 'times'; times: string[]; days?: Weekday[] }

export const MAX_TRIGGERS = 10
const clock = /^([01]\d|2[0-3]):([0-5]\d)$/
const localDateTime = /^(\d{4})-(\d\d)-(\d\d)T([01]\d|2[0-3]):([0-5]\d)$/

const fail = (message: string): never => { throw new TypeError(message) }
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

function days(value: unknown, at: string): Weekday[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.some(day => !WEEKDAYS.includes(day as Weekday)) || new Set(value).size !== value.length) fail(`${at}.days must list distinct weekdays: ${WEEKDAYS.join(', ')}`)
  return (value as Weekday[]).slice()
}
function time(value: unknown, at: string): string {
  return typeof value === 'string' && clock.test(value) ? value : fail(`${at} must be a 24-hour time such as "07:15"`)
}

/** Checks triggers as a kip or the person sends them. A `once` trigger must be after `now`. */
export function parseTriggers(value: unknown, timeZone: string, now: Date): Trigger[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TRIGGERS) fail(`triggers must list 1 to ${MAX_TRIGGERS} triggers`)
  return (value as unknown[]).map((item, index): Trigger => {
    const at = `triggers[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(`${at} must be an object`)
    const source = item as Record<string, unknown>
    const allowed = (keys: string[]) => { for (const key of Object.keys(source)) if (key !== 'type' && !keys.includes(key)) fail(`${at}.${key} is not a field of a ${String(source.type)} trigger`) }
    if (source.type === 'once') {
      allowed(['at'])
      const match = typeof source.at === 'string' ? localDateTime.exec(source.at) : null
      if (!match) fail(`${at}.at must be a local date and time such as "2026-10-22T15:00"`)
      const [, y, mo, d, h, mi] = match!.map(Number) as number[]
      if (new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDate() !== d) fail(`${at}.at is not a real date`)
      if (instant(y!, mo!, d!, h! * 60 + mi!, timeZone) <= now.getTime()) fail(`${at}.at is not in the future`)
      return { type: 'once', at: source.at as string }
    }
    if (source.type === 'every') {
      allowed(['minutes', 'from', 'until', 'days'])
      if (!Number.isSafeInteger(source.minutes) || (source.minutes as number) < 1 || (source.minutes as number) > 1440) fail(`${at}.minutes must be a whole number from 1 to 1440`)
      const from = source.from === undefined ? undefined : time(source.from, `${at}.from`)
      const until = source.until === undefined ? undefined : time(source.until, `${at}.until`)
      if (from !== undefined && until !== undefined && minutesOf(until) <= minutesOf(from)) fail(`${at}.until must be later than from`)
      const weekdays = days(source.days, at)
      return { type: 'every', minutes: source.minutes as number, ...(from ? { from } : {}), ...(until ? { until } : {}), ...(weekdays ? { days: weekdays } : {}) }
    }
    if (source.type === 'times') {
      allowed(['times', 'days'])
      if (!Array.isArray(source.times) || !source.times.length || source.times.length > 48) fail(`${at}.times must list 1 to 48 times`)
      const times = (source.times as unknown[]).map((item, position) => time(item, `${at}.times[${position}]`))
      if (new Set(times).size !== times.length) fail(`${at}.times must not repeat a time`)
      const weekdays = days(source.days, at)
      return { type: 'times', times: times.sort(), ...(weekdays ? { days: weekdays } : {}) }
    }
    return fail(`${at}.type must be once, every or times`)
  })
}

export function validTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone || zone.length > 100) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}
/** The time zone of the computer Core runs on. */
export const hostTimeZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const formats = new Map<string, Intl.DateTimeFormat>()
/** The wall-clock date and time at `ms` in `zone`. */
function wall(ms: number, zone: string): { y: number; mo: number; d: number; minute: number; second: number } {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(zone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map(part => [part.type, part.value]))
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), minute: Number(parts.hour) * 60 + Number(parts.minute), second: Number(parts.second) }
}
/** How far `zone` is ahead of UTC at `ms`. */
function offset(ms: number, zone: string): number {
  const whole = Math.floor(ms / 1000) * 1000
  const local = wall(whole, zone)
  return Date.UTC(local.y, local.mo - 1, local.d, 0, local.minute, local.second) - whole
}
/**
 * The instant a wall-clock time happens in `zone`. A time skipped by a daylight-saving change moves forward by the
 * change; a time that happens twice is its first occurrence.
 */
function instant(y: number, mo: number, d: number, minute: number, zone: string): number {
  const local = Date.UTC(y, mo - 1, d, 0, minute)
  const early = local - offset(local - 86400000 / 2, zone), late = local - offset(local + 86400000 / 2, zone)
  const candidates = [early, late].filter(t => offset(t, zone) === local - t).sort((a, b) => a - b)
  return candidates[0] ?? Math.max(early, late)
}

/** The wall-clock minutes of a day on which a trigger fires. */
function minutesOn(trigger: Exclude<Trigger, { type: 'once' }>, weekday: Weekday): number[] {
  if (trigger.days && !trigger.days.includes(weekday)) return []
  if (trigger.type === 'times') return trigger.times.map(minutesOf)
  const from = trigger.from ? minutesOf(trigger.from) : 0, until = trigger.until ? minutesOf(trigger.until) : 1439
  const result: number[] = []
  for (let minute = from; minute <= until; minute += trigger.minutes) result.push(minute)
  return result
}

/** The first time after `after` at which any trigger fires, or null when none fires again. */
export function nextRunAfter(triggers: readonly Trigger[], zone: string, after: Date): Date | null {
  const limit = after.getTime()
  let best: number | null = null
  const consider = (t: number) => { if (t > limit && (best === null || t < best)) best = t }
  const start = wall(limit, zone)
  for (const trigger of triggers) {
    if (trigger.type === 'once') {
      const [, y, mo, d, h, mi] = localDateTime.exec(trigger.at)!.map(Number) as number[]
      consider(instant(y!, mo!, d!, h! * 60 + mi!, zone))
      continue
    }
    // A week and a day covers every weekday after the starting day, which may have no time left.
    for (let offsetDays = 0; offsetDays <= 8; offsetDays++) {
      const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + offsetDays))
      const found = minutesOn(trigger, WEEKDAYS[day.getUTCDay()]!).map(minute => instant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), minute, zone)).find(t => t > limit)
      if (found !== undefined) { consider(found); break }
    }
  }
  return best === null ? null : new Date(best)
}

/** The start of the day containing `at` in `zone`. */
export function startOfDay(at: Date, zone: string): Date {
  const local = wall(at.getTime(), zone)
  return new Date(instant(local.y, local.mo, local.d, 0, zone))
}

/** A time as the person reads it, such as "Thu, 22 Oct 2026, 06:00 (America/New_York)". */
export function localLabel(at: Date, zone: string): string {
  const text = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  return `${text} (${zone})`
}
