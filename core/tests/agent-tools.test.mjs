import test from 'node:test'
import assert from 'node:assert/strict'
import { executionTools, memoryGuidance } from '../dist/workflows/agent-tools.js'
import { kipInstructions } from '../dist/workflows/kip-instructions.js'
import { adminSkill, skillsSection } from '../dist/workflows/skills.js'
import { textPublicationHost } from '../dist/runtime.js'
import { access, readFile } from 'node:fs/promises'

const all = { organization: true, structured: true, vectors: true, administration: true }
const names = scope => executionTools(scope).map(tool => tool.name)
const instructionsFor = scope => kipInstructions({ kipLine: '', admin: !!scope.admin, workspace: !!scope.organization })

test('Core offers each execution the tools its scope allows, with provider-safe names and JSON Schemas', () => {
  const base = names({ organization: false, structured: false, vectors: false, administration: false })
  assert.deepEqual(base, ['message_user', 'transcribe_media', 'list_kips', 'get_kip', 'message_kip', 'create_rich_doc', 'list_rich_docs', 'read_rich_doc', 'edit_rich_doc', 'delete_rich_doc', 'create_routine', 'edit_routine', 'list_routines', 'delete_routine'])
  const full = names(all)
  assert.deepEqual(full.filter(name => !base.includes(name)), ['copy_attachment_to_workspace', 'manage_data_tables', 'manage_vector_collections', 'list_admin_operations', 'run_admin_operation'])
  for (const tool of executionTools(all)) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
  }
  // A pending result, not the tool, leaves a run waiting.
  assert.equal(executionTools(all).filter(tool => tool.waits).length, 0)
  const messageUser = executionTools(all).find(tool => tool.name === 'message_user').inputSchema
  assert.deepEqual(messageUser.required, ['priority'])
  assert.deepEqual(messageUser.properties.priority.enum, ['silent', 'normal'])
  assert.deepEqual(Object.keys(messageUser.properties.attachments.items.properties), ['path', 'artifactId', 'documentId'])
  assert.deepEqual(messageUser.properties.element.properties.type.enum, ['choice', 'approval'])
  assert.deepEqual(Object.keys(executionTools(all).find(tool => tool.name === 'message_kip').inputSchema.properties.attachments.items.properties), ['path', 'artifactId'])
  assert.deepEqual(names({ ...all, memory: true }).filter(name => !full.includes(name)), ['search_memory', 'list_threads', 'read_thread', 'save_memory', 'forget_memory'])
  // The admin kip lists and reads every kip's threads with memory off too; only memory-on adds the other memory tools.
  assert.deepEqual(names({ ...all, admin: true }).filter(name => !full.includes(name)), ['list_threads', 'read_thread'])
  assert.deepEqual(names({ ...all, admin: true, linked: true }), names({ ...all, admin: true }))
  assert.deepEqual(names({ ...all, admin: true, memory: true }).filter(name => !full.includes(name)), ['search_memory', 'list_threads', 'read_thread', 'save_memory', 'forget_memory'])
  assert.match(memoryGuidance, /list_threads with notSearchable true/)
  assert.match(memoryGuidance, /search_memory/)
  // A linked thread offers read_thread for its source thread with memory off, and once with memory on.
  assert.deepEqual(names({ ...all, linked: true }).filter(name => !full.includes(name)), ['read_thread'])
  assert.match(executionTools({ ...all, linked: true }).find(tool => tool.name === 'read_thread').description, /^Read the conversation this linked thread's kip messages come from, by position/)
  assert.deepEqual(names({ ...all, memory: true, linked: true }), names({ ...all, memory: true }))
  const dataTables = executionTools(all).find(tool => tool.name === 'manage_data_tables')
  assert.equal(dataTables.inputSchema.properties.sql, undefined, 'task data takes no raw SQL')
  const outside = instructionsFor({ organization: false }), inside = instructionsFor({ organization: true })
  assert.match(outside, /For several questions at once, write a rich doc/)
  assert.match(outside, /create a rich doc with create_rich_doc and send it with message_user/)
  assert.match(outside, /something done later or on a repeat, create a routine with create_routine/)
  assert.match(outside, /answer it with message_kip to that kip/i)
  assert.match(outside, /or end your turn without a message/)
  assert.doesNotMatch(outside, /delegat|post_chat_message|ask_user_question|request_user_approval|final reply is your answer/)
  assert.match(outside, /Attach files you create or download by path/)
  assert.doesNotMatch(outside, /artifacts_write|artifacts_publish|harness tools|unavailable Kipster capabilities/)
  assert.doesNotMatch(outside, /copy_attachment_to_workspace/, 'the copy tool is named only where it is offered')
  assert.match(inside, /copy_attachment_to_workspace/)
  assert.match(executionTools(all).find(tool => tool.name === 'edit_rich_doc').description, /```question/)
})

test('only the admin kip gets the fields that reach other workspaces and kips, and no tool names Kip', () => {
  const field = (scope, tool, name) => executionTools(scope).find(item => item.name === tool)?.inputSchema.properties[name]
  const admin = { organization: false, structured: false, vectors: false, administration: true, memory: true, admin: true }
  const member = { organization: true, structured: false, vectors: false, administration: false, memory: true }
  assert.deepEqual(executionTools(admin).find(tool => tool.name === 'copy_attachment_to_workspace').inputSchema.required, ['artifactId', 'workspaceId'])
  for (const [tool, name] of [['message_kip', 'workspaceId'], ['create_rich_doc', 'workspaceId'], ['search_memory', 'agent'], ['list_threads', 'agentId']]) {
    assert.ok(field(admin, tool, name), `${tool}.${name} for the admin kip`)
    assert.equal(field(member, tool, name), undefined, `${tool}.${name} only for the admin kip`)
  }
  assert.equal(field(member, 'copy_attachment_to_workspace', 'workspaceId'), undefined)
  assert.match(executionTools(admin).find(tool => tool.name === 'list_kips').description, /every kip with the workspaces/)
  assert.match(instructionsFor({ organization: false, admin: true }), /copy_attachment_to_workspace with its workspaceId/)
  assert.match(instructionsFor({ organization: false, admin: true }), /what other kips are doing or have done, list their threads with list_threads/)
  assert.doesNotMatch(instructionsFor({ organization: true }), /list_threads/)
  for (const scope of [admin, member]) assert.doesNotMatch(JSON.stringify(executionTools(scope)) + instructionsFor(scope), /\bKip\b/)
})

test('every offered tool name reaches its Core handler', async () => {
  const seen = []
  const record = method => async (...args) => { seen.push([method, ...args.filter(arg => typeof arg === 'string' && /[._]/.test(arg))]); return { status: 'pending', interactionId: 'card' } }
  const dispatcher = Object.fromEntries(['messageUserTool', 'askToolInteraction', 'structuredTool', 'vectorTool', 'copyArtifactTool', 'transcribeTool', 'transcribePathTool', 'agentTool', 'adminTool', 'documentTool', 'memoryTool', 'routineTool'].map(method => [method, record(method)]))
  const host = textPublicationHost(dispatcher)
  const valid = { message_user: { text: 'Hi', priority: 'normal' }, transcribe_media: { artifactId: 'a' }, copy_attachment_to_workspace: { artifactId: 'a' } }
  const offered = names({ ...all, memory: true })
  for (const name of offered) await host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: valid[name] ?? {} })
  const routed = Object.fromEntries(seen.map(([method, ...rest], index) => [offered[index], [method, rest.at(-1)]]))
  assert.equal(routed.message_user[0], 'messageUserTool')
  assert.deepEqual(routed.read_thread, ['memoryTool', 'read_thread'])
  assert.deepEqual(routed.message_kip, ['agentTool', 'agents.message'])
  assert.equal(routed.transcribe_media[0], 'transcribeTool')
  seen.length = 0
  await host.invokeTool({ attemptId: 'attempt', callId: 'call', name: 'transcribe_media', arguments: { path: '/tmp/talk.mp4' } })
  assert.deepEqual(seen, [['transcribePathTool', '/tmp/talk.mp4']])
  for (const args of [{}, { artifactId: 'a', path: '/tmp/talk.mp4' }, { path: 1 }]) await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name: 'transcribe_media', arguments: args }), /artifactId or path/)
  for (const name of ['delegate_to_kip', 'check_kip_task', 'post_chat_message']) await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: {} }), /Unsupported Kipster tool/)
  // Questions and approvals by name are only an adapter's way to show a provider's own.
  const question = { prompt: 'Pick', options: [{ id: 'a', label: 'A' }], freeText: false }
  await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name: 'ask_user_question', arguments: question }), /Unsupported Kipster tool/)
  seen.length = 0
  await host.invokeTool({ attemptId: 'attempt', callId: 'native:call', name: 'ask_user_question', arguments: question })
  assert.deepEqual(seen.map(([method]) => method), ['askToolInteraction'])
  assert.deepEqual(routed.run_admin_operation, ['adminTool', 'run_admin_operation'])
  assert.deepEqual(routed.manage_data_tables[0], 'structuredTool')
  assert.deepEqual(routed.manage_vector_collections[0], 'vectorTool')
  assert.deepEqual(routed.edit_rich_doc, ['documentTool', 'documents.edit'])
  assert.deepEqual(routed.create_routine, ['routineTool', 'create_routine'])
  assert.deepEqual(routed.delete_routine, ['routineTool', 'delete_routine'])
  for (const name of ['memory_save', 'memory_link', 'data_space', 'vectors_space', 'artifacts_write', 'artifacts_publish']) await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: {} }), /Unsupported Kipster tool/)
})

test('the admin skill ships with Core and is named in the instructions with its path', async () => {
  await access(adminSkill.path)
  assert.match(await readFile(adminSkill.path, 'utf8'), /^---\nname: kipster-admin\n/)
  assert.equal(skillsSection([]), '')
  assert.match(skillsSection([adminSkill]), new RegExp(`kipster-admin: .* File: ${adminSkill.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
})
