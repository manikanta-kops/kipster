import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime } from '../dist/runtime.js'
import { MemoryService } from '../dist/modules/memory/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const profile={id: 'ollama', contractMajor: 1,model:'fixture-embedding'}

test('memory survives restart; revisions fence stale vectors; organization publication is explicit', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl)
  const dbName=`kipster_memory_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster_memory-home-'))
  let blockedResolve
  let block=false
  let fail=false
  let mismatch=false
  let timeout=false
  const embedder={async embed(text){if(block)await new Promise(resolve=>{blockedResolve=resolve});if(timeout)await new Promise(()=>{});if(fail)throw Error('fixture provider unavailable');if(mismatch)return [1,0,0];return text.includes('Amsterdam')||text.includes('semantic-query')?[1,0]:[0,1]}}
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'One',rootAgent:'Root'},embedding:{...profile,...embedder}})
    await runtime.memory.stopIndexing()
    const {installationId,organizationId,rootAgentId}=runtime.bootstrap
    const otherOrg=randomUUID(), otherAgent=randomUUID()
    await runtime.db.query(`INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)`,[otherOrg,installationId])
    await runtime.db.query(`INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)`,[otherAgent,installationId])
    const one=await runtime.memory.save(rootAgentId,'fact','Amsterdam office opens at nine',[{sourceOrganizationId:organizationId,authorId:rootAgentId,subject:'hours'},{sourceOrganizationId:otherOrg,authorId:rootAgentId,subject:'confirmation'}])
    assert.equal(one.revision,1)
    assert.equal(one.provenance.length,2)
    assert.equal(one.indexStatus,'pending')
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam office')).at(0)?.retrieval,'lexical')
    assert.equal((await runtime.memory.search(otherAgent,null,'Amsterdam office')).length,0)
    assert.equal((await runtime.memory.search(rootAgentId,organizationId,'Amsterdam office')).at(0)?.record.id,one.id)
    assert.equal((await runtime.memory.search(rootAgentId,otherOrg,'Amsterdam office')).at(0)?.record.id,one.id)
    const published=await runtime.memory.publish(rootAgentId,organizationId,one.id,1)
    assert.equal(published.scope,'organization')
    assert.equal((await runtime.memory.search(otherAgent,organizationId,'Amsterdam office')).at(0)?.record.id,published.id)
    assert.equal((await runtime.memory.search(otherAgent,otherOrg,'Amsterdam office')).length,0)
    block=true
    const indexing=runtime.memory.indexPending(1)
    for(let i=0;i<100&&!blockedResolve;i++)await new Promise(resolve=>setTimeout(resolve,5))
    assert.ok(blockedResolve)
    const revised=await runtime.memory.correct(rootAgentId,one.id,1,'Amsterdam office opens at ten',[{sourceOrganizationId:organizationId,authorId:rootAgentId,subject:'updated hours'}])
    assert.equal(revised.id,one.id)
    assert.equal(revised.revision,2)
    await assert.rejects(runtime.memory.correct(rootAgentId,one.id,1,'Amsterdam office opens at eleven',[{authorId:rootAgentId}]),/revision conflict/)
    assert.equal((await runtime.memory.get(otherAgent,organizationId,published.id)).sourceStale,true)
    blockedResolve();await indexing;block=false
    const oldIndex=(await runtime.db.query(`SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1 AND source_revision=1`,[one.id])).rows[0]
    assert.equal(oldIndex.status,'stale')
    fail=true
    const unavailable=await runtime.memory.indexPending(10)
    assert.ok(unavailable.failed>0)
    assert.equal((await runtime.memory.get(rootAgentId,null,one.id)).text,'Amsterdam office opens at ten')
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam ten')).at(0)?.retrieval,'lexical')
    fail=false
    await runtime.memory.indexPending(10,true)
    assert.equal((await runtime.memory.get(rootAgentId,null,one.id)).indexStatus,'ready')
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam ten')).at(0)?.retrieval,'vector')
    const republished=await runtime.memory.publish(rootAgentId,organizationId,one.id,2,1)
    assert.equal(republished.id,published.id)
    assert.equal(republished.revision,2)
    assert.equal(republished.sourceStale,false)
    assert.equal(republished.text,'Amsterdam office opens at ten')
    await assert.rejects(runtime.memory.publish(rootAgentId,organizationId,one.id,2,1),/Publication revision conflict/)
    const competing=await runtime.memory.save(rootAgentId,'observation','Berlin lobby is quiet',[{authorId:rootAgentId}])
    const outcomes=await Promise.allSettled([
      runtime.memory.correct(rootAgentId,competing.id,1,'Berlin lobby is busy',[{authorId:rootAgentId}]),
      runtime.memory.correct(rootAgentId,competing.id,1,'Berlin lobby is closed',[{authorId:rootAgentId}]),
    ])
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1)
    assert.equal(outcomes.filter(item=>item.status==='rejected').length,1)
    mismatch=true
    const incompatible=await runtime.memory.save(rootAgentId,'fact','Rotterdam desk is closed',[{authorId:rootAgentId}])
    await runtime.memory.indexPending(10)
    assert.equal((await runtime.memory.get(rootAgentId,null,incompatible.id)).indexStatus,'failed')
    assert.equal((await runtime.memory.search(rootAgentId,null,'Rotterdam desk')).at(0)?.retrieval,'lexical')
    mismatch=false
    timeout=true
    const delayed=await runtime.memory.save(rootAgentId,'fact','Utrecht desk is open',[{authorId:rootAgentId}])
    await runtime.memory.indexPending(1)
    assert.equal((await runtime.memory.get(rootAgentId,null,delayed.id)).indexStatus,'failed')
    timeout=false
    await runtime.memory.indexPending(10,true)
    const wrongInstallation=new MemoryService(runtime.db,randomUUID(),{...profile,...embedder})
    assert.equal((await wrongInstallation.indexPending(10)).processed,0)
    assert.equal((await wrongInstallation.search(rootAgentId,organizationId,'Amsterdam')).length,0)
    let releaseLease,leaseStarted,leaseCalls=0
    const leaseBarrier=new Promise(resolve=>{leaseStarted=resolve})
    const leaseEmbedder={async embed(){leaseCalls++;if(leaseCalls===1){leaseStarted();await new Promise(resolve=>{releaseLease=resolve});return [1,0,0]}return [0,1]}}
    const leased=await runtime.memory.save(rootAgentId,'fact','Leiden archive is open',[{authorId:rootAgentId}])
    const competingIndexer=new MemoryService(runtime.db,installationId,{...profile,...leaseEmbedder})
    const oldWorker=competingIndexer.indexPending(1)
    await leaseBarrier
    await runtime.db.query(`UPDATE kipster.memory_index_intents SET lease_until=now()-interval '1 second' WHERE memory_id=$1`,[leased.id])
    assert.equal((await competingIndexer.indexPending(1)).ready,1)
    releaseLease()
    assert.equal((await oldWorker).stale,1)
    assert.equal((await runtime.db.query('SELECT dimension FROM kipster.memory_profiles WHERE installation_id=$1',[installationId])).rows[0].dimension,2)
    assert.equal((await runtime.memory.get(rootAgentId,null,leased.id)).indexStatus,'ready')
    const current=(await runtime.db.query('SELECT generation,dimension FROM kipster.memory_profiles WHERE installation_id=$1',[installationId])).rows[0]
    assert.equal(Number(current.generation),1)
    assert.equal(current.dimension,2)
    for(let index=0;index<201;index++)await runtime.memory.save(rootAgentId,'observation',`Irrelevant fixture ${index} for paging`,[{authorId:rootAgentId}])
    await runtime.db.query(`UPDATE kipster.memory_index_intents i SET status='stale' FROM kipster.memory_records m WHERE m.id=i.memory_id AND m.text LIKE 'Irrelevant fixture %'`)
    assert.equal((await runtime.memory.search(rootAgentId,null,'semantic-query')).at(0)?.record.id,one.id)
    assert.equal((await runtime.memory.search(rootAgentId,null,'semantic-query')).at(0)?.retrieval,'vector')
    await runtime.db.query(`INSERT INTO kipster.memory_embedding_generations(installation_id,generation,provider,model,dimension) VALUES ($1,2,'ollama',$2,2)`,[installationId,profile.model])
    await runtime.db.query('UPDATE kipster.memory_profiles SET generation=2 WHERE installation_id=$1',[installationId])
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam ten')).at(0)?.retrieval,'lexical')
    const restartIntent=await runtime.memory.save(rootAgentId,'fact','Haarlem desk opens early',[{authorId:rootAgentId}])
    assert.equal((await runtime.memory.get(rootAgentId,null,restartIntent.id)).indexStatus,'pending')
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Changed',organization:'Changed',rootAgent:'Changed'},embedding:{...profile,...embedder}})
    for(let index=0;index<100;index++){if((await runtime.memory.get(rootAgentId,null,restartIntent.id)).indexStatus==='ready')break;await new Promise(resolve=>setTimeout(resolve,40))}
    assert.equal((await runtime.memory.get(rootAgentId,null,restartIntent.id)).indexStatus,'ready')
    assert.equal((await runtime.memory.get(rootAgentId,null,one.id)).text,'Amsterdam office opens at ten')
    assert.equal((await runtime.memory.get(otherAgent,organizationId,published.id)).text,'Amsterdam office opens at ten')
    assert.ok((await runtime.memory.context(rootAgentId,organizationId,'Amsterdam office')).join('\n').includes('Amsterdam office opens at ten'))
  }finally{
    await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin.close()
  }
})

test('attempt-bound save is idempotent and changes the next admitted execution context', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),dbName=`kipster_memory_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster_memory-loop-'))
  let runtime,dispatcher,server
  try{
    const {TextDispatcher,startTextServer,textPublicationHost}=await import('../dist/runtime.js')
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:1,embedding:{...profile,async embed(text){return text.includes('Amsterdam')?[1,0]:[0,1]}}})
    const ids=runtime.bootstrap,actor={installationId:ids.installationId,personId:ids.ownerId}
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[ids.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
    const contexts=[],handles=[]
    const adapter={id:'test-adapter',version:'1',contractMajor:1,async execute(context){
      contexts.push(context)
      let next,closed=false;const queue=[]
      const handle={events:{async *[Symbol.asyncIterator](){while(!closed||queue.length){const event=queue.shift()??await new Promise(resolve=>{next=resolve});if(event)yield event}}},release(event){if(next){const resolve=next;next=undefined;resolve(event)}else queue.push(event);if(event.kind==='ended')closed=true},async cancel(){return{acknowledged:true,confirmedEnded:false}},async reconcile(){return'unknown'},abort(){closed=true;next?.(undefined)}}
      handles.push(handle);return handle
    },async close(){handles.forEach(handle=>handle.abort())}}
    dispatcher=new TextDispatcher(runtime,adapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0})
    const post=async(path,body)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status}`);return response.json()}
    const context={kind:'installation',installationId:ids.installationId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:ids.rootAgentId})).chatId
    const submit=(text,threadId)=>post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:ids.installationId,callerId:ids.ownerId},target:{context,chatId:chat},mode:threadId?'reply':'root',...(threadId?{threadId}:{}),parts:[{kind:'text',text}]})
    const first=await submit('Remember the Amsterdam office hours')
    await dispatcher.start()
    for(let i=0;i<100&&handles.length<1;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(handles.length,1)
    assert.equal(contexts[0].tools.some(tool=>tool.name==='memory_save'),true)
    const host=textPublicationHost(dispatcher)
    const request={attemptId:contexts[0].attemptId,callId:'memory-save-1',name:'memory_save',arguments:{kind:'fact',text:'Amsterdam office opens at ten'}}
    const [saved,simultaneous]=await Promise.all([host.invokeTool(request),host.invokeTool(request)])
    assert.equal(saved.status,'completed')
    assert.deepEqual(simultaneous,saved)
    assert.deepEqual(await host.invokeTool(request),saved)
    await assert.rejects(host.invokeTool({...request,arguments:{kind:'fact',text:'Amsterdam office opens at nine'}}),/identity reused/)
    assert.equal((await runtime.db.query(`SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`)).rows[0].n,1)
    const badCorrection={attemptId:contexts[0].attemptId,callId:'memory-correct-rollback',name:'memory_correct',arguments:{id:saved.record.id,expectedRevision:99,text:'Amsterdam office opens at ten sharp'}}
    await assert.rejects(host.invokeTool(badCorrection),/revision conflict/)
    assert.equal((await runtime.db.query(`SELECT count(*)::int AS n FROM kipster.memory_tool_receipts WHERE attempt_id=$1 AND call_id=$2`,[contexts[0].attemptId,badCorrection.callId])).rows[0].n,0)
    const corrected=await host.invokeTool({...badCorrection,arguments:{...badCorrection.arguments,expectedRevision:1}})
    assert.equal(corrected.record.revision,2)
    const large=[]
    for(let index=0;index<20;index++)large.push(await runtime.memory.save(ids.rootAgentId,'observation',`Batch result ${'x'.repeat(8000)}`,[{authorId:ids.rootAgentId}]))
    const ordered=large.map(item=>item.id).sort(),firstLarge=ordered[0],lastLarge=ordered.at(-1),largeEdge=randomUUID()
    const firstHash=(await runtime.db.query('SELECT source_hash FROM kipster.memory_records WHERE id=$1',[firstLarge])).rows[0].source_hash
    await runtime.db.query(`INSERT INTO kipster.memory_relationships(id,installation_id,owner_kind,owner_id,from_id,to_id,kind,weight,from_revision,to_revision) VALUES ($1,$2,'agent',$3,$4,$5,'contradicts',0.9,1,1)`,[largeEdge,ids.installationId,ids.rootAgentId,firstLarge,lastLarge])
    await runtime.db.query(`INSERT INTO kipster.memory_relationship_changes(relationship_id,revision,operation,actor_id,kind,weight,active,from_revision,to_revision) VALUES ($1,1,'link',$2,'contradicts',0.9,true,1,1)`,[largeEdge,ids.rootAgentId])
    await runtime.db.query(`INSERT INTO kipster.memory_relationship_evidence(relationship_id,relationship_revision,ordinal,memory_id,memory_revision,source_hash) VALUES ($1,1,1,$2,1,$3)`,[largeEdge,firstLarge,firstHash])
    const projected=await host.invokeTool({attemptId:contexts[0].attemptId,callId:'bounded-search-pair',name:'memory_search',arguments:{query:'Batch result',limit:20}})
    assert.ok(Buffer.byteLength(JSON.stringify(projected))<=32768)
    const projectedIds=new Set(projected.map(item=>item.record.id))
    assert.ok(projectedIds.has(firstLarge))
    assert.ok(!projectedIds.has(lastLarge),'large result should exercise dropped partner')
    assert.ok(projected.every(item=>item.relationship?.kind!=='contradicts'||projectedIds.has(item.relationship.partnerId)),'projection must not strand a claimed pair')
    assert.equal(projected.find(item=>item.record.id===firstLarge).relationship,undefined,'stranded contradiction label must be removed')
    const originalSearch=runtime.memory.search.bind(runtime.memory)
    let reached,release
    const entered=new Promise(resolve=>{reached=resolve})
    const held=new Promise(resolve=>{release=resolve})
    runtime.memory.search=async(...args)=>{const result=await originalSearch(...args);reached();await held;return result}
    const reading=host.invokeTool({attemptId:contexts[0].attemptId,callId:'search-stop-race',name:'memory_search',arguments:{query:'Amsterdam office'}})
    await entered
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE id=$1',[first.runId])
    release()
    await assert.rejects(reading,/no longer owns memory tools/)
    runtime.memory.search=originalSearch
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE id=$1',[first.runId])
    const question=await dispatcher.askToolInteraction(contexts[0].attemptId,'ask-after-memory',{kind:'question',prompt:'Choose one',options:[{id:'one',label:'One'}],freeText:false})
    handles[0].release({kind:'ended',attemptId:contexts[0].attemptId,confirmed:true})
    for(let i=0;i<100;i++){const row=(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[first.runId])).rows[0];if(row?.state==='waiting')break;await new Promise(resolve=>setTimeout(resolve,20))}
    assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[first.runId])).rows[0].state,'waiting')
    await assert.rejects(host.invokeTool({...request,callId:'late-save'}),/no longer owns/)
    await post('/v1/work/interactions/answer',{version:1,operationId:randomUUID(),interactionId:question.interactionId,threadId:first.threadId,runId:first.runId,attemptId:contexts[0].attemptId,answer:{kind:'choice',optionId:'one'}})
    for(let i=0;i<100&&handles.length<2;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(handles.length,2)
    assert.ok(contexts[1].memory.join('\n').includes('Amsterdam office opens at ten'))
    assert.equal(contexts[1].tools.some(tool=>tool.name==='memory_save'),true)
    handles[1].release({kind:'ended',attemptId:contexts[1].attemptId,confirmed:true})
    for(let i=0;i<100;i++){const row=(await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[first.runId])).rows[0];if(row?.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,20))}
    assert.equal((await runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[first.runId])).rows[0].state,'completed')
    await submit('What time does the Amsterdam office open?',first.threadId)
    for(let i=0;i<100&&handles.length<3;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(handles.length,3)
    assert.ok(contexts[2].memory.join('\n').includes('Amsterdam office opens at ten'))
    handles[2].release({kind:'ended',attemptId:contexts[2].attemptId,confirmed:true})
  }finally{
    await dispatcher?.close();await server?.close();await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);await admin.close()
  }
})

test('concurrent attempt-bound saves use one transaction each and Stop fences late writes', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),dbName=`kipster_memory_${randomUUID().replaceAll('-')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster_memory-pool-'))
  let runtime,dispatcher,server
  try{
    const {TextDispatcher,startTextServer,textPublicationHost}=await import('../dist/runtime.js')
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:12,embedding:{...profile,async embed(){return [1,0]}}})
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'pool-adapter',modelId:'test-model'})])
    const contexts=[],handles=[]
    const adapter={id:'pool-adapter',version:'1',contractMajor:1,async execute(context){contexts.push(context);let next,closed=false;const events=[];const handle={events:{async *[Symbol.asyncIterator](){while(!closed||events.length){const event=events.shift()??await new Promise(resolve=>next=resolve);if(event)yield event}}},release(event){if(next){const resolve=next;next=undefined;resolve(event)}else events.push(event);if(event.kind==='ended')closed=true},async cancel(){return{acknowledged:true,confirmedEnded:false}},async reconcile(){return'unknown'},abort(){closed=true;next?.(undefined)}};handles.push(handle);return handle},async close(){handles.forEach(handle=>handle.abort())}}
    dispatcher=new TextDispatcher(runtime,adapter)
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    const post=async(path,body)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status}`);return response.json()}
    const context={kind:'installation',installationId:actor.installationId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:runtime.bootstrap.rootAgentId})).chatId
    const submissions=await Promise.all(Array.from({length:12},(_,index)=>post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:`Remember fixture ${index}`}]})))
    await dispatcher.start()
    for(let index=0;index<200&&contexts.length<12;index++)await new Promise(resolve=>setTimeout(resolve,25))
    assert.equal(contexts.length,12)
    const host=textPublicationHost(dispatcher)
    const calls=contexts.map((item,index)=>host.invokeTool({attemptId:item.attemptId,callId:`pool-save-${index}`,name:'memory_save',arguments:{kind:'fact',text:`Pool memory ${index}`}}))
    let poolTimeout
    const results=await Promise.race([Promise.all(calls),new Promise((_,reject)=>{poolTimeout=setTimeout(()=>reject(Error('Concurrent memory tools exhausted the pool')),10000)})]).finally(()=>clearTimeout(poolTimeout))
    assert.equal(results.filter(item=>item.status==='completed').length,12)
    assert.equal((await runtime.db.query(`SELECT count(*)::int AS n FROM kipster.memory_records WHERE scope='agent'`)).rows[0].n,12)
    const first=contexts[0]
    const original=runtime.memory.provenance.bind(runtime.memory)
    let unblock,entered
    const gate=new Promise(resolve=>unblock=resolve),arrival=new Promise(resolve=>entered=resolve)
    runtime.memory.provenance=async(...args)=>{entered();await gate;return original(...args)}
    const racing=host.invokeTool({attemptId:first.attemptId,callId:'race-save',name:'memory_save',arguments:{kind:'fact',text:'Race memory'}})
    await arrival
    const firstRun=submissions.find(item=>item.runId===first.runId)
    const stop=post('/v1/work/controls',{version:1,operationId:randomUUID(),context,chatId:chat,threadId:firstRun.threadId,runId:first.runId,attemptId:first.attemptId,action:'stop'})
    let stopSettled=false;void stop.then(()=>{stopSettled=true})
    await new Promise(resolve=>setTimeout(resolve,50))
    assert.equal(stopSettled,false)
    unblock()
    assert.equal((await racing).status,'completed')
    assert.equal((await stop).outcome,'accepted')
    await assert.rejects(host.invokeTool({attemptId:first.attemptId,callId:'late-race',name:'memory_save',arguments:{kind:'fact',text:'Too late'}}),/no longer owns/)
    for(let index=0;index<handles.length;index++)handles[index].release({kind:'ended',attemptId:contexts[index].attemptId,confirmed:true})
  }finally{
    await dispatcher?.close();await server?.close();await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);await admin.close()
  }
})
