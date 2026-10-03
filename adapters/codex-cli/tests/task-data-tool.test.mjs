import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

for (const tool of [
  { label: 'task data', wire: 'data_space', callId: 'data-1', forbidden: 'sql', result: { tables: [] } },
  { label: 'vector collections', wire: 'vectors_space', callId: 'vector-1', forbidden: 'embeddingProvider', result: { collections: [] } },
]) test(`adapter offers the Core ${tool.label} tool and forwards bound attempt identity`, async t => {
  const directory=await mkdtemp(join(tmpdir(),'kipster-codex-data-'))
  const executable=join(directory,'codex')
  await writeFile(executable,`#!/usr/bin/env node
const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(x.method==='initialize')send({id:x.id,result:{}});
else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
else if(x.method==='thread/start'){
 const tool=x.params.dynamicTools.find(t=>t.name===${JSON.stringify(tool.wire)});
 if(!tool||!tool.inputSchema.properties.target||tool.inputSchema.properties[${JSON.stringify(tool.forbidden)}])send({id:x.id,error:{message:'bounded data tool absent'}});
 else send({id:x.id,result:{thread:{id:'thread-1'}}});
}else if(x.method==='turn/start'){
 send({id:x.id,result:{turn:{id:'turn-1'}}});
 setTimeout(()=>send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:${JSON.stringify(tool.callId)},tool:${JSON.stringify(tool.wire)},arguments:{operation:'discover',target:{kind:'agent',ownerId:'agent-a'}}}}),10);
}else if(x.id===101)send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
});
`)
  await chmod(executable,0o755)
  const environment = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME }
  t.after(() => { for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const previous=process.env.PATH;process.env.PATH=`${directory}:${previous}`
  process.env.CODEX_HOME=join(directory,'user-codex')
  await mkdir(process.env.CODEX_HOME, { recursive: true })
  const calls=[]
  const adapter=createAdapter({dataDirectory:join(directory,'codex-data'),now:()=>new Date().toISOString(),async invokeTool(request){calls.push(request);return tool.result}})
  try {
    assert.equal((await adapter.readiness()).ready,true)
    const handle=await adapter.execute({runId:'run',attemptId:'attempt',organizationId:null,agentId:'agent-a',workingDirectory:directory,instructions:'Current',prompt:'Current message',tools:[{name:tool.wire,description:tool.label,inputSchema:{type:'object',properties:{operation:{type:'string'},target:{type:'object'}},required:['operation','target']}}],settings:{adapterId:'codex-cli',modelId:'test-model'},input:[{messageId:'message',text:'List tables'}],triggerMessageId:'message'})
    const events=[];for await(const event of handle.events)events.push(event)
    assert.deepEqual(calls,[{attemptId:'attempt',callId:tool.callId,name:tool.wire,arguments:{operation:'discover',target:{kind:'agent',ownerId:'agent-a'}}}])
    assert.equal(events.at(-1).kind,'ended')
  } finally {await adapter.close();process.env.PATH=previous;await rm(directory,{recursive:true,force:true})}
})
