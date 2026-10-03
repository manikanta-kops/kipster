import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

// A fake Codex app server records the thread start and the answer to each tool call. In its turn it calls an
// offered tool, then a tool Core did not offer.
async function fakeCodex(directory) {
  const executable = join(directory, 'codex')
  const log = join(directory, 'log.jsonl')
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(x.method==='initialize')send({id:x.id,result:{}});
else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
else if(x.method==='thread/start'){record({instructions:x.params.baseInstructions,tools:x.params.dynamicTools});send({id:x.id,result:{thread:{id:'thread-1'}}})}
else if(x.method==='turn/start'){
 record({input:x.params.input});
 send({id:x.id,result:{turn:{id:'turn-1'}}});
 setTimeout(()=>send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-1',tool:'admin_call',arguments:{operation:'agents.create',operationId:'stable-create',arguments:{name:'Scout'}}}}),10);
}else if(x.id===101){record({answer:101,success:x.result.success});send({id:102,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call-2',tool:'admin_agents_create',arguments:{name:'Scout'}}})}
else if(x.id===102){record({answer:102,success:x.result.success});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})}
});
`)
  await chmod(executable, 0o755)
  return async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

const tools = [
  { name: 'conversation_publish', description: 'Publish a message.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false } },
  { name: 'admin_call', description: 'Run one administration operation.', inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'] } },
]

test('Core tools, instructions and prompt reach Codex unchanged, and only offered tools are forwarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-tools-'))
  const read = await fakeCodex(directory)
  const previous = process.env.PATH
  process.env.PATH = `${directory}:${previous}`
  process.env.CODEX_HOME = join(directory, 'user-codex')
  await mkdir(process.env.CODEX_HOME, { recursive: true })
  const calls = []
  const adapter = createAdapter({ dataDirectory: join(directory, 'codex-data'), now: () => new Date().toISOString(), async invokeTool(request) { calls.push(request); return { ok: true } } })
  try {
    assert.equal((await adapter.readiness()).ready, true)
    const handle = await adapter.execute({ runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'admin', workingDirectory: directory, instructions: 'Core instructions', prompt: 'Core prompt', tools, settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Add Scout' }] })
    const events = []
    for await (const event of handle.events) events.push(event)
    const log = await read()
    assert.equal(log[0].instructions, 'Core instructions')
    assert.deepEqual(log[0].tools, tools.map(tool => ({ type: 'function', ...tool })))
    assert.deepEqual(calls, [{ attemptId: 'attempt', callId: 'call-1', name: 'admin_call', arguments: { operation: 'agents.create', operationId: 'stable-create', arguments: { name: 'Scout' } } }])
    assert.deepEqual(log.filter(item => item.answer), [{ answer: 101, success: true }, { answer: 102, success: false }], 'a tool Core did not offer is refused before it reaches Core')
    assert.deepEqual(log.find(item => item.input).input, [{ type: 'text', text: 'Core prompt' }], 'Core renders the turn; the adapter sends it unchanged')
    assert.equal(events.at(-1).kind, 'ended')
  } finally {
    await adapter.close()
    process.env.PATH = previous
    await rm(directory, { recursive: true, force: true })
  }
})
