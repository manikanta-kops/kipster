import { createHash, randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { boundedEmbed, sameProfile, vectorLiteral, type MemoryService } from '../memory/public.js'
import { isLive } from '../identity/public.js'

type Target = { kind:'agent'|'organization'; ownerId:string }
type Input = Record<string,unknown>
type Profile = {generation:string;dimension:number|null;provider:string;model:string}
type Identity = {actor_id:string;context_kind:string;context_id:string;root_thread_id:string;thread_id:string;run_id:string;run_state:string;attempt_state:string;intent_state:string;current_attempt_id:string;generation:string;intent_generation:string;incarnation:string;stop_requested:boolean}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const namePattern=/^[a-z][a-z0-9_]{0,39}$/
const ops=new Set(['create','discover','describe','get','upsert','search','delete_record','delete_collection'])
const writes=new Set(['create','upsert','delete_record','delete_collection'])
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
function object(value:unknown):Input {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected vector arguments');return value as Input}
function only(value:Input,keys:string[]):void {if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unexpected vector field')}
function id(value:unknown):string {if(typeof value!=='string'||!uuid.test(value))throw new Error('Invalid vector ID');return value}
function name(value:unknown):string {if(typeof value!=='string'||!namePattern.test(value))throw new Error('Invalid collection name');return value}
function key(value:unknown):string {if(typeof value!=='string'||value.length<1||value.length>100||Buffer.byteLength(value)>200||value.includes('\0'))throw new Error('Invalid record key');return value}
function integer(value:unknown,min:number,max:number):number {if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new Error('Invalid vector integer');return Number(value)}
function canonical(value:unknown):string {
  if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw new Error('Invalid vector number')
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value&&typeof value==='object'){
    if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new Error('Invalid vector object')
    return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
  }
  const encoded=JSON.stringify(value)
  if(encoded===undefined)throw new Error('Invalid vector value')
  return encoded
}
function target(value:unknown):Target {const row=object(value);only(row,['kind','ownerId']);if(row.kind!=='agent'&&row.kind!=='organization')throw new Error('Invalid vector owner');return {kind:row.kind,ownerId:id(row.ownerId)}}
function source(value:unknown):{text:string;metadata:Input;hash:string;bytes:number} {
  const row=object(value);only(row,['text','metadata'])
  if(typeof row.text!=='string'||!row.text.trim()||Buffer.byteLength(row.text)>8192||row.text.includes('\0'))throw new Error('Invalid vector source text')
  const metadata=row.metadata===undefined?{}:object(row.metadata)
  const encoded=canonical(metadata)
  if(Buffer.byteLength(encoded)>2048||Object.keys(metadata).length>32)throw new Error('Vector metadata limit exceeded')
  const bytes=Buffer.byteLength(row.text)+Buffer.byteLength(encoded)
  return {text:row.text,metadata,hash:hash(row.text+'\0'+encoded),bytes}
}
function cursor(value:unknown):Input|null {
  if(value===undefined)return null
  if(typeof value!=='string'||value.length>1200)throw new Error('Invalid vector cursor')
  try {const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as unknown;return object(decoded)}
  catch {throw new Error('Invalid vector cursor')}
}
const encode=(value:Input)=>Buffer.from(JSON.stringify(value)).toString('base64url')
const identitySql=`SELECT COALESCE(d.recipient_agent_id,c.agent_id) AS actor_id,c.context_kind,c.context_id,
  COALESCE(d.origin_thread_id,r.thread_id) AS root_thread_id,r.thread_id,r.id AS run_id,r.state AS run_state,
  r.stop_requested,a.state AS attempt_state,i.state AS intent_state,r.current_attempt_id,a.generation,i.generation AS intent_generation,a.incarnation
  FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id JOIN kipster.text_runs r ON r.id=i.id
  JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
  LEFT JOIN kipster.delegations d ON d.child_run_id=r.id WHERE a.id=$1 AND c.installation_id=$2`

/** Deletes up to `limit` collections of an owner with their records, sources and index state. Returns how many were deleted. */
export async function deleteOwnerCollections(client:SqlClient,installationId:string,owner:Target,limit:number):Promise<number>{
  const rows=(await client.query<{id:string}>('SELECT id FROM kipster.vector_collections WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 ORDER BY id LIMIT $4 FOR UPDATE',[installationId,owner.kind,owner.ownerId,limit])).rows.map(row=>row.id)
  await client.query('DELETE FROM kipster.vector_collections WHERE id=ANY($1::uuid[])',[rows])
  return rows.length
}

/** Core-owned vector collections. No collection is an implicit memory retrieval source. */
export class VectorService {
  private timer:ReturnType<typeof setTimeout>|null=null
  private active:Promise<void>|null=null
  private stopped=false
  constructor(readonly db:Postgres,readonly installationId:string,readonly memory:MemoryService){}
  startIndexing():void {this.stopped=false;this.wakeIndexing()}
  wakeIndexing():void {if(this.stopped)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.loop()},0);this.timer.unref()}
  private async loop():Promise<void> {if(this.active||this.stopped)return;this.active=(async()=>{try{await this.indexPending(2)}catch{/* Durable intents remain retryable. */}})();await this.active;this.active=null;if(!this.stopped){this.timer=setTimeout(()=>{this.timer=null;void this.loop()},5000);this.timer.unref()}}
  async stopIndexing():Promise<void> {this.stopped=true;if(this.timer)clearTimeout(this.timer);this.timer=null;await this.active}
  private live(row:Identity,attemptId:string,incarnation:string):boolean {return row.run_state==='running'&&!row.stop_requested&&row.attempt_state==='issued'&&row.intent_state==='issued'&&row.current_attempt_id===attemptId&&row.generation===row.intent_generation&&row.incarnation===incarnation}
  private async guard(client:SqlClient,attemptId:string,incarnation:string,owner:Target,lock:boolean):Promise<Identity> {
    const initial=(await client.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
    if(!initial)throw new Error('Unknown vector attempt')
    if(owner.kind==='organization'&&(initial.context_kind!=='organization'||initial.context_id!==owner.ownerId))throw new Error('Vector organization target is outside active context')
    if(lock){
      const capacity=await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[this.installationId])
      if(!capacity.rows.length)throw new Error('Missing vector execution guard')
      await this.owners(client,initial.actor_id,owner,true)
      const root=await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[initial.root_thread_id])
      if(!root.rows.length)throw new Error('Missing vector root thread')
      if(initial.thread_id!==initial.root_thread_id){
        const thread=await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[initial.thread_id])
        if(!thread.rows.length)throw new Error('Missing vector child thread')
      }
      const attempt=await client.query(`SELECT 1 FROM kipster.text_runs r JOIN kipster.work_intents i ON i.id=r.id
        JOIN kipster.attempts a ON a.intent_id=r.id WHERE r.id=$1 AND a.id=$2 FOR UPDATE OF r,i,a`,[initial.run_id,attemptId])
      if(!attempt.rows.length)throw new Error('Missing vector attempt')
    }
    const current=(await client.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
    if(!current||current.root_thread_id!==initial.root_thread_id||current.thread_id!==initial.thread_id||!this.live(current,attemptId,incarnation))throw new Error('Vector attempt no longer owns tools')
    if(owner.kind==='organization'&&(current.context_kind!=='organization'||current.context_id!==owner.ownerId))throw new Error('Vector organization target is outside active context')
    if(!lock)await this.owners(client,current.actor_id,owner,false)
    return current
  }
  /** The acting agent and the owner must be live; a write keeps their rows locked until commit. */
  private async owners(client:SqlClient,actorId:string,owner:Target,lock:boolean):Promise<void>{
    if(!await isLive(client,this.installationId,'agent',actorId,lock))throw new Error('Acting vector agent unavailable')
    if(!await isLive(client,this.installationId,owner.kind,owner.ownerId,lock))throw new Error('Vector owner unavailable')
  }
  private async profile(client:SqlClient,lock:boolean,requireConfigured=true):Promise<Profile> {
    const p=(await client.query<Profile>(`SELECT generation,dimension,provider,model FROM kipster.memory_profiles WHERE installation_id=$1 ${lock?'FOR SHARE':''}`,[this.installationId])).rows[0]
    if(!p)throw new Error('Embedding profile unavailable')
    const configured=this.memory.embeddingConfig().profile
    if(requireConfigured&&!sameProfile(p,configured))throw new Error('Embedding profile changed; restart or reconfigure runtime')
    return p
  }
  async invoke(attemptId:string,incarnation:string,callId:string,args:unknown):Promise<unknown> {
    id(attemptId);id(incarnation)
    if(typeof callId!=='string'||callId.length<1||callId.length>200)throw new Error('Invalid vector call ID')
    const input=object(args),operation=input.operation
    if(typeof operation!=='string'||!ops.has(operation))throw new Error('Unknown vector operation')
    const owner=target(input.target)
    if(Buffer.byteLength(canonical(input))>16000)throw new Error('Vector request limit exceeded')
    const fields:Record<string,string[]>={create:['operation','target','name'],discover:['operation','target','after','limit'],describe:['operation','target','collectionId'],get:['operation','target','collectionId','key'],upsert:['operation','target','collectionId','key','expectedRevision','text','metadata'],search:['operation','target','collectionId','query','limit','cursor'],delete_record:['operation','target','collectionId','key','expectedRevision'],delete_collection:['operation','target','collectionId','expectedRevision']}
    only(input,fields[operation]!)
    if(operation==='create')name(input.name)
    if(!['create','discover'].includes(operation))id(input.collectionId)
    if(['get','upsert','delete_record'].includes(operation))key(input.key)
    if(['upsert','delete_record'].includes(operation))integer(input.expectedRevision,0,Number.MAX_SAFE_INTEGER)
    if(operation==='delete_collection')integer(input.expectedRevision,1,Number.MAX_SAFE_INTEGER)
    if(operation==='upsert')source({text:input.text,metadata:input.metadata})
    if(operation==='search'&&(typeof input.query!=='string'||!input.query.trim()||Buffer.byteLength(input.query)>1000))throw new Error('Invalid vector query')
    if(input.limit!==undefined)integer(input.limit,1,20)
    const payloadHash=hash(canonical(input))
    const identified=(await this.db.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
    if(!identified||identified.incarnation!==incarnation)throw new Error('Unknown vector attempt')
    if(owner.kind==='organization'&&(identified.context_kind!=='organization'||identified.context_id!==owner.ownerId))throw new Error('Vector organization target is outside active context')
    if(writes.has(operation))return this.db.transaction(async client=>{
      await client.query("SET LOCAL transaction_timeout='5s'")
      await client.query("SET LOCAL lock_timeout='1500ms'")
      const previous=(await client.query<{operation:string;arguments_hash:string;result:unknown}>('SELECT operation,arguments_hash,result FROM kipster.vector_tool_receipts WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if(previous){if(previous.operation!==operation||previous.arguments_hash!==payloadHash)throw new Error('Vector call identity conflict');return previous.result}
      const identity=await this.guard(client,attemptId,incarnation,owner,true)
      const raced=(await client.query<{operation:string;arguments_hash:string;result:unknown}>('SELECT operation,arguments_hash,result FROM kipster.vector_tool_receipts WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if(raced){if(raced.operation!==operation||raced.arguments_hash!==payloadHash)throw new Error('Vector call identity conflict');return raced.result}
      const profile=await this.profile(client,true,operation==='upsert')
      const result=await this.executeWrite(client,operation,input,owner,identity.actor_id,profile)
      await client.query('INSERT INTO kipster.vector_tool_receipts(attempt_id,call_id,operation,arguments_hash,result) VALUES ($1,$2,$3,$4,$5::jsonb)',[attemptId,callId,operation,payloadHash,JSON.stringify(result)])
      return result
    }).then(result=>{this.wakeIndexing();return result})
    await this.db.transaction(client=>this.guard(client,attemptId,incarnation,owner,false))
    if(operation==='search')return this.search(attemptId,incarnation,owner,input)
    const result=await this.executeRead(owner,operation,input)
    await this.db.transaction(client=>this.guard(client,attemptId,incarnation,owner,false))
    return result
  }
  private async collection(client:SqlClient,idValue:unknown,owner:Target,lock:boolean):Promise<{id:string;revision:string}|null>{
    const row=(await client.query<{id:string;revision:string}>(`SELECT id,revision FROM kipster.vector_collections WHERE id=$1 AND installation_id=$2 AND owner_kind=$3 AND owner_id=$4 ${lock?'FOR NO KEY UPDATE':''}`,[idValue,this.installationId,owner.kind,owner.ownerId])).rows[0]
    return row??null
  }
  private async executeWrite(client:SqlClient,operation:string,input:Input,owner:Target,actorId:string,profile:Profile):Promise<unknown>{
    if(operation==='create'){
      const count=(await client.query<{count:string}>('SELECT count(*)::text AS count FROM kipster.vector_collections WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3',[this.installationId,owner.kind,owner.ownerId])).rows[0]
      if(Number(count?.count)>=100)throw new Error('Collection count limit exceeded')
      const collectionId=randomUUID()
      await client.query('INSERT INTO kipster.vector_collections(id,installation_id,owner_kind,owner_id,name) VALUES ($1,$2,$3,$4,$5)',[collectionId,this.installationId,owner.kind,owner.ownerId,input.name])
      return {status:'completed',actorId,owner,collectionId,name:input.name,revision:1}
    }
    const collection=await this.collection(client,input.collectionId,owner,true)
    if(!collection)throw new Error('Vector collection not found')
    if(operation==='delete_collection'){
      if(Number(collection.revision)!==input.expectedRevision)throw new Error('Collection revision conflict')
      await client.query('DELETE FROM kipster.vector_collections WHERE id=$1',[collection.id])
      return {status:'completed',actorId,owner,collectionId:collection.id,deleted:true}
    }
    const record=(await client.query<{id:string;revision:number;source_bytes:number}>(`SELECT id,revision,source_bytes FROM kipster.vector_records WHERE collection_id=$1 AND record_key=$2 FOR NO KEY UPDATE`,[collection.id,input.key])).rows[0]
    if(operation==='delete_record'){
      if(!record||record.revision!==input.expectedRevision)throw new Error('Vector record revision conflict')
      await client.query('DELETE FROM kipster.vector_records WHERE id=$1',[record.id])
      await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id])
      return {status:'completed',actorId,owner,collectionId:collection.id,recordId:record.id,deleted:true}
    }
    const value=source({text:input.text,metadata:input.metadata}),expected=input.expectedRevision as number
    let recordId:string,revision:number
    if(record){
      if(record.revision!==expected)throw new Error('Vector record revision conflict')
      const total=(await client.query<{bytes:string}>('SELECT COALESCE(sum(source_bytes),0)::text AS bytes FROM kipster.vector_records WHERE collection_id=$1',[collection.id])).rows[0]!
      if(Number(total.bytes)-record.source_bytes+value.bytes>8388608)throw new Error('Collection resource limit exceeded')
      recordId=record.id;revision=record.revision+1
      await client.query('UPDATE kipster.vector_records SET text=$2,metadata=$3::jsonb,source_hash=$4,revision=$5,source_bytes=$6,updated_at=now() WHERE id=$1',[recordId,value.text,JSON.stringify(value.metadata),value.hash,revision,value.bytes])
      await client.query("UPDATE kipster.vector_index_intents SET status='stale',embedding=NULL,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE record_id=$1 AND status IN ('pending','processing','failed')",[recordId])
    }else{
      if(expected!==0)throw new Error('Vector record revision conflict')
      const bounds=(await client.query<{count:string;bytes:string}>('SELECT count(*)::text AS count,COALESCE(sum(source_bytes),0)::text AS bytes FROM kipster.vector_records WHERE collection_id=$1',[collection.id])).rows[0]!
      if(Number(bounds.count)>=1000||Number(bounds.bytes)+value.bytes>8388608)throw new Error('Collection resource limit exceeded')
      recordId=randomUUID();revision=1
      await client.query('INSERT INTO kipster.vector_records(id,collection_id,record_key,text,metadata,source_hash,source_bytes) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)',[recordId,collection.id,input.key,value.text,JSON.stringify(value.metadata),value.hash,value.bytes])
    }
    await client.query('INSERT INTO kipster.vector_sources(record_id,revision,text,metadata,source_hash) VALUES ($1,$2,$3,$4::jsonb,$5)',[recordId,revision,value.text,JSON.stringify(value.metadata),value.hash])
    await client.query('DELETE FROM kipster.vector_sources WHERE record_id=$1 AND revision<$2',[recordId,revision])
    await client.query("INSERT INTO kipster.vector_index_intents(record_id,source_revision,source_hash,generation,provider,model,status) VALUES ($1,$2,$3,$4,$5,$6,'pending')",[recordId,revision,value.hash,profile.generation,profile.provider,profile.model])
    await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id])
    return {status:'completed',actorId,owner,collectionId:collection.id,recordId,key:input.key,revision,indexStatus:'pending'}
  }
  private async executeRead(owner:Target,operation:string,input:Input):Promise<unknown>{
    if(operation==='discover'){
      const limit=input.limit===undefined?20:integer(input.limit,1,20)
      const after=input.after===undefined?'':name(input.after)
      const rows=(await this.db.query<{id:string;name:string;revision:string}>(`SELECT id,name,revision FROM kipster.vector_collections WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 AND name>$4 ORDER BY name,id LIMIT $5`,[this.installationId,owner.kind,owner.ownerId,after,limit+1])).rows
      return {owner,collections:rows.slice(0,limit).map(row=>({id:row.id,name:row.name,revision:Number(row.revision)})),next:rows.length>limit?rows[limit-1]!.name:null}
    }
    const collection=await this.collection(this.db,input.collectionId,owner,false)
    if(!collection)throw new Error('Vector collection not found')
    if(operation==='describe'){
      const rows=(await this.db.query<{name:string;count:string}>(`SELECT c.name,count(r.id)::text AS count FROM kipster.vector_collections c LEFT JOIN kipster.vector_records r ON r.collection_id=c.id WHERE c.id=$1 GROUP BY c.id`,[collection.id])).rows
      return {owner,collectionId:collection.id,name:rows[0]?.name,revision:Number(collection.revision),recordCount:Number(rows[0]?.count??0)}
    }
    const row=(await this.db.query<{id:string;record_key:string;text:string;metadata:Input;revision:number;source_hash:string;status:string|null;failure:string|null}>(`SELECT r.id,r.record_key,r.text,r.metadata,r.revision,r.source_hash,i.status,i.failure FROM kipster.vector_records r
      JOIN kipster.vector_collections c ON c.id=r.collection_id
      LEFT JOIN kipster.memory_profiles p ON p.installation_id=c.installation_id
      LEFT JOIN kipster.vector_index_intents i ON i.record_id=r.id AND i.source_revision=r.revision AND i.source_hash=r.source_hash AND i.generation=p.generation
      WHERE c.id=$1 AND c.installation_id=$2 AND c.owner_kind=$3 AND c.owner_id=$4 AND r.record_key=$5`,[collection.id,this.installationId,owner.kind,owner.ownerId,input.key])).rows[0]
    return {owner,collectionId:collection.id,record:row?{id:row.id,key:row.record_key,text:row.text,metadata:row.metadata,revision:row.revision,sourceHash:row.source_hash,indexStatus:row.status??'pending',failure:row.failure}:null}
  }
  private async search(attemptId:string,incarnation:string,owner:Target,input:Input):Promise<unknown>{
    const collectionId=id(input.collectionId),query=input.query as string,limit=input.limit===undefined?10:integer(input.limit,1,20)
    const first=(await this.db.query<Profile & {collection_revision:string}>(`SELECT p.generation,p.dimension,p.provider,p.model,c.revision AS collection_revision
      FROM kipster.vector_collections c JOIN kipster.memory_profiles p ON p.installation_id=c.installation_id
      WHERE c.id=$1 AND c.installation_id=$2 AND c.owner_kind=$3 AND c.owner_id=$4`,[collectionId,this.installationId,owner.kind,owner.ownerId])).rows[0]
    if(!first)throw new Error('Vector collection not found')
    const token=cursor(input.cursor),queryHash=hash(query)
    if(token&&(token.collectionId!==collectionId||token.queryHash!==queryHash||token.generation!==first.generation||token.revision!==first.collection_revision||typeof token.distance!=='number'||!Number.isFinite(token.distance)||typeof token.id!=='string'||!uuid.test(token.id)))throw new Error('Vector pagination invalidated')
    const configured=this.memory.embeddingConfig()
    if(!sameProfile(first,configured.profile))throw new Error('Embedding profile changed; restart or reconfigure runtime')
    let vector:string|undefined,availability:'ready'|'pending'|'failed'='pending'
    if(first.dimension!==null){
      try{const values=await boundedEmbed(configured.embedder,query,3000);if(values.length!==first.dimension)throw new Error('Embedding dimension mismatch');vector=vectorLiteral(values);availability='ready'}
      catch{availability='failed'}
    }
    const result=await this.db.transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL transaction_timeout='5s'")
      const final=(await client.query<Profile & {collection_revision:string}>(`SELECT p.generation,p.dimension,p.provider,p.model,c.revision AS collection_revision FROM kipster.vector_collections c
        JOIN kipster.memory_profiles p ON p.installation_id=c.installation_id WHERE c.id=$1 AND c.installation_id=$2 AND c.owner_kind=$3 AND c.owner_id=$4`,[collectionId,this.installationId,owner.kind,owner.ownerId])).rows[0]
      if(!final||final.generation!==first.generation||final.collection_revision!==first.collection_revision||!sameProfile(final,first)||final.dimension!==first.dimension)throw new Error('Vector pagination invalidated')
      const pending=(await client.query<{pending:string;failed:string;total:string}>(`SELECT count(*) FILTER (WHERE i.status IN ('pending','processing') OR i.status IS NULL)::text AS pending,
        count(*) FILTER (WHERE i.status='failed')::text AS failed,count(*)::text AS total
        FROM kipster.vector_records r LEFT JOIN kipster.vector_index_intents i ON i.record_id=r.id AND i.source_revision=r.revision AND i.source_hash=r.source_hash AND i.generation=$2 WHERE r.collection_id=$1`,[collectionId,first.generation])).rows[0]!
      const state=availability==='failed'||Number(pending.failed)>0?'failed':Number(pending.pending)>0||final.dimension===null&&Number(pending.total)>0?'pending':'ready'
      if(!vector)return {owner,collectionId,generation:Number(first.generation),availability:state,pending:Number(pending.pending),failed:Number(pending.failed),results:[],nextCursor:null}
      const rows=(await client.query<{id:string;record_key:string;text:string;metadata:Input;revision:number;distance:number}>(`SELECT r.id,r.record_key,r.text,r.metadata,r.revision,(i.embedding <=> $5::vector)::float8 AS distance
        FROM kipster.vector_records r JOIN kipster.vector_collections c ON c.id=r.collection_id
        JOIN kipster.vector_index_intents i ON i.record_id=r.id AND i.source_revision=r.revision AND i.source_hash=r.source_hash
        WHERE c.id=$1 AND c.installation_id=$2 AND c.owner_kind=$3 AND c.owner_id=$4 AND i.generation=$6 AND i.provider=$7 AND i.model=$8 AND i.status='ready' AND i.dimension=$9
        AND ($10::float8 IS NULL OR (i.embedding <=> $5::vector)::float8>$10 OR ((i.embedding <=> $5::vector)::float8=$10 AND r.id>$11::uuid))
        ORDER BY distance,r.id LIMIT $12`,[collectionId,this.installationId,owner.kind,owner.ownerId,vector,first.generation,first.provider,first.model,first.dimension,token?.distance??null,token?.id??null,limit+1])).rows
      const page=rows.slice(0,limit),last=page.at(-1)
      return {owner,collectionId,generation:Number(first.generation),availability:state,pending:Number(pending.pending),failed:Number(pending.failed),results:page.map(row=>({id:row.id,key:row.record_key,text:row.text,metadata:row.metadata,revision:row.revision,score:Math.max(0,1-Number(row.distance))})),nextCursor:rows.length>limit&&last?encode({collectionId,queryHash,generation:first.generation,revision:first.collection_revision,distance:Number(last.distance),id:last.id}):null}
    })
    await this.db.transaction(client=>this.guard(client,attemptId,incarnation,owner,false))
    const current=(await this.db.query<Profile & {collection_revision:string}>(`SELECT p.generation,p.dimension,p.provider,p.model,c.revision AS collection_revision FROM kipster.vector_collections c
      JOIN kipster.memory_profiles p ON p.installation_id=c.installation_id WHERE c.id=$1`,[collectionId])).rows[0]
    if(!current||current.generation!==first.generation||current.collection_revision!==first.collection_revision||!sameProfile(current,first))throw new Error('Vector pagination invalidated')
    return result
  }
  async indexPending(limit=2,force=false):Promise<{processed:number;ready:number;failed:number;stale:number}>{
    integer(limit,1,20)
    const counts={processed:0,ready:0,failed:0,stale:0},deadline=Date.now()+30000,seen:string[]=[]
    for(let n=0;n<limit&&Date.now()<deadline;n++){
      const configured=this.memory.embeddingConfig(),leaseOwner=randomUUID()
      const claimed=await this.db.transaction(async client=>{
        await client.query("SET LOCAL transaction_timeout='5s'")
        const row=(await client.query<{record_id:string;source_revision:number;source_hash:string;generation:string;provider:string;model:string;text:string;owner_kind:'agent'|'organization';owner_id:string}>(`SELECT i.record_id,i.source_revision,i.source_hash,i.generation,i.provider,i.model,s.text,c.owner_kind,c.owner_id FROM kipster.vector_index_intents i
          JOIN kipster.vector_sources s ON s.record_id=i.record_id AND s.revision=i.source_revision
          JOIN kipster.vector_records r ON r.id=i.record_id JOIN kipster.vector_collections c ON c.id=r.collection_id
          JOIN kipster.memory_profiles p ON p.installation_id=c.installation_id AND p.generation=i.generation AND p.provider=i.provider AND p.model=i.model
          WHERE c.installation_id=$1 AND p.provider=$4 AND p.model=$5 AND NOT(i.record_id=ANY($3::uuid[]))
          AND ((i.status IN ('pending','failed') AND (i.next_attempt_at<=now() OR $2)) OR (i.status='processing' AND i.lease_until<now()))
          AND CASE c.owner_kind WHEN 'agent' THEN kipster.live_agent(c.owner_id) ELSE kipster.live_organization(c.owner_id) END
          ORDER BY i.updated_at,i.record_id LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,[this.installationId,force,seen,configured.profile.provider,configured.profile.model])).rows[0]
        if(!row)return null
        await client.query("UPDATE kipster.vector_index_intents SET status='processing',lease_owner=$4,lease_until=now()+interval '15 seconds',updated_at=now() WHERE record_id=$1 AND source_revision=$2 AND generation=$3",[row.record_id,row.source_revision,row.generation,leaseOwner])
        return row
      })
      if(!claimed)break
      seen.push(claimed.record_id);counts.processed++
      let vector:string|undefined,failure:string|undefined
      try{vector=vectorLiteral(await boundedEmbed(configured.embedder,claimed.text,5000))}catch(error){failure=error instanceof Error?error.message:'Embedding failed'}
      const outcome=await this.db.transaction(async client=>{
        await client.query("SET LOCAL transaction_timeout='5s'")
        // A lease that ends after its owner stopped being live writes nothing; it is picked up again once the owner is live.
        if(!await isLive(client,this.installationId,claimed.owner_kind,claimed.owner_id))return 'stale'
        const profile=(await client.query<Profile>('SELECT generation,dimension,provider,model FROM kipster.memory_profiles WHERE installation_id=$1 FOR UPDATE',[this.installationId])).rows[0]
        const collection=(await client.query<{id:string}>(`SELECT c.id FROM kipster.vector_collections c JOIN kipster.vector_records r ON r.collection_id=c.id WHERE r.id=$1 AND c.installation_id=$2 FOR NO KEY UPDATE OF c`,[claimed.record_id,this.installationId])).rows[0]
        const record=(await client.query<{revision:number;source_hash:string}>(`SELECT revision,source_hash FROM kipster.vector_records WHERE id=$1 FOR NO KEY UPDATE`,[claimed.record_id])).rows[0]
        const lease=(await client.query<{status:string;lease_owner:string|null;valid:boolean}>(`SELECT status,lease_owner,lease_until>now() AS valid FROM kipster.vector_index_intents WHERE record_id=$1 AND source_revision=$2 AND generation=$3 FOR UPDATE`,[claimed.record_id,claimed.source_revision,claimed.generation])).rows[0]
        if(!lease||lease.status!=='processing'||lease.lease_owner!==leaseOwner||!lease.valid)return 'stale'
        if(!profile||!collection||!record||record.revision!==claimed.source_revision||record.source_hash!==claimed.source_hash||profile.generation!==claimed.generation||!sameProfile(profile,configured.profile)||profile.provider!==claimed.provider||profile.model!==claimed.model){
          await client.query("UPDATE kipster.vector_index_intents SET status='stale',embedding=NULL,lease_owner=NULL,lease_until=NULL WHERE record_id=$1 AND source_revision=$2 AND generation=$3",[claimed.record_id,claimed.source_revision,claimed.generation]);if(collection)await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id]);return 'stale'
        }
        if(failure){await client.query("UPDATE kipster.vector_index_intents SET status='failed',failure=$4,lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval '30 seconds' WHERE record_id=$1 AND source_revision=$2 AND generation=$3",[claimed.record_id,claimed.source_revision,claimed.generation,failure.slice(0,500)]);await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id]);return 'failed'}
        const dimension=vector!.slice(1,-1).split(',').length
        if(profile.dimension!==null&&profile.dimension!==dimension){await client.query("UPDATE kipster.vector_index_intents SET status='failed',failure='Embedding dimension mismatch',lease_owner=NULL,lease_until=NULL,next_attempt_at=now()+interval '30 seconds' WHERE record_id=$1 AND source_revision=$2 AND generation=$3",[claimed.record_id,claimed.source_revision,claimed.generation]);await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id]);return 'failed'}
        if(profile.dimension===null){await client.query('UPDATE kipster.memory_profiles SET dimension=$2 WHERE installation_id=$1',[this.installationId,dimension]);await client.query('UPDATE kipster.memory_embedding_generations SET dimension=$3 WHERE installation_id=$1 AND generation=$2',[this.installationId,claimed.generation,dimension])}
        await client.query("UPDATE kipster.vector_index_intents SET status='ready',failure=NULL,embedding=$4::vector,dimension=$5,lease_owner=NULL,lease_until=NULL,updated_at=now() WHERE record_id=$1 AND source_revision=$2 AND generation=$3",[claimed.record_id,claimed.source_revision,claimed.generation,vector,dimension])
        await client.query('UPDATE kipster.vector_collections SET revision=revision+1 WHERE id=$1',[collection.id])
        return 'ready'
      })
      counts[outcome]++
    }
    return counts
  }
}
