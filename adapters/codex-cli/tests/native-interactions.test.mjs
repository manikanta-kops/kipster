import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeInteractions } from '../dist/native-interactions.js'
const context = { interactions: [] }

test('native command approvals match exact actions across provider IDs', () => {
  const params = { threadId: 'old', turnId: 'old', itemId: 'old', approvalId: 'old', startedAtMs: 1, reason: 'run tests', command: 'npm test', cwd: '/workspace' }
  const [first] = nativeInteractions(context, 'item/commandExecution/requestApproval', params)
  const answered = { interactions: [{ kind: 'approval', ...first.arguments, response: { answer: { kind: 'approve' } } }] }
  const [same] = nativeInteractions(answered, 'item/commandExecution/requestApproval', { ...params, threadId: 'new', turnId: 'new', itemId: 'new', approvalId: 'new', startedAtMs: 2, reason: 'reworded' })
  assert.deepEqual(same.result(same.saved), { decision: 'accept' })
  const [changed] = nativeInteractions(answered, 'item/commandExecution/requestApproval', { ...params, command: 'npm publish' })
  assert.equal(changed.saved, undefined)
  assert.deepEqual(first.result({ kind: 'decline' }), { decision: 'decline' })
  assert.throws(() => nativeInteractions(context, 'item/fileChange/requestApproval', { reason: 'change files' }), /omitted file changes/)
})

const computerUse = (app, shown, callId, session) => ({ mode: 'form', serverName: 'cua_repl', message: `Allow Computer Use to use "${shown}"?`, requestedSchema: { type: 'object', properties: {} }, _meta: {
  callId, codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use', persist: ['session', 'always'], riskLevel: 'high',
  subtitle: 'Using this app carries risks.', tool_name: 'get_app_state', tool_params: { app }, tool_params_display: [{ display_name: 'App', name: 'app', value: shown }],
  'x-codex-turn-metadata': { session_id: session, thread_id: session, turn_id: session, turn_started_at_unix_ms: Date.now() },
} })

test('Computer Use approvals read plainly, match across attempts and offer a per-app grant', () => {
  const [card] = nativeInteractions(context, 'mcpServer/elicitation/request', computerUse('company.thebrowser.Browser', 'Arc', 'call-1', 's1'))
  assert.equal(card.arguments.prompt, 'Allow Computer Use to use "Arc"?\nApp: Arc\nUsing this app carries risks.')
  assert.deepEqual(card.arguments.grant, { key: 'codex-cli:mcp:cua_repl:computer-use:app:company.thebrowser.Browser', label: 'Computer Use in Arc', scopes: ['conversation', 'always'] })
  assert.doesNotMatch(card.arguments.proposal, /call-1|s1/)
  const answered = { interactions: [{ kind: 'approval', ...card.arguments, response: { answer: { kind: 'approve' } } }] }
  const [again] = nativeInteractions(answered, 'mcpServer/elicitation/request', computerUse('company.thebrowser.Browser', 'Arc', 'call-2', 's2'))
  assert.deepEqual(again.saved, { kind: 'approve' })
  assert.equal(again.granted, undefined)
  const [granted] = nativeInteractions({ interactions: [], approvalGrants: [card.arguments.grant.key] }, 'mcpServer/elicitation/request', { ...computerUse('company.thebrowser.Browser', 'Arc', 'call-3', 's3'), _meta: { ...computerUse('company.thebrowser.Browser', 'Arc', 'call-3', 's3')._meta, tool_name: 'click', tool_params: { app: 'company.thebrowser.Browser', x: 4, y: 2 } } })
  assert.equal(granted.granted, true)
  assert.deepEqual(granted.result(granted.saved), { action: 'accept', content: {}, _meta: null })
  const [chrome] = nativeInteractions({ interactions: [], approvalGrants: [card.arguments.grant.key] }, 'mcpServer/elicitation/request', computerUse('com.google.Chrome', 'Google Chrome', 'call-4', 's4'))
  assert.equal(chrome.saved, undefined)
  const [plain] = nativeInteractions(context, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'browser', message: 'Allow browser?', requestedSchema: { type: 'object', properties: {} } })
  assert.equal(plain.arguments.grant, undefined)
})

test('command, edit and permission approvals offer grants that match their action', () => {
  const [command] = nativeInteractions(context, 'item/commandExecution/requestApproval', { command: 'npm test', cwd: '/work', reason: 'Run the suite' })
  assert.equal(command.arguments.prompt, 'Run `npm test`?\nRun the suite\nIn /work')
  assert.deepEqual(command.arguments.grant, { key: 'codex-cli:command:npm test', label: 'Run npm test', scopes: ['conversation', 'always'] })
  const [edit] = nativeInteractions(context, 'item/fileChange/requestApproval', { changes: [{ path: '/work/b.ts' }, { path: '/work/a.ts' }] })
  assert.equal(edit.arguments.prompt, 'Edit 2 files?\n/work/a.ts\n/work/b.ts')
  assert.deepEqual(edit.arguments.grant.scopes, ['conversation'])
  const [permissions] = nativeInteractions(context, 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } })
  assert.equal(permissions.arguments.prompt, 'Allow extra access?\nNetwork access')
  const [granted] = nativeInteractions({ interactions: [], approvalGrants: ['codex-cli:command:npm test'] }, 'item/commandExecution/requestApproval', { command: 'npm test', cwd: '/elsewhere' })
  assert.deepEqual(granted.result(granted.saved), { decision: 'accept' })
})

