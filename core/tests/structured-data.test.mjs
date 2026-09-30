import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher } from '../dist/runtime.js'
import { adminUrl, noDatabase, taskDataRole as login } from './support/database.mjs'

async function until(read, match) {
  for (let n=0;n<200;n++) { const value=await read(); if (match(value)) return value; await new Promise(resolve=>setTimeout(resolve,25)) }
  throw new Error('Timed out waiting for task-data execution')
}
function fixture() {
  const contexts=[], handles=[]
  return { id:'structured-fixture',version:'1',contractMajor:1,contexts,handles,
    async execute(context) { contexts.push(context); const queue=[]; let wake,closed=false
      const handle={events:{async *[Symbol.asyncIterator]() { while(!closed||queue.length){const next=queue.shift()??await new Promise(resolve=>wake=resolve);if(next)yield next} }},emit(event){if(wake){const resolve=wake;wake=undefined;resolve(event)}else queue.push(event);if(['ended','failed'].includes(event.kind))closed=true},async cancel(){return {acknowledged:false,confirmedEnded:false}},async reconcile(){return 'active'}}
      handles.push(handle);return handle },
    async close(){for(const [index,handle] of handles.entries())handle.emit({kind:'failed',attemptId:contexts[index].attemptId,confirmedEnded:false,message:'closed'})} }
}

