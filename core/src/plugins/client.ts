import type { PluginServerEndpoint } from './supervisor.js'
import { pluginAccountList, pluginAccountRemoval, pluginAccountResult, pluginDefaultAccount, pluginErrorCodes, pluginList, pluginResult, pluginSignInStart, pluginSignInStatus, type PluginAccountList, type PluginAccountRemoval, type PluginAccountResult, type PluginDefaultAccount, type PluginList, type PluginResult, type PluginSignInStart, type PluginSignInStatus } from '../protocol/plugins.js'
import type { Schema } from '../protocol/schema.js'

/** A plugin route's refusal: Kipster's code or the plugin server's, with the HTTP status Core answers. */
export class PluginRouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const unavailable = () => new PluginRouteError(503, pluginErrorCodes.unavailable, 'Plugins are off: the plugin server is not running')
const failed = (message: string) => new PluginRouteError(502, pluginErrorCodes.serverFailed, message)
type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** The plugin server's body with `version: 1`, unchanged otherwise, once it reads as the protocol's response. */
function relay<T>(schema: Schema<T>, body: Json): T {
  const { version: _, ...fields } = body
  const value = { version: 1, ...fields }
  try { schema.parse(value) } catch { throw failed('The plugin server answered with a body Core cannot read') }
  return value as T
}

/**
 * Calls the plugin server's control API v1 at the supervisor's endpoint with its bearer token. Without an endpoint
 * plugins are off. Results are the plugin server's JSON in Kipster's envelope; its errors keep their status and code.
 */
export class PluginControlClient {
  constructor(private readonly server: PluginServerEndpoint | undefined, private readonly timeoutMs = 30000) {}

  /** Throws `plugins-unavailable` while plugins are off. */
  requireReady(): void { this.#endpoint() }

  #endpoint(): { url: string; token: string } {
    const endpoint = this.server?.endpoint()
    if (!endpoint) throw unavailable()
    return endpoint
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    try { return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) }) }
    catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw failed('The plugin server did not answer in time')
      // The server stopped between the endpoint check and the request.
      if (!this.server?.endpoint()) throw unavailable()
      throw failed('The plugin server could not be reached')
    }
  }

  /** One control API call: `path` is relative to the server, such as `/v1/plugins`. */
  async #request(method: string, path: string, body?: Json): Promise<Json> {
    const { url, token } = this.#endpoint()
    const response = await this.#fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    let value: unknown
    try { value = await response.json() } catch { throw failed(`The plugin server answered ${response.status} without JSON`) }
    if (response.ok) {
      if (!isObject(value)) throw failed('The plugin server answered with an unexpected body')
      return value
    }
    const error = isObject(value) && isObject(value.error) ? value.error : undefined
    // A refused token or host is Core's fault, not the request's.
    if (response.status === 401 || (response.status === 403 && error?.code === 'forbidden-host')) throw failed('The plugin server refused Core')
    if (!error || typeof error.code !== 'string' || !error.code || response.status < 400 || response.status > 599) throw failed(`The plugin server answered ${response.status}`)
    throw new PluginRouteError(response.status, error.code, typeof error.message === 'string' ? error.message : error.code)
  }

  async listPlugins(): Promise<PluginList> { return relay(pluginList, await this.#request('GET', '/v1/plugins')) }
  async getPlugin(pluginId: string): Promise<PluginResult> { return relay(pluginResult, await this.#request('GET', `/v1/plugins/${encodeURIComponent(pluginId)}`)) }
  async startSignIn(pluginId: string, input: { address?: string | undefined; returnAddress?: string | undefined }): Promise<PluginSignInStart> {
    return relay(pluginSignInStart, await this.#request('POST', `/v1/plugins/${encodeURIComponent(pluginId)}/sign-in`, {
      ...(input.address !== undefined ? { address: input.address } : {}),
      ...(input.returnAddress !== undefined ? { returnAddress: input.returnAddress } : {}),
    }))
  }
  async signInStatus(signInId: string): Promise<PluginSignInStatus> { return relay(pluginSignInStatus, await this.#request('GET', `/v1/sign-ins/${encodeURIComponent(signInId)}`)) }
  async listAccounts(pluginId?: string): Promise<PluginAccountList> {
    return relay(pluginAccountList, await this.#request('GET', pluginId === undefined ? '/v1/accounts' : `/v1/accounts?plugin=${encodeURIComponent(pluginId)}`))
  }
  async renameAccount(accountId: string, label: string): Promise<PluginAccountResult> { return relay(pluginAccountResult, await this.#request('PATCH', `/v1/accounts/${encodeURIComponent(accountId)}`, { label })) }
  /** Sets the plugin's default account; null clears it. */
  async setDefaultAccount(pluginId: string, accountId: string | null): Promise<PluginDefaultAccount> {
    return relay(pluginDefaultAccount, await this.#request('PUT', `/v1/plugins/${encodeURIComponent(pluginId)}/default-account`, { account: accountId }))
  }
  async clearDefaultAccount(pluginId: string): Promise<PluginDefaultAccount> { return relay(pluginDefaultAccount, await this.#request('DELETE', `/v1/plugins/${encodeURIComponent(pluginId)}/default-account`)) }
  async removeAccount(accountId: string): Promise<PluginAccountRemoval> { return relay(pluginAccountRemoval, await this.#request('DELETE', `/v1/accounts/${encodeURIComponent(accountId)}`)) }

  /** The plugin server's sign-in return page for a raw query string such as `?code=...&state=...`, unchanged. */
  async callback(search: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const { url } = this.#endpoint()
    const response = await this.#fetch(`${url}/callback${search}`, { method: 'GET' })
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'cache-control', 'referrer-policy']) {
      const value = response.headers.get(name)
      if (value !== null) headers[name] = value
    }
    return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) }
  }
}