test('full access allows every provider approval without a card, but still asks questions', () => {
  const full = { interactions: [], permissionMode: 'fullAccess' }
  for (const [method, params] of [['item/commandExecution/requestApproval', { command: 'rm -rf build' }], ['mcpServer/elicitation/request', computerUse('com.google.Chrome', 'Google Chrome', 'c', 's')]]) {
    const [approval] = nativeInteractions(full, method, params)
    assert.equal(approval.granted, true)
    assert.equal(approval.saved.kind, 'approve')
  }
  const [question] = nativeInteractions(full, 'item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Which?' }] })
  assert.equal(question.saved, undefined)
})

test('native choices and free text translate saved Core answers', () => {
  const params = { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] }
  const [first] = nativeInteractions(context, 'item/tool/requestUserInput', params)
  assert.equal(first.kind, 'question')
  assert.deepEqual(first.result({ kind: 'choice', optionId: 'option-2' }), { answers: { q1: { answers: ['Two'] } } })
  assert.deepEqual(first.result({ kind: 'text', text: 'Custom' }), { answers: { q1: { answers: ['Custom'] } } })
  assert.deepEqual(first.result({ kind: 'dismiss' }), { answers: { q1: { answers: [] } } })
  const answered = { interactions: [{ kind: 'question', ...first.arguments, response: { answer: { kind: 'text', text: 'Custom' } } }] }
  assert.deepEqual(nativeInteractions(answered, 'item/tool/requestUserInput', params)[0].saved, { kind: 'text', text: 'Custom' })
  assert.throws(() => nativeInteractions(context, 'item/tool/requestUserInput', { questions: [{ id: 'secret', question: 'Password?', isSecret: true }] }), /Unsupported/)
})

test('MCP consent is explicit and unknown forms fail rather than hanging', () => {
  const [consent] = nativeInteractions(context, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'browser', message: 'Allow browser?', requestedSchema: { type: 'object', properties: {} } })
  assert.deepEqual(consent.result({ kind: 'approve' }), { action: 'accept', content: {}, _meta: null })
  assert.deepEqual(consent.result({ kind: 'decline' }), { action: 'decline', content: null, _meta: null })
  assert.throws(() => nativeInteractions(context, 'unknown/method', {}), /Unsupported Codex server request/)
})

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

test('native approval yields a durable card, ends its process, and consumes the exact saved answer on continuation', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-native-'))
  const home = join(directory, 'user'), executable = join(directory, 'codex'), receipt = join(directory, 'receipt')
  await mkdir(home)
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline'),fs=require('node:fs');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{}}});
 else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread-'+process.pid}}});
 else if(x.method==='turn/start'){
  send({id:x.id,result:{turn:{id:'turn'}}});
  send({id:1,method:'item/commandExecution/requestApproval',params:{threadId:x.params.threadId,turnId:'turn',itemId:'item',command:'echo hello',cwd:'/workspace'}});
  global.thread=x.params.threadId;
 } else if(x.id===1 && !x.method){
  fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(x.result));
  send({method:'turn/completed',params:{threadId:global.thread,turn:{id:'turn',status:'completed'}}});
 }
});
`, { mode: 0o700 })
  const calls = []
  const adapter = createAdapter({ dataDirectory: join(directory, 'state'), now: () => '', async invokeTool(request) { calls.push(request); return { status: 'pending', interactionId: 'card' } } }, { executable, codexHome: home })
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await adapter.readiness()).ready, true)
  const base = { runId: 'run', attemptId: 'one', organizationId: null, agentId: 'agent', workingDirectory: directory, instructions: '',prompt:'Current message', settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Hello' }], triggerMessageId: 'message', interactions: [] }
  const first = await adapter.execute(base)
  const events = []; for await (const event of first.events) events.push(event)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'interactions_request_approval')
  assert.equal(events.find(x => x.kind === 'waiting').interactionId, 'card')
  assert.equal(events.at(-1).kind, 'ended')
  assert.equal(events.at(-1).confirmed, true)
  const pid = events.find(x => x.kind === 'provider').processId
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const next = await adapter.execute({ ...base, attemptId: 'two', interactions: [{ kind: 'approval', ...calls[0].arguments, response: { answer: { kind: 'approve' } } }] })
  const resumed = []; for await (const event of next.events) resumed.push(event)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { decision: 'accept' })
  assert.equal(resumed.at(-1).kind, 'ended')
  await rm(receipt)
  const granted = await adapter.execute({ ...base, attemptId: 'three', approvalGrants: [calls[0].arguments.grant.key] })
  const allowed = []; for await (const event of granted.events) allowed.push(event)
  assert.equal(calls.length, 1, 'a granted action asks nobody')
  assert.equal(allowed.some(x => x.kind === 'waiting'), false)
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), { decision: 'accept' })
})
