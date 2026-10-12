import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEmbeddingProvider, validateHostConfig } from '../dist/host.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime } from '../dist/runtime.js'
import { boundedEmbed, EmbeddingProfile } from '../dist/modules/vectors/public.js'
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

test('provider generation switches record each generation and are owner-only', {skip:noDatabase,timeout:30000}, async () => {
  const admin=new Postgres(adminUrl)
  const dbName=`kipster_embed_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE "${dbName}"`)
  const url=new URL(adminUrl);url.pathname=`/${dbName}`
  const home=await mkdtemp(join(tmpdir(),'kipster-embedding-config-'))
  let runtime
  const a={id: 'ollama', contractMajor: 1,model:'fixture-a'}
  const b={...a,model:'fixture-b'}
  const embedder={async embed(){return [1,0]}}
  try {
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},embedding:{...a,...embedder}})
    await runtime.vectors.stopIndexing()
    const {installationId,ownerId}=runtime.bootstrap
    await assert.rejects(runtime.embedding.activateRebuild(randomUUID(),1,{ ...b, ...embedder }),/denied/)
    await assert.rejects(runtime.embedding.activateRebuild(ownerId,2,{ ...b, ...embedder }),/generation conflict/)
    await assert.rejects(runtime.embedding.activateRebuild(ownerId,1,{ ...a, ...embedder }),/unchanged/)
    assert.equal(await runtime.embedding.activateRebuild(ownerId,1,{ ...b, ...embedder }),2)
    const oldProfile=new EmbeddingProfile(runtime.db,installationId,{...a,...embedder})
    await assert.rejects(oldProfile.activateRebuild(ownerId,2,{ ...a, ...embedder }),/generation conflict/)
    const rows=(await runtime.db.query(`SELECT generation,provider,model FROM kipster.embedding_generations WHERE installation_id=$1 ORDER BY generation`,[installationId])).rows
    assert.deepEqual(rows.map(row=>[Number(row.generation),row.provider,row.model]),[[1,'ollama','fixture-a'],[2,'ollama','fixture-b']])
    assert.deepEqual(runtime.embedding.embeddingConfig().profile,{provider:'ollama',model:'fixture-b'})
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},embedding:{...b,...embedder}})
    assert.equal((await runtime.db.query('SELECT generation FROM kipster.embedding_profiles')).rows[0].generation,'2')
  } finally {
    await runtime?.close()
    await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin.close()
  }
})

test('restart keeps identity or re-embeds every retained vector source', {skip:noDatabase,timeout:30000}, async () => {
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
    await runtime.vectors.stopIndexing()
  }
  try {
    await reopen(provider)
    const {installationId,rootAgentId} = runtime.bootstrap
    const collection = randomUUID(), record = randomUUID()
    await runtime.db.query(`INSERT INTO kipster.vector_collections(id,installation_id,owner_kind,owner_id,name) VALUES ($1,$2,'agent',$3,'fixture')`,[collection,installationId,rootAgentId])
    await runtime.db.query(`INSERT INTO kipster.vector_records(id,collection_id,record_key,text,source_hash,source_bytes) VALUES ($1,$2,'one','Amsterdam vector source','hash',23)`,[record,collection])
    await runtime.db.query(`INSERT INTO kipster.vector_sources(record_id,revision,text,metadata,source_hash) VALUES ($1,1,'Amsterdam vector source','{}','hash')`,[record])
    await runtime.db.query(`INSERT INTO kipster.vector_index_intents(record_id,source_revision,source_hash,generation,provider,model,status) VALUES ($1,1,'hash',1,'custom','one','pending')`,[record])
    assert.equal((await runtime.vectors.indexPending(10)).ready,1)
    await reopen(provider)
    assert.equal((await runtime.db.query('SELECT generation FROM kipster.embedding_profiles')).rows[0].generation,'1')
    for (const [generation, next] of [[2,{...provider,model:'two'}],[3,{...provider,id:'another',model:'two'}]]) {
      available = false
      await reopen(next)
      const active = (await runtime.db.query('SELECT generation,provider,model,dimension FROM kipster.embedding_profiles')).rows[0]
      assert.deepEqual(active,{generation:String(generation),provider:next.id,model:next.model,dimension:null})
      for (const table of ['vector_index_intents']) {
        const rows = (await runtime.db.query(`SELECT status FROM kipster.${table} WHERE generation=$1`,[generation])).rows
        assert.equal(rows.length,1)
        assert.ok(['pending','failed'].includes(rows[0].status))
        assert.equal((await runtime.db.query(`SELECT count(*) FROM kipster.${table} WHERE generation=1 AND status='ready'`)).rows[0].count,'1')
      }
      assert.equal((await runtime.db.query('SELECT text FROM kipster.vector_records WHERE id=$1',[record])).rows[0].text,'Amsterdam vector source')
      available = true; seen.length = 0
      assert.equal((await runtime.vectors.indexPending(10,true)).ready,1)
      assert.deepEqual(seen,['Amsterdam vector source'])
    }
  } finally {
    await runtime?.close(); await rm(home,{recursive:true,force:true})
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await admin.close()
  }
})
