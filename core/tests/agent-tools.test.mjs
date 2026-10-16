import test from 'node:test'
import assert from 'node:assert/strict'
import { executionTools, memoryGuidance, toolGuidance } from '../dist/workflows/agent-tools.js'
import { adminSkill, skillsSection } from '../dist/workflows/skills.js'
import { textPublicationHost } from '../dist/runtime.js'
import { access, readFile } from 'node:fs/promises'

const all = { organization: true, structured: true, vectors: true, administration: true }
const names = scope => executionTools(scope).map(tool => tool.name)

test('Core offers each execution the tools its scope allows, with provider-safe names and JSON Schemas', () => {
  const base = names({ organization: false, structured: false, vectors: false, administration: false })
  assert.deepEqual(base, ['post_chat_message', 'transcribe_voice_note', 'ask_user_question', 'request_user_approval', 'list_kips', 'get_kip', 'message_kip', 'create_rich_doc', 'list_rich_docs', 'read_rich_doc', 'edit_rich_doc', 'delete_rich_doc'])
  const full = names(all)
  assert.deepEqual(full.filter(name => !base.includes(name)), ['copy_attachment_to_workspace', 'manage_data_tables', 'manage_vector_collections', 'list_admin_operations', 'run_admin_operation'])
  for (const tool of executionTools(all)) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
  }
  const waits = Object.fromEntries(executionTools(all).filter(tool => tool.waits).map(tool => [tool.name, tool.waits]))
  // A kip message never pauses the sender's turn.
  assert.deepEqual(waits, { ask_user_question: 'question', request_user_approval: 'approval' })
  assert.deepEqual(names({ ...all, memory: true }).filter(name => !full.includes(name)), ['search_memory', 'list_recent_threads', 'read_thread', 'save_memory', 'forget_memory'])
  assert.match(memoryGuidance, /search_memory/)
  const dataTables = executionTools(all).find(tool => tool.name === 'manage_data_tables')
  assert.equal(dataTables.inputSchema.properties.sql, undefined, 'task data takes no raw SQL')
  const outside = toolGuidance({ organization: false }), inside = toolGuidance({ organization: true })
  assert.match(outside, /post_chat_message/)
  assert.match(outside, /create_rich_doc/)
  assert.match(outside, /message_kip/)
  assert.match(outside, /end your turn with an empty reply/)
  assert.doesNotMatch(outside, /delegat/)
  assert.match(outside, /call post_chat_message with their paths in `files`/)
  assert.doesNotMatch(outside, /artifacts_write|artifacts_publish|harness tools|unavailable Kipster capabilities/)
  assert.doesNotMatch(outside, /copy_attachment_to_workspace/, 'the copy tool is named only where it is offered')
  assert.match(inside, /copy_attachment_to_workspace/)
  for (const name of ['post_chat_message', 'message_kip']) assert.deepEqual(executionTools(all).find(tool => tool.name === name).inputSchema.properties.files.items, { type: 'string' })
  assert.match(executionTools(all).find(tool => tool.name === 'edit_rich_doc').description, /```question/)
})

test('only the admin kip gets the fields that reach other workspaces and kips, and no tool names Kip', () => {
  const field = (scope, tool, name) => executionTools(scope).find(item => item.name === tool)?.inputSchema.properties[name]
  const admin = { organization: false, structured: false, vectors: false, administration: true, memory: true, admin: true }
  const member = { organization: true, structured: false, vectors: false, administration: false, memory: true }
  assert.deepEqual(executionTools(admin).find(tool => tool.name === 'copy_attachment_to_workspace').inputSchema.required, ['artifactId', 'workspaceId'])
  for (const [tool, name] of [['message_kip', 'workspaceId'], ['create_rich_doc', 'workspaceId'], ['search_memory', 'agent'], ['list_recent_threads', 'agent']]) {
    assert.ok(field(admin, tool, name), `${tool}.${name} for the admin kip`)
    assert.equal(field(member, tool, name), undefined, `${tool}.${name} only for the admin kip`)
  }
  assert.equal(field(member, 'copy_attachment_to_workspace', 'workspaceId'), undefined)
  assert.match(executionTools(admin).find(tool => tool.name === 'list_kips').description, /every kip with the workspaces/)
  assert.match(toolGuidance({ organization: false, admin: true }), /copy_attachment_to_workspace with its workspaceId/)
  for (const scope of [admin, member]) assert.doesNotMatch(JSON.stringify(executionTools(scope)) + toolGuidance(scope), /\bKip\b/)
})

test('every offered tool name reaches its Core handler', async () => {
  const seen = []
  const record = method => async (...args) => { seen.push([method, ...args.filter(arg => typeof arg === 'string' && /[._]/.test(arg))]); return { status: 'pending', interactionId: 'card' } }
  const dispatcher = Object.fromEntries(['publishToolText', 'askToolInteraction', 'structuredTool', 'vectorTool', 'copyArtifactTool', 'transcribeTool', 'agentTool', 'adminTool', 'documentTool', 'memoryTool'].map(method => [method, record(method)]))
  const host = textPublicationHost(dispatcher)
  const valid = { post_chat_message: { text: 'Hi' }, transcribe_voice_note: { artifactId: 'a' }, copy_attachment_to_workspace: { artifactId: 'a' } }
  const offered = names({ ...all, memory: true })
  for (const name of offered) await host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: valid[name] ?? {} })
  const routed = Object.fromEntries(seen.map(([method, ...rest], index) => [offered[index], [method, rest.at(-1)]]))
  assert.deepEqual(routed.read_thread, ['memoryTool', 'read_thread'])
  assert.deepEqual(routed.message_kip, ['agentTool', 'agents.message'])
  for (const name of ['delegate_to_kip', 'check_kip_task']) await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: {} }), /Unsupported Kipster tool/)
  assert.deepEqual(routed.run_admin_operation, ['adminTool', 'run_admin_operation'])
  assert.deepEqual(routed.manage_data_tables[0], 'structuredTool')
  assert.deepEqual(routed.manage_vector_collections[0], 'vectorTool')
  assert.deepEqual(routed.edit_rich_doc, ['documentTool', 'documents.edit'])
  for (const name of ['memory_save', 'memory_link', 'data_space', 'vectors_space', 'artifacts_write', 'artifacts_publish']) await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: {} }), /Unsupported Kipster tool/)
})

test('the admin skill ships with Core and is named in the instructions with its path', async () => {
  await access(adminSkill.path)
  assert.match(await readFile(adminSkill.path, 'utf8'), /^---\nname: kipster-admin\n/)
  assert.equal(skillsSection([]), '')
  assert.match(skillsSection([adminSkill]), new RegExp(`kipster-admin: .* File: ${adminSkill.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
})
