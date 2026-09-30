export type { JsonObject, JsonPrimitive, JsonValue } from '../index.js'

/** Connection configuration for a Kipster backend. */
export interface ClientOptions {
  readonly baseUrl: string
}

/** Validate and normalize an absolute HTTP(S) backend URL without performing I/O. */
export function defineClientOptions(options: ClientOptions): ClientOptions {
  const url = new URL(options.baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Kipster backend URL must use HTTP or HTTPS')
  }
  return Object.freeze({ baseUrl: url.href })
}
