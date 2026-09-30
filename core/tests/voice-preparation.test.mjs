import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {Postgres} from '../dist/platform/postgres/public.js'
import {openRuntime,TextDispatcher,startTextServer} from '../dist/runtime.js'
import {resolveDirectChat,acceptText,messageRecord} from '../dist/modules/conversations/public.js'
import {snapshot} from '../dist/modules/synchronization/public.js'
import {abortableResult} from '../dist/workflows/text-dispatch.js'
import {acceptsType} from '../dist/transcription/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const stream=bytes=>(async function*(){yield bytes})()
async function until(read,predicate){for(let i=0;i<150;i++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,30))}throw new Error('Timed out')}
test('Core MIME matching ignores parameters and enforces declared provider input types',()=>{
 const provider={inputTypes:['audio/*','application/octet-stream']}
 assert.equal(acceptsType(provider,'Audio/WebM;codecs=opus'),true)
 assert.equal(acceptsType(provider,'video/mp4'),false)
 assert.equal(acceptsType({inputTypes:['audio/wav']},'AUDIO/WAV; charset=binary'),true)
})
test('voice preparation rejects video when provider declares audio-only types', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-type-'))
 let runtime,dispatcher
 try{
  const provider=transcription({status:'succeeded',text:'should not run',provider:'fixture-transcription'});provider.inputTypes=['audio/*']
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('video fixture')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'clip.mp4',mimeType:'video/mp4',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
  dispatcher=new TextDispatcher(runtime,execution());await dispatcher.start()
  await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  assert.equal(provider.calls.length,0)
  assert.equal((await messageRecord(runtime.db,saved.messageId)).preparation[0].error,'invalid-input')
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})
function execution(){const contexts=[];return {id:'test-adapter',version:'1',contractMajor:1,contexts,async execute(context){contexts.push(context);return {events:(async function*(){yield {kind:'ended',attemptId:context.attemptId,confirmed:true}})(),async cancel(){return {acknowledged:true,confirmedEnded:true}},async reconcile(){return 'ended'}}},async close(){}}}
function transcription(result){const calls=[];return {id:'fixture-transcription',contractMajor:1,inputTypes:['audio/*','video/*'],calls,async readiness(){return {ready:true}},async transcribe(input){calls.push(input);return result},async close(){}}}
test('voice preparation saves derived result and preserves ordered originals and caption', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-db-'))
 let runtime,dispatcher
 try{
  const provider=transcription({status:'succeeded',text:'spoken instruction',provider:'fixture-transcription'})
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0})
  try{assert.equal((await (await fetch(server.url+'/v1/bootstrap')).json()).capabilities.voiceRecording,true)}finally{await server.close()}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId}
  async function upload(purpose){const bytes=Buffer.from('RIFFtest');const intent={uploadId:randomUUID(),target,name:'recording.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose};const result=await runtime.artifacts.upload(actor,intent,stream(bytes));return result.artifact.id}
  const ordinary=await upload('attachment'),voice=await upload('voice_note')
  const parts=[{kind:'text',text:'typed caption'},{kind:'file',artifactId:ordinary,purpose:'attachment'},{kind:'file',artifactId:voice,purpose:'voice_note'}]
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts})
  assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.voice_preparations WHERE message_id=$1',[saved.messageId])).rows[0].n,1)
  const adapter=execution();dispatcher=new TextDispatcher(runtime,adapter);await dispatcher.start()
  await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  assert.equal(provider.calls.length,1)
  const record=await messageRecord(runtime.db,saved.messageId);assert.deepEqual(record.parts,parts);assert.equal(record.preparation[0].transcript,'spoken instruction');assert.equal(record.preparation[0].partIndex,2)
  const scope={kind:'thread',installationId:actor.installationId,callerId:actor.personId,threadId:saved.threadId}
  const page=await snapshot(runtime.db,scope,{afterMessagePosition:null,afterWorkPosition:null,limit:10});assert.equal(page.messages[0].preparation[0].status,'succeeded')
  assert.equal(adapter.contexts[0].input[0].parts[1].purpose,'attachment');assert.equal(adapter.contexts[0].input[0].parts[2].transcription.text,'spoken instruction')
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})

