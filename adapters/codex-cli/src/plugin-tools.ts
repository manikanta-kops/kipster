import type { ExecutionMcpServer } from '@kipster/core/adapter'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
/** Core's server names: lowercase letters, digits and hyphens, so each is a plain configuration key and names one token variable. */
const serverName = /^[a-z0-9][a-z0-9-]{0,62}$/
const accessKey = 'app.kipster/access'
const pluginKey = 'app.kipster/plugin'
const lookupTimeout = 10000
const maxPages = 20

/** The servers Core passed that this adapter can address: a usable name and an HTTP(S) URL. */
export function pluginServers(servers: readonly ExecutionMcpServer[] | undefined): ExecutionMcpServer[] {
  const seen = new Set<string>()
  return (servers ?? []).filter(server => {
    if (!serverName.test(server.name) || seen.has(server.name) || !server.bearerToken) return false
    try { if (!['http:', 'https:'].includes(new URL(server.url).protocol)) return false } catch { return false }
    seen.add(server.name)
    return true
  })
}

/** What the server's own listing says about one tool. A label in the tool's input is never read. */
export interface ListedTool { readonly access?: 'read' | 'write'; readonly plugin?: string; readonly ownAccount: boolean }
/** One plugin tool as an approval card names it. */
export interface PluginTool { readonly server: string; readonly tool: string; readonly plugin: string; readonly account: string; readonly access?: 'read' | 'write' }

/**
 * Tool labels from each plugin server's `tools/list`, read on first use and kept for the attempt. A failed lookup
 * leaves every tool of that server unlabelled, so it asks.
 */
export class PluginLabels {
  private readonly listings = new Map<string, Promise<Map<string, ListedTool>>>()
  constructor(readonly servers: readonly ExecutionMcpServer[]) {}
  async lookup(server: string, tool: string): Promise<ListedTool | undefined> {
    const entry = this.servers.find(item => item.name === server)
    if (!entry) return undefined
    let listing = this.listings.get(server)
    if (!listing) this.listings.set(server, listing = listTools(entry).catch(() => new Map()))
    return (await listing).get(tool)
  }
  /** The card's names for a call: the tool without its plugin prefix, the plugin, and the account the call selects. */
  async describe(server: string, tool: string, input: ObjectValue): Promise<PluginTool> {
    const listed = await this.lookup(server, tool)
    const split = tool.indexOf('__')
    const own = typeof input.kipster_account === 'string' && input.kipster_account ? input.kipster_account : undefined
    // A tool that declares its own `account` takes the plugin server's selector as `kipster_account` instead.
    const account = own ?? (!listed?.ownAccount && typeof input.account === 'string' && input.account ? input.account : undefined)
    return {
      server,
      tool: split > 0 ? tool.slice(split + 2) : tool,
      plugin: listed?.plugin ?? (split > 0 ? tool.slice(0, split) : server),
      account: account ?? 'the default account',
      ...(listed?.access ? { access: listed.access } : {}),
    }
  }
}

/** Reads every page of a Streamable HTTP MCP server's tool listing, as a 2025-era client with a session. */
async function listTools(server: ExecutionMcpServer): Promise<Map<string, ListedTool>> {
  const signal = AbortSignal.timeout(lookupTimeout)
  const headers: Record<string, string> = { authorization: `Bearer ${server.bearerToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  let id = 0
  const post = async (method: string, params?: ObjectValue): Promise<ObjectValue> => {
    const request = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(method.startsWith('notifications/') ? {} : { id: ++id }) }
    const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(request), signal })
    if (!response.ok) throw new Error(`MCP ${method} failed with HTTP ${response.status}`)
    const session = response.headers.get('mcp-session-id')
    if (session) headers['mcp-session-id'] = session
    const text = await response.text()
    if (!('id' in request)) return {}
    // A response arrives as JSON or as one event of a short event stream.
    const bodies = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
      : [text]
    for (const body of bodies) {
      const message = object(JSON.parse(body))
      if (message.id !== request.id) continue
      if (message.error) throw new Error(`MCP ${method} failed`)
      return object(message.result)
    }
    throw new Error(`MCP ${method} returned no result`)
  }
  try {
    const initialized = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kipster-adapter', version: '0.0.0' } })
    if (typeof initialized.protocolVersion === 'string') headers['mcp-protocol-version'] = initialized.protocolVersion
    await post('notifications/initialized')
    const tools = new Map<string, ListedTool>()
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const listing = await post('tools/list', cursor ? { cursor } : {})
      for (const raw of Array.isArray(listing.tools) ? listing.tools : []) {
        const tool = object(raw), meta = object(tool._meta), properties = object(object(tool.inputSchema).properties)
        if (typeof tool.name !== 'string') continue
        const access = meta[accessKey] === 'read' || meta[accessKey] === 'write' ? meta[accessKey] : undefined
        const plugin = typeof meta[pluginKey] === 'string' && meta[pluginKey] ? meta[pluginKey] : undefined
        tools.set(tool.name, { ...(access ? { access } : {}), ...(plugin ? { plugin } : {}), ownAccount: Object.hasOwn(properties, 'kipster_account') })
      }
      cursor = typeof listing.nextCursor === 'string' && listing.nextCursor ? listing.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  } finally {
    if (headers['mcp-session-id']) void fetch(server.url, { method: 'DELETE', headers, signal: AbortSignal.timeout(lookupTimeout) }).then(response => response.body?.cancel()).catch(() => undefined)
  }
}

/** The variable that carries a server's bearer token, set only in the Codex process's environment. */
export const tokenVariable = (server: string): string => `KIPSTER_MCP_${server.toUpperCase().replaceAll('-', '_')}_TOKEN`
