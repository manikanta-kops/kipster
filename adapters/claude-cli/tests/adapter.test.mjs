import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdapter } from '../dist/index.js'

const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-claude-'))
  const executable = join(directory, 'claude')
  await writeFile(executable, `#!${process.execPath}\nimport(${JSON.stringify(fake)})\n`)
  await chmod(executable, 0o755)
  const log = join(directory, 'log.jsonl'), modeFile = join(directory, 'mode')
  const home = join(directory, 'agent')
  await mkdir(home)
  const calls = []
  let answer = request => request.name.startsWith('interactions_') ? { status: 'pending', interactionId: `card-${calls.length}` } : { ok: true, echoed: request.arguments }
  const adapter = createAdapter({ dataDirectory: join(directory, 'data'), now: () => new Date().toISOString(), async invokeTool(request) { calls.push(request); return answer(request) } },
    { executable, permissionMode: 'default', environment: { FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE_FILE: modeFile } })
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }) })
  return {
    directory, home, adapter, calls,
    mode: value => writeFile(modeFile, value),
    answer: next => { answer = next },
    records: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  }
}
const tools = [
  { name: 'notes_echo', description: 'Echo a note.', inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
  { name: 'interactions_ask', description: 'Ask.', inputSchema: { type: 'object' }, waits: 'question' },
]
const context = (f, extra = {}) => ({ runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', workingDirectory: f.home, instructions: 'You are Kip.', prompt: 'Core prompt', tools, settings: { adapterId: 'claude-cli', modelId: 'opus', effort: 'high' }, triggerMessageId: 'm1', input: [{ messageId: 'm1', text: 'Hi' }], ...extra })
async function collect(handle) { const events = []; for await (const event of handle.events) events.push(event); return events }
async function ready(f) { await f.mode('chat'); const readiness = await f.adapter.readiness(); assert.equal(readiness.ready, true, readiness.reason); return readiness }

test('readiness reads the live model catalog without spending tokens', async t => {
  const f = await fixture(t)
  const readiness = await ready(f)
  assert.deepEqual(readiness.catalog.models, [{ id: 'opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'haiku' }])
  assert.deepEqual(readiness.catalog.defaultModel, { id: 'opus', effort: 'high' }, 'the CLI default model, with high effort')
  assert.equal(readiness.catalog.capabilities.maintenance, true)
  assert.deepEqual([readiness.recoveryVersions, readiness.recoveryStateScopes], [[1], ['claude-cli-process']])
  const launch = (await f.records()).find(record => record.launch).launch
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) assert.ok(launch.argv.includes(flag), flag)
  await f.mode('signed-out')
  const signedOut = await f.adapter.readiness()
  assert.equal(signedOut.ready, false)
  assert.match(signedOut.reason, /not signed in/)
})

test('configuration is validated by the adapter', () => {
  const host = { dataDirectory: '/tmp/kipster-claude-config', now: () => '', invokeTool: async () => ({}) }
  assert.throws(() => createAdapter(host, { codexHome: '/x' }), /Unknown Claude CLI configuration: codexHome/)
  assert.throws(() => createAdapter(host, { executable: 'relative/claude' }), /absolute executable path/)
  assert.throws(() => createAdapter(host, { permissionMode: 'plan' }), /permissionMode must be one of/)
  assert.throws(() => createAdapter(host, { environment: { HOME: '/elsewhere' } }), /other than HOME/)
})

test('a turn streams text, offers Core tools over MCP and forwards only offered tools', async t => {
  const f = await fixture(t)
  await ready(f)
  const attachment = join(f.directory, 'photo-object')
  await writeFile(attachment, png)
  process.env.KIPSTER_DATABASE_URL = 'postgresql://secret'
  t.after(() => { delete process.env.KIPSTER_DATABASE_URL })
  const events = await collect(await f.adapter.execute(context(f, { input: [{ messageId: 'm1', text: '', parts: [{ kind: 'text', text: 'Look' }, { kind: 'file', artifactId: 'photo', purpose: 'attachment', name: 'photo.png', mimeType: 'image/png', size: png.length, availability: 'available', readablePath: attachment }] }] })))
  const records = await f.records()
  const launch = records.findLast(record => record.launch).launch
  assert.equal(launch.cwd.endsWith('/agent'), true)
  for (const [flag, value] of [['--model', 'opus'], ['--effort', 'high'], ['--permission-mode', 'default'], ['--permission-prompt-tool', 'mcp__kipster_permission__prompt'], ['--disallowedTools', 'mcp__kipster_permission__prompt'], ['--allowedTools', `Read(/${attachment})`]]) assert.equal(launch.argv[launch.argv.indexOf(flag) + 1], value, flag)
  for (const flag of ['--no-session-persistence', '--include-partial-messages']) assert.ok(launch.argv.includes(flag), flag)
  assert.match(launch.instructions, /^You are Kip\.\n\nKipster tools are available to you as MCP tools named mcp__kipster__/)
  assert.equal(launch.mcp.mcpServers.kipster.alwaysLoad, true)
  assert.equal(launch.env.KIPSTER_DATABASE_URL, undefined, 'Core credentials are not inherited')
  assert.equal(launch.env.FAKE_CLAUDE_LOG.endsWith('log.jsonl'), true, 'configured environment is passed')
  const user = records.find(record => record.user).user
  assert.deepEqual(user[0], { type: 'text', text: 'Core prompt' })
  assert.match(user[1].text, /^Visual input for message "m1", part 2, artifact "photo"/)
  assert.deepEqual(user[2], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } })
  assert.deepEqual(records.find(record => record.listed), { listed: ['notes_echo', 'interactions_ask'], permissionListed: ['prompt'] })
  assert.deepEqual(f.calls, [{ attemptId: 'attempt', callId: 'toolu_1', name: 'notes_echo', arguments: { note: 'alpha' } }])
  assert.equal(JSON.parse(records.find(record => record.offered).offered.content[0].text).echoed.note, 'alpha')
  assert.equal(records.find(record => record.unoffered).unoffered.isError, true, 'a tool Core did not offer never reaches Core')
  assert.equal(records.find(record => record.kipsterPermission).kipsterPermission.behavior, 'allow', 'Core decides its own tools')
  assert.equal(records.find(record => record.wrongToken).wrongToken, 401)
  const texts = events.filter(event => event.kind === 'text')
  assert.deepEqual(texts.filter(event => event.final).map(event => [event.messageId, event.text]), [['msg_1:0', 'Hello there'], ['msg_2:0', 'All done']])
  assert.deepEqual(texts.filter(event => !event.final && event.messageId === 'msg_1:0').map(event => event.text), ['Hel', 'Hello ', 'Hello the', 'Hello there'], 'drafts carry accumulated text')
  assert.equal(events[0].kind, 'provider')
  assert.equal(events[0].threadId, '11111111-2222-4333-8444-555555555555')
  assert.deepEqual(events.at(-1), { kind: 'ended', attemptId: 'attempt', confirmed: true })
  assert.deepEqual(await readdir(join(f.directory, 'data', 'attempts')), [], 'per-attempt files are removed')
})

test('a native approval becomes a Core card bound to the exact action, then resumes from the saved answer', async t => {
  const f = await fixture(t)
  await ready(f)
  await f.mode('approve')
  const first = await collect(await f.adapter.execute(context(f)))
  assert.deepEqual(first.slice(1).map(event => event.kind), ['waiting', 'ended'])
  assert.equal(first[1].for, 'approval')
  const card = f.calls[0]
  assert.equal(card.name, 'interactions_request_approval')
  assert.equal(card.callId, 'native:toolu_bash')
  assert.equal(card.arguments.proposal, '{"input":{"command":"touch approved.txt"},"tool":"Bash"}', 'regenerated labels are not part of the approved action')
  assert.match(card.arguments.prompt, /^Claude requests approval to use Bash/)
  const saved = answer => ({ id: 'i1', kind: 'approval', prompt: card.arguments.prompt, options: [], freeText: false, proposalId: card.arguments.proposalId, proposal: card.arguments.proposal, response: { actorId: 'human', answer, acceptedAt: '2026-10-03T00:00:00Z' } })
  const approved = await collect(await f.adapter.execute(context(f, { attemptId: 'attempt-2', interactions: [saved({ kind: 'approve' })] })))
  const records = await f.records()
  assert.equal(records.findLast(record => record.decision).decision.behavior, 'allow')
  assert.match(records.findLast(record => record.again).again.message, /already approved once/, 'one approval allows one action')
  assert.deepEqual(approved.filter(event => event.kind === 'text' && event.final).map(event => event.text), ['Ran it'])
  assert.equal(approved.at(-1).kind, 'ended')
  await collect(await f.adapter.execute(context(f, { attemptId: 'attempt-3', interactions: [saved({ kind: 'decline', comment: 'Not now' })] })))
  assert.deepEqual((await f.records()).findLast(record => record.decision).decision, { behavior: 'deny', message: 'The person declined this action: Not now. Do not retry it.' })
  assert.equal(f.calls.length, 1, 'saved answers create no new cards')
})

test('AskUserQuestion becomes a Core question whose saved answer reaches Claude', async t => {
  const f = await fixture(t)
  await ready(f)
  await f.mode('ask')
  const first = await collect(await f.adapter.execute(context(f)))
  assert.deepEqual(first.slice(1).map(event => event.kind), ['waiting', 'ended'])
  assert.deepEqual(f.calls[0].arguments, { prompt: 'Which city?', options: [{ id: 'option-1', label: 'Paris' }, { id: 'option-2', label: 'Rome' }], freeText: true })
  const saved = { id: 'q1', kind: 'question', prompt: 'Which city?', options: f.calls[0].arguments.options, freeText: true, response: { actorId: 'human', answer: { kind: 'choice', optionId: 'option-2' }, acceptedAt: '2026-10-03T00:00:00Z' } }
  await collect(await f.adapter.execute(context(f, { attemptId: 'attempt-2', interactions: [saved] })))
  const decision = (await f.records()).findLast(record => record.decision).decision
  assert.equal(decision.behavior, 'allow')
  assert.deepEqual(decision.updatedInput.answers, { 'Which city?': 'Rome' })
})

test('a repeated interaction request in one turn is refused and fails the attempt visibly', async t => {
  const f = await fixture(t)
  await ready(f)
  await f.mode('repeat')
  const events = await collect(await f.adapter.execute(context(f)))
  assert.equal(f.calls.length, 1)
  assert.equal(events.filter(event => event.kind === 'waiting').length, 1)
  assert.equal((await f.records()).find(record => record.second).second.isError, true)
  assert.match(events.at(-1).message, /repeated an interaction/)
})

test('a failed turn and a cancelled turn end visibly with confirmed process exit', async t => {
  const f = await fixture(t)
  await ready(f)
  await f.mode('error')
  const failed = await collect(await f.adapter.execute(context(f)))
  assert.deepEqual(failed.at(-1), { kind: 'failed', attemptId: 'attempt', confirmedEnded: true, message: 'Claude turn failed: API Error: overloaded' })
  await f.mode('hang')
  const handle = await f.adapter.execute(context(f, { attemptId: 'attempt-2' }))
  const events = collect(handle)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await handle.reconcile(), 'active')
  assert.deepEqual(await handle.cancel(), { acknowledged: true, confirmedEnded: true })
  assert.deepEqual((await events).at(-1), { kind: 'failed', attemptId: 'attempt-2', confirmedEnded: true, message: 'Claude turn cancelled' })
  assert.equal(await handle.reconcile(), 'ended')
})

test('maintenance runs isolated with the schema Core supplies and returns its structured output', async t => {
  const f = await fixture(t)
  await ready(f)
  await f.mode('maintenance')
  const schema = { type: 'object', required: ['candidates'], properties: { candidates: { type: 'array' } } }
  const maintenance = { kind: 'maintenance', runId: 'mr', attemptId: 'm1', organizationId: null, agentId: 'agent', maintenance: { task: 'extract', sourceRunId: 's', sourceRevision: 1, contextKind: 'installation', contextId: 'i', instructions: 'Extract.', sources: [], outputSchema: schema, settings: { adapterId: 'claude-cli', modelId: 'haiku' } } }
  const events = await collect(await f.adapter.execute(maintenance))
  assert.deepEqual(events.map(event => event.kind), ['provider', 'text', 'ended'])
  assert.equal(events[1].text, '{"candidates":[]}')
  assert.equal(events[0].providerStateScope, 'claude-cli-process')
  const records = await f.records()
  const launch = records.findLast(record => record.launch).launch
  assert.equal(launch.argv[launch.argv.indexOf('--json-schema') + 1], JSON.stringify(schema))
  assert.equal(launch.argv[launch.argv.indexOf('--tools') + 1], '')
  assert.equal(launch.argv[launch.argv.indexOf('--session-id') + 1], events[0].threadId)
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(launch.argv.includes(flag), flag)
  assert.equal(launch.argv.includes('--mcp-config'), false)
  assert.deepEqual(records.findLast(record => record.user).user, [{ type: 'text', text: 'Extract.' }])
  assert.deepEqual(await readdir(join(f.directory, 'data', 'maintenance', 'processes')), [], 'the process record is removed after the end is confirmed')
  await f.mode('maintenance-leak')
  const leaked = await collect(await f.adapter.execute({ ...maintenance, attemptId: 'm2' }))
  assert.match(leaked.at(-1).message, /isolation check failed/)
  const unknown = await collect(await f.adapter.execute({ ...maintenance, attemptId: 'm3', maintenance: { ...maintenance.maintenance, task: 'summarize' } }))
  assert.deepEqual(unknown, [{ kind: 'failed', attemptId: 'm3', confirmedEnded: true, message: 'Unsupported maintenance task' }])
})

test('durable reconciliation confirms an end only when the recorded process group is gone', async t => {
  const f = await fixture(t)
  const ref = providerIds => ({ adapterId: 'claude-cli', contractMajor: 1, recoveryVersion: 1, stateScope: 'claude-cli-process', providerIds })
  assert.equal((await f.adapter.durableReconcile({ recoveryRef: { ...ref({}), stateScope: 'shared-codex-home' } })).outcome, 'unknown')
  assert.equal((await f.adapter.durableReconcile({ recoveryRef: ref({ processId: 2 ** 22 - 3, threadId: '11111111-2222-4333-8444-555555555555' }) })).outcome, 'ended')
  assert.equal((await f.adapter.durableReconcile({ recoveryRef: ref({ processId: process.pid, threadId: '11111111-2222-4333-8444-555555555555' }) })).outcome, 'unknown', 'a live process without its record is unknown')
})
