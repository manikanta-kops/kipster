/** Compile-time JSON value types for the public wire boundary; not runtime validators. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
export type JsonObject = { readonly [key: string]: JsonValue }
export * from './version.js'
export * from './text.js'
export * from './admin.js'
