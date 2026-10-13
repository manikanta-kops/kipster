// A fake Kipster Plugins server: Streamable HTTP MCP at /mcp behind a bearer token. It answers `tools/list` with
// labelled tools as an event stream across two pages, and records every request.
import { createServer } from 'node:http'

export const pluginTools = [
  { name: 'plugin_list', inputSchema: { type: 'object' }, _meta: { 'app.kipster/access': 'read' } },
  { name: 'github__get_issue', inputSchema: { type: 'object', properties: { number: { type: 'number' } } }, _meta: { 'app.kipster/access': 'read', 'app.kipster/plugin': 'github' } },
  { name: 'github__create_issue', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, account: { type: 'string', enum: ['work', 'personal'] } } }, _meta: { 'app.kipster/access': 'write', 'app.kipster/plugin': 'github' } },
  { name: 'github__mystery', inputSchema: { type: 'object' }, _meta: { 'app.kipster/plugin': 'github' } },
  { name: 'jira__assign', inputSchema: { type: 'object', properties: { account: { type: 'string' }, kipster_account: { type: 'string', enum: ['ops', 'dev'] } } }, _meta: { 'app.kipster/access': 'write', 'app.kipster/plugin': 'jira' } },
]

export async function fakePlugins(t, token = 'plugin-secret-token') {
  const requests = []
  let failing = false
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const message = body ? JSON.parse(body) : undefined
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, session: request.headers['mcp-session-id'], rpc: message?.method })
    if (failing) return response.writeHead(500).end()
    if (request.headers.authorization !== `Bearer ${token}`) return response.writeHead(401).end()
    if (request.url !== '/mcp') return response.writeHead(404).end()
    if (request.method === 'DELETE') return response.writeHead(200).end()
    if (!message.id) return response.writeHead(202).end()
    if (message.method === 'initialize') return response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kipster-plugins', version: '0.2.0' } } }))
    if (request.headers['mcp-session-id'] !== 'session-1') return response.writeHead(400).end()
    if (message.method === 'tools/list') {
      const page = message.params?.cursor === 'page-2' ? { tools: pluginTools.slice(3) } : { tools: pluginTools.slice(0, 3), nextCursor: 'page-2' }
      return response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: page })}\n\n`)
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    token,
    requests,
    listings: () => requests.filter(request => request.rpc === 'tools/list').length,
    fail: () => { failing = true },
  }
}
