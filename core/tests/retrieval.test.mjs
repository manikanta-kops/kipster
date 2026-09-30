import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Postgres} from '../dist/platform/postgres/public.js'
import {openRuntime} from '../dist/runtime.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const profile={id: 'ollama', contractMajor: 1,model:'fixture-embedding'}
test('bounded retrieval keeps current conflicts, independent publications and generation safety', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl), dbName=`kipster_retrieval_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster_retrieval-home-'))
  let waitQuery=false, releaseQuery, queryStarted
  const started=new Promise(resolve=>{queryStarted=resolve})
  const embedder={async embed(text){if(waitQuery&&text==='harbor access'){queryStarted();await new Promise(resolve=>{releaseQuery=resolve})}return text.includes('harbor')||text.includes('cactus')?[1,0]:[0,1]}}
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},embedding:{...profile,...embedder}})
    await runtime.memory.stopIndexing()
    const {installationId,organizationId,rootAgentId}=runtime.bootstrap
    // Exercise canonical Unicode content and the current lexical token path with no vectors.
    for (const text of ['日本語の記録', 'café réunion', 'Москва архив', 'العربية مكتبة']) {
      const record=await runtime.memory.save(rootAgentId,'fact',text,[{authorId:rootAgentId}])
      assert.equal((await runtime.memory.get(rootAgentId,null,record.id)).text,text)
      const matches=await runtime.memory.search(rootAgentId,null,text)
      assert.ok(matches.some(result=>result.record.id===record.id&&result.retrieval==='lexical'))
    }
    const otherAgent=randomUUID(),otherOrg=randomUUID()
    await runtime.db.query(`INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)`,[otherAgent,installationId])
    await runtime.db.query(`INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,'Other',true)`,[otherOrg,installationId])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[otherOrg,otherAgent])
    const allowed=await runtime.memory.save(rootAgentId,'fact','Harbor access is open for visitors',[{authorId:rootAgentId,subject:'gate report'}])
    const opposing=await runtime.memory.save(rootAgentId,'fact','The visitor gate is closed after dusk',[{authorId:rootAgentId,subject:'evening report'}])
    const privateOther=await runtime.memory.save(otherAgent,'fact','Harbor access is classified',[{authorId:otherAgent}])
    const oldOrg=await runtime.memory.publish(rootAgentId,organizationId,allowed.id,1)
    await runtime.memory.publish(otherAgent,otherOrg,privateOther.id,1)
    assert.ok(!(await runtime.memory.context(rootAgentId,organizationId,'harbor access')).join(' ').includes('classified'))
    const edgeId=randomUUID()
    const ids=[allowed.id,opposing.id].sort()
    const hashes=(await runtime.db.query(`SELECT id,source_hash FROM kipster.memory_records WHERE id=ANY($1::uuid[])`,[ids])).rows
    const byId=new Map(hashes.map(row=>[row.id,row.source_hash]))
    await runtime.db.query(`INSERT INTO kipster.memory_relationships(id,installation_id,owner_kind,owner_id,from_id,to_id,kind,weight,from_revision,to_revision) VALUES ($1,$2,'agent',$3,$4,$5,'contradicts',0.9,1,1)`,[edgeId,installationId,rootAgentId,ids[0],ids[1]])
    await runtime.db.query(`INSERT INTO kipster.memory_relationship_changes(relationship_id,revision,operation,actor_id,kind,weight,active,from_revision,to_revision) VALUES ($1,1,'link',$2,'contradicts',0.9,true,1,1)`,[edgeId,rootAgentId])
    await runtime.db.query(`INSERT INTO kipster.memory_relationship_evidence(relationship_id,relationship_revision,ordinal,memory_id,memory_revision,source_hash) VALUES ($1,1,1,$2,1,$3)`,[edgeId,allowed.id,byId.get(allowed.id)])
    const conflict=(await runtime.memory.context(rootAgentId,null,'harbor access')).join('\n')
    assert.match(conflict,/Harbor access is open/)
    assert.match(conflict,/visitor gate is closed/)
    assert.match(conflict,/contradicts/)
    assert.ok(conflict.includes(edgeId))
    assert.match(conflict,/relationship; agent/)
    assert.ok(Buffer.byteLength(conflict)<=3000)
    for(const kind of ['supports','derived_from']){
      const from=await runtime.memory.save(rootAgentId,'fact',`${kind} northbound plan`,[{authorId:rootAgentId}])
      const to=await runtime.memory.save(rootAgentId,'fact',`${kind} southbound record`,[{authorId:rootAgentId}])
      const linkId=randomUUID()
      const sourceHash=(await runtime.db.query('SELECT source_hash FROM kipster.memory_records WHERE id=$1',[from.id])).rows[0].source_hash
      await runtime.db.query(`INSERT INTO kipster.memory_relationships(id,installation_id,owner_kind,owner_id,from_id,to_id,kind,weight,from_revision,to_revision) VALUES ($1,$2,'agent',$3,$4,$5,$6,0.9,1,1)`,[linkId,installationId,rootAgentId,from.id,to.id,kind])
      await runtime.db.query(`INSERT INTO kipster.memory_relationship_changes(relationship_id,revision,operation,actor_id,kind,weight,active,from_revision,to_revision) VALUES ($1,1,'link',$2,$3,0.9,true,1,1)`,[linkId,rootAgentId,kind])
      await runtime.db.query(`INSERT INTO kipster.memory_relationship_evidence(relationship_id,relationship_revision,ordinal,memory_id,memory_revision,source_hash) VALUES ($1,1,1,$2,1,$3)`,[linkId,from.id,sourceHash])
      for(const query of [`${kind} northbound`,`${kind} southbound`]){
        const directed=(await runtime.memory.context(rootAgentId,null,query)).join('\n')
        assert.ok(directed.includes(`${from.id} ${kind} ${to.id}`),`correct ${kind} direction when anchored by ${query}`)
        assert.ok(!directed.includes(`${to.id} ${kind} ${from.id}`),'reverse directed claim must not appear')
        assert.ok(directed.includes(from.text)&&directed.includes(to.text))
        const structured=await runtime.memory.search(rootAgentId,null,query)
        const annotated=structured.filter(item=>item.relationship?.id===linkId)
        assert.equal(annotated.length,2)
        assert.ok(annotated.every(item=>item.relationship.fromId===from.id&&item.relationship.toId===to.id))
      }
    }
    await runtime.memory.correct(rootAgentId,opposing.id,1,'The visitor gate is now open after dusk',[{authorId:rootAgentId}])
    const after=(await runtime.memory.context(rootAgentId,null,'harbor access')).join('\n')
    assert.ok(!after.includes(edgeId),'stale edge must not be presented current')
    await runtime.memory.correct(rootAgentId,allowed.id,1,'Harbor access now requires a pass',[{authorId:rootAgentId}])
    const published=(await runtime.memory.context(otherAgent,organizationId,'harbor access')).join('\n')
    assert.match(published,/Harbor access is open/)
    assert.match(published,/source changed since publication/)
    assert.ok(!published.includes('requires a pass'))
    const republished=await runtime.memory.publish(rootAgentId,organizationId,allowed.id,2,1)
    assert.equal(republished.id,oldOrg.id)
    assert.match((await runtime.memory.context(otherAgent,organizationId,'harbor access')).join('\n'),/requires a pass/)
    const emoji='🧭'.repeat(1600)
    await runtime.memory.save(rootAgentId,'observation',`Harbor access ${emoji}`,[{authorId:rootAgentId,subject:'unicode'}])
    const unicode=(await runtime.memory.context(rootAgentId,null,'harbor access')).join('\n')
    assert.ok(Buffer.byteLength(unicode)<=3000)
    assert.ok(!unicode.includes('\uFFFD'))
    assert.ok((unicode.match(/\[memory /g)??[]).length<=6)
    const longQuery=(await runtime.memory.context(rootAgentId,null,'harbor access '+'🧭'.repeat(300))).join('\n')
    assert.ok(Buffer.byteLength(longQuery)<=3000)
    assert.ok(!longQuery.includes('\uFFFD'))
    await runtime.memory.save(rootAgentId,'observation','The cactus orchestra rehearses at dawn',[{authorId:rootAgentId}])
    await runtime.memory.indexPending(20,true)
    const ranked=await runtime.memory.search(rootAgentId,null,'harbor access')
    assert.ok(ranked[0].record.text.toLowerCase().includes('harbor access'),'exact relevant phrase outranks unrelated vector candidate')
    assert.ok(ranked.find(item=>item.record.text.includes('cactus')),'unrelated vector candidate was actually considered')
    waitQuery=true
    const search=runtime.memory.search(rootAgentId,null,'harbor access')
    await started
    await runtime.db.query(`INSERT INTO kipster.memory_embedding_generations(installation_id,generation,provider,model,dimension) VALUES ($1,2,'ollama','new-model',2)`,[installationId])
    await runtime.db.query(`UPDATE kipster.memory_profiles SET generation=2,model='new-model' WHERE installation_id=$1`,[installationId])
    releaseQuery()
    const raced=await search
    assert.ok(raced.length>0)
    assert.ok(raced.every(item=>item.retrieval==='lexical'))
  }finally{
    await runtime?.close();await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);await admin.close()
  }
})
