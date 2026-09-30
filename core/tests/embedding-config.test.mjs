import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEmbeddingProvider, validateHostConfig } from '../dist/host.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime } from '../dist/runtime.js'
import { boundedEmbed, MemoryService } from '../dist/modules/memory/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

test('embedding modules and provider objects are validated at load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-embedding-loader-'))
  try {
    const valid = "{id:'custom',model:'any model name',contractMajor:1,async embed(){return [1]}}"
    const sources = ['export const missing = true', ...['null', '{}', valid.replace("id:'custom'", "id:' '"), valid.replace("model:'any model name'", "model:''"), valid.replace('contractMajor:1', 'contractMajor:2'), valid.replace('async embed(){return [1]}', 'embed:42')].map(value => `export const createEmbeddingProvider = () => (${value})`)]
    for (const [index, source] of sources.entries()) {
      const module = join(directory, `${index}.mjs`)
      await writeFile(module, source)
      await assert.rejects(loadEmbeddingProvider({embedding:{module,options:{}}}), /embedding|Embedding/)
    }
    const module = join(directory, 'valid.mjs')
    await writeFile(module, `export const createEmbeddingProvider = options => ({...${valid},model:options.model})`)
    const provider = await loadEmbeddingProvider({embedding:{module,options:{model:'configured model'}}})
    assert.equal(provider.model, 'configured model')
    assert.deepEqual(await boundedEmbed(provider, 'hello', 100), [1])
    const config = {version:1,home:directory,databaseUrl:'postgresql://kipster@localhost/unused',listen:{host:'127.0.0.1',port:1234,allowedHosts:[],allowedOrigins:[]},adapters:[]}
    assert.equal(validateHostConfig({...config,embedding:{module,options:{}}}).embedding.module,module)
    for (const embedding of [{module:'relative',options:{}},{module,options:[]},{provider:'ollama',model:'old'}]) assert.throws(()=>validateHostConfig({...config,embedding}))
  } finally { await rm(directory,{recursive:true,force:true}) }
})

test('Core validates every returned vector at one boundary', async () => {
  for (const values of [undefined, {}, [], ['1'], [NaN], [Infinity], new Array(2), [0, 0], Array(16001).fill(1)]) {
    await assert.rejects(boundedEmbed({async embed(){return values}}, 'hello', 100), /invalid vector/)
  }
  for (const values of [[0, 0.5], Array(16000).fill(1)]) assert.deepEqual(await boundedEmbed({async embed(){return values}}, 'hello', 100),values)
})

