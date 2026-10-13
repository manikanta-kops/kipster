import { PluginControlClient, PluginRouteError } from '../../plugins/client.js'
import { pluginAccountRename, pluginDefaultAccountWrite, pluginErrorCodes, pluginPaths, pluginSignInRequest } from '../../protocol/plugins.js'

/**
 * Whether a sign-in may return to `value`: Core's own `/plugins/callback` on a host Core answers, so the service's
 * code never goes to another origin. `accepts` tells whether Core accepts a Host header.
 */
export function returnAddressAllowed(value: string, accepts: (host: string) => boolean): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== pluginPaths.callback) return false
  // A browser omits the default port from Host; an allowed host may still name it.
  return accepts(url.host) || (!url.port && accepts(`${url.hostname}:${url.protocol === 'https:' ? 443 : 80}`))
}

function identifier(value: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw new Error('Invalid plugin route identifier') }
  if (!decoded) throw new Error('Invalid plugin route identifier')
  return decoded
}

/**
 * The owner's `/v1/plugins` routes, one-to-one with the plugin server's control API. Returns the response body, or
 * undefined when no route matches. While plugins are off every route throws 503 `plugins-unavailable`, before reading
 * its request.
 */
export async function pluginRoute(client: PluginControlClient, method: string, path: string, query: URLSearchParams, read: () => Promise<unknown>, accepts: (host: string) => boolean): Promise<object | undefined> {
  const handler = route(client, method, path, query, read, accepts)
  if (!handler) return undefined
  client.requireReady()
  return handler()
}

function route(client: PluginControlClient, method: string, path: string, query: URLSearchParams, read: () => Promise<unknown>, accepts: (host: string) => boolean): (() => Promise<object>) | undefined {
  if (path === '/v1/plugins' && method === 'GET') return () => client.listPlugins()
  if (path === '/v1/plugins/accounts' && method === 'GET') return () => {
    const plugin = query.get('plugin')
    if (plugin === '') throw new Error('Invalid plugin filter')
    return client.listAccounts(plugin ?? undefined)
  }
  const account = /^\/v1\/plugins\/accounts\/([^/]+)$/.exec(path)
  if (account && method === 'PATCH') return async () => client.renameAccount(identifier(account[1]!), pluginAccountRename.parse(await read()).label)
  if (account && method === 'DELETE') return () => client.removeAccount(identifier(account[1]!))
  const signIn = /^\/v1\/plugins\/sign-ins\/([^/]+)$/.exec(path)
  if (signIn && method === 'GET') return () => client.signInStatus(identifier(signIn[1]!))
  const plugin = /^\/v1\/plugins\/([^/]+)(\/sign-in|\/default-account)?$/.exec(path)
  if (!plugin || plugin[1] === 'accounts' || plugin[1] === 'sign-ins') return undefined
  const pluginId = () => identifier(plugin[1]!)
  if (!plugin[2] && method === 'GET') return () => client.getPlugin(pluginId())
  if (plugin[2] === '/sign-in' && method === 'POST') return async () => {
    const id = pluginId()
    const input = pluginSignInRequest.parse(await read())
    if (input.returnAddress !== undefined && !returnAddressAllowed(input.returnAddress, accepts))
      throw new PluginRouteError(400, pluginErrorCodes.returnAddressRefused, `A sign-in may return only to ${pluginPaths.callback} on an address of this Kipster Core`)
    return client.startSignIn(id, input)
  }
  if (plugin[2] === '/default-account' && method === 'PUT') return async () => {
    const id = pluginId()
    return client.setDefaultAccount(id, pluginDefaultAccountWrite.parse(await read()).account)
  }
  if (plugin[2] === '/default-account' && method === 'DELETE') return () => client.clearDefaultAccount(pluginId())
  return undefined
}

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${text}</p>`

/** `GET /plugins/callback`: the plugin server's sign-in return page for the raw query, or a page saying why not. */
export async function pluginCallback(client: PluginControlClient, search: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const security = { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'", 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }
  try {
    const reply = await client.callback(search)
    return { status: reply.status, headers: { ...security, ...reply.headers }, body: reply.body }
  } catch (error) {
    const off = error instanceof PluginRouteError && error.status === 503
    const body = off ? page('Plugins are off', 'Plugins are off right now, so this sign-in cannot finish. Start the sign-in again once plugins are on.') : page('Sign-in failed', 'Kipster could not reach the plugin server to finish this sign-in. Try again.')
    return { status: off ? 503 : 502, headers: { ...security, 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(body) }
  }
}
