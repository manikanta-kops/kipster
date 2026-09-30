import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { adminUrl, noDatabase } from './support/database.mjs'

async function until(read,predicate,label) { for(let i=0;i<150;i++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,40))}throw new Error(`Timed out: ${label}`) }
function fixture(){const handles=[];const contexts=[];return {id:'test-adapter',version:'1',contractMajor:1,handles,contexts,async execute(context){contexts.push(context);const events=[];let wake;let closed=false;const handle={context,events:{async *[Symbol.asyncIterator](){while(!closed||events.length){const value=events.shift()??await new Promise(resolve=>wake=resolve);if(value)yield value}}},emit(event){if(wake){const resolve=wake;wake=undefined;resolve(event)}else events.push(event);if(['ended','failed'].includes(event.kind))closed=true},async cancel(){return {acknowledged:true,confirmedEnded:false}},async reconcile(){return 'unknown'}};handles.push(handle);return handle},async close(){for(const h of handles)h.emit({kind:'failed',attemptId:h.context?.attemptId,confirmedEnded:false,message:'closed'})}}}

test('late Retry after Resume cannot overtake an active later reply at capacity two', {skip:noDatabase},async()=>{
  const database=`kipster_retry_${randomUUID().replaceAll('-','')}`
  const admin=new Postgres(adminUrl);await admin.query(`CREATE DATABASE "${database}"`)
  const isolated=new URL(adminUrl);isolated.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster_retry-home-'))
  let runtime,dispatcher,server
  try{
    runtime=await openRuntime({connectionString:isolated.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:2})
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
    const original=adapter.contexts[0];
    adapter.handles[0].emit({kind:'failed',attemptId:original.attemptId,confirmedEnded:true,message:'fail'});
    await until(async()=> (await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[root.runId])).rows[0].state,s=>s==='failed','failed');
    const later=(await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId:chat},mode:'reply',threadId:root.threadId,parts:[{kind:'text',text:'later'}]})).data;
    const command=action=>({version:1,operationId:randomUUID(),context,chatId:chat,threadId:root.threadId,runId:root.runId,attemptId:original.attemptId,action});
    assert.equal((await post('/v1/work/controls',command('resume'))).data.outcome,'accepted');
    const earlyRetry=await post('/v1/work/controls',command('retry'));
    assert.equal(earlyRetry.data.outcome,'rejected','Resume consumed the failed run retry window');
    await until(()=>adapter.contexts.length,n=>n===2,'later active');
    const lateRetry=await post('/v1/work/controls',command('retry'));
    assert.equal(lateRetry.data.outcome,'rejected');
    // Fault-inject the former bug's revived queue row to verify admission also
    // respects the live thread owner even if a stale producer enqueues it.
    await runtime.db.transaction(async client=>{
      await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[root.threadId]);
      await client.query("UPDATE kipster.text_runs SET state='queued',queue_hold=true WHERE id=$1",[root.runId]);
      await client.query("UPDATE kipster.work_intents SET state='queued' WHERE id=$1",[root.runId]);
      await runtime.jobs.send(client,root.runId);
    });
    await new Promise(r=>setTimeout(r,400));
    assert.equal(adapter.contexts.length,2,'Must not start a second execution in same thread');
    assert.equal((await runtime.db.query("SELECT count(*)::int AS n FROM kipster.text_runs WHERE thread_id=$1 AND state='running'",[root.threadId])).rows[0].n,1);
    assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[later.runId])).rows[0].state,'running');
  }finally{await server?.close();await dispatcher?.close();await runtime?.close();await rm(home,{recursive:true,force:true});await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close()}
});
