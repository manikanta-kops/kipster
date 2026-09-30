import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

test('a repeated provider interaction yields one saved card and a visible failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-repeat-'))
  const executable = join(directory, 'codex')
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let calls=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
 else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread-1'}}});
 else if(x.method==='turn/start'){
  if(!x.params.input[0].text.includes('Human choice')||!x.params.input[0].text.includes('"optionId":"opaque"')){send({id:x.id,error:{message:'Settled answer missing from reconstructed context'}});return;}
  send({id:x.id,result:{turn:{id:'turn-1'}}});
  setTimeout(()=>send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'first',tool:'interactions_ask',arguments:{prompt:'First?',options:[{id:'opaque',label:'Human choice'}],freeText:false}}}),10);
 } else if(x.id===101){calls++;send({id:102,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'second',tool:'interactions_ask',arguments:{prompt:'Second?',options:[{id:'other',label:'Other'}],freeText:false}}});}
 else if(x.id===102){calls++;send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});}
});
`)
  await chmod(executable, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}:${previousPath}`
  process.env.CODEX_HOME=join(directory,'user-codex')
  await mkdir(process.env.CODEX_HOME, { recursive: true })
  const calls = []
  const adapter = createAdapter({dataDirectory:join(directory,'codex-data'),now:()=>new Date().toISOString(), async invokeTool(request){calls.push(request);return {status:'pending',interactionId:'saved-card'}}})
  try {
    assert.equal((await adapter.readiness()).ready,true)
    const settled = {id:'earlier',kind:'question',prompt:'Earlier choice?',options:[{id:'opaque',label:'Human choice'}],freeText:false,response:{actorId:'human',answer:{kind:'choice',optionId:'opaque'},acceptedAt:'2026-09-23T00:00:00Z'}}
    const handle = await adapter.execute({runId:'run',attemptId:'attempt',organizationId:null,agentId:'agent',workingDirectory:directory,instructions:'Current',settings:{adapterId:'codex-cli',modelId:'test-model'},input:[{messageId:'message',text:'Ask once'}],triggerMessageId:'message',interactions:[settled]})
    const events = []
    for await (const event of handle.events) events.push(event)
    assert.equal(calls.length,1)
    assert.equal(events.filter(x=>x.kind==='waiting').length,1)
    assert.equal(events.find(x=>x.kind==='waiting').interactionId,'saved-card')
    assert.equal(events.at(-1).kind,'failed')
    assert.match(events.at(-1).message,/repeated an interaction/)
    assert.equal(events.at(-1).confirmedEnded,true)
    assert.equal(settled.response.answer.optionId,'opaque')
  } finally {await adapter.close();process.env.PATH=previousPath;await rm(directory,{recursive:true,force:true})}
})