test('failed voice-only preparation still dispatches original with honest status', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-fail-'))
 let runtime,dispatcher
 try{
  const provider=transcription({status:'unavailable',reason:'provider-error',provider:'fixture-transcription'})
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'voice.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
  const adapter=execution();dispatcher=new TextDispatcher(runtime,adapter);await dispatcher.start()
  await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  const part=adapter.contexts[0].input[0].parts[0]
  assert.equal(part.artifactId,upload.artifact.id);assert.equal(part.availability,'available');assert.equal(part.transcription.status,'unavailable');assert.equal(part.transcription.reason,'provider-error')
  const record=await messageRecord(runtime.db,saved.messageId);assert.equal(record.preparation[0].status,'unavailable');assert.equal(record.preparation[0].error,'provider-error')
  assert.equal(provider.calls.length,1)
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})

test('restart fences interrupted voice preparation and does not invoke provider twice', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-recover-'))
 let runtime,dispatcher
 try{
  const provider=transcription({status:'succeeded',text:'late text',provider:'fixture-transcription'})
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'voice.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
  const incarnation=randomUUID(),attemptId=randomUUID()
  await runtime.db.transaction(async client=>{
   await client.query("UPDATE kipster.work_intents SET state='preparing',generation=1 WHERE id=$1",[saved.runId])
   await client.query("INSERT INTO kipster.attempts(id,intent_id,generation,incarnation,state) VALUES ($1,$2,1,$3,'preparing')",[attemptId,saved.runId,incarnation])
   await client.query("UPDATE kipster.text_runs SET state='preparing',current_attempt_id=$2 WHERE id=$1",[saved.runId,attemptId])
   await client.query("UPDATE kipster.voice_preparations SET status='preparing',attempt_id=$2,provider_id='fixture-transcription' WHERE message_id=$1",[saved.messageId,attemptId])
  })
  const adapter=execution();dispatcher=new TextDispatcher(runtime,adapter);await dispatcher.start()
  await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  assert.equal(provider.calls.length,0)
  assert.equal((await messageRecord(runtime.db,saved.messageId)).preparation[0].status,'unavailable')
  assert.equal((await runtime.db.query("SELECT count(*)::int AS n FROM kipster.thread_events WHERE resource_id=$1 AND type='message-final'",[saved.messageId])).rows[0].n,2)
  assert.equal(adapter.contexts.length,1);assert.equal(adapter.contexts[0].input[0].parts[0].transcription.reason,'interrupted')
  assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.attempts WHERE intent_id=$1',[saved.runId])).rows[0].n,2)
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})

