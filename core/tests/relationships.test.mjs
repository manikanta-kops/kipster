import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Postgres} from '../dist/platform/postgres/public.js'
import {openRuntime,TextDispatcher,startTextServer,textPublicationHost} from '../dist/runtime.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const profile={id: 'ollama', contractMajor: 1,model:'fixture-embedding',async embed(){return [1,0]}}

test('relationships preserve evidence and history under correction, republish, CAS and replay', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),dbName=`kipster_relationships_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster_relationships-home-'))
  let runtime,dispatcher,server
  const contexts=[],handles=[]
  try{
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},executionLimit:1,embedding:profile})
    await runtime.memory.stopIndexing()
    const ids=runtime.bootstrap,actor={installationId:ids.installationId,personId:ids.ownerId}
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[ids.rootAgentId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
    const adapter={id:'test-adapter',version:'1',contractMajor:1,async execute(context){
      contexts.push(context)
      let next,closed=false;const queue=[]
      const handle={events:{async *[Symbol.asyncIterator](){while(!closed||queue.length){const event=queue.shift()??await new Promise(resolve=>{next=resolve});if(event)yield event}}},release(event){if(next){const resolve=next;next=undefined;resolve(event)}else queue.push(event);if(event.kind==='ended')closed=true},async cancel(){return{acknowledged:true,confirmedEnded:false}},async reconcile(){return'unknown'},abort(){closed=true;next?.(undefined)}}
      handles.push(handle);return handle
    },async close(){handles.forEach(handle=>handle.abort())}}
    dispatcher=new TextDispatcher(runtime,adapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0})
    const post=async(path,body)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok,`${path}: ${response.status}`);return response.json()}
    const context={kind:'organization',organizationId:ids.organizationId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:ids.rootAgentId})).chatId
    await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:ids.installationId,callerId:ids.ownerId},target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Connect these memories'}]})
    await dispatcher.start()
    for(let i=0;i<100&&contexts.length<1;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(contexts.length,1)
    const attemptId=contexts[0].attemptId,host=textPublicationHost(dispatcher)
    const invoke=(callId,name,args)=>host.invokeTool({attemptId,callId,name,arguments:args})
    const first=await runtime.memory.save(ids.rootAgentId,'fact','Amsterdam desk opens at nine',[{authorId:ids.rootAgentId}])
    const second=await runtime.memory.save(ids.rootAgentId,'observation','Visitors arrive early',[{authorId:ids.rootAgentId}])
    const owner={kind:'agent',ownerId:ids.rootAgentId}
    const linkArgs={owner,fromId:first.id,toId:second.id,fromRevision:1,toRevision:1,kind:'supports',weight:0.7,evidence:[{memoryId:first.id,revision:1}]}
    const [linked,replayed]=await Promise.all([invoke('link-1','memory.link',linkArgs),invoke('link-1','memory.link',linkArgs)])
    assert.deepEqual(linked,replayed)
    await assert.rejects(runtime.relationships.invoke(attemptId,randomUUID(),'link-1','memory.link',linkArgs),/attempt identity mismatch/)
    const edgeId=linked.relationship.id
    assert.equal(linked.relationship.stale,false)
    const coherence=await invoke('coherence-link','memory.link',{...linkArgs,kind:'related_to',weight:0.6})
    const coherenceId=coherence.relationship.id
    const baseTransaction=runtime.db.transaction.bind(runtime.db)
    let injectedView=false
    runtime.db.transaction=work=>baseTransaction(async client=>work({query:async(sql,values)=>{
      const result=await client.query(sql,values)
      if(!injectedView&&sql.startsWith('SELECT * FROM kipster.memory_relationships WHERE id=$1 AND installation_id=$2')&&values?.[0]===coherenceId){
        injectedView=true
        await invoke('coherence-update','memory.relationship_update',{owner,relationshipId:coherenceId,expectedRevision:1,fromRevision:1,toRevision:1,kind:'related_to',weight:0.8,evidence:[{memoryId:first.id,revision:1}]})
      }
      return result
    }}))
    let observed
    try{observed=await invoke('coherence-get','memory.relationship_get',{owner,relationshipId:coherenceId})}finally{runtime.db.transaction=baseTransaction}
    assert.equal(observed.revision,1)
    assert.equal(observed.weight,0.6)
    assert.ok(observed.history.every(change=>change.revision<=observed.revision))
    assert.equal((await invoke('coherence-current','memory.relationship_get',{owner,relationshipId:coherenceId})).revision,2)
    const firstHistoryPage=await invoke('history-page-1','memory.relationship_get',{owner,relationshipId:coherenceId,historyLimit:1})
    assert.equal(firstHistoryPage.nextHistoryAfter,1)
    let injectedList=false
    runtime.db.transaction=work=>baseTransaction(async client=>work({query:async(sql,values)=>{
      const result=await client.query(sql,values)
      if(!injectedList&&sql.startsWith('SELECT revision FROM kipster.memory_relationship_owner_versions')){
        injectedList=true
        await invoke('coherence-update-list','memory.relationship_update',{owner,relationshipId:coherenceId,expectedRevision:2,fromRevision:1,toRevision:1,kind:'related_to',weight:0.9,evidence:[{memoryId:first.id,revision:1}]})
      }
      return result
    }}))
    let coherentList
    try{coherentList=await invoke('coherence-list','memory.relationship_list',{owner})}finally{runtime.db.transaction=baseTransaction}
    assert.equal(coherentList.relationships.find(row=>row.id===coherenceId).revision,2)
    assert.equal(coherentList.relationships.find(row=>row.id===coherenceId).weight,0.8)
    assert.equal((await invoke('coherence-list-current','memory.relationship_list',{owner})).relationships.find(row=>row.id===coherenceId).revision,3)
    await assert.rejects(invoke('history-stale','memory.relationship_get',{owner,relationshipId:coherenceId,historyAfter:1,historyRevision:firstHistoryPage.revision,historyLimit:1}),/history changed; restart pagination/)
    for(let revision=3;revision<67;revision++)await invoke(`retained-history-${revision}`,'memory.relationship_update',{owner,relationshipId:coherenceId,expectedRevision:revision,fromRevision:1,toRevision:1,kind:'related_to',weight:0.9,evidence:[{memoryId:first.id,revision:1}]})
    assert.deepEqual((await runtime.db.query('SELECT count(*)::int AS count,min(revision) AS first,max(revision) AS last FROM kipster.memory_relationship_changes WHERE relationship_id=$1',[coherenceId])).rows,[{count:64,first:4,last:67}])
    const retainedPage=await invoke('retained-page','memory.relationship_get',{owner,relationshipId:coherenceId,historyAfter:65,historyRevision:67})
    assert.deepEqual(retainedPage.history.map(change=>change.revision),[66,67])
    let injectedStop=false
    runtime.db.transaction=work=>baseTransaction(async client=>work({query:async(sql,values)=>{
      const result=await client.query(sql,values)
      if(!injectedStop&&sql.startsWith('SELECT * FROM kipster.memory_relationships WHERE id=$1 AND installation_id=$2')&&values?.[0]===coherenceId){
        injectedStop=true
        await baseTransaction(writer=>writer.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attemptId]))
      }
      return result
    }}))
    try{await assert.rejects(invoke('read-stop-race','memory.relationship_get',{owner,relationshipId:coherenceId}),/no longer owns tools/)}finally{runtime.db.transaction=baseTransaction}
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE current_attempt_id=$1',[attemptId])
    await assert.rejects(invoke('link-1','memory.unlink',{owner,relationshipId:edgeId,expectedRevision:1}),/identity conflict/)
    await assert.rejects(invoke('link-invalid','memory.link',{...linkArgs,kind:'derived_from',evidence:[{memoryId:second.id,revision:2}]}),/revision conflict/)
    const otherAgent=randomUUID()
    await runtime.db.query(`INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)`,[otherAgent,ids.installationId])
    const alien=await runtime.memory.save(otherAgent,'fact','Private other',[{authorId:otherAgent}])
    await assert.rejects(invoke('link-cross','memory.link',{...linkArgs,kind:'derived_from',evidence:[{memoryId:first.id,revision:1},{memoryId:alien.id,revision:1}]}),/outside owner/)
    await runtime.memory.correct(ids.rootAgentId,first.id,1,'Amsterdam desk opens at ten',[{authorId:ids.rootAgentId}])
    assert.equal((await invoke('get-stale','memory.relationship_get',{owner,relationshipId:edgeId})).stale,true)
    await assert.rejects(invoke('update-stale','memory.relationship_update',{owner,relationshipId:edgeId,expectedRevision:1,fromRevision:1,toRevision:1,kind:'supports',weight:0.8,evidence:[{memoryId:first.id,revision:1}]}),/revision conflict/)
    const updated=await invoke('update-1','memory.relationship_update',{owner,relationshipId:edgeId,expectedRevision:1,fromRevision:2,toRevision:1,kind:'supports',weight:0.8,evidence:[{memoryId:first.id,revision:2},{memoryId:second.id,revision:1}]})
    assert.equal(updated.relationship.revision,2)
    assert.equal(updated.relationship.stale,false)
    assert.deepEqual(updated.relationship.history.map(change=>change.evidence.map(item=>item.revision)),[[1],[2,1]])
    const publishedFirst=await runtime.memory.publish(ids.rootAgentId,ids.organizationId,first.id,2)
    const publishedSecond=await runtime.memory.publish(ids.rootAgentId,ids.organizationId,second.id,1)
    assert.equal((await invoke('org-list','memory.relationship_list',{owner:{kind:'organization',ownerId:ids.organizationId}})).relationships.length,0)
    const orgOwner={kind:'organization',ownerId:ids.organizationId}
    const orgLinked=await invoke('org-link','memory.link',{owner:orgOwner,fromId:publishedFirst.id,toId:publishedSecond.id,fromRevision:1,toRevision:1,kind:'related_to',weight:0.4,evidence:[{memoryId:publishedFirst.id,revision:1}]})
    await runtime.memory.correct(ids.rootAgentId,first.id,2,'Amsterdam desk opens at eleven',[{authorId:ids.rootAgentId}])
    assert.equal((await invoke('org-before-republish','memory.relationship_get',{owner:orgOwner,relationshipId:orgLinked.relationship.id})).stale,false)
    await runtime.memory.publish(ids.rootAgentId,ids.organizationId,first.id,3,1)
    assert.equal((await invoke('org-after-republish','memory.relationship_get',{owner:orgOwner,relationshipId:orgLinked.relationship.id})).stale,true)
    const closed=await invoke('unlink-1','memory.unlink',{owner,relationshipId:edgeId,expectedRevision:2})
    assert.equal(closed.relationship.active,false)
    assert.equal(closed.relationship.history.length,3)
    const replacement=await invoke('relink-1','memory.link',{...linkArgs,fromRevision:3,evidence:[{memoryId:first.id,revision:3}]})
    assert.notEqual(replacement.relationship.id,edgeId)
    const page=await invoke('list-page','memory.relationship_list',{owner,limit:1})
    assert.ok(page.nextCursor)
    const revisions=await Promise.allSettled([
      invoke('cas-left','memory.relationship_update',{owner,relationshipId:replacement.relationship.id,expectedRevision:1,fromRevision:3,toRevision:1,kind:'supports',weight:0.3,evidence:[{memoryId:first.id,revision:3}]}),
      invoke('cas-right','memory.relationship_update',{owner,relationshipId:replacement.relationship.id,expectedRevision:1,fromRevision:3,toRevision:1,kind:'supports',weight:0.9,evidence:[{memoryId:first.id,revision:3}]})
    ])
    assert.equal(revisions.filter(result=>result.status==='fulfilled').length,1)
    assert.equal(revisions.filter(result=>result.status==='rejected').length,1)
    await assert.rejects(invoke('list-stale','memory.relationship_list',{owner,cursor:page.nextCursor,limit:1}),/changed; restart pagination/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.memory_tool_receipts WHERE attempt_id=$1 AND call_id=$2',[attemptId,'link-invalid'])).rows[0].n,0)
    await assert.rejects(invoke('late-old','memory.unlink',{owner,relationshipId:edgeId,expectedRevision:2}),/revision conflict/)
    let releasePersonal,personalLocked
    const personalBarrier=new Promise(resolve=>personalLocked=resolve)
    const personalHold=new Promise(resolve=>releasePersonal=resolve)
    const personalBlocker=runtime.db.transaction(async client=>{
      await client.query('SELECT 1 FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 FOR UPDATE',[ids.installationId,'agent',ids.rootAgentId])
      personalLocked();await personalHold
    })
    await personalBarrier
    const correctionRace=invoke('correction-race','memory.link',{...linkArgs,kind:'derived_from',fromRevision:3,evidence:[{memoryId:first.id,revision:3}]}).then(()=>null,error=>error)
    await runtime.memory.correct(ids.rootAgentId,first.id,3,'Amsterdam desk opens at noon',[{authorId:ids.rootAgentId}])
    releasePersonal();await personalBlocker
    assert.match((await correctionRace).message,/revision conflict/)
    let releaseOrg,orgLocked
    const orgBarrier=new Promise(resolve=>orgLocked=resolve)
    const orgHold=new Promise(resolve=>releaseOrg=resolve)
    const orgBlocker=runtime.db.transaction(async client=>{
      await client.query('SELECT 1 FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 FOR UPDATE',[ids.installationId,'organization',ids.organizationId])
      orgLocked();await orgHold
    })
    await orgBarrier
    const publicationRace=invoke('publication-race','memory.link',{owner:orgOwner,fromId:publishedFirst.id,toId:publishedSecond.id,fromRevision:2,toRevision:1,kind:'supports',weight:0.6,evidence:[{memoryId:publishedFirst.id,revision:2}]}).then(()=>null,error=>error)
    await runtime.memory.publish(ids.rootAgentId,ids.organizationId,first.id,4,2)
    releaseOrg();await orgBlocker
    assert.match((await publicationRace).message,/revision conflict/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[otherAgent])
    await assert.rejects(invoke('owner-fence','memory.relationship_list',{owner:{kind:'agent',ownerId:otherAgent}}),/owner unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[otherAgent])
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[ids.rootAgentId])
    await assert.rejects(invoke('actor-fence','memory.relationship_get',{owner,relationshipId:edgeId}),/actor unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[ids.rootAgentId])
    await runtime.db.query('DELETE FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2',[ids.organizationId,ids.rootAgentId])
    assert.equal((await invoke('accepted-membership','memory.relationship_get',{owner:orgOwner,relationshipId:orgLinked.relationship.id})).id,orgLinked.relationship.id)
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attemptId])
    await assert.rejects(invoke('stopped-read','memory.relationship_get',{owner,relationshipId:edgeId}),/no longer owns tools/)
    await assert.rejects(invoke('stopped-write','memory.unlink',{owner,relationshipId:replacement.relationship.id,expectedRevision:2}),/no longer owns tools/)
    assert.deepEqual(await invoke('link-1','memory.link',linkArgs),linked,'completed call replay survives Stop')
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE current_attempt_id=$1',[attemptId])
    await runtime.home.provisionAgent(otherAgent)
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[ids.organizationId,ids.rootAgentId])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[ids.organizationId,otherAgent])
    await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1',[ids.organizationId,JSON.stringify({adapterId:'test-adapter',modelId:'test-model'})])
    const otherMemory=await runtime.memory.save(otherAgent,'observation','Private other observation',[{authorId:otherAgent}])
    const delegated=await dispatcher.agentTool(attemptId,'delegate-other','agents.delegate',{recipientId:otherAgent,request:'Connect two memories'})
    handles[0].release({kind:'ended',attemptId,confirmed:true})
    for(let i=0;i<100&&contexts.length<2;i++)await new Promise(resolve=>setTimeout(resolve,20))
    assert.equal(contexts[1].agentId,otherAgent)
    const childAttempt=contexts[1].attemptId
    const childLinked=await host.invokeTool({attemptId:childAttempt,callId:'child-link',name:'memory.link',arguments:{owner:{kind:'agent',ownerId:otherAgent},fromId:alien.id,toId:otherMemory.id,fromRevision:1,toRevision:1,kind:'supports',weight:0.6,evidence:[{memoryId:alien.id,revision:1}]}})
    assert.equal((await runtime.db.query('SELECT actor_id FROM kipster.memory_relationship_changes WHERE relationship_id=$1',[childLinked.relationship.id])).rows[0].actor_id,otherAgent)
    assert.equal((await runtime.db.query('SELECT child_run_id FROM kipster.delegations WHERE id=$1',[delegated.id])).rows[0].child_run_id,delegated.childRunId)
    assert.deepEqual(await invoke('link-1','memory.link',linkArgs),linked,'receipt replay survives ended attempt')
    await assert.rejects(invoke('late-new','memory.relationship_list',{owner}),/no longer owns tools/)
    handles.forEach(handle=>handle.abort())
    await dispatcher.close();dispatcher=null
    await server.close();server=null
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Ignored',organization:'Ignored',rootAgent:'Ignored'},executionLimit:1,embedding:profile})
    assert.equal((await runtime.db.query('SELECT active FROM kipster.memory_relationships WHERE id=$1',[edgeId])).rows[0].active,false)
    assert.deepEqual((await runtime.db.query('SELECT revision FROM kipster.memory_relationship_changes WHERE relationship_id=$1 ORDER BY revision',[edgeId])).rows.map(row=>row.revision),[1,2,3])
  }finally{
    handles.forEach(handle=>handle.abort())
    await dispatcher?.close();await server?.close();await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);await admin.close()
  }
})