test('provider generation switches preserve vector compatibility', {skip:noDatabase,timeout:30000}, async () => {
  const admin=new Postgres(adminUrl)
  const dbName=`kipster_embed_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster-embedding-config-'))
  let runtime
  const a={id: 'ollama', contractMajor: 1,model:'fixture-a'}
  const b={...a,model:'fixture-b'}
  let releaseIndex, indexStarted, releaseQuery, queryStarted
  const oldEmbedder={async embed(text){
    if(text==='blocked source'){indexStarted();await new Promise(resolve=>{releaseIndex=resolve})}
    if(text==='Amsterdam race'){queryStarted();await new Promise(resolve=>{releaseQuery=resolve})}
    return [1,0]
  }}
  const newEmbedder={async embed(){return [0,1]}}
  try {
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},embedding:{...a,...oldEmbedder}})
    await runtime.memory.stopIndexing()
    const {installationId,ownerId,rootAgentId}=runtime.bootstrap
    const saved=await runtime.memory.save(rootAgentId,'fact','Amsterdam office opens at ten',[{authorId:rootAgentId}])
    assert.equal((await runtime.memory.indexPending(1)).ready,1)
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam office'))[0].retrieval,'vector')
    const blocked=await runtime.memory.save(rootAgentId,'fact','blocked source',[{authorId:rootAgentId}])
    const started=new Promise(resolve=>{indexStarted=resolve})
    const oldIndex=runtime.memory.indexPending(1)
    await started
    const queryBarrier=new Promise(resolve=>{queryStarted=resolve})
    const oldQuery=runtime.memory.search(rootAgentId,null,'Amsterdam race')
    await queryBarrier
    await assert.rejects(runtime.memory.activateRebuild(randomUUID(),1,{ ...b, ...newEmbedder }),/denied/)
    await assert.rejects(runtime.memory.activateRebuild(ownerId,2,{ ...b, ...newEmbedder }),/generation conflict/)
    const generation=await runtime.memory.activateRebuild(ownerId,1,{ ...b, ...newEmbedder })
    assert.equal(generation,2)
    releaseQuery()
    assert.equal((await oldQuery)[0].retrieval,'lexical')
    releaseIndex()
    assert.equal((await oldIndex).stale,1)
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam office'))[0].retrieval,'lexical')
    const oldRuntime=new MemoryService(runtime.db,installationId,{...a,...oldEmbedder})
    assert.equal((await oldRuntime.indexPending(10)).processed,0)
    assert.equal((await oldRuntime.search(rootAgentId,null,'Amsterdam office'))[0].retrieval,'lexical')
    const revision=await runtime.memory.correct(rootAgentId,blocked.id,1,'blocked source revised',[{authorId:rootAgentId}])
    assert.equal(revision.revision,2)
    const indexed=await runtime.memory.indexPending(10,true)
    assert.equal(indexed.ready,2)
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam office'))[0].retrieval,'vector')
    const rows=(await runtime.db.query(`SELECT generation,provider,model,dimension FROM kipster.memory_embedding_generations WHERE installation_id=$1 ORDER BY generation`,[installationId])).rows
    assert.deepEqual(rows.map(row=>[Number(row.generation),row.provider,row.model,row.dimension]),[[1,'ollama','fixture-a',2],[2,'ollama','fixture-b',2]])
    const active=(await runtime.db.query(`SELECT generation,model,dimension FROM kipster.memory_profiles WHERE installation_id=$1`,[installationId])).rows[0]
    assert.deepEqual([Number(active.generation),active.model,active.dimension],[2,'fixture-b',2])
    assert.equal((await runtime.db.query(`SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1 AND source_revision=1 AND generation=2`,[blocked.id])).rows[0].status,'stale')
    await assert.rejects(oldRuntime.activateRebuild(ownerId,2,{ ...a, ...oldEmbedder }),/generation conflict/)
    const concurrent=await runtime.memory.save(rootAgentId,'fact','The library opens at nine',[{authorId:rootAgentId}])
    const c={...a,model:'fixture-c'}
    const [corrected,thirdGeneration]=await Promise.all([
      runtime.memory.correct(rootAgentId,concurrent.id,1,'The library opens at ten',[{authorId:rootAgentId}]),
      runtime.memory.activateRebuild(ownerId,2,{ ...c, ...newEmbedder }),
    ])
    assert.equal(corrected.revision,2)
    assert.equal(thirdGeneration,3)
    assert.equal((await runtime.db.query(`SELECT status FROM kipster.memory_index_intents WHERE memory_id=$1 AND source_revision=2 AND generation=3`,[concurrent.id])).rows[0].status,'pending')
    await runtime.memory.indexPending(10,true)
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},embedding:{...c,...newEmbedder}})
    await runtime.memory.stopIndexing()
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam office'))[0].retrieval,'vector')
    assert.equal((await runtime.db.query('SELECT generation FROM kipster.memory_profiles')).rows[0].generation,'3')
    assert.ok((await runtime.memory.search(rootAgentId,null,'Amsterdam office')).some(hit=>hit.record.id===saved.id))
  } finally {
    releaseIndex?.();releaseQuery?.()
    await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin.close()
  }
})

test('restart keeps identity or re-embeds every retained memory and vector source', {skip:noDatabase,timeout:30000}, async () => {
  const admin = new Postgres(adminUrl), database = `kipster_restart_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl); url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(),'kipster-reembed-'))
  let runtime
  const seen = []
  let available = true
  const provider = {id:'custom',model:'one',contractMajor:1,async embed(text){if(!available)throw Error('offline');seen.push(text);return [1,0]}}
  const config = {connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'}}
  const reopen = async embedding => {
    await runtime?.close(); runtime = undefined
    runtime = await openRuntime({...config,embedding})
    await runtime.memory.stopIndexing(); await runtime.vectors.stopIndexing()
  }
  try {
    await reopen(provider)
    const {installationId,rootAgentId} = runtime.bootstrap
    const memory = await runtime.memory.save(rootAgentId,'fact','Amsterdam memory source',[{authorId:rootAgentId}])
    const collection = randomUUID(), record = randomUUID()
    await runtime.db.query(`INSERT INTO kipster.vector_collections(id,installation_id,owner_kind,owner_id,name) VALUES ($1,$2,'agent',$3,'fixture')`,[collection,installationId,rootAgentId])
    await runtime.db.query(`INSERT INTO kipster.vector_records(id,collection_id,record_key,text,source_hash,source_bytes) VALUES ($1,$2,'one','Amsterdam vector source','hash',23)`,[record,collection])
    await runtime.db.query(`INSERT INTO kipster.vector_sources(record_id,revision,text,metadata,source_hash) VALUES ($1,1,'Amsterdam vector source','{}','hash')`,[record])
    await runtime.db.query(`INSERT INTO kipster.vector_index_intents(record_id,source_revision,source_hash,generation,provider,model,status) VALUES ($1,1,'hash',1,'custom','one','pending')`,[record])
    assert.equal((await runtime.memory.indexPending(10)).ready,1)
    assert.equal((await runtime.vectors.indexPending(10)).ready,1)
    await reopen(provider)
    assert.equal((await runtime.db.query('SELECT generation FROM kipster.memory_profiles')).rows[0].generation,'1')
    assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam memory'))[0].retrieval,'vector')
    for (const [generation, next] of [[2,{...provider,model:'two'}],[3,{...provider,id:'another',model:'two'}]]) {
      available = false
      await reopen(next)
      const active = (await runtime.db.query('SELECT generation,provider,model,dimension FROM kipster.memory_profiles')).rows[0]
      assert.deepEqual(active,{generation:String(generation),provider:next.id,model:next.model,dimension:null})
      for (const table of ['memory_index_intents','vector_index_intents']) {
        const rows = (await runtime.db.query(`SELECT status FROM kipster.${table} WHERE generation=$1`,[generation])).rows
        assert.equal(rows.length,1)
        assert.ok(['pending','failed'].includes(rows[0].status))
        assert.equal((await runtime.db.query(`SELECT count(*) FROM kipster.${table} WHERE generation=1 AND status='ready'`)).rows[0].count,'1')
      }
      assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam memory'))[0].retrieval,'lexical')
      assert.equal((await runtime.memory.get(rootAgentId,null,memory.id)).text,'Amsterdam memory source')
      assert.equal((await runtime.db.query('SELECT text FROM kipster.vector_records WHERE id=$1',[record])).rows[0].text,'Amsterdam vector source')
      available = true; seen.length = 0
      assert.equal((await runtime.memory.indexPending(10,true)).ready,1)
      assert.equal((await runtime.vectors.indexPending(10,true)).ready,1)
      assert.deepEqual(seen.sort(),['Amsterdam memory source','Amsterdam vector source'])
      assert.equal((await runtime.memory.search(rootAgentId,null,'Amsterdam memory'))[0].retrieval,'vector')
    }
  } finally {
    await runtime?.close(); await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.close()
  }
})
