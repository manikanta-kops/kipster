// A fake `claude` CLI: answers `auth status`, the initialize control request, and one user turn per scenario.
// The scenario comes from the file named by FAKE_CLAUDE_MODE_FILE; every observation is appended to FAKE_CLAUDE_LOG.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const mode = readFileSync(process.env.FAKE_CLAUDE_MODE_FILE, 'utf8').trim()
const log = value => appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(value) + '\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }

if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: mode !== 'signed-out', authMethod: 'claude.ai' }))
  process.exit(0)
}
const session = option('--session-id') ?? option('--resume') ?? '11111111-2222-4333-8444-555555555555'
log({ launch: { argv: args, cwd: process.cwd(), env: process.env, pid: process.pid, instructions: option('--append-system-prompt-file') ? readFileSync(option('--append-system-prompt-file'), 'utf8') : undefined, mcp: option('--mcp-config') ? JSON.parse(readFileSync(option('--mcp-config'), 'utf8')) : undefined } })

const config = option('--mcp-config') ? JSON.parse(readFileSync(option('--mcp-config'), 'utf8')).mcpServers : {}
let rpc = 0
async function mcp(server, method, params) {
  const { url, headers } = config[server]
  const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method, params }) })
  return (await response.json()).result
}
const call = (name, args, toolUseId) => mcp('kipster', 'tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': toolUseId } })
const permission = async (tool_name, input, tool_use_id) => JSON.parse((await mcp('kipster_permission', 'tools/call', { name: 'prompt', arguments: { tool_name, input, tool_use_id } })).content[0].text)
const stream = event => send({ type: 'stream_event', event, parent_tool_use_id: null, session_id: session })
function reply(id, text) {
  stream({ type: 'message_start', message: { id } })
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const piece of text.match(/.{1,3}/g)) stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
  stream({ type: 'content_block_stop', index: 0 })
}
const done = (extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: session, ...extra })

const scenarios = {
  async chat() {
    stream({ type: 'message_start', message: { id: 'sub' } })
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: 'toolu_task' })
    reply('msg_1', 'Hello there')
    log({ listed: (await mcp('kipster', 'tools/list', {})).tools.map(tool => tool.name), permissionListed: (await mcp('kipster_permission', 'tools/list', {})).tools.map(tool => tool.name) })
    log({ offered: await call('notes_echo', { note: 'alpha' }, 'toolu_1') })
    log({ unoffered: await call('admin_agents_create', { name: 'Scout' }, 'toolu_2') })
    log({ kipsterPermission: await permission('mcp__kipster__notes_echo', { note: 'alpha' }, 'toolu_1') })
    const denied = await fetch(config.kipster.url, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
    log({ wrongToken: denied.status })
    reply('msg_2', 'All done')
    done()
  },
  async approve() {
    const decision = await permission('Bash', { command: 'touch approved.txt', description: `label ${Date.now()}` }, 'toolu_bash')
    log({ decision })
    if (decision.behavior === 'allow') {
      const again = await permission('Bash', { command: 'touch approved.txt', description: 'another label' }, 'toolu_bash_2')
      log({ again })
      reply('msg_ran', 'Ran it')
    }
    done()
  },
  async ask() {
    const decision = await permission('AskUserQuestion', { questions: [{ question: 'Which city?', header: 'City', options: [{ label: 'Paris' }, { label: 'Rome' }], multiSelect: false }] }, 'toolu_ask')
    log({ decision })
    done()
  },
  async repeat() {
    await call('interactions_ask', { prompt: 'First?', options: [], freeText: true }, 'toolu_a')
    log({ second: await call('interactions_ask', { prompt: 'Second?', options: [], freeText: true }, 'toolu_b') })
    done()
  },
  async error() { send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded', session_id: session }) },
  async hang() { await new Promise(() => {}) },
  async maintenance() { done({ structured_output: { candidates: [] } }) },
}

let started = false
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models: [
      { value: 'default', resolvedModel: 'claude-opus-5-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5' },
    ] } } })
    return
  }
  if (message.type !== 'user' || started) return
  started = true
  log({ user: message.message.content })
  send({ type: 'system', subtype: 'init', session_id: session, tools: mode.startsWith('maintenance') ? (mode === 'maintenance-leak' ? ['Bash', 'StructuredOutput'] : ['StructuredOutput']) : ['Bash', 'mcp__kipster__notes_echo'], mcp_servers: [] })
  void scenarios[mode.startsWith('maintenance') ? 'maintenance' : mode]().catch(error => { log({ error: String(error) }); process.exit(1) })
})
process.stdin.on('end', () => process.exit(0))
