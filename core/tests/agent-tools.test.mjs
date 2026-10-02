import test from 'node:test'
import assert from 'node:assert/strict'
import { executionTools, toolGuidance } from '../dist/workflows/agent-tools.js'
import { adminSkill, skillsSection } from '../dist/workflows/skills.js'
import { textPublicationHost } from '../dist/runtime.js'
import { access, readFile } from 'node:fs/promises'

const all = { organization: true, memory: true, structured: true, vectors: true, administration: true }
const names = scope => executionTools(scope).map(tool => tool.name)

test('Core offers each execution the tools its scope allows, with provider-safe names and JSON Schemas', () => {
  const base = names({ organization: false, memory: false, structured: false, vectors: false, administration: false })
  assert.deepEqual(base, ['conversation_publish', 'audio_transcribe', 'artifacts_write', 'artifacts_publish', 'interactions_ask', 'interactions_request_approval', 'agents_list', 'agents_get', 'agents_delegate', 'agents_delegation_status'])
  const full = names(all)
  assert.deepEqual(full.filter(name => !base.includes(name)), ['artifacts_copy_to_organization', 'memory_save', 'memory_search', 'memory_get', 'memory_correct', 'memory_publish', 'memory_link', 'memory_relationship_get', 'memory_relationship_list', 'memory_relationship_update', 'memory_unlink', 'data_space', 'vectors_space', 'admin_operations', 'admin_call'])
  for (const tool of executionTools(all)) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
  }
  const waits = Object.fromEntries(executionTools(all).filter(tool => tool.waits).map(tool => [tool.name, tool.waits]))
  assert.deepEqual(waits, { interactions_ask: 'question', interactions_request_approval: 'approval', agents_delegate: 'child' })
  const dataSpace = executionTools(all).find(tool => tool.name === 'data_space')
  assert.equal(dataSpace.inputSchema.properties.sql, undefined, 'task data takes no raw SQL')
  assert.match(toolGuidance, /conversation_publish/)
})

test('every offered tool name reaches its Core handler', async () => {
  const seen = []
  const record = method => async (...args) => { seen.push([method, ...args.filter(arg => typeof arg === 'string' && /[._]/.test(arg))]); return { status: 'pending', interactionId: 'card' } }
  const dispatcher = Object.fromEntries(['publishToolText', 'askToolInteraction', 'memoryTool', 'structuredTool', 'vectorTool', 'writeArtifactTool', 'publishArtifactTool', 'copyArtifactTool', 'transcribeTool', 'agentTool', 'adminTool'].map(method => [method, record(method)]))
  const host = textPublicationHost(dispatcher)
  const valid = { conversation_publish: { text: 'Hi' }, audio_transcribe: { artifactId: 'a' }, artifacts_write: { name: 'a.txt', content: 'x' }, artifacts_publish: { outputId: 'o' }, artifacts_copy_to_organization: { artifactId: 'a' } }
  for (const name of names(all)) await host.invokeTool({ attemptId: 'attempt', callId: 'call', name, arguments: valid[name] ?? {} })
  const routed = Object.fromEntries(seen.map(([method, ...rest], index) => [names(all)[index], [method, rest.at(-1)]]))
  assert.deepEqual(routed.memory_relationship_get, ['memoryTool', 'memory.relationship_get'])
  assert.deepEqual(routed.agents_delegation_status, ['agentTool', 'agents.delegation_status'])
  assert.deepEqual(routed.admin_call, ['adminTool', 'admin_call'])
  assert.deepEqual(routed.data_space[0], 'structuredTool')
  await assert.rejects(host.invokeTool({ attemptId: 'attempt', callId: 'call', name: 'memory.save', arguments: {} }), /Unsupported Kipster tool/)
})

test('the admin skill ships with Core and is named in the instructions with its path', async () => {
  await access(adminSkill.path)
  assert.match(await readFile(adminSkill.path, 'utf8'), /^---\nname: kipster-admin\n/)
  assert.equal(skillsSection([]), '')
  assert.match(skillsSection([adminSkill]), new RegExp(`kipster-admin: .* File: ${adminSkill.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
})