test('Stop during voice preparation fences a late transcript and never dispatches', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-stop-'))
 let runtime,dispatcher
 try{
  let release;const provider={id:'fixture-transcription',contractMajor:1,inputTypes:['audio/*','video/*'],async readiness(){return {ready:true}},async transcribe(){return new Promise(resolve=>{release=resolve})},async close(){}}
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'voice.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
  const adapter=execution();dispatcher=new TextDispatcher(runtime,adapter);await dispatcher.start()
  await until(async()=>(await runtime.db.query('SELECT status FROM kipster.voice_preparations WHERE message_id=$1',[saved.messageId])).rows[0]?.status,x=>x==='preparing')
  await until(async()=>release,x=>typeof x==='function')
  const attemptId=(await runtime.db.query('SELECT current_attempt_id FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0].current_attempt_id
  const result=await dispatcher.control(actor,{operationId:randomUUID(),context,chatId,threadId:saved.threadId,runId:saved.runId,attemptId,action:'stop'})
  assert.equal(result.state,'cancelled')
  release({status:'succeeded',text:'too late',provider:provider.id})
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal((await messageRecord(runtime.db,saved.messageId)).preparation[0].status,'unavailable')
  assert.equal(adapter.contexts.length,0)
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})

test('agent tool transcribes ordinary audio only on an authorized current attempt and reuses call result', {skip:noDatabase},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-tool-'))
 let runtime,dispatcher
 try{
  const gate=deferred()
  const provider=transcription({status:'succeeded',text:'ordinary audio transcript',provider:'fixture-transcription'})
  const original=provider.transcribe.bind(provider)
  provider.transcribe=async input=>{await gate.promise;return original(input)}
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'ordinary.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'attachment'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'attachment'}]})
  let release;const done=new Promise(resolve=>{release=resolve})
  const adapter={id:'test-adapter',version:'1',contractMajor:1,async execute(ctx){return {events:(async function*(){await done;yield {kind:'ended',attemptId:ctx.attemptId,confirmed:true}})(),async cancel(){return {acknowledged:true,confirmedEnded:true}},async reconcile(){return 'ended'}}},async close(){release()}}
  dispatcher=new TextDispatcher(runtime,adapter);await dispatcher.start()
  const attemptId=await until(async()=>(await runtime.db.query('SELECT state,current_attempt_id FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0],x=>x?.state==='running').then(x=>x.current_attempt_id)
  assert.equal(provider.calls.length,0)
  const firstPromise=dispatcher.transcribeTool(attemptId,'call-1',upload.artifact.id)
  const concurrentPromise=dispatcher.transcribeTool(attemptId,'call-1',upload.artifact.id)
  gate.resolve()
  const [first,concurrent]=await Promise.all([firstPromise,concurrentPromise]);assert.equal(first.text,'ordinary audio transcript');assert.deepEqual(concurrent,first)
  const replay=await dispatcher.transcribeTool(attemptId,'call-1',upload.artifact.id);assert.deepEqual(replay,first);assert.equal(provider.calls.length,1)
  const denied=await dispatcher.transcribeTool(attemptId,'call-2',randomUUID());assert.equal(denied.status,'unavailable');assert.equal(provider.calls.length,1)
  release();await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  const obsolete=await dispatcher.transcribeTool(attemptId,'call-3',upload.artifact.id);assert.equal(obsolete.status,'unavailable')
 }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}}
test('pre-aborted provider boundary does not invoke a provider or wait for an abort event',async()=>{
  const controller=new AbortController();controller.abort()
  let invoked=0
  const result=await abortableResult(controller.signal,async()=>{invoked++;return 'late'},'cancelled')
  assert.equal(result,'cancelled');assert.equal(invoked,0)
})
async function voiceRaceFixture(hooks){
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-race-'))
 const provider=transcription({status:'succeeded',text:'late success',provider:'fixture-transcription'})
 const runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
 const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
 const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
 const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
 const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'voice.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
 const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
 const adapter=execution(),dispatcher=new TextDispatcher(runtime,adapter,undefined,hooks);await dispatcher.start()
 return {admin,database,home,runtime,actor,context,chatId,saved,provider,adapter,dispatcher,async close(){await dispatcher.close();await runtime.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}}
}
for(const phase of ['claim','settle'])test(`Stop between voice ${phase} eligibility read and thread lock fences late result`,{skip:noDatabase},async()=>{
 const reached=deferred(),proceed=deferred()
 const hooks=phase==='claim'?{beforeVoiceClaimLock:async()=>{reached.resolve();await proceed.promise}}:{beforeVoiceSettleLock:async()=>{reached.resolve();await proceed.promise}}
 const f=await voiceRaceFixture(hooks)
 try{
  await reached.promise
  const attemptId=(await f.runtime.db.query('SELECT current_attempt_id FROM kipster.text_runs WHERE id=$1',[f.saved.runId])).rows[0].current_attempt_id
  const stopped=await f.dispatcher.control(f.actor,{operationId:randomUUID(),context:f.context,chatId:f.chatId,threadId:f.saved.threadId,runId:f.saved.runId,attemptId,action:'stop'})
  assert.equal(stopped.state,'cancelled')
  proceed.resolve()
  await until(async()=>(await f.runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[f.saved.runId])).rows[0]?.state,x=>x==='cancelled')
  await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal((await messageRecord(f.runtime.db,f.saved.messageId)).preparation[0].status,'unavailable')
  assert.equal(f.adapter.contexts.length,0)
  assert.equal(f.provider.calls.length,phase==='claim'?0:1)
 }finally{proceed.resolve();await f.close()}
})

async function toolRaceFixture(hooks){
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-tool-race-'))
 const provider=transcription({status:'succeeded',text:'late tool text',provider:'fixture-transcription'})
 const runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
 const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
 const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
 const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
 const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'ordinary.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'attachment'},stream(bytes))
 const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'attachment'}]})
 const done=deferred()
 const adapter={id:'test-adapter',version:'1',contractMajor:1,async execute(ctx){return {events:(async function*(){await done.promise;yield {kind:'ended',attemptId:ctx.attemptId,confirmed:true}})(),async cancel(){return {acknowledged:true,confirmedEnded:true}},async reconcile(){return 'ended'}}},async close(){done.resolve()}}
 const dispatcher=new TextDispatcher(runtime,adapter,undefined,hooks);await dispatcher.start()
 const attemptId=await until(async()=>(await runtime.db.query('SELECT state,current_attempt_id FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0],x=>x?.state==='running').then(x=>x.current_attempt_id)
 return {admin,database,home,runtime,actor,context,chatId,saved,provider,dispatcher,attemptId,artifactId:upload.artifact.id,async close(){done.resolve();await dispatcher.close();await runtime.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}}
}
for(const phase of ['claim','settle'])test(`Stop between tool ${phase} eligibility read and thread lock denies result`,{skip:noDatabase},async()=>{
 const reached=deferred(),proceed=deferred()
 const hooks=phase==='claim'?{beforeToolClaimLock:async()=>{reached.resolve();await proceed.promise}}:{beforeToolSettleLock:async()=>{reached.resolve();await proceed.promise}}
 const f=await toolRaceFixture(hooks)
 try{
  const pending=f.dispatcher.transcribeTool(f.attemptId,'race-call',f.artifactId)
  await reached.promise
  const stopped=await f.dispatcher.control(f.actor,{operationId:randomUUID(),context:f.context,chatId:f.chatId,threadId:f.saved.threadId,runId:f.saved.runId,attemptId:f.attemptId,action:'stop'})
  assert.equal(stopped.outcome,'accepted')
  proceed.resolve()
  const result=await pending
  assert.equal(result.status,'unavailable');assert.equal(result.reason,'cancelled')
  assert.equal(f.provider.calls.length,phase==='claim'?0:1)
  const savedResult=(await f.runtime.db.query('SELECT result FROM kipster.voice_tool_calls WHERE attempt_id=$1 AND call_id=$2',[f.attemptId,'race-call'])).rows[0]?.result
  assert.equal(savedResult??null,null)
 }finally{proceed.resolve();await f.close()}
})

test('a coordinator lock blip keeps an in-progress transcription and dispatches the run once', {skip:noDatabase,timeout:30000},async()=>{
 const admin=new Postgres(adminUrl),database=`kipstervoice_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`;const home=await mkdtemp(join(tmpdir(),'kipster-voice-blip-'))
 let runtime,dispatcher,finish
 try{
  const gate=new Promise(resolve=>{finish=resolve})
  const calls=[]
  const provider={id:'fixture-transcription',contractMajor:1,inputTypes:['audio/*','video/*'],async readiness(){return {ready:true}},async transcribe(input){calls.push(input);await gate;return {status:'succeeded',text:'spoken across the blip',provider:'fixture-transcription'}},async close(){}}
  runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
  const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
  const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
  const target={installationId:actor.installationId,callerId:actor.personId,context,chatId},bytes=Buffer.from('RIFFtest')
  const upload=await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target,name:'voice.wav',mimeType:'audio/wav',size:bytes.length,sha256:digest(bytes),purpose:'voice_note'},stream(bytes))
  const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'voice_note'}]})
  const events=[],adapter=execution()
  dispatcher=new TextDispatcher(runtime,adapter,undefined,{coordinatorLock:state=>{events.push(state)}});await dispatcher.start()
  await until(async()=>calls.length,n=>n===1)
  const holder=(await admin.query(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=78315 AND objid=6 AND objsubid=2 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=$1)`,[database])).rows[0].pid
  await admin.query('SELECT pg_terminate_backend($1)',[holder])
  await until(async()=>events.join(),value=>value==='lost,restored')
  assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0].state,'preparing','this process still prepares the run')
  finish()
  await until(async()=>(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[saved.runId])).rows[0]?.state,x=>x==='completed')
  assert.equal(calls.length,1)
  assert.equal(adapter.contexts.length,1)
  assert.equal(adapter.contexts[0].input[0].parts[0].transcription.text,'spoken across the blip')
  assert.equal((await messageRecord(runtime.db,saved.messageId)).preparation[0].status,'succeeded')
 }finally{finish?.();await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})}
})
