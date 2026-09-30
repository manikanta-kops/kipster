import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeInteractions } from '../dist/native-interactions.js'
const context = { interactions: [] }

test('native command approvals match exact actions across provider IDs', () => {
  const params = { threadId: 'old', turnId: 'old', itemId: 'old', command: 'npm test', cwd: '/workspace' }
  const [first] = nativeInteractions(context, 'item/commandExecution/requestApproval', params)
  const answered = { interactions: [{ kind: 'approval', ...first.arguments, response: { answer: { kind: 'approve' } } }] }
  const [same] = nativeInteractions(answered, 'item/commandExecution/requestApproval', { ...params, threadId: 'new', turnId: 'new', itemId: 'new' })
  assert.deepEqual(same.result(same.saved), { decision: 'accept' })
  const [changed] = nativeInteractions(answered, 'item/commandExecution/requestApproval', { ...params, command: 'npm publish' })
  assert.equal(changed.saved, undefined)
  assert.deepEqual(first.result({ kind: 'decline' }), { decision: 'decline' })
  assert.throws(() => nativeInteractions(context, 'item/fileChange/requestApproval', { reason: 'change files' }), /omitted file changes/)
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
  const base = { runId: 'run', attemptId: 'one', organizationId: null, agentId: 'agent', workingDirectory: directory, instructions: '', settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Hello' }], triggerMessageId: 'message', interactions: [] }
  const first = await adapter.execute(base)
  const events = []; for await (const event of first.events) events.push(event)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'interactions.request_approval')
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
})
