import {createHash,randomUUID} from 'node:crypto'
import type {Postgres,SqlClient} from '../../platform/postgres/public.js'
import {homeSql} from './scope.js'
import {isLive} from '../identity/public.js'

type Owner={kind:'agent'|'organization';ownerId:string}
type Input=Record<string,unknown>
type Identity={actor_id:string;context_kind:string;context_id:string;root_thread_id:string;thread_id:string;run_id:string;run_state:string;attempt_state:string;intent_state:string;current_attempt_id:string;generation:string;intent_generation:string;incarnation:string;stop_requested:boolean}
type Memory={id:string;revision:string;source_hash:string;scope:string;owner_id:string;visible:boolean}
type Edge={id:string;from_id:string;to_id:string;kind:string;weight:number;revision:number;active:boolean;from_revision:string;to_revision:string;owner_kind:string;owner_id:string}
type Evidence={memoryId:string;revision:number;provenanceId?:string}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const types=new Set(['supports','derived_from','contradicts','related_to'])
const writes=new Set(['memory.link','memory.relationship_update','memory.unlink'])
const names=new Set(['memory.link','memory.relationship_get','memory.relationship_list','memory.relationship_update','memory.unlink'])
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
/** Organization of the execution, or null outside organizations. */
const contextOrganization=(identity:Identity)=>identity.context_kind==='organization'?identity.context_id:null
/** Links whose endpoints and current evidence are all visible under the organization home rule. */
const edgeVisibleSql=(organizationParam:string)=>`NOT EXISTS (SELECT 1 FROM kipster.memory_records hm WHERE (hm.id IN (memory_relationships.from_id,memory_relationships.to_id) OR hm.id IN (SELECT ev.memory_id FROM kipster.memory_relationship_evidence ev WHERE ev.relationship_id=memory_relationships.id AND ev.relationship_revision=memory_relationships.revision)) AND NOT ${homeSql('hm',organizationParam)})`
function object(value:unknown):Input {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid relationship arguments');return value as Input}
function only(value:Input,keys:string[]):void {if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unexpected relationship field')}
function id(value:unknown):string {if(typeof value!=='string'||!uuid.test(value))throw new Error('Invalid relationship ID');return value.toLowerCase()}
function integer(value:unknown,min=1,max=Number.MAX_SAFE_INTEGER):number {if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw new Error('Invalid relationship revision');return Number(value)}
function canonical(value:unknown):string {
  if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw new Error('Invalid relationship number')
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}'
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new Error('Invalid relationship value');return encoded
}
function owner(value:unknown):Owner {const row=object(value);only(row,['kind','ownerId']);if(row.kind!=='agent'&&row.kind!=='organization')throw new Error('Invalid relationship owner');return {kind:row.kind,ownerId:id(row.ownerId)}}
function evidence(value:unknown):Evidence[] {
  if(!Array.isArray(value)||value.length<1||value.length>8)throw new Error('Relationship requires 1–8 evidence items')
  const rows=value.map(item=>{const row=object(item);only(row,['memoryId','revision','provenanceId']);return {memoryId:id(row.memoryId),revision:integer(row.revision),...(row.provenanceId===undefined?{}:{provenanceId:id(row.provenanceId)})}})
  if(new Set(rows.map(row=>row.memoryId+':'+(row.provenanceId??''))).size!==rows.length)throw new Error('Duplicate relationship evidence')
  return rows
}
function edgeArgs(input:Input):{fromId:string;toId:string;fromRevision:number;toRevision:number;kind:string;weight:number;evidence:Evidence[]} {
  let fromId=id(input.fromId),toId=id(input.toId)
  let fromRevision=integer(input.fromRevision),toRevision=integer(input.toRevision)
  if(fromId===toId)throw new Error('Relationship endpoints must differ')
  const kind=input.kind
  if(typeof kind!=='string'||!types.has(kind))throw new Error('Invalid relationship type')
  if(typeof input.weight!=='number'||!Number.isFinite(input.weight)||input.weight<0||input.weight>1)throw new Error('Invalid relationship weight')
  const supports=evidence(input.evidence)
  if(!supports.some(row=>row.memoryId===fromId||row.memoryId===toId))throw new Error('Relationship evidence must include an endpoint')
  if((kind==='contradicts'||kind==='related_to')&&fromId>toId){[fromId,toId]=[toId,fromId];[fromRevision,toRevision]=[toRevision,fromRevision]}
  return {fromId,toId,fromRevision,toRevision,kind,weight:input.weight,evidence:supports}
}
const identitySql=`SELECT COALESCE(d.recipient_agent_id,c.agent_id) AS actor_id,c.context_kind,c.context_id,
 COALESCE(d.origin_thread_id,r.thread_id) AS root_thread_id,r.thread_id,r.id AS run_id,r.state AS run_state,
 r.stop_requested,a.state AS attempt_state,i.state AS intent_state,r.current_attempt_id,a.generation,i.generation AS intent_generation,a.incarnation
 FROM kipster.attempts a JOIN kipster.work_intents i ON i.id=a.intent_id JOIN kipster.text_runs r ON r.id=i.id
 JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
 LEFT JOIN kipster.delegations d ON d.child_run_id=r.id WHERE a.id=$1 AND c.installation_id=$2`

/** Owner-local, evidence-backed relationship graph. Tool calls are bound to one live Core attempt. */
export class RelationshipService {
  constructor(readonly db:Postgres,readonly installationId:string){}
  private live(row:Identity,attemptId:string,incarnation:string):boolean {return row.run_state==='running'&&!row.stop_requested&&row.attempt_state==='issued'&&row.intent_state==='issued'&&row.current_attempt_id===attemptId&&row.generation===row.intent_generation&&row.incarnation===incarnation}
  private async guard(client:SqlClient,attemptId:string,incarnation:string,target:Owner,lock:boolean):Promise<Identity> {
    const initial=(await client.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
    if(!initial)throw new Error('Unknown relationship attempt')
    if(target.kind==='organization'&&(initial.context_kind!=='organization'||initial.context_id!==target.ownerId))throw new Error('Relationship organization outside accepted context')
    if(lock){
      if(!(await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[this.installationId])).rows.length)throw new Error('Missing relationship execution guard')
      await this.owners(client,initial.actor_id,target,true)
      if(!(await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[initial.root_thread_id])).rows.length)throw new Error('Missing relationship root thread')
      if(initial.thread_id!==initial.root_thread_id&&!(await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[initial.thread_id])).rows.length)throw new Error('Missing relationship child thread')
      if(!(await client.query(`SELECT 1 FROM kipster.text_runs r JOIN kipster.work_intents i ON i.id=r.id JOIN kipster.attempts a ON a.intent_id=r.id WHERE r.id=$1 AND a.id=$2 FOR UPDATE OF r,i,a`,[initial.run_id,attemptId])).rows.length)throw new Error('Missing relationship attempt')
    }
    const current=(await client.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
    if(!current||current.thread_id!==initial.thread_id||current.root_thread_id!==initial.root_thread_id||!this.live(current,attemptId,incarnation))throw new Error('Relationship attempt no longer owns tools')
    if(target.kind==='organization'&&(current.context_kind!=='organization'||current.context_id!==target.ownerId))throw new Error('Relationship organization outside accepted context')
    if(!lock)await this.owners(client,current.actor_id,target,false)
    return current
  }
  /** The acting agent and the owner must be live; a write keeps their rows locked until commit. */
  private async owners(client:SqlClient,actorId:string,target:Owner,lock:boolean):Promise<void> {
    if(!await isLive(client,this.installationId,'agent',actorId,lock))throw new Error('Relationship actor unavailable')
    if(!await isLive(client,this.installationId,target.kind,target.ownerId,lock))throw new Error('Relationship owner unavailable')
  }
  private async memories(client:SqlClient,target:Owner,organizationId:string|null,ids:string[],lock:boolean):Promise<Map<string,Memory>> {
    const sorted=[...new Set(ids)].sort()
    const rows=(await client.query<Memory>(`SELECT id,revision,source_hash,scope,owner_id,${homeSql('memory_records','$3')} AS visible FROM kipster.memory_records WHERE id=ANY($1::uuid[]) AND installation_id=$2 ORDER BY id ${lock?'FOR NO KEY UPDATE':''}`,[sorted,this.installationId,organizationId])).rows
    if(rows.length!==sorted.length||rows.some(row=>row.scope!==target.kind||row.owner_id!==target.ownerId||!row.visible))throw new Error('Relationship memory outside owner')
    return new Map(rows.map(row=>[row.id,row]))
  }
  private async ownerVersion(client:SqlClient,target:Owner):Promise<{revision:string;relationship_count:number}> {
    await client.query(`INSERT INTO kipster.memory_relationship_owner_versions(installation_id,owner_kind,owner_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,[this.installationId,target.kind,target.ownerId])
    return (await client.query<{revision:string;relationship_count:number}>(`SELECT revision,relationship_count FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 FOR UPDATE`,[this.installationId,target.kind,target.ownerId])).rows[0]!
  }
  private async changed(client:SqlClient,target:Owner,created:boolean):Promise<void> {await client.query(`UPDATE kipster.memory_relationship_owner_versions SET revision=revision+1,relationship_count=relationship_count+$4 WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3`,[this.installationId,target.kind,target.ownerId,created?1:0])}
  private async storeChange(client:SqlClient,edgeId:string,revision:number,operation:string,actorId:string,attemptId:string,shape:ReturnType<typeof edgeArgs>,active:boolean,memories:Map<string,Memory>):Promise<void> {
    await client.query(`INSERT INTO kipster.memory_relationship_changes(relationship_id,revision,operation,actor_id,attempt_id,kind,weight,active,from_revision,to_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[edgeId,revision,operation,actorId,attemptId,shape.kind,shape.weight,active,shape.fromRevision,shape.toRevision])
    for(const [index,item] of shape.evidence.entries()){
      const memory=memories.get(item.memoryId)!
      if(Number(memory.revision)!==item.revision)throw new Error('Relationship evidence revision conflict')
      if(item.provenanceId){const provenance=(await client.query<{memory_id:string}>('SELECT memory_id FROM kipster.memory_provenance WHERE id=$1',[item.provenanceId])).rows[0];if(provenance?.memory_id!==item.memoryId)throw new Error('Relationship provenance mismatch')}
      await client.query(`INSERT INTO kipster.memory_relationship_evidence(relationship_id,relationship_revision,ordinal,memory_id,memory_revision,source_hash,provenance_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,[edgeId,revision,index+1,item.memoryId,item.revision,memory.source_hash,item.provenanceId??null])
    }
  }
  private async currentEvidence(client:SqlClient,edgeId:string,revision:number):Promise<Evidence[]> {
    return (await client.query<{memory_id:string;memory_revision:string;provenance_id:string|null}>(`SELECT memory_id,memory_revision,provenance_id FROM kipster.memory_relationship_evidence WHERE relationship_id=$1 AND relationship_revision=$2 ORDER BY ordinal`,[edgeId,revision])).rows.map(row=>({memoryId:row.memory_id,revision:Number(row.memory_revision),...(row.provenance_id?{provenanceId:row.provenance_id}:{})}))
  }
  /** Evidence of a past revision, or null when it cites a memory not visible under the organization home rule. */
  private async historyEvidence(client:SqlClient,edgeId:string,revision:number,organizationId:string|null):Promise<Evidence[]|null> {
    const rows=(await client.query<{memory_id:string;memory_revision:string;provenance_id:string|null;visible:boolean}>(`SELECT e.memory_id,e.memory_revision,e.provenance_id,${homeSql('hm','$3')} AS visible FROM kipster.memory_relationship_evidence e JOIN kipster.memory_records hm ON hm.id=e.memory_id WHERE e.relationship_id=$1 AND e.relationship_revision=$2 ORDER BY e.ordinal`,[edgeId,revision,organizationId])).rows
    if(rows.some(row=>!row.visible))return null
    return rows.map(row=>({memoryId:row.memory_id,revision:Number(row.memory_revision),...(row.provenance_id?{provenanceId:row.provenance_id}:{})}))
  }
  private async view(client:SqlClient,target:Owner,organizationId:string|null,edgeId:string,historyAfter=0,historyLimit=10,historyRevision?:number):Promise<unknown> {
    const edge=(await client.query<Edge>(`SELECT * FROM kipster.memory_relationships WHERE id=$1 AND installation_id=$2 AND owner_kind=$3 AND owner_id=$4 AND ${edgeVisibleSql('$5')}`,[edgeId,this.installationId,target.kind,target.ownerId,organizationId])).rows[0]
    if(!edge)return null
    if(historyRevision!==undefined&&historyRevision!==edge.revision)throw new Error('Relationship history changed; restart pagination')
    const supports=(await client.query<{memory_id:string;memory_revision:string;source_hash:string;provenance_id:string|null;current_revision:string|null;current_hash:string|null}>(`SELECT e.memory_id,e.memory_revision,e.source_hash,e.provenance_id,m.revision AS current_revision,m.source_hash AS current_hash FROM kipster.memory_relationship_evidence e LEFT JOIN kipster.memory_records m ON m.id=e.memory_id AND m.installation_id=$3 AND m.scope=$4 AND m.owner_id=$5 WHERE e.relationship_id=$1 AND e.relationship_revision=$2 ORDER BY e.ordinal`,[edgeId,edge.revision,this.installationId,target.kind,target.ownerId])).rows
    const endpoints=(await client.query<{id:string;revision:string}>(`SELECT id,revision FROM kipster.memory_records WHERE id=ANY($1::uuid[]) AND installation_id=$2 AND scope=$3 AND owner_id=$4`,[[edge.from_id,edge.to_id],this.installationId,target.kind,target.ownerId])).rows
    const revisions=new Map(endpoints.map(row=>[row.id,Number(row.revision)]))
    const dangling=revisions.size!==2||supports.some(row=>row.current_revision===null)
    const stale=dangling||revisions.get(edge.from_id)!==Number(edge.from_revision)||revisions.get(edge.to_id)!==Number(edge.to_revision)||supports.some(row=>row.current_revision!==row.memory_revision||row.current_hash!==row.source_hash)
    const changes=(await client.query<{revision:number;operation:string;actor_id:string;attempt_id:string|null;kind:string;weight:number;active:boolean;from_revision:string;to_revision:string;created_at:string}>(`SELECT * FROM kipster.memory_relationship_changes WHERE relationship_id=$1 AND revision>$2 ORDER BY revision LIMIT $3`,[edgeId,historyAfter,historyLimit+1])).rows
    const page=changes.slice(0,historyLimit)
    const history=[]
    for(const change of page){
      // A revision that cited a memory homed elsewhere is left out entirely.
      const evidence=await this.historyEvidence(client,edgeId,change.revision,organizationId)
      if(evidence)history.push({...change,created_at:new Date(change.created_at).toISOString(),from_revision:Number(change.from_revision),to_revision:Number(change.to_revision),evidence})
    }
    return {id:edge.id,owner:target,fromId:edge.from_id,toId:edge.to_id,kind:edge.kind,weight:edge.weight,revision:edge.revision,active:edge.active,fromRevision:Number(edge.from_revision),toRevision:Number(edge.to_revision),stale,dangling,evidence:supports.map(row=>({memoryId:row.memory_id,revision:Number(row.memory_revision),sourceHash:row.source_hash,provenanceId:row.provenance_id,stale:row.current_revision!==row.memory_revision||row.current_hash!==row.source_hash})),history,nextHistoryAfter:changes.length>historyLimit?page.at(-1)!.revision:null}
  }
  private async write(client:SqlClient,name:string,input:Input,target:Owner,identity:Identity,attemptId:string):Promise<unknown> {
    const organizationId=contextOrganization(identity)
    const version=await this.ownerVersion(client,target)
    if(name==='memory.link'){
      const shape=edgeArgs(input)
      if(version.relationship_count>=2000)throw new Error('Relationship owner limit exceeded')
      const memories=await this.memories(client,target,organizationId,[shape.fromId,shape.toId,...shape.evidence.map(item=>item.memoryId)],true)
      if(Number(memories.get(shape.fromId)!.revision)!==shape.fromRevision||Number(memories.get(shape.toId)!.revision)!==shape.toRevision)throw new Error('Relationship endpoint revision conflict')
      const edgeId=randomUUID()
      await client.query(`INSERT INTO kipster.memory_relationships(id,installation_id,owner_kind,owner_id,from_id,to_id,kind,weight,from_revision,to_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[edgeId,this.installationId,target.kind,target.ownerId,shape.fromId,shape.toId,shape.kind,shape.weight,shape.fromRevision,shape.toRevision])
      await this.storeChange(client,edgeId,1,'link',identity.actor_id,attemptId,shape,true,memories)
      await this.changed(client,target,true)
      return {status:'completed',relationship:await this.view(client,target,organizationId,edgeId)}
    }
    const edgeId=id(input.relationshipId)
    const preliminary=(await client.query<Edge>(`SELECT * FROM kipster.memory_relationships WHERE id=$1 AND installation_id=$2 AND owner_kind=$3 AND owner_id=$4 AND ${edgeVisibleSql('$5')}`,[edgeId,this.installationId,target.kind,target.ownerId,organizationId])).rows[0]
    if(!preliminary)throw new Error('Relationship not found')
    const shape=name==='memory.relationship_update'?edgeArgs({...input,fromId:preliminary.from_id,toId:preliminary.to_id}):{fromId:preliminary.from_id,toId:preliminary.to_id,fromRevision:Number(preliminary.from_revision),toRevision:Number(preliminary.to_revision),kind:preliminary.kind,weight:preliminary.weight,evidence:await this.currentEvidence(client,edgeId,preliminary.revision)}
    const memories=name==='memory.relationship_update'?await this.memories(client,target,organizationId,[shape.fromId,shape.toId,...shape.evidence.map(item=>item.memoryId)],true):new Map<string,Memory>()
    const edge=(await client.query<Edge>(`SELECT * FROM kipster.memory_relationships WHERE id=$1 FOR UPDATE`,[edgeId])).rows[0]!
    if(!edge.active||edge.revision!==integer(input.expectedRevision)||edge.revision!==preliminary.revision)throw new Error('Relationship revision conflict')
    if(shape.fromId!==edge.from_id||shape.toId!==edge.to_id)throw new Error('Relationship direction change requires unlink and relink')
    if(name==='memory.relationship_update'){
      if(Number(memories.get(shape.fromId)!.revision)!==shape.fromRevision||Number(memories.get(shape.toId)!.revision)!==shape.toRevision)throw new Error('Relationship endpoint revision conflict')
      const duplicate=(await client.query(`SELECT 1 FROM kipster.memory_relationships WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 AND from_id=$4 AND to_id=$5 AND kind=$6 AND active=true AND id<>$7`,[this.installationId,target.kind,target.ownerId,shape.fromId,shape.toId,shape.kind,edgeId])).rows[0]
      if(duplicate)throw new Error('Relationship already active')
    }
    const next=edge.revision+1,active=name!=='memory.unlink'
    await client.query(`UPDATE kipster.memory_relationships SET kind=$2,weight=$3,revision=$4,active=$5,from_revision=$6,to_revision=$7,updated_at=now() WHERE id=$1`,[edgeId,shape.kind,shape.weight,next,active,shape.fromRevision,shape.toRevision])
    if(active)await this.storeChange(client,edgeId,next,'update',identity.actor_id,attemptId,shape,true,memories)
    else{
      await client.query(`INSERT INTO kipster.memory_relationship_changes(relationship_id,revision,operation,actor_id,attempt_id,kind,weight,active,from_revision,to_revision) VALUES ($1,$2,'unlink',$3,$4,$5,$6,false,$7,$8)`,[edgeId,next,identity.actor_id,attemptId,shape.kind,shape.weight,shape.fromRevision,shape.toRevision])
      await client.query(`INSERT INTO kipster.memory_relationship_evidence(relationship_id,relationship_revision,ordinal,memory_id,memory_revision,source_hash,provenance_id) SELECT relationship_id,$2,ordinal,memory_id,memory_revision,source_hash,provenance_id FROM kipster.memory_relationship_evidence WHERE relationship_id=$1 AND relationship_revision=$3`,[edgeId,next,edge.revision])
    }
    await client.query('DELETE FROM kipster.memory_relationship_evidence WHERE relationship_id=$1 AND relationship_revision<=$2',[edgeId,next-64])
    await client.query('DELETE FROM kipster.memory_relationship_changes WHERE relationship_id=$1 AND revision<=$2',[edgeId,next-64])
    await this.changed(client,target,false)
    return {status:'completed',relationship:await this.view(client,target,organizationId,edgeId)}
  }
  async invoke(attemptId:string,incarnation:string,callId:string,name:string,args:unknown):Promise<unknown> {
    id(attemptId);id(incarnation)
    if(!names.has(name)||typeof callId!=='string'||!callId||callId.length>200)throw new Error('Invalid relationship tool call')
    const input=object(args),target=owner(input.owner)
    const fields:Record<string,string[]>={
      'memory.link':['owner','fromId','toId','fromRevision','toRevision','kind','weight','evidence'],
      'memory.relationship_update':['owner','relationshipId','expectedRevision','fromRevision','toRevision','kind','weight','evidence'],
      'memory.unlink':['owner','relationshipId','expectedRevision'],
      'memory.relationship_get':['owner','relationshipId','historyAfter','historyLimit','historyRevision'],
      'memory.relationship_list':['owner','cursor','limit']}
    only(input,fields[name]!)
    if(Buffer.byteLength(canonical(input))>6000)throw new Error('Relationship request limit exceeded')
    if(name==='memory.link')edgeArgs(input)
    if(name!=='memory.link'&&name!=='memory.relationship_list')id(input.relationshipId)
    if(name==='memory.relationship_update'||name==='memory.unlink')integer(input.expectedRevision)
    if(input.historyAfter!==undefined)integer(input.historyAfter,0)
    if(input.historyLimit!==undefined)integer(input.historyLimit,1,20)
    if(input.historyRevision!==undefined)integer(input.historyRevision,1)
    if(input.historyAfter!==undefined&&Number(input.historyAfter)>0&&input.historyRevision===undefined)throw new Error('Relationship history revision required')
    if(input.limit!==undefined)integer(input.limit,1,20)
    const payloadHash=digest(canonical(input))
    if(writes.has(name))return this.db.transaction(async client=>{
      await client.query("SET LOCAL transaction_timeout='5s'")
      await client.query("SET LOCAL lock_timeout='1500ms'")
      const bound=(await client.query<Identity>(identitySql,[attemptId,this.installationId])).rows[0]
      if(!bound||bound.incarnation!==incarnation)throw new Error('Relationship attempt identity mismatch')
      const prior=(await client.query<{operation:string;arguments_hash:string;result:unknown}>(`SELECT operation,arguments_hash,result FROM kipster.memory_tool_receipts WHERE attempt_id=$1 AND call_id=$2`,[attemptId,callId])).rows[0]
      if(prior){if(prior.operation!==name||prior.arguments_hash!==payloadHash)throw new Error('Memory call identity conflict');return prior.result}
      const identity=await this.guard(client,attemptId,incarnation,target,true)
      const raced=(await client.query<{operation:string;arguments_hash:string;result:unknown}>(`SELECT operation,arguments_hash,result FROM kipster.memory_tool_receipts WHERE attempt_id=$1 AND call_id=$2`,[attemptId,callId])).rows[0]
      if(raced){if(raced.operation!==name||raced.arguments_hash!==payloadHash)throw new Error('Memory call identity conflict');return raced.result}
      const result=await this.write(client,name,input,target,identity,attemptId)
      await client.query(`INSERT INTO kipster.memory_tool_receipts(attempt_id,call_id,operation,arguments_hash,result) VALUES ($1,$2,$3,$4,$5::jsonb)`,[attemptId,callId,name,payloadHash,JSON.stringify(result)])
      return result
    })
    const result=await this.db.transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const organizationId=contextOrganization(await this.guard(client,attemptId,incarnation,target,false))
      if(name==='memory.relationship_get'){
        return this.view(client,target,organizationId,id(input.relationshipId),input.historyAfter===undefined?0:integer(input.historyAfter,0),input.historyLimit===undefined?10:integer(input.historyLimit,1,20),input.historyRevision===undefined?undefined:integer(input.historyRevision,1))
      }
      let last='00000000-0000-0000-0000-000000000000',revision:string|null=null
      if(input.cursor!==undefined){if(typeof input.cursor!=='string'||input.cursor.length>500)throw new Error('Invalid relationship cursor');try{const row=object(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));if(row.ownerKind!==target.kind||row.ownerId!==target.ownerId)throw new Error('Cursor owner mismatch');last=id(row.last);revision=String(row.revision)}catch{throw new Error('Invalid relationship cursor')}}
      const current=(await client.query<{revision:string}>(`SELECT revision FROM kipster.memory_relationship_owner_versions WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3`,[this.installationId,target.kind,target.ownerId])).rows[0]?.revision??'0'
      if(revision!==null&&revision!==current)throw new Error('Relationship list changed; restart pagination')
      const limit=input.limit===undefined?10:integer(input.limit,1,20)
      const rows=(await client.query<{id:string}>(`SELECT id FROM kipster.memory_relationships WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 AND id>$4 AND ${edgeVisibleSql('$6')} ORDER BY id LIMIT $5`,[this.installationId,target.kind,target.ownerId,last,limit+1,organizationId])).rows
      const page=rows.slice(0,limit),relationships=[]
      for(const row of page)relationships.push(await this.view(client,target,organizationId,row.id,0,1))
      const next=rows.length>limit?Buffer.from(JSON.stringify({ownerKind:target.kind,ownerId:target.ownerId,revision:current,last:page.at(-1)!.id})).toString('base64url'):null
      return {owner:target,revision:Number(current),relationships,nextCursor:next}
    })
    await this.db.transaction(client=>this.guard(client,attemptId,incarnation,target,false))
    return result
  }
}
