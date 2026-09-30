import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { VectorService } from '../dist/modules/vectors/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

test('vector input rejects non-JSON metadata before database access',async()=>{
  const service=new VectorService({query(){throw Error('database was reached')}},randomUUID(),{})
  await assert.rejects(service.invoke(randomUUID(),randomUUID(),'invalid',{operation:'upsert',target:{kind:'agent',ownerId:randomUUID()},collectionId:randomUUID(),key:'one',expectedRevision:0,text:'valid text',metadata:{score:Infinity}}),/Invalid vector number/)
})
async function until(read,predicate) {for(let n=0;n<200;n++){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,20))}throw Error('Timed out')}
function fixture(){
  const contexts=[],handles=[]
  return {id:'vector-fixture',version:'1',contractMajor:1,contexts,handles,
    async execute(context){contexts.push(context);const queue=[];let wake,closed=false
      const handle={events:{async *[Symbol.asyncIterator](){while(!closed||queue.length){const item=queue.shift()??await new Promise(resolve=>wake=resolve);if(item)yield item}}},
        emit(item){if(wake){const next=wake;wake=undefined;next(item)}else queue.push(item);if(['ended','failed'].includes(item.kind))closed=true},
        async cancel(){return {acknowledged:false,confirmedEnded:false}},async reconcile(){return 'active'}}
      handles.push(handle);return handle},
    async close(){handles.forEach((handle,index)=>handle.emit({kind:'failed',attemptId:contexts[index].attemptId,confirmedEnded:false,message:'closed'}))}
  }
}

