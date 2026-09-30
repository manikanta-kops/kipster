import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { retainLast, readEvents } from '../dist/modules/synchronization/public.js'
import { threadSnapshot, appSnapshot, textEvent, controlCommand, interactionResponseCommand } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'

async function until(read,predicate,label) { for(let i=0;i<150;i++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,40))}throw new Error(`Timed out: ${label}`) }
function fixture(){const handles=[];const contexts=[];return {id:'test-adapter',version:'1',contractMajor:1,handles,contexts,async execute(context){contexts.push(context);const events=[];let wake;let closed=false;const handle={context,events:{async *[Symbol.asyncIterator](){while(!closed||events.length){const value=events.shift()??await new Promise(resolve=>wake=resolve);if(value)yield value}}},emit(event){if(wake){const resolve=wake;wake=undefined;resolve(event)}else events.push(event);if(['ended','failed'].includes(event.kind))closed=true},async cancel(){return {acknowledged:true,confirmedEnded:false}},async reconcile(){return 'unknown'}};handles.push(handle);return handle},async close(){for(const h of handles)h.emit({kind:'failed',attemptId:h.context?.attemptId,confirmedEnded:false,message:'closed'})}}}

test('saved question first winner, safe yield, current-context continuation and Stop hold', {skip:noDatabase},async()=>{
  const database=`kipster_controls_${randomUUID().replaceAll('-','')}`
  const admin=new Postgres(adminUrl);await admin.query(`CREATE DATABASE "${database}"`)
  const isolated=new URL(adminUrl);isolated.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster_controls-home-'))
  let runtime,dispatcher,server
  try{
    runtime=await openRuntime({connectionString:isolated.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:1})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
    const adapter=fixture();dispatcher=new TextDispatcher(runtime,adapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    await dispatcher.start()
    const post=async(path,data)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return {status:response.status,data:await response.json()}}
    const context={kind:'installation',installationId:actor.installationId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:runtime.bootstrap.rootAgentId})).data.chatId
    const root=(await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Ask me first'}]})).data
    await until(()=>adapter.handles.length,n=>n===1,'first execution')
    const first=adapter.contexts[0]
    await assert.rejects(dispatcher.askToolInteraction(first.attemptId,'bad-option',{kind:'question',prompt:'Bad',options:[{id:'x',label:'X',hidden:true}],freeText:false}),/Invalid interaction options/)
    await assert.rejects(dispatcher.askToolInteraction(first.attemptId,'bad-free-text',{kind:'question',prompt:'Bad',options:[{id:'x',label:'X'}],freeText:'no'}),/Invalid free-text flag/)
    await assert.rejects(dispatcher.askToolInteraction(first.attemptId,'bad-approval',{kind:'approval',prompt:'Bad',proposalId:'p'}),/Invalid approval proposal/)
    const card=await dispatcher.askToolInteraction(first.attemptId,'ask-1',{kind:'question',prompt:'Choose a color',options:[{id:'blue',label:'Blue'},{id:'red',label:'Red'}],freeText:false})
    adapter.handles[0].emit({kind:'ended',attemptId:first.attemptId,confirmed:true})
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='waiting','safe yield')
    await until(async()=> (await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,n=>n===0,'released permit')
    const page=await (await fetch(`${server.url}/v1/threads/${root.threadId}/snapshot`)).json()
    threadSnapshot.parse(page)
    assert.equal(page.interactions[0].state,'pending')
    const stream={kind:'thread',installationId:actor.installationId,callerId:actor.personId,threadId:root.threadId}
    for(const event of (await readEvents(runtime.db,stream,'t:'+root.threadId+':0')).events) textEvent.parse(event)
    await retainLast(runtime.db,stream,0)
    await assert.rejects(readEvents(runtime.db,stream,`t:${root.threadId}:0`),/resync-required/)
    assert.equal((await (await fetch(`${server.url}/v1/threads/${root.threadId}/snapshot`)).json()).interactions[0].state,'pending')
    const app=await (await fetch(`${server.url}/v1/app/snapshot`)).json()
    appSnapshot.parse(app)
    assert.ok(app.notifications.some(note=>note.runId===root.runId&&note.kind==='interaction'&&!note.read))
    const answerBody=(id,optionId)=>({version:1,operationId:id,interactionId:card.interactionId,threadId:root.threadId,runId:root.runId,attemptId:first.attemptId,answer:{kind:'choice',optionId}})
    const [a,b]=await Promise.all([post('/v1/work/interactions/answer',answerBody(randomUUID(),'blue')),post('/v1/work/interactions/answer',answerBody(randomUUID(),'red'))])
    assert.deepEqual([a.data.outcome,b.data.outcome].sort(),['accepted','rejected'])
    const winning=a.data.outcome==='accepted'?a:b
    const answerReceipt=await post('/v1/work/interactions/receipt',{version:1,operationId:winning.data.operationId,interactionId:card.interactionId,threadId:root.threadId,runId:root.runId,attemptId:first.attemptId,answer:{kind:'choice',optionId:'blue'}})
    assert.equal(answerReceipt.data.outcome,'accepted')
    await until(()=>adapter.contexts.length,n=>n===2,'continuation')
    assert.equal(adapter.contexts[1].continuation.answer.kind,'choice')
    assert.equal(adapter.contexts[1].continuation.prompt,'Choose a color')
    assert.equal(adapter.contexts[1].interactions[0].options.find(x=>x.id===adapter.contexts[1].continuation.answer.optionId).label, adapter.contexts[1].continuation.answer.optionId==='blue'?'Blue':'Red')
    const malformedStop={version:1,operationId:randomUUID(),context,chatId:chat,threadId:root.threadId,runId:root.runId,attemptId:42,action:'stop'}
    assert.throws(()=>controlCommand.parse(malformedStop),TypeError)
    assert.equal((await post('/v1/work/controls',malformedStop)).status,400)
    const unboundStop=await post('/v1/work/controls',{...malformedStop,operationId:randomUUID(),attemptId:null})
    assert.equal(unboundStop.data.outcome,'rejected')
    adapter.handles[1].cancel=async()=>({acknowledged:false,confirmedEnded:false})
    const stop={version:1,operationId:randomUUID(),context,chatId:chat,threadId:root.threadId,runId:root.runId,attemptId:adapter.contexts[1].attemptId,action:'stop'}
    const stopped=await post('/v1/work/controls',stop)
    assert.equal(stopped.data.outcome,'accepted')
    await until(async()=> (await runtime.db.query('SELECT cancel_delivery FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.cancel_delivery,x=>x==='uncertain','uncertain cancel delivery')
    assert.equal((await runtime.db.query('SELECT queue_hold FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].queue_hold,true)
    adapter.handles[1].emit({kind:'failed',attemptId:adapter.contexts[1].attemptId,confirmedEnded:true,message:'interrupted'})
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='cancelled','cancelled terminal')
    assert.equal((await runtime.db.query('SELECT cancel_delivery FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].cancel_delivery,'confirmed-ended')
    assert.deepEqual((await post('/v1/work/controls',stop)).data,stopped.data)
    assert.deepEqual((await post('/v1/work/controls/receipt',stop)).data,stopped.data)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n,0)
    const command=(run,action,attemptId)=>({version:1,operationId:randomUUID(),context,chatId:chat,threadId:root.threadId,runId:run.runId,attemptId,action})
    assert.equal((await post('/v1/work/controls',command(root,'resume',adapter.contexts[1].attemptId))).data.outcome,'accepted')
    const submit=async text=>(await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId:chat},mode:'reply',threadId:root.threadId,parts:[{kind:'text',text}]})).data
    const failed=await submit('Fail once')
    await until(()=>adapter.contexts.length,n=>n===3,'reply after Resume')
    const cancelledQueue=await submit('Keep my queued message')
    const queueCancelled=await post('/v1/work/controls',command(cancelledQueue,'cancel-queued',undefined))
    assert.equal(queueCancelled.data.outcome,'accepted')
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.messages WHERE id=$1',[cancelledQueue.messageId])).rows[0].n,1)
    adapter.handles[2].emit({kind:'failed',attemptId:adapter.contexts[2].attemptId,confirmedEnded:true,message:'controlled failure'})
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[failed.runId])).rows[0]?.state,x=>x==='failed','failed reply')
    const later=await submit('Run after retry settles')
    await new Promise(resolve=>setTimeout(resolve,150))
    assert.equal(adapter.contexts.length,3)
    const retried=await post('/v1/work/controls',command(failed,'retry',adapter.contexts[2].attemptId))
    assert.equal(retried.data.outcome,'accepted')
    await until(()=>adapter.contexts.length,n=>n===4,'explicit Retry')
    adapter.handles[3].emit({kind:'ended',attemptId:adapter.contexts[3].attemptId,confirmed:true})
    await until(()=>adapter.contexts.length,n=>n===5,'automatic queue after settled Retry')
    assert.equal(adapter.contexts[4].runId,later.runId)
    const approval=await dispatcher.askToolInteraction(adapter.contexts[4].attemptId,'approval-1',{kind:'approval',prompt:'Approve exact action: set color blue',proposalId:'proposal-blue-v1',proposal:'Set the color to blue'})
    adapter.handles[4].emit({kind:'ended',attemptId:adapter.contexts[4].attemptId,confirmed:true})
    await until(async()=>Number((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.owned_permits')).rows[0].n),n=>n===0,'approval yield')
    const wrong=await post('/v1/work/interactions/answer',{version:1,operationId:randomUUID(),interactionId:approval.interactionId,threadId:root.threadId,runId:later.runId,attemptId:adapter.contexts[4].attemptId,proposalId:'changed-proposal',answer:{kind:'approve'}})
    assert.equal(wrong.data.outcome,'rejected')
    const right=await post('/v1/work/interactions/answer',{version:1,operationId:randomUUID(),interactionId:approval.interactionId,threadId:root.threadId,runId:later.runId,attemptId:adapter.contexts[4].attemptId,proposalId:'proposal-blue-v1',answer:{kind:'approve'}})
    assert.equal(right.data.outcome,'accepted')
    const extra={version:1,operationId:randomUUID(),interactionId:approval.interactionId,threadId:root.threadId,runId:later.runId,attemptId:adapter.contexts[4].attemptId,proposalId:'proposal-blue-v1',answer:{kind:'approve',extra:true}}
    assert.throws(()=>interactionResponseCommand.parse(extra),TypeError)
    assert.equal((await post('/v1/work/interactions/answer',extra)).status,400)
    await until(()=>adapter.contexts.length,n=>n===6,'approval continuation')
    assert.equal(adapter.contexts[5].continuation.proposalId,'proposal-blue-v1')
    assert.equal(adapter.contexts[5].interactions[0].proposal,'Set the color to blue')
    adapter.handles[5].emit({kind:'ended',attemptId:adapter.contexts[5].attemptId,confirmed:true})
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[later.runId])).rows[0]?.state,x=>x==='completed','approved continuation complete')
  }finally{await server?.close();await dispatcher?.close();await runtime?.close();await rm(home,{recursive:true,force:true});await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close()}
})

