import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, realpath, link, rm, stat, unlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Home } from '../../platform/home/public.js'
import { isLive, type TrustedActor } from '../identity/public.js'
import { authorizedChat, messageRecord } from '../conversations/public.js'
import { publishThreadChange } from '../synchronization/public.js'
import type { Context, MessagePart } from '../../protocol/text.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha = /^[a-f0-9]{64}$/
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 10
export const MAX_MESSAGE_FILE_BYTES = 50 * 1024 * 1024
export const MAX_TOOL_WRITE_BYTES = 1024 * 1024
export const MAX_ATTEMPT_WRITE_BYTES = 5 * 1024 * 1024
export const MAX_ATTEMPT_OUTPUT_FILES = 32
export const MAX_ATTEMPT_PUBLICATIONS = 32
export interface ArtifactTarget { installationId: string; callerId: string; context: Context; chatId: string; threadId?: string }
export interface UploadIntent { uploadId: string; target: ArtifactTarget; name: string; mimeType: string; size: number; sha256: string; purpose: 'attachment' | 'voice_note' }
export interface ArtifactMetadata { id: string; name: string; mimeType: string; size: number; sha256: string; revision: number; availability: 'registered' | 'failed' | 'missing'; ownership: { kind: 'installation'|'organization'|'agent'; id: string }; provenance: { kind: 'upload'|'generated'|'published'; authorId: string }; sourceId?: string }
export interface ArtifactHooks { afterUploadLink?(id:string):Promise<void>; afterWriteLink?(id:string):Promise<void>; afterPublishLink?(id:string):Promise<void> }
interface ArtifactRow { id: string; installation_id: string; owner_kind: 'installation'|'organization'|'agent'; owner_id: string; source_id: string|null; provenance: 'upload'|'generated'|'published'; author_id: string; name: string; mime_type: string; size_bytes: string; sha256: string; state: 'staging'|'ready'|'failed'|'recovery-needed'; revision: string }
interface LiveAttempt { agent_id:string; thread_id:string; installation_id:string; caller_id:string; organization_id:string|null }
class ArtifactContentUnavailableError extends Error {}

function validIntent(intent: UploadIntent): void {
  if (!uuid.test(intent.uploadId) || !uuid.test(intent.target.installationId) || !uuid.test(intent.target.callerId) || !uuid.test(intent.target.chatId) || (intent.target.threadId && !uuid.test(intent.target.threadId))) throw new Error('Invalid upload identity')
  if (!intent.name || intent.name.length > 255 || /[\x00-\x1f]/.test(intent.name) || !intent.mimeType || intent.mimeType.length > 128 || !Number.isSafeInteger(intent.size) || intent.size < 0 || intent.size > MAX_UPLOAD_BYTES || !sha.test(intent.sha256)) throw new Error('Invalid upload metadata')
  if (!['attachment','voice_note'].includes(intent.purpose)) throw new Error('Invalid upload purpose')
}
function targetKey(target:ArtifactTarget):string{return JSON.stringify([target.installationId,target.callerId,target.context.kind,target.context.kind==='installation'?target.context.installationId:target.context.organizationId,target.chatId,target.threadId??null])}
function intentKey(intent:UploadIntent):string{return JSON.stringify([intent.uploadId,targetKey(intent.target),intent.name,intent.mimeType,intent.size,intent.sha256,intent.purpose])}
function metadata(row: ArtifactRow): ArtifactMetadata {
  return { id:row.id,name:row.name,mimeType:row.mime_type,size:Number(row.size_bytes),sha256:row.sha256,revision:Number(row.revision),availability:row.state==='ready'?'registered':row.state==='failed'?'failed':'missing',ownership:{kind:row.owner_kind,id:row.owner_id},provenance:{kind:row.provenance,authorId:row.author_id},...(row.source_id?{sourceId:row.source_id}:{}) }
}
async function directory(path: string, base: string): Promise<void> {
  if(path!==base&&!within(base,path))throw new Error('Unsafe managed directory')
  const parent=dirname(path)
  if(path!==base)await directory(parent,base)
  try{await mkdir(path,{mode:0o700})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
  const info=await lstat(path)
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Unsafe managed directory')
}
async function syncDirectory(path: string): Promise<void> {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{await handle.sync()}finally{await handle.close()}
}
function within(base: string, path: string): boolean { const rel=relative(base,path);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel) }
async function managedFile(path: string, base: string): Promise<Buffer> {
  if(!within(base,path)||resolve(path)!==path)throw new Error('Invalid managed path')
  const actual=await realpath(path),canonicalBase=await realpath(base)
  if(!within(canonicalBase,actual))throw new Error('Unsafe managed path')
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
    const before=await handle.stat(),atPath=await stat(path)
    if(!before.isFile()||before.nlink!==1||before.size>MAX_UPLOAD_BYTES||before.ino!==atPath.ino||before.dev!==atPath.dev)throw new Error('Unsafe managed file')
    const bytes=await handle.readFile()
    const after=await handle.stat()
    if(after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Managed file changed during read')
    return bytes
  }finally{await handle.close()}
}

