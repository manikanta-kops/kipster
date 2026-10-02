import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir, mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createAdapter} from '../dist/index.js'

test('adapter exposes memory and relationship tools with bound attempt identity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'kipster-codex-memory-'))
 const executable=join(directory,'codex')
 await writeFile(executable,`#!/usr/bin/env node
const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(x.method==='initialize')send({id:x.id,result:{}});
else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
else if(x.method==='thread/start'){
 const tools=x.params.dynamicTools.map(t=>t.name);
 if(!tools.includes('memory_save')||!tools.includes('memory_search')||!tools.includes('memory_correct')||!tools.includes('memory_publish')||!tools.includes('memory_link')||!tools.includes('memory_relationship_get')||!tools.includes('memory_relationship_list')||!tools.includes('memory_relationship_update')||!tools.includes('memory_unlink'))send({id:x.id,error:{message:'memory tools absent'}});
 else send({id:x.id,result:{thread:{id:'thread-1'}}});
}else if(x.method==='turn/start'){
 if(!x.params.input[0].text.includes('Amsterdam office opens at ten')||!x.params.input[0].text.includes('content unavailable')||!x.params.input[0].text.includes('Do not claim to have read its contents')||x.params.input[0].text.includes('readable path undefined')){send({id:x.id,error:{message:'memory or unavailable file context absent'}});return;}
 send({id:x.id,result:{turn:{id:'turn-1'}}});
 setTimeout(()=>send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'save-1',tool:'memory_save',arguments:{kind:'fact',text:'Amsterdam office opens at ten'}}}),10);
}else if(x.id===101){send({id:102,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'link-1',tool:'memory_link',arguments:{owner:{kind:'agent',ownerId:'agent'},fromId:'memory-1',toId:'memory-2',fromRevision:1,toRevision:1,kind:'supports',weight:0.7,evidence:[{memoryId:'memory-1',revision:1}]}}});}
else if(x.id===102){send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});}
});
`)
 await chmod(executable,0o755)
 const previous=process.env.PATH;process.env.PATH=`${directory}:${previous}`
 process.env.CODEX_HOME=join(directory,'user-codex')
  await mkdir(process.env.CODEX_HOME, { recursive: true })
 const calls=[]
 const adapter=createAdapter({dataDirectory:join(directory,'codex-data'),now:()=>new Date().toISOString(),async invokeTool(request){calls.push(request);return {status:'completed',record:{id:'memory-1'}}}})
 try{
  assert.equal((await adapter.readiness()).ready,true)
  const handle=await adapter.execute({runId:'run',attemptId:'attempt',organizationId:null,agentId:'agent',workingDirectory:directory,instructions:'Current',tools:['memory_save','memory_search','memory_correct','memory_publish','memory_link','memory_relationship_get','memory_relationship_list','memory_relationship_update','memory_unlink'].map(name=>({name,description:name,inputSchema:{type:'object'}})),memory:['Amsterdam office opens at ten'],settings:{adapterId:'codex-cli',modelId:'test-model'},input:[{messageId:'old',text:'',parts:[{kind:'file',artifactId:'historical',purpose:'attachment',name:'history.txt',mimeType:'text/plain',size:10,availability:'unavailable'}]},{messageId:'message',text:'Remember office hours'}],triggerMessageId:'message'})
  const events=[];for await(const event of handle.events)events.push(event)
  assert.equal(calls.length,2)
  assert.deepEqual(calls[0],{attemptId:'attempt',callId:'save-1',name:'memory_save',arguments:{kind:'fact',text:'Amsterdam office opens at ten'}})
  assert.deepEqual(calls[1],{attemptId:'attempt',callId:'link-1',name:'memory_link',arguments:{owner:{kind:'agent',ownerId:'agent'},fromId:'memory-1',toId:'memory-2',fromRevision:1,toRevision:1,kind:'supports',weight:0.7,evidence:[{memoryId:'memory-1',revision:1}]}})
  assert.equal(events.at(-1).kind,'ended')
 }finally{await adapter.close();process.env.PATH=previous;await rm(directory,{recursive:true,force:true})}
})