test('restricted task-data lifecycle, replay, fencing and restart', { skip:noDatabase, timeout:30000 }, async()=>{
  const admin=new Postgres(adminUrl), database=`kipstertask_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl); url.pathname=`/${database}`
  const restricted=new URL(url);restricted.username=login
  const home=await mkdtemp(join(tmpdir(),'kipster-task-data-'))
  let runtime, dispatcher, server
  try {
    await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
    runtime=await openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent A'}})
    const {installationId,ownerId,organizationId,rootAgentId}=runtime.bootstrap
    const actor={installationId,personId:ownerId}, adapter=fixture()
    await runtime.db.query('UPDATE kipster.organizations SET settings=$2::jsonb WHERE id=$1',[organizationId,JSON.stringify({adapterId:'structured-fixture',modelId:'fixture'})])
    dispatcher=new TextDispatcher(runtime,adapter)
    server=await startTextServer(runtime,actor,{host:'127.0.0.1',port:0,dispatcher})
    await dispatcher.start()
    const post=async(path,value)=>{const response=await fetch(server.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return response.json()}
    const context={kind:'organization',organizationId}, scope={installationId,callerId:ownerId}
    const chat=(await post('/v1/direct-chats',{version:1,context,agentId:rootAgentId})).chatId
    const submission=await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope,target:{context,chatId:chat},mode:'root',parts:[{kind:'text',text:'Track a task table'}]})
    await until(()=>adapter.contexts.length,n=>n===1)
    const attempt=adapter.contexts[0].attemptId, target={kind:'agent',ownerId:rootAgentId}
    const call=(callId,input)=>dispatcher.structuredTool(attempt,callId,{target,...input})
    const created=await call('create',{operation:'create_table',table:'projects',columns:[{name:'title',type:'text'},{name:'budget',type:'bigint'}]})
    assert.equal(created.status,'completed')
    await call('index',{operation:'create_index',table:'projects',index:'projects_title',column:'title'})
    const request={operation:'insert',table:'projects',values:{title:'North',budget:'9007199254740993'}}
    const [inserted,replayed]=await Promise.all([call('insert',request),call('insert',request)])
    assert.deepEqual(inserted,replayed)
    assert.equal((await call('query',{operation:'query',table:'projects',limit:10})).rows[0].budget,'9007199254740993')
    await assert.rejects(call('limit',{operation:'query',table:'projects',limit:51}),/Invalid query limit/)
    await assert.rejects(call('bytes',{operation:'insert',table:'projects',values:{title:'x'.repeat(17000)}}),/byte limit/)
    await assert.rejects(call('escape',{operation:'query',table:'kipster.threads'}),/Invalid task-data name/)
    await assert.rejects(call('multi',{operation:'query',table:'projects; DROP SCHEMA kipster'}),/Invalid task-data name/)
    await call('large-table',{operation:'create_table',table:'large_rows',columns:[{name:'note',type:'text'}]})
    for(let n=0;n<5;n++)await call(`large-${n}`,{operation:'insert',table:'large_rows',values:{note:'x'.repeat(15000)}})
    await assert.rejects(call('large-query',{operation:'query',table:'large_rows',limit:10}),/byte limit/)
    await call('large-drop',{operation:'drop_table',table:'large_rows'})
    await assert.rejects(call('insert',{...request,values:{title:'Different'}}),/different arguments/)
    await call('add',{operation:'add_column',table:'projects',column:'active',type:'boolean'})
    await call('update',{operation:'update',table:'projects',id:inserted.id,values:{active:true}})
    assert.equal((await call('query',{operation:'query',table:'projects',where:{column:'title',equals:'North'}})).rows[0].active,true)
    assert.equal((await call('describe',{operation:'describe',table:'projects'})).indexes.includes('projects_title'),true)
    const namespace=`task_a_${rootAgentId.replaceAll('-','')}`
    let releaseRow, rowLocked
    const rowLockedBarrier=new Promise(resolve=>rowLocked=resolve)
    const rowHold=new Promise(resolve=>releaseRow=resolve)
    const blocker=runtime.db.transaction(async client=>{
      await client.query(`SELECT id FROM "${namespace}".projects WHERE id=$1 FOR UPDATE`,[inserted.id])
      rowLocked()
      await rowHold
    })
    await rowLockedBarrier
    const blocked=call('blocked-update',{operation:'update',table:'projects',id:inserted.id,values:{active:false}}).then(()=>null,error=>error)
    await until(async()=> (await runtime.db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE %projects%'`,[login])).rows[0].n,n=>n===1)
    const stopped=runtime.db.transaction(async client=>{
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[installationId])
      await client.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attempt])
    })
    let stopFinished=false;stopped.then(()=>stopFinished=true)
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(stopFinished,false,'Stop waits for the restricted task transaction')
    assert.match((await blocked).message,/lock timeout|statement timeout/)
    await stopped
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attempt,'blocked-update'])).rows[0].n,0)
    releaseRow();await blocker
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE current_attempt_id=$1',[attempt])
    let releaseCrash, crashLocked
    const crashLockedBarrier=new Promise(resolve=>crashLocked=resolve)
    const crashHold=new Promise(resolve=>releaseCrash=resolve)
    const crashBlocker=runtime.db.transaction(async client=>{
      await client.query(`SELECT id FROM "${namespace}".projects WHERE id=$1 FOR UPDATE`,[inserted.id])
      crashLocked();await crashHold
    })
    await crashLockedBarrier
    const interrupted=call('backend-death',{operation:'update',table:'projects',id:inserted.id,values:{active:false}}).then(()=>null,error=>error)
    const backend=await until(async()=> (await runtime.db.query(`SELECT pid FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE %projects%'`,[login])).rows[0],row=>!!row)
    assert.equal((await runtime.db.query('SELECT pg_terminate_backend($1) AS terminated',[backend.pid])).rows[0].terminated,true)
    assert.ok(await interrupted,'backend death rejects the task call')
    releaseCrash();await crashBlocker
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attempt,'backend-death'])).rows[0].n,0)
    assert.equal((await call('query-after-death',{operation:'query',table:'projects'})).rows[0].active,true)
    let releaseOwner, ownerLocked
    const ownerBarrier=new Promise(resolve=>ownerLocked=resolve)
    const ownerHold=new Promise(resolve=>releaseOwner=resolve)
    const ownerBlocker=runtime.db.transaction(async client=>{
      await client.query(`SELECT id FROM "${namespace}".projects WHERE id=$1 FOR UPDATE`,[inserted.id])
      ownerLocked();await ownerHold
    })
    await ownerBarrier
    const ownerInterrupted=call('owner-fence-update',{operation:'update',table:'projects',id:inserted.id,values:{active:false}}).then(()=>null,error=>error)
    await until(async()=> (await runtime.db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE %projects%'`,[login])).rows[0].n,n=>n===1)
    const ownerFence=runtime.db.transaction(async client=>{
      await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[installationId])
      await client.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[rootAgentId])
    })
    let ownerFinished=false;ownerFence.then(()=>ownerFinished=true)
    await new Promise(resolve=>setTimeout(resolve,80))
    assert.equal(ownerFinished,false,'owner deletion waits for restricted task transaction')
    assert.match((await ownerInterrupted).message,/lock timeout|statement timeout/)
    await ownerFence
    releaseOwner();await ownerBlocker
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attempt,'owner-fence-update'])).rows[0].n,0)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[rootAgentId])
    await call('drop-index',{operation:'drop_index',table:'projects',index:'projects_title'})
    await call('drop-column',{operation:'drop_column',table:'projects',column:'active'})
    const orgTarget={kind:'organization',ownerId:organizationId}
    await dispatcher.structuredTool(attempt,'org-create',{operation:'create_table',target:orgTarget,table:'shared',columns:[{name:'note',type:'text'}]})
    assert.deepEqual((await dispatcher.structuredTool(attempt,'org-discover',{operation:'discover',target:orgTarget})).tables,['shared'])
    const otherOrg=randomUUID()
    await runtime.db.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[otherOrg,installationId,'Other org'])
    await assert.rejects(dispatcher.structuredTool(attempt,'wrong-org',{operation:'discover',target:{kind:'organization',ownerId:otherOrg}}),/Organization target unavailable/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1',[otherOrg])).rows[0].n,0)
    const stopOwner=randomUUID()
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[stopOwner,installationId,'Stop owner'])
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attempt])
    await assert.rejects(dispatcher.structuredTool(attempt,'stop-first',{operation:'discover',target:{kind:'agent',ownerId:stopOwner}}),/Attempt no longer owns task data/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1',[stopOwner])).rows[0].n,0)
    assert.equal((await runtime.db.query('SELECT to_regnamespace($1) AS name',[`task_a_${stopOwner.replaceAll('-','')}`])).rows[0].name,null)
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE current_attempt_id=$1',[attempt])
    const deletedOwner=randomUUID()
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,false)',[deletedOwner,installationId,'Deleted owner'])
    await assert.rejects(dispatcher.structuredTool(attempt,'owner-first',{operation:'discover',target:{kind:'agent',ownerId:deletedOwner}}),/Task-data owner unavailable/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1',[deletedOwner])).rows[0].n,0)
    const collisionOwner=randomUUID(),collisionSchema=`task_a_${collisionOwner.replaceAll('-','')}`
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[collisionOwner,installationId,'Collision owner'])
    await runtime.db.query(`CREATE SCHEMA "${collisionSchema}" AUTHORIZATION ${login}`)
    await assert.rejects(dispatcher.structuredTool(attempt,'provision-failure',{operation:'discover',target:{kind:'agent',ownerId:collisionOwner}}),/namespace ownership is untrusted/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1',[collisionOwner])).rows[0].n,0)
    const b=randomUUID();await runtime.home.provisionAgent(b)
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[b,installationId,'Agent B'])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[organizationId,b])
    const originalProvision=runtime.structured.provision.bind(runtime.structured)
    runtime.structured.provision=async (...args)=>{
      const registered=await originalProvision(...args)
      if(args[3].ownerId===b)await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE current_attempt_id=$1',[attempt])
      return registered
    }
    await assert.rejects(dispatcher.structuredTool(attempt,'provision-first',{operation:'create_table',target:{kind:'agent',ownerId:b},table:'late_table',columns:[{name:'note',type:'text'}]}),/Attempt no longer owns task data/)
    runtime.structured.provision=originalProvision
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.namespaces WHERE owner_id=$1',[b])).rows[0].n,1)
    assert.equal((await runtime.db.query('SELECT to_regclass($1) AS table',[`task_a_${b.replaceAll('-','')}.late_table`])).rows[0].table,null)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attempt,'provision-first'])).rows[0].n,0)
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=false WHERE current_attempt_id=$1',[attempt])
    await call('delete',{operation:'delete',table:'projects',id:inserted.id})
    await call('drop',{operation:'drop_table',table:'projects'})
    const restrictedDb=new Postgres(restricted.href)
    try {
      await assert.rejects(restrictedDb.query('UPDATE kipster.threads SET internal=true'),/permission denied/)
      await assert.rejects(restrictedDb.query('SET ROLE pg_read_all_data'),/permission denied/)
      await assert.rejects(restrictedDb.query('CREATE TEMP TABLE escape (id int)'),/permission denied/)
      await assert.rejects(restrictedDb.query('CREATE SCHEMA escape'),/permission denied/)
      await assert.rejects(restrictedDb.query('CREATE EXTENSION hstore'),/permission denied/)
      await assert.rejects(restrictedDb.query("SELECT pg_catalog.pg_read_file('/etc/hosts')"),/permission denied/)
      await restrictedDb.query(`CREATE FUNCTION "${namespace}".escape() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN UPDATE kipster.threads SET internal=true; END $$`)
      await assert.rejects(restrictedDb.query(`SELECT "${namespace}".escape()`),/permission denied/)
      await restrictedDb.query(`DROP FUNCTION "${namespace}".escape()`)
      await restrictedDb.query('RESET ROLE')
      assert.equal((await restrictedDb.query('SELECT current_user AS role')).rows[0].role,login)
    } finally { await restrictedDb.close() }
    // A deletion transaction uses the same capacity-first guard. Existing calls
    // can finish; new calls cannot pass once the owner is unavailable.
    await runtime.db.query('UPDATE kipster.agents SET provisioned=false WHERE id=$1',[rootAgentId])
    await assert.rejects(call('deleted-owner',{operation:'discover'}),/Acting agent unavailable/)
    await runtime.db.query('UPDATE kipster.agents SET provisioned=true WHERE id=$1',[rootAgentId])
    await runtime.db.query("UPDATE kipster.attempts SET state='settled' WHERE id=$1",[attempt])
    await assert.rejects(call('obsolete',{operation:'discover'}),/Attempt no longer owns task data/)
    assert.deepEqual(await call('insert',request),inserted,'committed receipt survives stale attempt')
    await runtime.db.query("UPDATE kipster.attempts SET state='issued' WHERE id=$1",[attempt])
    await dispatcher.agentTool(attempt,'delegate','agents.delegate',{recipientId:b,request:'Record task data'})
    adapter.handles[0].emit({kind:'ended',attemptId:attempt,confirmed:true})
    await until(()=>adapter.contexts.length,n=>n===2)
    const child=adapter.contexts[1]
    assert.equal(child.agentId,b)
    await dispatcher.structuredTool(child.attemptId,'child-table',{operation:'create_table',target:{kind:'agent',ownerId:b},table:'child_tasks',columns:[{name:'note',type:'text'}]})
    await dispatcher.structuredTool(child.attemptId,'child-collab',{operation:'create_table',target,table:'collab_tasks',columns:[{name:'note',type:'text'}]})
    const identity=(await runtime.db.query('SELECT actor_id,owner_id FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[child.attemptId,'child-collab'])).rows[0]
    assert.deepEqual(identity,{actor_id:b,owner_id:rootAgentId})
    await adapter.close()
    await dispatcher.close();dispatcher=null;await server.close();server=null;await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent A'}})
    const ns=`task_o_${organizationId.replaceAll('-','')}`
    assert.equal((await runtime.db.query('SELECT to_regclass($1) AS table',[`${ns}.shared`])).rows[0].table,`${ns}.shared`)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attempt,'insert'])).rows[0].n,1)
  } finally {
    await dispatcher?.close();await server?.close();await runtime?.close()
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>undefined)
    await admin.close();await rm(home,{recursive:true,force:true})
  }
})