export class ArtifactService {
  private readonly root: string
  private readonly objects: string
  private readonly staging: string
  private recoveryTimer: ReturnType<typeof setInterval>|null=null
  private recovering: Promise<void>|null=null
  constructor(readonly db: Postgres, readonly home: Home,private readonly hooks:ArtifactHooks={}) {
    this.root=join(home.root,'artifacts');this.objects=join(this.root,'objects');this.staging=join(this.root,'staging')
  }
  private object(id: string): string { if(!uuid.test(id))throw new Error('Invalid artifact identity');return join(this.objects,id) }
  private stage(id: string,token: string): string { if(!uuid.test(id)||!uuid.test(token))throw new Error('Invalid staging identity');return join(this.staging,`${id}.${token}`) }
  private output(agentId:string,threadId:string,attemptId:string,outputId:string):string{return join(this.home.output(agentId,threadId,attemptId),outputId)}
  /** The attempt still runs and its agent, and organization, are live. Owners are locked before the attempt and run rows. */
  private async liveAttempt(client:SqlClient,attemptId:string,incarnation:string):Promise<LiveAttempt>{
    if(!uuid.test(attemptId)||!uuid.test(incarnation))throw new Error('Invalid attempt identity')
    const sql=`SELECT COALESCE(d.recipient_agent_id,c.agent_id) AS agent_id,r.thread_id,c.installation_id,c.caller_id,CASE WHEN c.context_kind='organization' THEN c.context_id ELSE NULL END AS organization_id
      FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
      WHERE a.id=$1 AND a.incarnation=$2 AND a.state='issued' AND r.current_attempt_id=a.id AND r.state='running' AND r.stop_requested=false`
    const owners=(await client.query<LiveAttempt>(sql,[attemptId,incarnation])).rows[0]
    if(!owners)throw new Error('Attempt is not live')
    if(!await isLive(client,owners.installation_id,'agent',owners.agent_id)||owners.organization_id&&!await isLive(client,owners.installation_id,'organization',owners.organization_id))throw new Error('Attempt owner is not live')
    const row=(await client.query<LiveAttempt>(`${sql} FOR UPDATE OF a,r`,[attemptId,incarnation])).rows[0]
    if(!row)throw new Error('Attempt is not live')
    return row
  }
  async writeOutput(attemptId:string,incarnation:string,callId:string,name:string,content:string):Promise<{status:'completed';outputId:string;name:string;size:number;sha256:string}> {
    if(!callId||callId.length>200||!name||name.length>128||!(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))||name==='.'||name==='..'||typeof content!=='string')throw new Error('Invalid artifact write arguments')
    const bytes=Buffer.from(content,'utf8')
    if(bytes.length>MAX_TOOL_WRITE_BYTES)throw new Error('Invalid artifact write size')
    const contentHash=createHash('sha256').update(bytes).digest('hex'),requestHash=createHash('sha256').update(JSON.stringify([name,content])).digest('hex')
    const claim=await this.db.transaction(async client=>{
      const attempt=await this.liveAttempt(client,attemptId,incarnation)
      const prior=(await client.query<{id:string;name:string;size_bytes:string;sha256:string;request_sha256:string;state:string}>('SELECT * FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if(prior){if(prior.request_sha256!==requestHash)throw new Error('Artifact write replay conflict');if(prior.state==='ready')return {status:'ready' as const,id:prior.id,attempt};throw new Error('Artifact write pending or failed')}
      const count=(await client.query<{count:number}>('SELECT count(*)::int AS count FROM kipster.artifact_output_writes WHERE attempt_id=$1',[attemptId])).rows[0]!.count
      if(count>=MAX_ATTEMPT_OUTPUT_FILES)throw new Error('Attempt output count exceeded')
      const usage=(await client.query<{total:string}>("SELECT coalesce(sum(size_bytes),0)::text AS total FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND state IN ('staging','ready')",[attemptId])).rows[0]!
      if(Number(usage.total)+bytes.length>MAX_ATTEMPT_WRITE_BYTES)throw new Error('Attempt output quota exceeded')
      const id=randomUUID()
      await client.query('INSERT INTO kipster.artifact_output_writes(id,attempt_id,call_id,name,request_sha256,size_bytes,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[id,attemptId,callId,name,requestHash,bytes.length,contentHash,'staging'])
      return {status:'claimed' as const,id,attempt}
    })
    if(claim.status==='ready')return {status:'completed',outputId:claim.id,name,size:bytes.length,sha256:contentHash}
    const dir=this.home.output(claim.attempt.agent_id,claim.attempt.thread_id,attemptId),path=this.output(claim.attempt.agent_id,claim.attempt.thread_id,attemptId,claim.id),staged=path+'.tmp'
    try{
      await directory(dir,this.home.root)
      const handle=await open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
      try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
      await link(staged,path);await syncDirectory(dir);await unlink(staged)
      await this.hooks.afterWriteLink?.(claim.id)
      await this.db.transaction(async client=>{await this.liveAttempt(client,attemptId,incarnation);await client.query("UPDATE kipster.artifact_output_writes SET state='ready' WHERE id=$1 AND state='staging'",[claim.id])})
      return {status:'completed',outputId:claim.id,name,size:bytes.length,sha256:contentHash}
    }catch(error){const failed=await this.db.query("UPDATE kipster.artifact_output_writes SET state='failed' WHERE id=$1 AND state='staging'",[claim.id]).then(result=>!!result.rowCount).catch(()=>false);await rm(staged,{force:true}).catch(()=>undefined);if(failed)await rm(path,{force:true}).catch(()=>undefined);throw error}
  }
  async publishOutput(attemptId:string,incarnation:string,callId:string,outputId:string):Promise<{status:'completed';artifact:ArtifactMetadata}> {
    if(!callId||callId.length>200||!uuid.test(outputId))throw new Error('Invalid artifact publication arguments')
    const requestHash=createHash('sha256').update(outputId).digest('hex')
    const claim=await this.db.transaction(async client=>{
      const attempt=await this.liveAttempt(client,attemptId,incarnation)
      const prior=(await client.query<{artifact_id:string;request_sha256:string;state:string}>('SELECT * FROM kipster.artifact_publications WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if(prior){if(prior.request_sha256!==requestHash)throw new Error('Artifact publication replay conflict');if(prior.state==='ready')return {status:'ready' as const,id:prior.artifact_id,attempt};throw new Error('Artifact publication pending or failed')}
      await this.publicationCapacity(client,attemptId)
      const written=(await client.query<{id:string;name:string;size_bytes:string;sha256:string;state:string}>('SELECT * FROM kipster.artifact_output_writes WHERE id=$1 AND attempt_id=$2',[outputId,attemptId])).rows[0]
      if(!written||written.state!=='ready')throw new Error('Output file unavailable')
      const id=randomUUID(),mimeType='text/plain; charset=utf-8'
      await client.query('INSERT INTO kipster.artifacts(id,installation_id,owner_kind,owner_id,provenance,author_id,name,mime_type,size_bytes,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,attempt.installation_id,'agent',attempt.agent_id,'generated',attempt.agent_id,written.name,mimeType,written.size_bytes,written.sha256,'staging'])
      await client.query('INSERT INTO kipster.artifact_publications(attempt_id,call_id,input_id,request_sha256,artifact_id,state) VALUES ($1,$2,$3,$4,$5,$6)',[attemptId,callId,outputId,requestHash,id,'staging'])
      return {status:'claimed' as const,id,attempt,written}
    })
    if(claim.status==='ready')return {status:'completed',artifact:metadata((await this.db.query<ArtifactRow>('SELECT * FROM kipster.artifacts WHERE id=$1',[claim.id])).rows[0]!)}
    const source=this.output(claim.attempt.agent_id,claim.attempt.thread_id,attemptId,outputId),destination=this.object(claim.id),staged=this.stage(claim.id,randomUUID())
    try{
      const bytes=await managedFile(source,this.home.output(claim.attempt.agent_id,claim.attempt.thread_id,attemptId))
      if(bytes.length!==Number(claim.written.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==claim.written.sha256)throw new Error('Output file integrity changed')
      const handle=await open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
      try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
      await link(staged,destination);await syncDirectory(this.objects);await unlink(staged)
      await this.hooks.afterPublishLink?.(claim.id)
      return await this.db.transaction(async client=>{await this.liveAttempt(client,attemptId,incarnation);await client.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1 AND state='staging'",[claim.id]);await client.query("UPDATE kipster.artifact_publications SET state='ready' WHERE attempt_id=$1 AND call_id=$2 AND state='staging'",[attemptId,callId]);return {status:'completed' as const,artifact:metadata(await this.row(client,claim.id))}})
    }catch(error){const failed=await this.db.transaction(async client=>{const changed=await client.query("UPDATE kipster.artifacts SET state='failed',failure=$2 WHERE id=$1 AND state='staging'",[claim.id,error instanceof Error?error.message:'Publication failed']);await client.query("UPDATE kipster.artifact_publications SET state='failed' WHERE attempt_id=$1 AND call_id=$2 AND state='staging'",[attemptId,callId]);return !!changed.rowCount}).catch(()=>false);await rm(staged,{force:true}).catch(()=>undefined);if(failed)await rm(destination,{force:true}).catch(()=>undefined);throw error}
  }
  async copyToOrganization(attemptId:string,incarnation:string,callId:string,sourceId:string):Promise<{status:'completed';artifact:ArtifactMetadata}> {
    if(!callId||callId.length>200||!uuid.test(sourceId))throw new Error('Invalid organization publication arguments')
    const claim=await this.db.transaction(async client=>{
      const attempt=await this.liveAttempt(client,attemptId,incarnation)
      if(!attempt.organization_id)throw new Error('Organization publication requires organization context')
      const prior=(await client.query<{artifact_id:string;source_id:string;state:string}>('SELECT * FROM kipster.artifact_organization_copies WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if(prior){if(prior.source_id!==sourceId)throw new Error('Organization publication replay conflict');if(prior.state==='ready')return {status:'ready' as const,id:prior.artifact_id};throw new Error('Organization publication pending or failed')}
      await this.publicationCapacity(client,attemptId)
      const source=await this.row(client,sourceId)
      if(source.installation_id!==attempt.installation_id||source.owner_kind!=='agent'||source.owner_id!==attempt.agent_id||source.state!=='ready')throw new Error('Source artifact unavailable')
      const id=randomUUID()
      await client.query('INSERT INTO kipster.artifacts(id,installation_id,owner_kind,owner_id,source_id,provenance,author_id,name,mime_type,size_bytes,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[id,attempt.installation_id,'organization',attempt.organization_id,sourceId,'published',attempt.agent_id,source.name,source.mime_type,source.size_bytes,source.sha256,'staging'])
      await client.query('INSERT INTO kipster.artifact_organization_copies(attempt_id,call_id,source_id,organization_id,artifact_id,state) VALUES ($1,$2,$3,$4,$5,$6)',[attemptId,callId,sourceId,attempt.organization_id,id,'staging'])
      return {status:'claimed' as const,id,source}
    })
    if(claim.status==='ready')return {status:'completed',artifact:metadata((await this.db.query<ArtifactRow>('SELECT * FROM kipster.artifacts WHERE id=$1',[claim.id])).rows[0]!)}
    const staged=this.stage(claim.id,randomUUID()),destination=this.object(claim.id)
    try{
      const bytes=await managedFile(this.object(sourceId),this.objects)
      if(bytes.length!==Number(claim.source.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==claim.source.sha256)throw new Error('Source artifact integrity changed')
      const handle=await open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
      try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
      await link(staged,destination);await syncDirectory(this.objects);await unlink(staged)
      await this.hooks.afterPublishLink?.(claim.id)
      return await this.db.transaction(async client=>{await this.liveAttempt(client,attemptId,incarnation);await client.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1 AND state='staging'",[claim.id]);await client.query("UPDATE kipster.artifact_organization_copies SET state='ready' WHERE attempt_id=$1 AND call_id=$2 AND state='staging'",[attemptId,callId]);return {status:'completed' as const,artifact:metadata(await this.row(client,claim.id))}})
    }catch(error){const failed=await this.db.transaction(async client=>{const changed=await client.query("UPDATE kipster.artifacts SET state='failed',failure=$2 WHERE id=$1 AND state='staging'",[claim.id,error instanceof Error?error.message:'Organization publication failed']);await client.query("UPDATE kipster.artifact_organization_copies SET state='failed' WHERE attempt_id=$1 AND call_id=$2 AND state='staging'",[attemptId,callId]);return !!changed.rowCount}).catch(()=>false);await rm(staged,{force:true}).catch(()=>undefined);if(failed)await rm(destination,{force:true}).catch(()=>undefined);throw error}
  }
  private async publicationCapacity(client:SqlClient,attemptId:string):Promise<void>{
    const count=(await client.query<{count:number}>("SELECT ((SELECT count(*) FROM kipster.artifact_publications WHERE attempt_id=$1)+(SELECT count(*) FROM kipster.artifact_organization_copies WHERE attempt_id=$1))::int AS count",[attemptId])).rows[0]!.count
    if(count>=MAX_ATTEMPT_PUBLICATIONS)throw new Error('Attempt publication count exceeded')
  }
  /**
   * Copies a ready file into an organization as an independent organization-owned file with the given
   * ID, in the caller's transaction. Bytes are linked before the row, so a repeat with the same ID
   * finishes the copy. A source whose bytes are unavailable is recorded as a failed copy. Returns
   * whether the copy is ready.
   */
  async copyIntoOrganization(client:SqlClient,sourceId:string,organizationId:string,copyId:string):Promise<boolean>{
    const source=await this.row(client,sourceId),destination=this.object(copyId)
    // The destination may have begun deletion since the batch selected it. Hold its liveness
    // lock through the copy commit so organization cleanup cannot finish before these bytes exist.
    if(!await isLive(client,source.installation_id,'organization',organizationId))return false
    const insert=(state:'ready'|'failed',failure:string|null)=>client.query('INSERT INTO kipster.artifacts(id,installation_id,owner_kind,owner_id,source_id,provenance,author_id,name,mime_type,size_bytes,sha256,state,failure) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING',[copyId,source.installation_id,'organization',organizationId,sourceId,'published',source.author_id,source.name,source.mime_type,source.size_bytes,source.sha256,state,failure])
    let bytes:Buffer
    try{bytes=await managedFile(this.object(sourceId),this.objects);if(bytes.length!==Number(source.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==source.sha256)throw new Error('Content mismatch')}
    catch{await insert('failed','Managed bytes unavailable');return false}
    const staged=this.stage(copyId,randomUUID())
    try{
      const handle=await open(staged,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
      try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
      try{await link(staged,destination)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const saved=await managedFile(destination,this.objects);if(createHash('sha256').update(saved).digest('hex')!==source.sha256)throw new Error('Conflicting copied bytes')}
      await syncDirectory(this.objects)
    }finally{await rm(staged,{force:true})}
    await insert('ready',null)
    return true
  }

  /**
   * Deletes up to `limit` files of an owner, bytes first and then rows, and returns how many it
   * deleted. A message that still shows one of them, outside the chats removed with the owner, gets
   * the file's copy in the message's organization when there is one, and otherwise a `removed` part;
   * the change is published to its thread. Caller holds the capacity lock.
   */
  async removeOwnedFiles(client:SqlClient,installationId:string,owner:{kind:'agent'|'organization';id:string},limit:number):Promise<number>{
    const files=(await client.query<{id:string}>('SELECT id FROM kipster.artifacts WHERE installation_id=$1 AND owner_kind=$2 AND owner_id=$3 ORDER BY id LIMIT $4',[installationId,owner.kind,owner.id,limit])).rows.map(row=>row.id)
    if(!files.length)return 0
    const shown=(await client.query<{message_id:string;thread_id:string;chat_id:string;caller_id:string;organization_id:string|null}>(`SELECT DISTINCT ma.message_id,m.thread_id,t.chat_id,c.caller_id,CASE WHEN c.context_kind='organization' THEN c.context_id END AS organization_id
      FROM kipster.message_artifacts ma JOIN kipster.messages m ON m.id=ma.message_id JOIN kipster.threads t ON t.id=m.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id
      WHERE ma.artifact_id=ANY($1::uuid[]) ORDER BY m.thread_id,ma.message_id`,[files])).rows
    if(shown.length)await client.query('SELECT 1 FROM kipster.threads WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[...new Set(shown.map(row=>row.thread_id))]])
    for(const message of shown){
      const current=(await client.query<{parts:MessagePart[]}>('SELECT parts FROM kipster.messages WHERE id=$1',[message.message_id])).rows[0]!
      const parts:MessagePart[]=[]
      for(const part of current.parts){
        if(part.kind!=='file'||!files.includes(part.artifactId)){parts.push(part);continue}
        const copy=message.organization_id?(await client.query<{id:string}>("SELECT id FROM kipster.artifacts WHERE source_id=$1 AND owner_kind='organization' AND owner_id=$2 AND state='ready' ORDER BY created_at,id LIMIT 1",[part.artifactId,message.organization_id])).rows[0]:undefined
        parts.push(copy?{...part,artifactId:copy.id}:{kind:'removed',artifactId:part.artifactId})
        if(copy)await client.query('UPDATE kipster.message_artifacts SET artifact_id=$3 WHERE message_id=$1 AND artifact_id=$2',[message.message_id,part.artifactId,copy.id])
        else await client.query('DELETE FROM kipster.message_artifacts WHERE message_id=$1 AND artifact_id=$2',[message.message_id,part.artifactId])
      }
      const revision=Number((await client.query<{revision:string}>('UPDATE kipster.messages SET parts=$2::jsonb,revision=revision+1 WHERE id=$1 RETURNING revision',[message.message_id,JSON.stringify(parts)])).rows[0]!.revision)
      const state=(await client.query<{state:string}>('SELECT state FROM kipster.text_runs WHERE thread_id=$1 ORDER BY queue_position DESC LIMIT 1',[message.thread_id])).rows[0]?.state??'completed'
      await publishThreadChange(client,installationId,message.caller_id,message.thread_id,message.chat_id,'message-final',message.message_id,revision,await messageRecord(client,message.message_id),state,null)
    }
    for(const id of files)await rm(this.object(id),{force:true})
    for(const name of await readdir(this.staging))if(files.includes(name.slice(0,36))&&name[36]==='.')await rm(join(this.staging,name),{force:true})
    await client.query('DELETE FROM kipster.voice_preparations WHERE artifact_id=ANY($1::uuid[])',[files])
    await client.query('DELETE FROM kipster.voice_tool_calls WHERE artifact_id=ANY($1::uuid[])',[files])
    await client.query('DELETE FROM kipster.artifacts WHERE id=ANY($1::uuid[])',[files])
    return files.length
  }
  async initialize(): Promise<void> { await directory(this.objects,this.home.root);await directory(this.staging,this.home.root);await this.recover() }
  startRecovery():void {if(this.recoveryTimer)return;this.recoveryTimer=setInterval(()=>{if(!this.recovering)this.recovering=this.recoverExpiredUploads().catch(()=>undefined).finally(()=>{this.recovering=null})},30000);this.recoveryTimer.unref()}
  async stopRecovery():Promise<void>{if(this.recoveryTimer){clearInterval(this.recoveryTimer);this.recoveryTimer=null}await this.recovering}
  private async authorize(client: SqlClient, actor: TrustedActor, target: ArtifactTarget, internal=false): Promise<void> {
    if(target.installationId!==actor.installationId||target.callerId!==actor.personId)throw new Error('Caller scope mismatch')
    await authorizedChat(client,actor,target.context,target.chatId)
    if(target.threadId){const found=await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 AND chat_id=$2 AND (internal=false OR $3=true)',[target.threadId,target.chatId,internal]);if(!found.rows.length)throw new Error('Thread not found in chat')}
  }
  async authorizeTarget(client: SqlClient, actor: TrustedActor, target: ArtifactTarget): Promise<void> { await this.authorize(client,actor,target) }
  /** An upload into an organization needs the organization live until the upload row commits. */
  private async liveUploadOwner(client: SqlClient, actor: TrustedActor, target: ArtifactTarget): Promise<void> {
    if(target.context.kind==='organization'&&!await isLive(client,actor.installationId,'organization',target.context.organizationId))throw new Error('Organization access denied')
  }
  private async row(client: SqlClient,id: string): Promise<ArtifactRow> { const found=(await client.query<ArtifactRow>('SELECT * FROM kipster.artifacts WHERE id=$1',[id])).rows[0];if(!found)throw new Error('Artifact not found');return found }
  private async verifyReady(record:ArtifactMetadata):Promise<void>{
    if(record.availability!=='registered')throw new ArtifactContentUnavailableError('Artifact content recovery needed')
    try{const bytes=await managedFile(this.object(record.id),this.objects);if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error('Content mismatch')}
    catch{await this.db.query("UPDATE kipster.artifacts SET state='recovery-needed',failure='Managed bytes unavailable' WHERE id=$1 AND state='ready'",[record.id]);throw new ArtifactContentUnavailableError('Artifact content recovery needed')}
  }
  async authorizedArtifact(client: SqlClient,actor: TrustedActor,context: Context,id: string): Promise<ArtifactRow> {
    const row=await this.row(client,id)
    if(row.installation_id!==actor.installationId||row.state!=='ready')throw new Error('Artifact unavailable')
    if(row.owner_kind==='organization'&&(context.kind!=='organization'||context.organizationId!==row.owner_id))throw new Error('Artifact access denied')
    if(row.owner_kind==='installation'&&(context.kind!=='installation'||context.installationId!==row.owner_id))throw new Error('Artifact access denied')
    if(row.owner_kind==='agent')throw new Error('Artifact access denied')
    return row
  }
  async upload(actor: TrustedActor,intent: UploadIntent,bytes: AsyncIterable<Uint8Array>): Promise<{status:'accepted';intent:UploadIntent;artifact:ArtifactMetadata}|{status:'unknown';uploadId:string}> {
    validIntent(intent)
    const claim=await this.db.transaction(async client=>{
      await this.authorize(client,actor,intent.target)
      await this.liveUploadOwner(client,actor,intent.target)
      const existing=(await client.query<{artifact_id:string;intent:UploadIntent;state:string;claim_expires_at:Date|null}>('SELECT artifact_id,intent,state,claim_expires_at FROM kipster.artifact_uploads WHERE installation_id=$1 AND caller_id=$2 AND upload_id=$3 FOR UPDATE',[actor.installationId,actor.personId,intent.uploadId])).rows[0]
      if(existing){
        if(intentKey(existing.intent)!==intentKey(intent))throw new Error('Upload intent conflict')
        if(existing.state==='ready')return {status:'ready' as const,id:existing.artifact_id}
        if(existing.state==='staging'&&existing.claim_expires_at&&new Date(existing.claim_expires_at).getTime()>Date.now())return {status:'busy' as const,id:existing.artifact_id}
        const id=randomUUID(),token=randomUUID(),ownerKind=intent.target.context.kind,ownerId=ownerKind==='installation'?intent.target.context.installationId:intent.target.context.organizationId
        await client.query("UPDATE kipster.artifacts SET state='failed',failure='Superseded upload claim' WHERE id=$1 AND state='staging'",[existing.artifact_id])
        await client.query('INSERT INTO kipster.artifacts(id,installation_id,owner_kind,owner_id,provenance,author_id,name,mime_type,size_bytes,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,actor.installationId,ownerKind,ownerId,'upload',actor.personId,intent.name,intent.mimeType,intent.size,intent.sha256,'staging'])
        await client.query("UPDATE kipster.artifact_uploads SET artifact_id=$4,state='staging',claim_token=$5,claim_expires_at=now()+interval '10 minutes' WHERE installation_id=$1 AND caller_id=$2 AND upload_id=$3",[actor.installationId,actor.personId,intent.uploadId,id,token])
        return {status:'claimed' as const,id,token}
      }
      const id=randomUUID(),token=randomUUID(),ownerKind=intent.target.context.kind,ownerId=ownerKind==='installation'?intent.target.context.installationId:intent.target.context.organizationId
      await client.query('INSERT INTO kipster.artifacts(id,installation_id,owner_kind,owner_id,provenance,author_id,name,mime_type,size_bytes,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,actor.installationId,ownerKind,ownerId,'upload',actor.personId,intent.name,intent.mimeType,intent.size,intent.sha256,'staging'])
      await client.query("INSERT INTO kipster.artifact_uploads(installation_id,caller_id,upload_id,artifact_id,intent,state,claim_token,claim_expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,now()+interval '10 minutes')",[actor.installationId,actor.personId,intent.uploadId,id,JSON.stringify(intent),'staging',token])
      return {status:'claimed' as const,id,token}
    })
    if(claim.status==='busy')return {status:'unknown',uploadId:intent.uploadId}
    if(claim.status==='ready'){const artifact=metadata((await this.db.query<ArtifactRow>('SELECT * FROM kipster.artifacts WHERE id=$1',[claim.id])).rows[0]!);await this.verifyReady(artifact);return {status:'accepted',intent,artifact}}
    const path=this.stage(claim.id,claim.token),destination=this.object(claim.id)
    try{
      const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
      let length=0;const digest=createHash('sha256')
      try{for await(const chunk of bytes){length+=chunk.length;if(length>intent.size||length>MAX_UPLOAD_BYTES)throw new Error('Invalid upload size');digest.update(chunk);await handle.writeFile(chunk)}await handle.sync()}finally{await handle.close()}
      if(length!==intent.size||digest.digest('hex')!==intent.sha256)throw new Error('Invalid upload integrity')
      const live=(await this.db.query<{claim_token:string;state:string}>("SELECT claim_token,state FROM kipster.artifact_uploads WHERE artifact_id=$1",[claim.id])).rows[0]
      if(live?.claim_token!==claim.token||live.state!=='staging')throw new Error('Upload claim expired')
      try{await link(path,destination)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const saved=await managedFile(destination,this.objects);if(saved.length!==intent.size||createHash('sha256').update(saved).digest('hex')!==intent.sha256)throw new Error('Conflicting published bytes')}
      await syncDirectory(this.objects)
      await unlink(path)
      await this.hooks.afterUploadLink?.(claim.id)
      return await this.db.transaction(async client=>{
        await this.liveUploadOwner(client,actor,intent.target)
        const lock=(await client.query<{state:string;claim_token:string}>('SELECT state,claim_token FROM kipster.artifact_uploads WHERE installation_id=$1 AND caller_id=$2 AND upload_id=$3 FOR UPDATE',[actor.installationId,actor.personId,intent.uploadId])).rows[0]
        if(lock?.state!=='staging'||lock.claim_token!==claim.token)throw new Error('Upload claim expired')
        await client.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1",[claim.id])
        await client.query("UPDATE kipster.artifact_uploads SET state='ready',claim_token=NULL,claim_expires_at=NULL WHERE installation_id=$1 AND caller_id=$2 AND upload_id=$3",[actor.installationId,actor.personId,intent.uploadId])
        return {status:'accepted' as const,intent,artifact:metadata(await this.row(client,claim.id))}
      })
    }catch(error){const failed=await this.db.transaction(async client=>{const changed=await client.query("UPDATE kipster.artifact_uploads SET state='failed',claim_token=NULL,claim_expires_at=NULL WHERE artifact_id=$1 AND state='staging' AND claim_token=$2",[claim.id,claim.token]);if(changed.rowCount)await client.query("UPDATE kipster.artifacts SET state='failed',failure=$2 WHERE id=$1 AND state='staging'",[claim.id,error instanceof Error?error.message:'Upload failed']);return !!changed.rowCount}).catch(()=>false);await rm(path,{force:true}).catch(()=>undefined);if(failed)await rm(destination,{force:true}).catch(()=>undefined);throw error}
  }
  async uploadReceipt(actor:TrustedActor,uploadId:string,target:ArtifactTarget):Promise<{status:'accepted';intent:UploadIntent;artifact:ArtifactMetadata}|{status:'unknown';uploadId:string}> {
    if(!uuid.test(uploadId))throw new Error('Invalid upload identity')
    await this.recoverExpiredUploads()
    const receipt=await this.db.transaction(async client=>{await this.authorize(client,actor,target);const found=(await client.query<{intent:UploadIntent;artifact_id:string;state:string}>('SELECT intent,artifact_id,state FROM kipster.artifact_uploads WHERE installation_id=$1 AND caller_id=$2 AND upload_id=$3',[actor.installationId,actor.personId,uploadId])).rows[0];if(!found||found.state!=='ready')return {status:'unknown' as const,uploadId};if(targetKey(found.intent.target)!==targetKey(target))throw new Error('Upload target mismatch');return {status:'accepted' as const,intent:found.intent,artifact:metadata(await this.row(client,found.artifact_id))}})
    if(receipt.status==='accepted')await this.verifyReady(receipt.artifact)
    return receipt
  }
  private async scopedRecord(client:SqlClient,actor:TrustedActor,id:string,target:ArtifactTarget,internal=false):Promise<ArtifactRow>{
    await this.authorize(client,actor,target,internal)
    const row=await this.row(client,id)
    if(row.installation_id!==actor.installationId)throw new Error('Artifact access denied')
    if(row.owner_kind==='agent'){
      const associated=await client.query(`SELECT 1 FROM kipster.message_artifacts ma JOIN kipster.messages m ON m.id=ma.message_id JOIN kipster.threads t ON t.id=m.thread_id WHERE ma.artifact_id=$1 AND t.chat_id=$2 AND ($3::uuid IS NULL OR t.id=$3) AND (t.internal=false OR $4=true) LIMIT 1`,[id,target.chatId,target.threadId??null,internal])
      if(!associated.rows.length)throw new Error('Artifact access denied')
    }else if(row.owner_kind==='organization'&&(target.context.kind!=='organization'||target.context.organizationId!==row.owner_id))throw new Error('Artifact access denied')
    else if(row.owner_kind==='installation'&&(target.context.kind!=='installation'||target.context.installationId!==row.owner_id))throw new Error('Artifact access denied')
    return row
  }
  async get(actor:TrustedActor,id:string,target:ArtifactTarget):Promise<ArtifactMetadata> {
    const row=await this.db.transaction(client=>this.scopedRecord(client,actor,id,target))
    if(row.state!=='ready')throw new Error('Artifact unavailable')
    const record=metadata(row)
    await this.verifyReady(record)
    return record
  }
  async content(actor:TrustedActor,id:string,target:ArtifactTarget):Promise<{metadata:ArtifactMetadata;bytes:Buffer}> {
    const record=await this.get(actor,id,target)
    const bytes=await managedFile(this.object(id),this.objects)
    if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error('Artifact content recovery needed')
    return {metadata:record,bytes}
  }
  /** A ready artifact of the installation for a caller that authorized access itself, such as a document that references it. */
  async referenced(installationId:string,id:string):Promise<{metadata:ArtifactMetadata;bytes:Buffer}> {
    if(!uuid.test(id))throw new Error('Artifact not found')
    const row=await this.db.transaction(client=>this.row(client,id))
    if(row.installation_id!==installationId)throw new Error('Artifact not found')
    if(row.state!=='ready')throw new Error('Artifact unavailable')
    const record=metadata(row)
    await this.verifyReady(record)
    const bytes=await managedFile(this.object(id),this.objects)
    if(bytes.length!==record.size||createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw new Error('Artifact content recovery needed')
    return {metadata:record,bytes}
  }
  async inputForExecution(actor:TrustedActor,id:string,target:ArtifactTarget):Promise<{artifactId:string;name:string;mimeType:string;size:number;availability:'available';readablePath:string}|{artifactId:string;name:string;mimeType:string;size:number;availability:'unavailable'}> {
    const row=await this.db.transaction(client=>this.scopedRecord(client,actor,id,target,true))
    const file=metadata(row),details={artifactId:id,name:file.name,mimeType:file.mimeType,size:file.size}
    if(row.state!=='ready')return {...details,availability:'unavailable'}
    try{await this.verifyReady(file)}catch(error){if(error instanceof ArtifactContentUnavailableError)return {...details,availability:'unavailable'};throw error}
    return {...details,availability:'available',readablePath:this.object(id)}
  }
  async outputDirectory(agentId:string,threadId:string,attemptId:string):Promise<string> {const path=this.home.output(agentId,threadId,attemptId);await directory(path,this.home.root);return path}
  private async recoverExpiredUploads():Promise<void> {
    // Uploads of an organization that is not live are left for its deletion.
    const pending=(await this.db.query<ArtifactRow>("SELECT a.* FROM kipster.artifacts a JOIN kipster.artifact_uploads u ON u.artifact_id=a.id WHERE a.state='staging' AND a.provenance='upload' AND (u.claim_expires_at IS NULL OR u.claim_expires_at < now()) AND (a.owner_kind<>'organization' OR kipster.live_organization(a.owner_id))")).rows
    for(const row of pending){
      try{const bytes=await managedFile(this.object(row.id),this.objects);if(bytes.length!==Number(row.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('Invalid staged artifact');await this.db.transaction(async client=>{if(row.owner_kind==='organization'&&!await isLive(client,row.installation_id,'organization',row.owner_id))return;const settled=await client.query("UPDATE kipster.artifact_uploads SET state='ready',claim_token=NULL,claim_expires_at=NULL WHERE artifact_id=$1 AND state='staging' AND (claim_expires_at IS NULL OR claim_expires_at < now())",[row.id]);if(settled.rowCount)await client.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1 AND state='staging'",[row.id])})}
      catch{await this.db.transaction(async client=>{const settled=await client.query("UPDATE kipster.artifact_uploads SET state='failed',claim_token=NULL,claim_expires_at=NULL WHERE artifact_id=$1 AND state='staging' AND (claim_expires_at IS NULL OR claim_expires_at < now())",[row.id]);if(settled.rowCount)await client.query("UPDATE kipster.artifacts SET state='failed',failure='Interrupted publication' WHERE id=$1 AND state='staging'",[row.id])})}
    }
    await this.cleanupFailedFiles()
  }
  private async cleanupFailedFiles():Promise<void> {
    const failed=(await this.db.query<ArtifactRow>("SELECT * FROM kipster.artifacts WHERE state='failed'")).rows
    const failedIds=new Set(failed.map(row=>row.id))
    for(const row of failed)await rm(this.object(row.id),{force:true})
    for(const name of await readdir(this.staging))if(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f-]+$/.test(name)&&failedIds.has(name.slice(0,36)))await rm(join(this.staging,name),{force:true})
    const failedOutputs=(await this.db.query<{id:string;attempt_id:string;agent_id:string;thread_id:string}>("SELECT w.id,w.attempt_id,COALESCE(d.recipient_agent_id,c.agent_id) AS agent_id,r.thread_id FROM kipster.artifact_output_writes w JOIN kipster.attempts a ON a.id=w.attempt_id JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id WHERE w.state='failed'")).rows
    for(const output of failedOutputs){const path=this.output(output.agent_id,output.thread_id,output.attempt_id,output.id);await rm(path,{force:true});await rm(path+'.tmp',{force:true})}
  }
  async recover():Promise<void> {
    await this.recoverExpiredUploads()
    await this.db.query("UPDATE kipster.artifacts SET state='failed',failure='Interrupted generated publication' WHERE state='staging' AND provenance<>'upload'")
    await this.db.query("UPDATE kipster.artifact_output_writes SET state='failed' WHERE state='staging'")
    await this.db.query("UPDATE kipster.artifact_publications SET state='failed' WHERE state='staging'")
    await this.db.query("UPDATE kipster.artifact_organization_copies SET state='failed' WHERE state='staging'")
    await this.cleanupFailedFiles()
    const ready=(await this.db.query<ArtifactRow>("SELECT * FROM kipster.artifacts WHERE state='ready'")).rows
    for(const row of ready){try{const bytes=await managedFile(this.object(row.id),this.objects);if(bytes.length!==Number(row.size_bytes)||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new Error('Content mismatch')}catch{await this.db.query("UPDATE kipster.artifacts SET state='recovery-needed',failure='Managed bytes unavailable' WHERE id=$1 AND state='ready'",[row.id])}}
  }
}
