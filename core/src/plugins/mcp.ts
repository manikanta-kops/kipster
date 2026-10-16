/** A Streamable HTTP MCP client for the plugin server's `/mcp`, one session per request. */

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const maxPages = 20

/** One tool the plugin server lists: `<plugin>__<tool>` with the plugin's ID in `_meta`. */
export interface ListedPluginTool { name: string; plugin: string; title?: string; description: string; inputSchema: Json }

async function session<T>(endpoint: { url: string; token: string }, timeoutMs: number, work: (post: (method: string, params?: Json) => Promise<Json>) => Promise<T>): Promise<T> {
  const url = `${endpoint.url}/mcp`
  const signal = AbortSignal.timeout(timeoutMs)
  const headers: Record<string, string> = { authorization: `Bearer ${endpoint.token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  let id = 0
  const post = async (method: string, params?: Json): Promise<Json> => {
    const notification = method.startsWith('notifications/')
    const request = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id: ++id }) }
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request), signal })
    if (!response.ok) throw new Error(`The plugin server answered ${method} with HTTP ${response.status}`)
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId) headers['mcp-session-id'] = sessionId
    const text = await response.text()
    if (notification) return {}
    // A response arrives as JSON or as one event of a short event stream.
    const bodies = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
      : [text]
    for (const body of bodies) {
      const message = object(JSON.parse(body))
      if (message.id !== request.id) continue
      if (message.error) throw new Error(`The plugin server refused ${method}: ${JSON.stringify(message.error)}`)
      return object(message.result)
    }
    throw new Error(`The plugin server returned no result for ${method}`)
  }
  try {
    const initialized = await post('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kipster-core', version: '1' } })
    if (typeof initialized.protocolVersion === 'string') headers['mcp-protocol-version'] = initialized.protocolVersion
    await post('notifications/initialized')
    return await work(post)
  } finally {
    if (headers['mcp-session-id']) void fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) }).then(response => response.body?.cancel()).catch(() => undefined)
  }
}

/** Every plugin tool the plugin server serves now: those of plugins with a working account. */
export async function listPluginTools(endpoint: { url: string; token: string }, timeoutMs = 60000): Promise<ListedPluginTool[]> {
  return session(endpoint, timeoutMs, async post => {
    const tools: ListedPluginTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const listing = await post('tools/list', cursor ? { cursor } : {})
      for (const raw of Array.isArray(listing.tools) ? listing.tools : []) {
        const tool = object(raw), plugin = object(tool._meta)['app.kipster/plugin']
        if (typeof tool.name !== 'string' || typeof plugin !== 'string' || !plugin) continue
        const title = typeof tool.title === 'string' ? tool.title : typeof object(tool.annotations).title === 'string' ? object(tool.annotations).title as string : undefined
        tools.push({ name: tool.name, plugin, ...(title ? { title } : {}), description: typeof tool.description === 'string' ? tool.description : '', inputSchema: object(tool.inputSchema) })
      }
      cursor = typeof listing.nextCursor === 'string' && listing.nextCursor ? listing.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  })
}

/** The plugin server's MCP result of one call, unchanged. */
export async function callPluginTool(endpoint: { url: string; token: string }, name: string, args: Json, timeoutMs = 600000): Promise<Json> {
  return session(endpoint, timeoutMs, post => post('tools/call', { name, arguments: args }))
}
