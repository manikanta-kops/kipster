import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

test('native images reach Codex with tools inherited; message deltas remain independent', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-deltas-'))
  const home = join(directory, 'user'), executable = join(directory, 'codex')
  await mkdir(home)
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{}}});
 else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread'}}});
 else if(x.method==='turn/start'){
  if(x.params.input[2]?.type!=='localImage'||x.params.input[2]?.path!=='/managed/photo.png'||process.argv.includes('-c')){send({id:x.id,error:{message:'Native image missing or tools overridden'}});return;}
  send({id:x.id,result:{turn:{id:'turn'}}});
  const delta=(itemId,delta)=>send({method:'item/agentMessage/delta',params:{threadId:'thread',turnId:'turn',itemId,delta}});
  delta('a','Hello');delta('b','Second');delta('a',' there');
  setTimeout(()=>{
   for(const [id,text] of [['a','Hello there!'],['b','Second answer']])send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',id,text}}});
   delta('a','late');
   send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
  },200);
 }
});
`, { mode: 0o700 })
  const adapter = createAdapter({ dataDirectory: join(directory, 'state'), now: () => '', async invokeTool() { throw new Error('unexpected tool') } }, { executable, codexHome: home })
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await adapter.readiness()).ready, true)
  const handle = await adapter.execute({ runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', workingDirectory: directory, instructions: '',prompt:'Current message', settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Hello', parts:[{kind:'text',text:'Hello'},{kind:'file',artifactId:'photo',purpose:'attachment',name:'photo.png',mimeType:'image/png',size:10,availability:'available',readablePath:'/managed/photo.png'}] }], triggerMessageId: 'message' })
  const events = []
  for await (const event of handle.events) events.push(event)
  assert.deepEqual(events.filter(e => e.kind === 'text').map(({ messageId, text, final }) => ({ messageId, text, final })), [
    { messageId: 'a', text: 'Hello', final: false }, { messageId: 'b', text: 'Second', final: false }, { messageId: 'a', text: 'Hello there', final: false },
    { messageId: 'a', text: 'Hello there!', final: true }, { messageId: 'b', text: 'Second answer', final: true },
  ])
  assert.equal(events.at(-1).kind, 'ended')
})