test('vector collection lifecycle, shared generations, retained sources and stale fences', {skip:noDatabase,timeout:30000},async()=>{
  const admin=new Postgres(adminUrl),database=`kipstervec_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  const home=await mkdtemp(join(tmpdir(),'kipster-vectors-'))
  let runtime,dispatcher,server
  try{
    let fail=false,release,entered,releaseQuery,enteredQuery,releaseCollection,enteredCollection,releaseStopQuery,enteredStopQuery,releaseOwnerQuery,enteredOwnerQuery,releaseLease,enteredLease,leaseCalls=0
    const barrier=new Promise(resolve=>entered=resolve)
    const queryBarrier=new Promise(resolve=>enteredQuery=resolve)
    const collectionBarrier=new Promise(resolve=>enteredCollection=resolve)
    const stopQueryBarrier=new Promise(resolve=>enteredStopQuery=resolve)
    const ownerQueryBarrier=new Promise(resolve=>enteredOwnerQuery=resolve)
    const leaseBarrier=new Promise(resolve=>enteredLease=resolve)
    const embedder={async embed(text){if(text==='BLOCK'){entered();await new Promise(resolve=>release=resolve)}if(text==='LEASE_BLOCK'&&++leaseCalls===1){enteredLease();await new Promise(resolve=>releaseLease=resolve)}if(fail)throw Error('provider offline');return text.includes('north')||text==='BLOCK'?[1,0]:[0,1]}}
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'One',rootAgent:'Agent'},embedding:{id: 'ollama', contractMajor: 1,model:'fixture-one',...embedder}})
    await runtime.vectors.stopIndexing();await runtime.memory.stopIndexing()
    const ids=runtime.bootstrap,otherAgent=randomUUID(),otherOrg=randomUUID()
    await runtime.home.provisionAgent(otherAgent)
    await runtime.db.query("INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)",[otherAgent,ids.installationId])
    await runtime.db.query("INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)",[otherOrg,ids.installationId])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[ids.organizationId,otherAgent])
    await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1',[ids.organizationId,JSON.stringify({adapterId:'vector-fixture',modelId:'fixture'})])
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[ids.rootAgentId,JSON.stringify({adapterId:'vector-fixture',modelId:'fixture'})])
    const adapter=fixture(),actor={installationId:ids.installationId,personId:ids.ownerId}
    dispatcher=new TextDispatcher(runtime,adapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    const post=async(path,value)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});assert.ok(response.ok,`${path}: ${response.status}`);return response.json()}
    const context={kind:'organization',organizationId:ids.organizationId},scope={installationId:ids.installationId,callerId:ids.ownerId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:ids.rootAgentId})).chatId
    await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Build a vector collection'}]})
    await dispatcher.start()
    await until(()=>adapter.contexts.length,n=>n===1)
    assert.equal(adapter.contexts[0].vectorsEnabled,true)
    const attempt=adapter.contexts[0].attemptId,host=textPublicationHost(dispatcher),target={kind:'agent',ownerId:ids.rootAgentId}
    const call=(callId,input)=>host.invokeTool({attemptId:attempt,callId,name:'vectors.space',arguments:{target,...input}})
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[otherAgent])
    await assert.rejects(call('unavailable-owner',{operation:'create',target:{kind:'agent',ownerId:otherAgent},name:'denied_owner'}),/owner unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[otherAgent])
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[ids.rootAgentId])
    await assert.rejects(call('unavailable-actor',{operation:'create',target:{kind:'agent',ownerId:otherAgent},name:'denied_actor'}),/Acting vector agent unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[ids.rootAgentId])
    let unlockOwner,ownerLocked,capacityAcquired=false
    const ownerBarrier=new Promise(resolve=>ownerLocked=resolve)
    const ownerHold=new Promise(resolve=>unlockOwner=resolve)
    const ownerBlocker=runtime.db.transaction(async client=>{
      await client.query('SELECT id FROM kipster.agents WHERE id=$1 FOR UPDATE',[otherAgent])
      ownerLocked();await ownerHold
      await client.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[otherAgent])
    })
    await ownerBarrier
    const racingOwner=call('owner-order',{operation:'create',target:{kind:'agent',ownerId:otherAgent},name:'denied_order'}).then(()=>null,error=>error)
    try {
      await until(async()=>Number((await runtime.db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%kipster.agents%' ")).rows[0].n),n=>n>0)
      const capacityProbe=runtime.db.transaction(async client=>{
        await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[ids.installationId]);capacityAcquired=true
      })
      await new Promise(resolve=>setTimeout(resolve,50))
      assert.equal(capacityAcquired,false,'vector mutation holds capacity before owner lock')
      unlockOwner();await ownerBlocker
      assert.match((await racingOwner).message,/owner unavailable/)
      await capacityProbe
      assert.equal(capacityAcquired,true)
    } finally {unlockOwner?.();await ownerBlocker}
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[otherAgent])
    const create={operation:'create',name:'documents'}
    const [collection,replayed]=await Promise.all([call('collection',create),call('collection',create)])
    assert.deepEqual(collection,replayed)
    const collectionId=collection.collectionId
    assert.equal((await call('discover',{operation:'discover'})).collections[0].id,collectionId)
    assert.equal((await call('describe',{operation:'describe',collectionId})).recordCount,0)
    await assert.rejects(call('too-long',{operation:'upsert',collectionId,key:'oversize',expectedRevision:0,text:'x'.repeat(9000)}),/request limit|source text/)
    await assert.rejects(call('too-many',{operation:'search',collectionId,query:'north',limit:21}),/vector integer/)
    await assert.rejects(call('unexpected',{operation:'create',name:'bad',sql:'DROP TABLE kipster.attempts'}),/Unexpected vector field/)
    const upsert={operation:'upsert',collectionId,key:'doc-1',expectedRevision:0,text:'north station',metadata:{source:'test'}}
    const [record,duplicate]=await Promise.all([call('upsert',upsert),call('upsert',upsert)])
    assert.deepEqual(record,duplicate)
    assert.equal((await call('get',{operation:'get',collectionId,key:'doc-1'})).record.indexStatus,'pending')
    assert.equal((await call('search-pending',{operation:'search',collectionId,query:'north'})).availability,'pending')
    assert.deepEqual(await runtime.memory.context(ids.rootAgentId,ids.organizationId,'north'),[])
    fail=true
    assert.equal((await runtime.vectors.indexPending(1)).failed,1)
    assert.equal((await call('get-failed',{operation:'get',collectionId,key:'doc-1'})).record.indexStatus,'failed')
    assert.equal((await call('search-failed',{operation:'search',collectionId,query:'north'})).availability,'failed')
    fail=false
    assert.equal((await runtime.vectors.indexPending(1,true)).ready,1)
    assert.equal((await call('search-ready',{operation:'search',collectionId,query:'north'})).results[0].id,record.recordId)
    const corrected=await call('correct',{...upsert,expectedRevision:1,text:'south station'})
    assert.equal(corrected.revision,2)
    assert.equal((await call('get-corrected',{operation:'get',collectionId,key:'doc-1'})).record.text,'south station')
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.vector_sources WHERE record_id=$1',[record.recordId])).rows[0].n,1)
    assert.equal((await call('search-before-correct-index',{operation:'search',collectionId,query:'north'})).results.length,0)
    assert.equal((await runtime.vectors.indexPending(1)).ready,1)
    const next=await call('second',{operation:'upsert',collectionId,key:'doc-2',expectedRevision:0,text:'south platform'})
    await runtime.vectors.indexPending(1)
    const firstPage=await call('page-one',{operation:'search',collectionId,query:'south',limit:1})
    assert.equal(firstPage.results.length,1)
    assert.ok(firstPage.nextCursor)
    await call('second-correct',{operation:'upsert',collectionId,key:'doc-2',expectedRevision:1,text:'south terminal'})
    await assert.rejects(call('old-page',{operation:'search',collectionId,query:'south',limit:1,cursor:firstPage.nextCursor}),/pagination invalidated/)
    assert.equal((await runtime.vectors.indexPending(1)).ready,1)
    const leaseCollection=await call('lease-collection',{operation:'create',name:'leasebox'})
    const leaseRecord=await call('lease-record',{operation:'upsert',collectionId:leaseCollection.collectionId,key:'one',expectedRevision:0,text:'LEASE_BLOCK'})
    const oldLease=runtime.vectors.indexPending(1)
    await leaseBarrier
    await runtime.db.query("UPDATE kipster.vector_index_intents SET lease_until=now()-interval '1 second' WHERE record_id=$1",[leaseRecord.recordId])
    assert.equal((await runtime.vectors.indexPending(1)).ready,1)
    releaseLease()
    assert.equal((await oldLease).stale,1)
    await call('lease-delete',{operation:'delete_collection',collectionId:leaseCollection.collectionId,expectedRevision:(await call('lease-describe',{operation:'describe',collectionId:leaseCollection.collectionId})).revision})
    assert.equal((await call('cross-agent',{operation:'discover',target:{kind:'agent',ownerId:otherAgent}})).collections.length,0)
    await assert.rejects(call('bad-org',{operation:'discover',target:{kind:'organization',ownerId:otherOrg}}),/outside active context/)
    const org=await call('org-create',{operation:'create',target:{kind:'organization',ownerId:ids.organizationId},name:'shared'})
    assert.equal(org.owner.kind,'organization')
    await runtime.db.query("CREATE FUNCTION kipster.reject_vector_rebuild() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'vector rebuild rejected'; END $$")
    await runtime.db.query('CREATE TRIGGER reject_vector_rebuild BEFORE INSERT ON kipster.vector_index_intents FOR EACH ROW EXECUTE FUNCTION kipster.reject_vector_rebuild()')
    await assert.rejects(runtime.memory.activateRebuild(ids.ownerId,1,{ id: 'ollama', contractMajor: 1,model:'fixture-two', async embed(){return [0,1]} }),/vector rebuild rejected/)
    assert.equal(Number((await runtime.db.query('SELECT generation FROM kipster.memory_profiles WHERE installation_id=$1',[ids.installationId])).rows[0].generation),1)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.memory_embedding_generations WHERE installation_id=$1',[ids.installationId])).rows[0].n,1)
    await runtime.db.query('DROP TRIGGER reject_vector_rebuild ON kipster.vector_index_intents')
    await runtime.db.query('DROP FUNCTION kipster.reject_vector_rebuild()')
    const newGeneration=await runtime.memory.activateRebuild(ids.ownerId,1,{ id: 'ollama', contractMajor: 1,model:'fixture-two', async embed(text){if(text==='QUERY_BLOCK'){enteredQuery();await new Promise(resolve=>releaseQuery=resolve)}return [0,1]} })
    assert.equal(newGeneration,2)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.vector_index_intents WHERE generation=2')).rows[0].n,2)
    const rebuilding=await call('rebuilding',{operation:'search',collectionId,query:'south'})
    assert.equal(rebuilding.availability,'pending')
    assert.equal(rebuilding.results.length,0)
    assert.equal((await runtime.vectors.indexPending(2)).ready,2)
    assert.equal((await call('rebuilt',{operation:'search',collectionId,query:'south'})).results.length,2)
    const queryDuringChange=call('query-changing',{operation:'search',collectionId,query:'QUERY_BLOCK'}).then(()=>null,error=>error)
    await queryBarrier
    assert.equal(await runtime.memory.activateRebuild(ids.ownerId,2,{ id: 'ollama', contractMajor: 1,model:'fixture-three', async embed(text){if(text==='BLOCK'){entered();await new Promise(resolve=>release=resolve)}if(text==='COLLECTION_BLOCK'){enteredCollection();await new Promise(resolve=>releaseCollection=resolve)}if(text==='QUERY_STOP'){enteredStopQuery();await new Promise(resolve=>releaseStopQuery=resolve)}return [0,1]} }),3)
    releaseQuery()
    assert.match((await queryDuringChange).message,/pagination invalidated/)
    assert.equal((await runtime.vectors.indexPending(2)).ready,2)
    const oldWorker=runtime.vectors.indexPending(1,true)
    await oldWorker
    const blocked=await call('blocking',{operation:'upsert',collectionId,key:'doc-3',expectedRevision:0,text:'BLOCK'})
    const embedding=runtime.vectors.indexPending(1)
    await barrier
    await call('delete-inflight',{operation:'delete_record',collectionId,key:'doc-3',expectedRevision:1})
    release();assert.equal((await embedding).stale,1)
    assert.equal((await call('deleted-get',{operation:'get',collectionId,key:'doc-3'})).record,null)
    const newRecord=await call('new-same-key',{operation:'upsert',collectionId,key:'doc-3',expectedRevision:0,text:'south again'})
    assert.notEqual(newRecord.recordId,blocked.recordId)
    let unlockRecord,recordLocked
    const rowBarrier=new Promise(resolve=>recordLocked=resolve)
    const rowHold=new Promise(resolve=>unlockRecord=resolve)
    const rowBlocker=runtime.db.transaction(async client=>{
      await client.query('SELECT id FROM kipster.vector_records WHERE id=$1 FOR UPDATE',[record.recordId])
      recordLocked();await rowHold
    })
    await rowBarrier
    const concurrentUpsert=call('concurrent-upsert',{operation:'upsert',collectionId,key:'doc-1',expectedRevision:2,text:'south changed'})
    await new Promise(resolve=>setTimeout(resolve,80))
    const concurrentActivation=runtime.memory.activateRebuild(ids.ownerId,3,{ id: 'ollama', contractMajor: 1,model:'fixture-four', async embed(text){if(text==='COLLECTION_BLOCK'){enteredCollection();await new Promise(resolve=>releaseCollection=resolve)}if(text==='QUERY_STOP'){enteredStopQuery();await new Promise(resolve=>releaseStopQuery=resolve)}if(text==='QUERY_OWNER'){enteredOwnerQuery();await new Promise(resolve=>releaseOwnerQuery=resolve)}return [0,1]} })
    unlockRecord();await rowBlocker
    const overlap=await Promise.allSettled([concurrentUpsert,concurrentActivation])
    assert.equal(overlap[0].status,'fulfilled')
    assert.equal(overlap[0].value.revision,3)
    assert.equal(overlap[1].status,'fulfilled')
    assert.equal(overlap[1].value,4)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.vector_index_intents WHERE record_id=$1 AND source_revision=3 AND generation=4',[record.recordId])).rows[0].n,1)
    const last=await call('delete-collection',{operation:'delete_collection',collectionId,expectedRevision:(await call('describe-final',{operation:'describe',collectionId})).revision})
    assert.equal(last.deleted,true)
    await assert.rejects(call('deleted-search',{operation:'search',collectionId,query:'south'}),/not found/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.vector_records WHERE collection_id=$1',[collectionId])).rows[0].n,0)
    await assert.rejects(call('upsert',{...upsert,text:'other'}),/identity conflict/)
    const recreated=await call('recreate-documents',{operation:'create',name:'documents'})
    assert.notEqual(recreated.collectionId,collectionId)
    assert.equal((await call('collection',create)).collectionId,collectionId,'old receipt cannot redirect to replacement')
    await call('delete-recreated',{operation:'delete_collection',collectionId:recreated.collectionId,expectedRevision:1})
    const history=await call('history-collection',{operation:'create',name:'history'})
    await call('history-1',{operation:'upsert',collectionId:history.collectionId,key:'one',expectedRevision:0,text:'version 1'})
    for(let revision=1;revision<=20;revision++)await call(`history-${revision+1}`,{operation:'upsert',collectionId:history.collectionId,key:'one',expectedRevision:revision,text:`version ${revision+1}`})
    assert.deepEqual((await runtime.db.query('SELECT s.revision,s.text FROM kipster.vector_sources s JOIN kipster.vector_records r ON r.id=s.record_id WHERE r.collection_id=$1',[history.collectionId])).rows,[{revision:21,text:'version 21'}])
    await call('history-delete',{operation:'delete_collection',collectionId:history.collectionId,expectedRevision:(await call('history-describe',{operation:'describe',collectionId:history.collectionId})).revision})
    const doomed=await call('doomed-collection',{operation:'create',name:'doomed'})
    await call('doomed-source',{operation:'upsert',collectionId:doomed.collectionId,key:'one',expectedRevision:0,text:'COLLECTION_BLOCK'})
    const lateIndex=runtime.vectors.indexPending(1)
    await collectionBarrier
    await call('doomed-delete',{operation:'delete_collection',collectionId:doomed.collectionId,expectedRevision:(await call('doomed-describe',{operation:'describe',collectionId:doomed.collectionId})).revision})
    releaseCollection()
    assert.equal((await lateIndex).stale,1)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.vector_index_intents i JOIN kipster.vector_records r ON r.id=i.record_id WHERE r.collection_id=$1',[doomed.collectionId])).rows[0].n,0)
    const restartCollection=await call('restart-collection',{operation:'create',name:'restart'})
    await call('restart-source',{operation:'upsert',collectionId:restartCollection.collectionId,key:'durable',expectedRevision:0,text:'north restart'})
    assert.equal((await runtime.vectors.indexPending(1)).ready,1)
    const crossOwned=await call('cross-owner-collection',{operation:'create',target:{kind:'agent',ownerId:otherAgent},name:'cross_owned'})
    await call('cross-owner-source',{operation:'upsert',target:{kind:'agent',ownerId:otherAgent},collectionId:crossOwned.collectionId,key:'one',expectedRevision:0,text:'south cross owner'})
    assert.equal((await runtime.vectors.indexPending(1)).ready,1)
    const ownerQuery=call('query-owner',{operation:'search',target:{kind:'agent',ownerId:otherAgent},collectionId:crossOwned.collectionId,query:'QUERY_OWNER'}).then(()=>null,error=>error)
    await ownerQueryBarrier
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[otherAgent])
    releaseOwnerQuery()
    assert.match((await ownerQuery).message,/owner unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[otherAgent])
    const restartPending=await call('restart-pending',{operation:'upsert',collectionId:restartCollection.collectionId,key:'pending',expectedRevision:0,text:'south restart'})
    await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Ask the other agent to write a vector'}]})
    await until(()=>adapter.contexts.length,n=>n>=2)
    const parentAttempt=adapter.contexts[1].attemptId
    await dispatcher.agentTool(parentAttempt,'delegate-vector','agents.delegate',{recipientId:otherAgent,request:'Write one vector collection'})
    adapter.handles[1].emit({kind:'ended',attemptId:parentAttempt,confirmed:true})
    const childContext=await until(()=>adapter.contexts.find(item=>item.agentId===otherAgent),Boolean)
    const childAttempt=childContext.attemptId
    const delegated=await host.invokeTool({attemptId:childAttempt,callId:'delegated-vector',name:'vectors.space',arguments:{operation:'create',target:{kind:'agent',ownerId:ids.rootAgentId},name:'delegated'}})
    assert.equal(delegated.actorId,otherAgent)
    assert.equal(delegated.owner.ownerId,ids.rootAgentId)
    adapter.handles[adapter.contexts.indexOf(childContext)].emit({kind:'ended',attemptId:childAttempt,confirmed:true})
    const queryAfterStop=call('query-stop',{operation:'search',collectionId:restartCollection.collectionId,query:'QUERY_STOP'}).then(()=>null,error=>error)
    await stopQueryBarrier
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attempt])
    releaseStopQuery()
    assert.match((await queryAfterStop).message,/no longer owns/)
    await assert.rejects(call('stopped',{operation:'discover'}),/no longer owns/)
    await dispatcher.close();dispatcher=null
    await server.close();server=null
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'One',rootAgent:'Agent'},embedding:{id: 'ollama', contractMajor: 1,model:'fixture-four',async embed(){return [0,1]}}})
    await runtime.vectors.stopIndexing()
    await runtime.vectors.indexPending(20,true)
    const durable=(await runtime.db.query('SELECT status FROM kipster.vector_index_intents WHERE record_id=$1 AND generation=4',[restartPending.recordId])).rows[0]
    assert.equal(durable.status,'ready')
  }finally{
    await dispatcher?.close();await server?.close();await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.close()
  }
})
