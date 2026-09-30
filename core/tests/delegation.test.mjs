import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { threadSnapshot, textEvent } from '../dist/protocol/index.js'
import { readEvents } from '../dist/modules/synchronization/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

async function until(read,match,label){for(let n=0;n<200;n++){const value=await read();if(match(value))return value;await new Promise(resolve=>setTimeout(resolve,35))}throw new Error(`Timed out: ${label}`)}
function adapter(){const contexts=[],handles=[];return {id:'delegation-fixture',version:'1',contractMajor:1,contexts,handles,async execute(context){contexts.push(context);const queued=[];let wake,closed=false;const handle={context,events:{async *[Symbol.asyncIterator](){while(!closed||queued.length){const next=queued.shift()??await new Promise(resolve=>wake=resolve);if(next)yield next}}},emit(event){if(wake){const resolve=wake;wake=undefined;resolve(event)}else queued.push(event);if(['ended','failed'].includes(event.kind))closed=true},async cancel(){return {acknowledged:true,confirmedEnded:false}},async reconcile(){return 'unknown'}};handles.push(handle);return handle},async close(){for(const handle of handles)handle.emit({kind:'failed',attemptId:handle.context.attemptId,confirmedEnded:false,message:'closed'})}}}

test('capacity-one delegation routes exact child question and internal result back to parent', {skip:noDatabase,timeout:30000},async()=>{
  const database=`kipsterdelegate_${randomUUID().replaceAll('-','')}`,admin=new Postgres(adminUrl),url=new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`);url.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster-delegate-'))
  let runtime,dispatcher,server
  try{
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent A'},executionLimit:1,embedding:{id: 'ollama', contractMajor: 1,model:'fixture-embedding',async embed(){return [1,0]}}})
    await runtime.memory.stopIndexing()
    const a=runtime.bootstrap.rootAgentId,b=randomUUID(),hidden=randomUUID(),org=runtime.bootstrap.organizationId,actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    await runtime.home.provisionAgent(b)
    await runtime.home.provisionAgent(hidden)
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[b,actor.installationId,'Agent B'])
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[hidden,actor.installationId,'Hidden agent'])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[org,b])
    await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1',[org,JSON.stringify({adapterId:'delegation-fixture',modelId:'fixture'})])
    const fixture=adapter();dispatcher=new TextDispatcher(runtime,fixture)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    await dispatcher.start()
    const post=async(path,value)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return {status:response.status,data:await response.json()}}
    const ctx={kind:'organization',organizationId:org},scope={installationId:actor.installationId,callerId:actor.personId}
    const chat=(await post('/v1/direct-chats',{version:1,context:ctx,agentId:a})).data.chatId
    const root=(await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context:ctx,chatId:chat},mode:'root',parts:[{kind:'text',text:'Consult B, then answer'}]})).data
    await until(()=>fixture.contexts.length,n=>n===1,'parent execution')
    const parent=fixture.contexts[0]
    assert.equal(parent.agentId,a)
    assert.deepEqual((await dispatcher.agentTool(parent.attemptId,'list','agents.list',{})).agents.map(x=>x.id).sort(),[a,b].sort())
    assert.equal((await dispatcher.agentTool(parent.attemptId,'get-hidden','agents.get',{agentId:hidden})).agent,null)
    await assert.rejects(dispatcher.agentTool(parent.attemptId,'hidden','agents.delegate',{recipientId:hidden,request:'Leak'}),/unavailable in originating context/)
    const [first,replayed]=await Promise.all([dispatcher.agentTool(parent.attemptId,'delegate-1','agents.delegate',{recipientId:b,request:'Review technical risk'}),dispatcher.agentTool(parent.attemptId,'delegate-1','agents.delegate',{recipientId:b,request:'Review technical risk'})])
    assert.equal(first.id,replayed.id)
    const independent=await dispatcher.publishToolText(parent.attemptId,'parent-comment','I am checking the rest of the request while B reviews risk')
    assert.equal(independent.status,'completed')
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.delegations')).rows[0].n,1)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,1)
    await new Promise(resolve=>setTimeout(resolve,120))
    assert.equal(fixture.contexts.length,1,'child must not claim a permit before parent provider ends')
    await assert.rejects(dispatcher.agentTool(parent.attemptId,'self','agents.delegate',{recipientId:a,request:'Loop'}),/cycle/)
    fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(()=>fixture.contexts.length,n=>n===2,'child execution')
    const child=fixture.contexts[1]
    assert.equal(child.agentId,b)
    assert.equal(child.runId,first.childRunId)
    assert.equal(child.organizationId,org)
    const memory=await dispatcher.memoryTool(child.attemptId,'memory-b','memory.save',{kind:'fact',text:'Agent B remembers the review'})
    assert.equal(memory.status,'completed')
    assert.equal((await runtime.db.query('SELECT owner_id FROM kipster.memory_records WHERE id=$1',[memory.record.id])).rows[0].owner_id,b)
    const written=await dispatcher.writeArtifactTool(child.attemptId,'write-b','review.txt','B wrote this')
    const published=await dispatcher.publishArtifactTool(child.attemptId,'publish-b',written.outputId)
    assert.equal((await runtime.db.query('SELECT owner_id FROM kipster.artifacts WHERE id=$1',[published.artifact.id])).rows[0].owner_id,b)
    const fileTarget={installationId:actor.installationId,callerId:actor.personId,context:ctx,chatId:chat,threadId:root.threadId}
    await assert.rejects(runtime.artifacts.get(actor,published.artifact.id,fileTarget),/access denied/)
    const question=await dispatcher.askToolInteraction(child.attemptId,'ask-b',{kind:'question',prompt:'Which market?',options:[{id:'eu',label:'Europe'},{id:'us',label:'United States'}],freeText:false})
    fixture.handles[1].emit({kind:'ended',attemptId:child.attemptId,confirmed:true})
    await until(async()=>Number((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n),n=>n===0,'child verified yield')
    const snapshot=await (await fetch(`${server.url}/v1/threads/${root.threadId}/snapshot`)).json()
    threadSnapshot.parse(snapshot)
    assert.equal(snapshot.interactions.find(x=>x.id===question.interactionId).sourceAgentId,b)
    assert.equal(snapshot.delegations[0].recipientAgentId,b)
    assert.equal(snapshot.delegations[0].result,undefined)
    const privateThread=(await runtime.db.query('SELECT thread_id FROM kipster.text_runs WHERE id=$1',[child.runId])).rows[0].thread_id
    assert.equal((await fetch(`${server.url}/v1/threads/${privateThread}/snapshot`)).status,403)
    assert.equal((await fetch(`${server.url}/v1/threads/${privateThread}/events?after=t:${privateThread}:0`)).status,403)
    const privateReply=await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context:ctx,chatId:chat},mode:'reply',threadId:privateThread,parts:[{kind:'text',text:'probe'}]})
    assert.notEqual(privateReply.status,200)
    assert.equal((await post('/v1/work/controls',{version:1,operationId:randomUUID(),context:ctx,chatId:chat,threadId:privateThread,runId:child.runId,attemptId:child.attemptId,action:'stop'})).status,403)
    const answer={version:1,operationId:randomUUID(),interactionId:question.interactionId,threadId:root.threadId,runId:child.runId,attemptId:child.attemptId,answer:{kind:'choice',optionId:'eu'}}
    const accepted=await post('/v1/work/interactions/answer',answer)
    assert.equal(accepted.data.outcome,'accepted')
    assert.equal((await post('/v1/work/interactions/answer',answer)).data.outcome,'accepted')
    await until(()=>fixture.contexts.length,n=>n===3,'child answer continuation')
    const childContinued=fixture.contexts[2]
    assert.equal(childContinued.agentId,b)
    assert.equal(childContinued.continuation.answer.optionId,'eu')
    fixture.handles[2].emit({kind:'text',attemptId:childContinued.attemptId,messageId:'internal-result',text:'Risk is low in Europe',final:true})
    fixture.handles[2].emit({kind:'ended',attemptId:childContinued.attemptId,confirmed:true})
    await until(()=>fixture.contexts.length,n=>n===4,'parent result continuation')
    const resumed=fixture.contexts[3]
    assert.equal(resumed.agentId,a)
    assert.deepEqual(resumed.delegationResults.map(x=>x.result),['Risk is low in Europe'])
    const repeatedAfterResult=await dispatcher.agentTool(resumed.attemptId,'again','agents.delegate',{recipientId:b,request:'Review technical risk'})
    assert.equal(repeatedAfterResult.id,first.id)
    assert.equal(repeatedAfterResult.state,'completed')
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.delegations')).rows[0].n,1)
    assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].state,'running')
    fixture.handles[3].emit({kind:'text',attemptId:resumed.attemptId,messageId:'parent-final',text:'Plan ready after B review',final:true})
    fixture.handles[3].emit({kind:'ended',attemptId:resumed.attemptId,confirmed:true})
    await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='completed','root completion')
    const final=await (await fetch(`${server.url}/v1/threads/${root.threadId}/snapshot`)).json()
    assert.equal(final.messages.some(x=>x.parts.some(p=>p.text==='Risk is low in Europe')),false)
    assert.equal(final.messages.some(x=>x.parts.some(p=>p.text==='Plan ready after B review')),true)
    assert.equal(final.delegations[0].state,'completed')
    const stream={kind:'thread',installationId:actor.installationId,callerId:actor.personId,threadId:root.threadId}
    for(const event of (await readEvents(runtime.db,stream,`t:${root.threadId}:0`)).events)textEvent.parse(event)
  }finally{
    await dispatcher?.close();await server?.close();await runtime?.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>undefined)
    await admin.close();await rm(home,{recursive:true,force:true})
  }
})

async function environment(limit=1,extraAgents=['Agent B']){
  const database=`kipsterdelegate_${randomUUID().replaceAll('-','')}`,admin=new Postgres(adminUrl),url=new URL(adminUrl)
  await admin.query(`CREATE DATABASE "${database}"`);url.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster-delegate-'))
  const runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent A'},executionLimit:limit})
  const a=runtime.bootstrap.rootAgentId,org=runtime.bootstrap.organizationId,actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},others=[]
  for(const name of extraAgents){const id=randomUUID();others.push(id);await runtime.home.provisionAgent(id);await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[id,actor.installationId,name]);await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[org,id])}
  await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1',[org,JSON.stringify({adapterId:'delegation-fixture',modelId:'fixture'})])
  const fixture=adapter(),dispatcher=new TextDispatcher(runtime,fixture),server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
  await dispatcher.start()
  const post=async(path,value)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return {status:response.status,data:await response.json()}}
  const context={kind:'organization',organizationId:org},scope={installationId:actor.installationId,callerId:actor.personId}
  const chat=(await post('/v1/direct-chats',{version:1,context,agentId:a})).data.chatId
  const submit=async(text)=> (await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text}]})).data
  const close=async()=>{await dispatcher.close();await server.close();await runtime.close();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
  return {runtime,dispatcher,fixture,server,post,context,scope,chat,submit,a,others,url,home,close}
}

test('installation context discovers and delegates only root-admin agents', {skip:noDatabase,timeout:30000},async()=>{
  const e=await environment(1,['Admin B','Ordinary C'])
  try{
    await e.runtime.db.query("INSERT INTO kipster.agent_roles(agent_id,role) VALUES ($1,'root-admin')",[e.others[0]])
    for(const id of [e.a,e.others[0]])await e.runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[id,JSON.stringify({adapterId:'delegation-fixture',modelId:'fixture'})])
    const context={kind:'installation',installationId:e.scope.installationId}
    const chat=(await e.post('/v1/direct-chats',{version:1,context,agentId:e.a})).data.chatId
    const root=(await e.post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:e.scope,target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Consult admin B'}]})).data
    await until(()=>e.fixture.contexts.length,n=>n===1,'installation parent')
    const parent=e.fixture.contexts[0]
    const listed=await e.dispatcher.agentTool(parent.attemptId,'list-install','agents.list',{})
    assert.deepEqual(listed.agents.map(x=>x.id).sort(),[e.a,e.others[0]].sort())
    assert.equal((await e.dispatcher.agentTool(parent.attemptId,'get-ordinary','agents.get',{agentId:e.others[1]})).agent,null)
    await assert.rejects(e.dispatcher.agentTool(parent.attemptId,'ordinary','agents.delegate',{recipientId:e.others[1],request:'Review'}),/unavailable/)
    const delegated=await e.dispatcher.agentTool(parent.attemptId,'admin','agents.delegate',{recipientId:e.others[0],request:'Review'})
    e.fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(()=>e.fixture.contexts.length,n=>n===2,'installation child')
    assert.equal(e.fixture.contexts[1].agentId,e.others[0])
    assert.equal(e.fixture.contexts[1].runId,delegated.childRunId)
  }finally{await e.close()}
})

test('siblings resolve out of order; parent resumes once in request order after provider end', {skip:noDatabase,timeout:30000},async()=>{
  const e=await environment(3,['Agent B','Agent C'])
  try{
    const root=await e.submit('Consult B and C')
    await until(()=>e.fixture.contexts.length,n=>n===1,'parent')
    const parent=e.fixture.contexts[0]
    const b=await e.dispatcher.agentTool(parent.attemptId,'b','agents.delegate',{recipientId:e.others[0],request:'B review'})
    const c=await e.dispatcher.agentTool(parent.attemptId,'c','agents.delegate',{recipientId:e.others[1],request:'C review'})
    assert.deepEqual([b.ordinal,c.ordinal],[1,2])
    await until(()=>e.fixture.contexts.length,n=>n===3,'both children while parent owns permit')
    assert.equal((await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,3)
    const bIndex=e.fixture.contexts.findIndex(x=>x.agentId===e.others[0]),cIndex=e.fixture.contexts.findIndex(x=>x.agentId===e.others[1])
    assert.ok(bIndex>0&&cIndex>0)
    const second=e.fixture.contexts[cIndex]
    e.fixture.handles[cIndex].emit({kind:'text',attemptId:second.attemptId,messageId:'c-result',text:'C done',final:true})
    e.fixture.handles[cIndex].emit({kind:'ended',attemptId:second.attemptId,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[c.id])).rows[0]?.state,x=>x==='completed','second result')
    assert.equal(e.fixture.contexts.length,3,'parent provider is still active')
    const first=e.fixture.contexts[bIndex]
    e.fixture.handles[bIndex].emit({kind:'text',attemptId:first.attemptId,messageId:'b-result',text:'B done',final:true})
    e.fixture.handles[bIndex].emit({kind:'ended',attemptId:first.attemptId,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[b.id])).rows[0]?.state,x=>x==='completed','first result')
    assert.equal(e.fixture.contexts.length,3,'parent provider is still active')
    assert.equal((await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,1)
    e.fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(()=>e.fixture.contexts.length,n=>n===4,'parent continuation')
    assert.deepEqual(e.fixture.contexts[3].delegationResults.map(x=>x.result),['B done','C done'])
    e.fixture.handles[3].emit({kind:'ended',attemptId:e.fixture.contexts[3].attemptId,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='completed','root complete')
    assert.equal((await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1',[root.runId])).rows[0].n,2)
  }finally{await e.close()}
})

test('Stop fences active child, retains late internal result and never revives parent', {skip:noDatabase,timeout:30000},async()=>{
  const e=await environment(1)
  try{
    const root=await e.submit('Consult B')
    await until(()=>e.fixture.contexts.length,n=>n===1,'parent')
    const parent=e.fixture.contexts[0]
    const delegated=await e.dispatcher.agentTool(parent.attemptId,'b','agents.delegate',{recipientId:e.others[0],request:'Review'})
    e.fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(()=>e.fixture.contexts.length,n=>n===2,'child')
    const child=e.fixture.contexts[1]
    e.fixture.handles[1].emit({kind:'text',attemptId:child.attemptId,messageId:'pre-stop',text:'Child work already saved',final:true})
    await until(async()=> (await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.messages WHERE source_attempt_id=$1',[child.attemptId])).rows[0].n,n=>n===1,'child publication committed')
    const stop=await e.post('/v1/work/controls',{version:1,operationId:randomUUID(),context:e.context,chatId:e.chat,threadId:root.threadId,runId:root.runId,attemptId:parent.attemptId,action:'stop'})
    assert.equal(stop.data.outcome,'accepted')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[delegated.id])).rows[0].state,'cancelled')
    e.fixture.handles[1].emit({kind:'ended',attemptId:child.attemptId,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT late_result FROM kipster.delegations WHERE id=$1',[delegated.id])).rows[0]?.late_result,x=>x==='Child work already saved','late result retained')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].state,'cancelled')
    await new Promise(resolve=>setTimeout(resolve,150))
    assert.equal(e.fixture.contexts.length,2)
    assert.equal((await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,0)
  }finally{await e.close()}
})

test('Stop preserves a completed child while cancelling an active sibling', {skip:noDatabase,timeout:30000},async()=>{
  const e=await environment(3,['Agent B','Agent C'])
  try{
    const root=await e.submit('Consult B and C')
    await until(()=>e.fixture.contexts.length,n=>n===1,'parent')
    const parent=e.fixture.contexts[0]
    const b=await e.dispatcher.agentTool(parent.attemptId,'b','agents.delegate',{recipientId:e.others[0],request:'B review'})
    const c=await e.dispatcher.agentTool(parent.attemptId,'c','agents.delegate',{recipientId:e.others[1],request:'C review'})
    await until(()=>e.fixture.contexts.length,n=>n===3,'both children')
    const bIndex=e.fixture.contexts.findIndex(x=>x.agentId===e.others[0])
    const bAttempt=e.fixture.contexts[bIndex].attemptId
    e.fixture.handles[bIndex].emit({kind:'text',attemptId:bAttempt,messageId:'b-result',text:'B done',final:true})
    e.fixture.handles[bIndex].emit({kind:'ended',attemptId:bAttempt,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[b.id])).rows[0]?.state,x=>x==='completed','B result')
    const stop=await e.post('/v1/work/controls',{version:1,operationId:randomUUID(),context:e.context,chatId:e.chat,threadId:root.threadId,runId:root.runId,attemptId:parent.attemptId,action:'stop'})
    assert.equal(stop.data.outcome,'accepted')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[b.id])).rows[0].state,'completed')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[b.childRunId])).rows[0].state,'completed')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[c.id])).rows[0].state,'cancelled')
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].state,'cancellation-requested')
    e.fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='cancelled','parent cancelled')
    assert.equal(e.fixture.contexts.length,3)
  }finally{await e.close()}
})

test('unknown child provider end survives restart without releasing capacity or replaying work', {skip:noDatabase,timeout:30000},async()=>{
  const e=await environment(1)
  let reopened,nextDispatcher
  try{
    const root=await e.submit('Consult B')
    await until(()=>e.fixture.contexts.length,n=>n===1,'parent')
    const parent=e.fixture.contexts[0]
    const delegated=await e.dispatcher.agentTool(parent.attemptId,'b','agents.delegate',{recipientId:e.others[0],request:'Review'})
    e.fixture.handles[0].emit({kind:'ended',attemptId:parent.attemptId,confirmed:true})
    await until(()=>e.fixture.contexts.length,n=>n===2,'child')
    const child=e.fixture.contexts[1]
    e.fixture.handles[1].emit({kind:'failed',attemptId:child.attemptId,confirmedEnded:false,message:'provider disconnected'})
    await until(async()=> (await e.runtime.db.query('SELECT state FROM kipster.delegations WHERE id=$1',[delegated.id])).rows[0]?.state,x=>x==='recovery-needed','delegation recovery activity')
    assert.equal((await e.runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,1)
    assert.equal((await e.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].state,'waiting')
    const page=await (await fetch(`${e.server.url}/v1/threads/${root.threadId}/snapshot`)).json()
    assert.equal(page.delegations[0].state,'recovery-needed')
    assert.match(page.delegations[0].failure,/reconciliation/)
    await e.dispatcher.close();await e.runtime.close()
    reopened=await openRuntime({connectionString:e.url.href,home:e.home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent A'},executionLimit:1})
    const next=adapter();nextDispatcher=new TextDispatcher(reopened,next)
    await nextDispatcher.start()
    await new Promise(resolve=>setTimeout(resolve,180))
    assert.equal(next.contexts.length,0)
    assert.equal((await reopened.db.query('SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1',[child.runId])).rows[0].n,1)
    assert.equal((await reopened.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,1)
  }finally{await nextDispatcher?.close();await reopened?.close();await e.close()}
})
