import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { ToolDefinition } from '@kipster/core/adapter'

type ObjectValue = Record<string, unknown>
export interface ToolResult { readonly text: string; readonly isError?: boolean }
/** One execution's tools. `permission` answers Claude's permission prompts; a request it leaves unanswered stays open until the process stops. */
export interface ToolSession {
  readonly tools: readonly ToolDefinition[]
  call(name: string, args: ObjectValue, toolUseId: string | undefined): Promise<ToolResult>
  permission(args: ObjectValue): Promise<ToolResult>
}
export const permissionTool = 'prompt'
const permissionSchema = { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] }
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
const maxBody = 32 * 1024 * 1024

/**
 * A loopback Streamable HTTP MCP server. Each execution gets a bearer token; `/tools` lists that execution's Core tools
 * and `/permission` its permission prompt tool. Responses are plain JSON; no server-initiated stream is offered.
 */
export class ToolServer {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private readonly sessions = new Map<string, ToolSession>()
  private readonly open = new Set<ServerResponse>()
  start(): Promise<number> {
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => { void this.handle(request, response) })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
  }
  register(session: ToolSession): { token: string; close(): void } {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, session)
    return { token, close: () => { this.sessions.delete(token) } }
  }
  async close(): Promise<void> {
    this.sessions.clear()
    for (const response of this.open) response.destroy()
    const server = this.server
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
  private session(request: IncomingMessage): ToolSession | undefined {
    const header = request.headers.authorization ?? ''
    const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    for (const [token, session] of this.sessions) {
      const expected = Buffer.from(token)
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return session
    }
    return undefined
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.open.add(response)
    response.once('close', () => this.open.delete(response))
    const reply = (status: number, body?: unknown) => {
      if (response.writableEnded || response.destroyed) return
      if (body === undefined) response.writeHead(status).end()
      else response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    }
    const session = this.session(request)
    if (!session) return reply(401)
    if (request.method !== 'POST') return reply(405)
    const route = request.url === '/tools' ? 'tools' : request.url === '/permission' ? 'permission' : undefined
    if (!route) return reply(404)
    let body = ''
    for await (const chunk of request) { body += chunk; if (body.length > maxBody) return reply(413) }
    let message: ObjectValue
    try { message = object(JSON.parse(body)) } catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }
    if (message.id === undefined || message.id === null) return reply(202)
    const result = (value: unknown) => reply(200, { jsonrpc: '2.0', id: message.id, result: value })
    const failure = (code: number, text: string) => reply(200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } })
    const params = object(message.params)
    if (message.method === 'initialize') return result({ protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'kipster', version: '0.0.0' } })
    if (message.method === 'ping') return result({})
    if (message.method === 'tools/list') return result({ tools: route === 'tools' ? session.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) : [{ name: permissionTool, description: 'Answers Claude Code permission prompts for Kipster.', inputSchema: permissionSchema }] })
    if (message.method !== 'tools/call') return failure(-32601, 'Method not found')
    const name = typeof params.name === 'string' ? params.name : ''
    const args = object(params.arguments)
    const meta = object(params._meta)
    const toolUseId = typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : undefined
    try {
      const outcome = route === 'permission'
        ? name === permissionTool ? await session.permission(args) : { text: 'Unknown tool', isError: true }
        : await session.call(name, args, toolUseId)
      return result({ content: [{ type: 'text', text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) })
    } catch (error) { return result({ content: [{ type: 'text', text: String(error) }], isError: true }) }
  }
}
