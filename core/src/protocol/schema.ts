/** Small, dependency-free wire schema. Mutations are exact; reads allow additive fields. */
export interface Schema<T> { parse(value: unknown, path?: string): T; describe(): WireShape }
/** The JSON-serializable structure a schema accepts, compared between releases to keep changes additive. */
export type WireShape =
  | { type: 'string'; min?: number; max?: number; format?: 'utc-timestamp' | 'clock-time' }
  | { type: 'integer'; min: number; max?: number }
  | { type: 'boolean' } | { type: 'record' } | { type: 'unknown' }
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'array'; items: WireShape; min?: number; max?: number }
  | { type: 'nullable'; of: WireShape }
  | { type: 'optional'; of: WireShape }
  | { type: 'object'; exact: boolean; fields: Record<string, WireShape> }
  | { type: 'union'; of: WireShape[] }
export type Infer<S> = S extends Schema<infer T> ? T : never

function invalid(path: string): never { throw new TypeError(`Invalid wire value at ${path}`) }
export const string = (): Schema<string> => ({ parse: (v, p = '$') => typeof v === 'string' ? v : invalid(p), describe: () => ({ type: 'string' }) })
export const nonempty = (): Schema<string> => ({ parse: (v, p = '$') => typeof v === 'string' && v.length > 0 ? v : invalid(p), describe: () => ({ type: 'string', min: 1 }) })
export const utcTimestamp = (): Schema<string> => ({ describe: () => ({ type: 'string', format: 'utc-timestamp' }), parse(v, p = '$') {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) invalid(p)
  return v
} })
/** A string of `min` to `max` UTF-16 code units. */
export const boundedString = (min: number, max: number): Schema<string> => ({ parse: (v, p = '$') => typeof v === 'string' && v.length >= min && v.length <= max ? v : invalid(p), describe: () => ({ type: 'string', min, max }) })
/** A plain JSON object whose members are not inspected. */
export const record = (): Schema<Record<string, unknown>> => ({ parse: (v, p = '$') => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : invalid(p), describe: () => ({ type: 'record' }) })
/** Any JSON value, passed through uninspected. */
export const unknown = (): Schema<unknown> => ({ parse: v => v, describe: () => ({ type: 'unknown' }) })
/** A time of day, "HH:MM" on a 24-hour clock. */
export const clockTime = (): Schema<string> => ({ parse: (v, p = '$') => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : invalid(p), describe: () => ({ type: 'string', format: 'clock-time' }) })
export const integer = (): Schema<number> => ({ parse: (v, p = '$') => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : invalid(p), describe: () => ({ type: 'integer', min: 0 }) })
export const boundedInteger = (min: number, max: number): Schema<number> => ({ parse: (v, p = '$') => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : invalid(p), describe: () => ({ type: 'integer', min, max }) })
export const boolean = (): Schema<boolean> => ({ parse: (v, p = '$') => typeof v === 'boolean' ? v : invalid(p), describe: () => ({ type: 'boolean' }) })
export const literal = <const T extends string | number | boolean>(expected: T): Schema<T> => ({ parse: (v, p = '$') => v === expected ? expected : invalid(p), describe: () => ({ type: 'literal', value: expected }) })
export const array = <T>(item: Schema<T>): Schema<T[]> => ({ parse(v, p = '$') { if (!Array.isArray(v)) invalid(p); return v.map((x, i) => item.parse(x, `${p}[${i}]`)) }, describe: () => ({ type: 'array', items: item.describe() }) })
export const nullable = <T>(item: Schema<T>): Schema<T | null> => ({ parse: (v, p = '$') => v === null ? null : item.parse(v, p), describe: () => ({ type: 'nullable', of: item.describe() }) })
export interface OptionalSchema<T> extends Schema<T | undefined> { readonly optional: true }
export const optional = <T>(item: Schema<T>): OptionalSchema<T> => ({ optional: true, parse: (v, p = '$') => v === undefined ? undefined : item.parse(v, p), describe: () => ({ type: 'optional', of: item.describe() }) })
type Shape = Record<string, Schema<unknown>>
type FromShape<S extends Shape> = { [K in keyof S as S[K] extends OptionalSchema<unknown> ? never : K]: Infer<S[K]> } & { [K in keyof S as S[K] extends OptionalSchema<unknown> ? K : never]?: Infer<S[K]> }
export function object<const S extends Shape>(shape: S, exact = true): Schema<FromShape<S>> {
  return { describe: () => ({ type: 'object', exact, fields: Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.describe()])) }), parse(v, p = '$') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) invalid(p)
    const source = v as Record<string, unknown>
    if (exact) for (const key of Object.keys(source)) if (!Object.hasOwn(shape, key)) invalid(`${p}.${key}`)
    const result: Record<string, unknown> = {}
    for (const [key, schema] of Object.entries(shape)) {
      if (!Object.hasOwn(source, key)) {
        if ('optional' in schema && schema.optional === true) continue
        invalid(`${p}.${key}`)
      }
      result[key] = schema.parse(source[key], `${p}.${key}`)
    }
    return result as FromShape<S>
  } }
}
export function union<const S extends readonly Schema<unknown>[]>(...choices: S): Schema<Infer<S[number]>> {
  return { describe: () => ({ type: 'union', of: choices.map(choice => choice.describe()) }), parse(v, p = '$') { for (const choice of choices) { try { return choice.parse(v, p) as Infer<S[number]> } catch (error) { if (!(error instanceof TypeError)) throw error } } return invalid(p) } }
}