test('days-old pending question survives Core restart and resumes once', {skip:noDatabase},async()=>{
  const database=`kipster_controlsold_${randomUUID().replaceAll('-','')}`
  const admin=new Postgres(adminUrl);await admin.query(`CREATE DATABASE "${database}"`)
  const isolated=new URL(adminUrl);isolated.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster_controls-old-'))
  let runtime,dispatcher,server
  try{
    runtime=await openRuntime({connectionString:isolated.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:1})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
    const firstAdapter=fixture();dispatcher=new TextDispatcher(runtime,firstAdapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    await dispatcher.start()
    const post=async(path,data)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return {status:response.status,data:await response.json()}}
    const context={kind:'installation',installationId:actor.installationId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:runtime.bootstrap.rootAgentId})).data.chatId
    const root=(await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Wait for old answer'}]})).data
    await until(()=>firstAdapter.contexts.length,n=>n===1,'first attempt')
    const attempt=firstAdapter.contexts[0].attemptId
    const question=await dispatcher.askToolInteraction(attempt,'old-question',{kind:'question',prompt:'Old choice?',options:[{id:'yes',label:'Yes'}],freeText:false})
    firstAdapter.handles[0].emit({kind:'ended',attemptId:attempt,confirmed:true})
    await until(async()=>Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.owned_permits')).rows[0].n),n=>n===0,'old question yield')
    await runtime.db.query("UPDATE kipster.interactions SET created_at=now()-interval '8 days' WHERE id=$1",[question.interactionId])
    await server.close();server=undefined;await dispatcher.close();dispatcher=undefined;await runtime.close();runtime=undefined
    runtime=await openRuntime({connectionString:isolated.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:1})
    const secondAdapter=fixture();dispatcher=new TextDispatcher(runtime,secondAdapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    await dispatcher.start()
    const snapshot=await (await fetch(`${server.url}/v1/threads/${root.threadId}/snapshot`)).json()
    assert.equal(snapshot.interactions[0].state,'pending')
    const response=await fetch(server.url+'/v1/work/interactions/answer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:1,operationId:randomUUID(),interactionId:question.interactionId,threadId:root.threadId,runId:root.runId,attemptId:attempt,answer:{kind:'choice',optionId:'yes'}})})
    assert.equal((await response.json()).outcome,'accepted')
    await until(()=>secondAdapter.contexts.length,n=>n===1,'recovered continuation')
    assert.equal(secondAdapter.contexts[0].continuation.answer.optionId,'yes')
    assert.equal(secondAdapter.contexts[0].interactions[0].options[0].label,'Yes')
    const second=await dispatcher.askToolInteraction(secondAdapter.contexts[0].attemptId,'second-question',{kind:'question',prompt:'Second choice?',options:[{id:'opaque_8',label:'Proceed with saved choice'}],freeText:false})
    secondAdapter.handles[0].emit({kind:'ended',attemptId:secondAdapter.contexts[0].attemptId,confirmed:true})
    await until(async()=>Number((await runtime.db.query('SELECT count(*) AS n FROM kipster.owned_permits')).rows[0].n),n=>n===0,'second question yield')
    const secondAnswer=await post('/v1/work/interactions/answer',{version:1,operationId:randomUUID(),interactionId:second.interactionId,threadId:root.threadId,runId:root.runId,attemptId:secondAdapter.contexts[0].attemptId,answer:{kind:'choice',optionId:'opaque_8'}})
    assert.equal(secondAnswer.data.outcome,'accepted')
    await until(()=>secondAdapter.contexts.length,n=>n===2,'second continuation')
    assert.deepEqual(secondAdapter.contexts[1].interactions.map(x=>x.prompt),['Old choice?','Second choice?'])
    assert.equal(secondAdapter.contexts[1].interactions[1].options[0].label,'Proceed with saved choice')
    assert.equal(secondAdapter.contexts[1].interactions[1].response.answer.optionId,'opaque_8')
    secondAdapter.handles[1].emit({kind:'ended',attemptId:secondAdapter.contexts[1].attemptId,confirmed:true})
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0]?.state,x=>x==='completed','recovered completion')
    await new Promise(resolve=>setTimeout(resolve,100))
    assert.equal(secondAdapter.contexts.length,2)
  }finally{await server?.close();await dispatcher?.close();await runtime?.close();await rm(home,{recursive:true,force:true});await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close()}
})
