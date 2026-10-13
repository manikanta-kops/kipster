import { pluginAccountList, pluginAccountRemoval, pluginAccountResult, pluginDefaultAccount, pluginList, pluginPaths, pluginResult, pluginSignInStart, pluginSignInStatus, type PluginAccountList, type PluginAccountRemoval, type PluginAccountResult, type PluginDefaultAccount, type PluginList, type PluginResult, type PluginSignInStart, type PluginSignInStatus } from '../plugins.js'
import type { Schema } from '../schema.js'
import { bootstrap, type Bootstrap } from '../text.js'

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

/** An `AbortSignal`, described structurally so the declarations need no DOM or Node types. */
export interface ClientSignal { readonly aborted: boolean }
export interface RequestOptions { readonly signal?: ClientSignal }
/** The part of `fetch` the client uses. A wrapper can pass `init` on to the global `fetch` as a `RequestInit`. */
export interface FetchInit { readonly method: string; readonly cache: 'no-store'; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly signal?: ClientSignal }
export interface FetchResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown> }
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>

/**
 * A response Core refused or that this client cannot read. `code` is Core's error code, the plugin server's for plugin
 * routes, or `invalid-response`.
 */
export class KipsterClientError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | null
  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message)
    this.name = 'KipsterClientError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

export interface KipsterClient {
  bootstrap(options?: RequestOptions): Promise<Bootstrap>
  listPlugins(options?: RequestOptions): Promise<PluginList>
  getPlugin(pluginId: string, options?: RequestOptions): Promise<PluginResult>
  /** Open a `redirect` result's `authorizationUrl` in the person's browser, then poll `getPluginSignIn`. */
  startPluginSignIn(pluginId: string, input?: { readonly address?: string; readonly returnAddress?: string }, options?: RequestOptions): Promise<PluginSignInStart>
  getPluginSignIn(signInId: string, options?: RequestOptions): Promise<PluginSignInStatus>
  listPluginAccounts(filter?: { readonly plugin?: string }, options?: RequestOptions): Promise<PluginAccountList>
  renamePluginAccount(accountId: string, label: string, options?: RequestOptions): Promise<PluginAccountResult>
  setDefaultPluginAccount(pluginId: string, accountId: string, options?: RequestOptions): Promise<PluginDefaultAccount>
  clearDefaultPluginAccount(pluginId: string, options?: RequestOptions): Promise<PluginDefaultAccount>
  /** Revokes the account at its service where possible and removes it. */
  removePluginAccount(accountId: string, options?: RequestOptions): Promise<PluginAccountRemoval>
}

/** A client for Core's HTTP routes. `fetch` defaults to the global one. */
export function createClient(options: ClientOptions, fetch: Fetch = (url, init) => globalThis.fetch(url, init as RequestInit)): KipsterClient {
  const { baseUrl } = defineClientOptions(options)
  async function call<T>(schema: Schema<T>, method: string, path: string, body: unknown, options: RequestOptions | undefined): Promise<T> {
    const response = await fetch(new URL(path.slice(1), baseUrl).href, {
      method, cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const error = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
      throw new KipsterClientError(response.status, typeof error.code === 'string' && error.code ? error.code : 'invalid-response',
        typeof error.message === 'string' ? error.message : `Request failed with status ${response.status}`, typeof error.requestId === 'string' ? error.requestId : null)
    }
    try { return schema.parse(value) } catch (error) {
      if (error instanceof TypeError) throw new KipsterClientError(response.status, 'invalid-response', error.message)
      throw error
    }
  }
  return {
    bootstrap: options => call(bootstrap, 'GET', '/v1/bootstrap', undefined, options),
    listPlugins: options => call(pluginList, 'GET', pluginPaths.plugins, undefined, options),
    getPlugin: (pluginId, options) => call(pluginResult, 'GET', pluginPaths.plugin(pluginId), undefined, options),
    startPluginSignIn: (pluginId, input = {}, options) => call(pluginSignInStart, 'POST', pluginPaths.signIn(pluginId), { version: 1, ...input }, options),
    getPluginSignIn: (signInId, options) => call(pluginSignInStatus, 'GET', pluginPaths.signInStatus(signInId), undefined, options),
    listPluginAccounts: (filter = {}, options) => call(pluginAccountList, 'GET', pluginPaths.accounts(filter.plugin), undefined, options),
    renamePluginAccount: (accountId, label, options) => call(pluginAccountResult, 'PATCH', pluginPaths.account(accountId), { version: 1, label }, options),
    setDefaultPluginAccount: (pluginId, accountId, options) => call(pluginDefaultAccount, 'PUT', pluginPaths.defaultAccount(pluginId), { version: 1, account: accountId }, options),
    clearDefaultPluginAccount: (pluginId, options) => call(pluginDefaultAccount, 'DELETE', pluginPaths.defaultAccount(pluginId), undefined, options),
    removePluginAccount: (accountId, options) => call(pluginAccountRemoval, 'DELETE', pluginPaths.account(accountId), undefined, options),
  }
}