test('startup refuses a task login with protected receipt mutation privilege', {skip:noDatabase,timeout:15000},async()=>{
  const admin=new Postgres(adminUrl),database=`kipsterdataaudit_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  const restricted=new URL(url);restricted.username=login
  const home=await mkdtemp(join(tmpdir(),'kipster-data-audit-'))
  let runtime
  try {
    await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}})
    await runtime.close();runtime=null
    const db=new Postgres(url.href)
    try { await db.query(`GRANT DELETE ON task_data.receipts TO ${login}`) } finally { await db.close() }
    await assert.rejects(openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}}),/privilege boundary invalid/)
    const repair=new Postgres(url.href)
    try { await repair.query(`REVOKE DELETE ON task_data.receipts FROM ${login}`) } finally { await repair.close() }
    runtime=await openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}})
    assert.ok(runtime.structured)
  } finally {
    await runtime?.close();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>undefined)
    await admin.close();await rm(home,{recursive:true,force:true})
  }
})

test('startup rejects protected identity and namespace writes, including column grants', {skip:noDatabase,timeout:30000},async()=>{
  const admin=new Postgres(adminUrl),database=`kipsterdatagrants_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  const restricted=new URL(url);restricted.username=login
  const home=await mkdtemp(join(tmpdir(),'kipster-data-grants-'))
  let runtime
  try {
    await admin.query(`REVOKE TEMPORARY ON DATABASE "${database}" FROM PUBLIC`)
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}})
    await runtime.close();runtime=null
    const cases=[
      ['UPDATE ON task_data.database_identity','UPDATE ON task_data.database_identity'],
      ['INSERT ON task_data.namespaces','INSERT ON task_data.namespaces'],
      ['UPDATE ON task_data.namespaces','UPDATE ON task_data.namespaces'],
      ['DELETE ON task_data.namespaces','DELETE ON task_data.namespaces'],
      ['UPDATE (id) ON task_data.database_identity','UPDATE (id) ON task_data.database_identity'],
      ['UPDATE (schema_name) ON task_data.namespaces','UPDATE (schema_name) ON task_data.namespaces'],
      ['UPDATE (result) ON task_data.receipts','UPDATE (result) ON task_data.receipts'],
    ]
    const db=new Postgres(url.href)
    try {
      for(const [grant,revoke] of cases){
        await db.query(`GRANT ${grant} TO ${login}`)
        await assert.rejects(openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}}),/privilege boundary invalid/)
        await db.query(`REVOKE ${revoke} FROM ${login}`)
        runtime=await openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}})
        assert.ok(runtime.structured)
        await runtime.close();runtime=null
      }
      const adminRole=(await db.query('SELECT current_user AS role')).rows[0].role
      await db.query(`ALTER TABLE task_data.namespaces OWNER TO ${login}`)
      await assert.rejects(openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}}),/ownership or definition is untrusted/)
      await db.query(`ALTER TABLE task_data.namespaces OWNER TO "${adminRole.replaceAll('"','""')}"`)
      runtime=await openRuntime({connectionString:url.href,taskDataConnectionString:restricted.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Agent'}})
      assert.ok(runtime.structured)
      await runtime.close();runtime=null
    } finally { await db.close() }
  } finally {
    await runtime?.close();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>undefined)
    await admin.close();await rm(home,{recursive:true,force:true})
  }
})
