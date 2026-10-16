import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,readdir,symlink,link,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
import {Postgres} from '../dist/platform/postgres/public.js'
import {openRuntime,TextDispatcher} from '../dist/runtime.js'
import {resolveDirectChat,acceptText} from '../dist/modules/conversations/public.js'
import {claimPreparation,issueAttempt} from '../dist/modules/work/public.js'
import {ArtifactService} from '../dist/modules/artifacts/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'

const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const stream=bytes=>(async function*(){yield bytes})()
const death=child=>new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))})
const waitFor=async(read,accept)=>{for(let index=0;index<100;index++){const result=await read();if(accept(result))return result;await new Promise(resolve=>setTimeout(resolve,50))}throw new Error('Timed out waiting for execution')}
const lostCommitDb=(db,settledSql)=>({
  query:(...args)=>db.query(...args),
  transaction:async task=>{
    let settled=false
    const result=await db.transaction(client=>task({query:(sql,...args)=>{if(sql.includes(settledSql))settled=true;return client.query(sql,...args)}}))
    if(settled)throw new Error('Lost commit response')
    return result
  }
})

test('managed originals, scoped receipts, immutable downloads and interrupted publication recover on real PostgreSQL', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-files-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    const context={kind:'installation',installationId:actor.installationId}
    const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
    const target={installationId:actor.installationId,callerId:actor.personId,context,chatId}
    const bytes=Buffer.from('durable original')
    const intent={uploadId:randomUUID(),target,name:'original.txt',mimeType:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'attachment'}
    const first=await runtime.artifacts.upload(actor,intent,stream(bytes))
    assert.equal(first.status,'accepted')
    assert.equal((await runtime.artifacts.upload(actor,intent,stream(Buffer.from('different')))).artifact.id,first.artifact.id)
    assert.equal((await runtime.artifacts.uploadReceipt(actor,intent.uploadId,target)).artifact.id,first.artifact.id)
    assert.equal((await runtime.artifacts.content(actor,first.artifact.id,target)).bytes.toString(),bytes.toString())
    const submissionId=randomUUID(),submit={version:1,submissionId,scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:first.artifact.id,purpose:'attachment'}]}
    const saved=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,submit)
    assert.equal(saved.status,'accepted')
    assert.equal((await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{...submit,parts:[{kind:'text',text:'changed retry'}]})).messageId,saved.messageId)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.message_artifacts WHERE message_id=$1',[saved.messageId])).rows[0].n,1)
    await assert.rejects(acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{...submit,submissionId:randomUUID(),parts:[{kind:'text',text:'still here'},{kind:'file',artifactId:randomUUID(),purpose:'attachment'}]}),/not found/)
    assert.equal((await runtime.db.query('SELECT count(*)::int AS n FROM kipster.messages WHERE thread_id=$1',[saved.threadId])).rows[0].n,1)
    await assert.rejects(runtime.artifacts.get(actor,first.artifact.id,{...target,context:{kind:'organization',organizationId:runtime.bootstrap.organizationId}}),/denied/)
    const tamper=join(homePath,'artifacts','objects',first.artifact.id)
    await link(tamper,tamper+'.alias')
    await assert.rejects(runtime.artifacts.content(actor,first.artifact.id,target),/recovery needed/)
    assert.equal((await runtime.db.query('SELECT state FROM kipster.artifacts WHERE id=$1',[first.artifact.id])).rows[0].state,'recovery-needed')
    await rm(tamper+'.alias')
    await runtime.db.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1",[first.artifact.id])
    await rm(tamper)
    await symlink('/etc/hosts',tamper)
    await assert.rejects(runtime.artifacts.content(actor,first.artifact.id,target),/recovery needed/)
    await rm(tamper)
    await writeFile(tamper,bytes)
    await runtime.db.query("UPDATE kipster.artifacts SET state='ready' WHERE id=$1",[first.artifact.id])
    const failedIntent={...intent,uploadId:randomUUID(),name:'failed-after-link.txt'}
    const failedUpload=new ArtifactService(runtime.db,runtime.home,{afterUploadLink:async()=>{throw new Error('Injected upload failure')}})
    await assert.rejects(failedUpload.upload(actor,failedIntent,stream(bytes)),/Injected upload failure/)
    const failedRow=(await runtime.db.query('SELECT artifact_id FROM kipster.artifact_uploads WHERE upload_id=$1',[failedIntent.uploadId])).rows[0]
    await assert.rejects(readFile(join(homePath,'artifacts','objects',failedRow.artifact_id)),/ENOENT/)
    const afterFailure=await runtime.artifacts.upload(actor,failedIntent,stream(bytes))
    assert.equal(afterFailure.status,'accepted')
    assert.notEqual(afterFailure.artifact.id,failedRow.artifact_id)
    const crashIntent={...intent,uploadId:randomUUID(),name:'crash.txt'}
    const proof=join(homePath,'crash-proof.json')
    await writeFile(proof,JSON.stringify({actor,intent:crashIntent,content:bytes.toString()}))
    const complete=spawn(process.execPath,[new URL('./fixtures/artifact-crash.mjs',import.meta.url).pathname,url.href,homePath,proof,'complete'],{stdio:'ignore'})
    assert.equal((await death(complete)).signal,'SIGKILL')
    const row=(await runtime.db.query('SELECT artifact_id,state FROM kipster.artifact_uploads WHERE upload_id=$1',[crashIntent.uploadId])).rows[0]
    assert.equal(row.state,'staging')
    await runtime.db.query("UPDATE kipster.artifact_uploads SET claim_expires_at=now()-interval '1 minute' WHERE upload_id=$1",[crashIntent.uploadId])
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    assert.equal((await runtime.artifacts.uploadReceipt(actor,crashIntent.uploadId,target)).status,'accepted')
    assert.equal((await runtime.artifacts.content(actor,row.artifact_id,target)).bytes.toString(),bytes.toString())
    const partialIntent={...intent,uploadId:randomUUID(),name:'partial.txt'}
    await writeFile(proof,JSON.stringify({actor,intent:partialIntent,content:bytes.toString()}))
    const partial=spawn(process.execPath,[new URL('./fixtures/artifact-crash.mjs',import.meta.url).pathname,url.href,homePath,proof,'partial'],{stdio:'ignore'})
    assert.equal((await death(partial)).signal,'SIGKILL')
    const partialRow=(await runtime.db.query('SELECT artifact_id FROM kipster.artifact_uploads WHERE upload_id=$1',[partialIntent.uploadId])).rows[0]
    const staging=join(homePath,'artifacts','staging')
    assert.ok((await readdir(staging)).some(name=>name.startsWith(`${partialRow.artifact_id}.`)))
    await runtime.db.query("UPDATE kipster.artifact_uploads SET claim_expires_at=now()-interval '1 minute' WHERE upload_id=$1",[partialIntent.uploadId])
    assert.equal((await runtime.artifacts.uploadReceipt(actor,partialIntent.uploadId,target)).status,'unknown')
    assert.ok(!(await readdir(staging)).some(name=>name.startsWith(`${partialRow.artifact_id}.`)))
    const retried=await runtime.artifacts.upload(actor,partialIntent,stream(bytes))
    assert.equal(retried.status,'accepted')
    assert.notEqual(retried.artifact.id,partialRow.artifact_id)
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    assert.equal((await runtime.artifacts.uploadReceipt(actor,partialIntent.uploadId,target)).artifact.id,retried.artifact.id)
  }finally{
    await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})
  }
})

test('files attached by path fence replays and Stop; organization copy owns independent bytes', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-output-')),folder=await mkdtemp(join(tmpdir(),'kipster_artifacts-source-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId}
    const context={kind:'organization',organizationId:runtime.bootstrap.organizationId}
    const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
    const receipt=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'text',text:'Create a file'}]})
    const incarnation=randomUUID()
    const attempt=await runtime.db.transaction(async client=>{
      const claim=await claimPreparation(client,receipt.runId,incarnation)
      assert.ok(claim)
      assert.equal(await issueAttempt(client,claim),true)
      await client.query("UPDATE kipster.text_runs SET state='running',current_attempt_id=$2 WHERE id=$1",[receipt.runId,claim.id])
      return claim
    })
    await writeFile(join(folder,'report.txt'),'initial content')
    const request=(paths,requestHash=digest('report'))=>({paths,base:folder,artifactIds:[],requestHash})
    const states=async callId=>(await runtime.db.query('SELECT f.state AS claim,a.state AS file FROM kipster.artifact_file_attachments f JOIN kipster.artifacts a ON a.id=f.artifact_id WHERE f.attempt_id=$1 AND f.call_id=$2 ORDER BY f.ordinal',[attempt.id,callId])).rows
    const attached=await runtime.artifacts.attachFiles(attempt.id,incarnation,'attach-1',request(['report.txt']))
    assert.deepEqual(attached.files.map(file=>[file.name,file.mimeType,file.size]),[['report.txt','text/plain',15]])
    assert.deepEqual(await states('attach-1'),[{claim:'staging',file:'staging'}],'nothing is ready before the publication commits')
    await assert.rejects(runtime.artifacts.attachFiles(attempt.id,incarnation,'attach-1',request(['report.txt'])),/pending or failed/)
    await runtime.db.transaction(client=>attached.settle(client))
    await attached.abandon()
    assert.deepEqual(await states('attach-1'),[{claim:'ready',file:'ready'}],'abandoning a settled attachment changes nothing')
    const personal=attached.files[0].artifactId
    assert.deepEqual((await runtime.artifacts.attachFiles(attempt.id,incarnation,'attach-1',request(['report.txt']))).files,attached.files)
    await assert.rejects(runtime.artifacts.attachFiles(attempt.id,incarnation,'attach-1',request(['report.txt'],digest('other'))),/replay conflict/)
    const row=(await runtime.db.query('SELECT owner_kind,owner_id,provenance,author_id,sha256 FROM kipster.artifacts WHERE id=$1',[personal])).rows[0]
    assert.deepEqual(row,{owner_kind:'agent',owner_id:runtime.bootstrap.rootAgentId,provenance:'generated',author_id:runtime.bootstrap.rootAgentId,sha256:digest('initial content')})
    await writeFile(join(folder,'report.txt'),'mutated after attachment')
    const copy=await runtime.artifacts.copyToOrganization(attempt.id,incarnation,'copy-1',personal)
    assert.equal(copy.artifact.ownership.kind,'organization')
    await writeFile(join(folder,'second.txt'),'second content')
    const failAfterLink=new ArtifactService(runtime.db,runtime.home,{afterAttachLink:async()=>{throw new Error('Injected post-link failure')},afterPublishLink:async()=>{throw new Error('Injected post-link failure')}})
    await assert.rejects(failAfterLink.attachFiles(attempt.id,incarnation,'attach-failed',request(['second.txt'])),/Injected post-link failure/)
    const failedAttach=(await runtime.db.query("SELECT f.state,f.artifact_id,a.state AS file FROM kipster.artifact_file_attachments f JOIN kipster.artifacts a ON a.id=f.artifact_id WHERE f.attempt_id=$1 AND f.call_id='attach-failed'",[attempt.id])).rows[0]
    assert.deepEqual([failedAttach.state,failedAttach.file],['failed','failed'])
    await assert.rejects(readFile(join(homePath,'artifacts','objects',failedAttach.artifact_id)),/ENOENT/)
    await assert.rejects(failAfterLink.copyToOrganization(attempt.id,incarnation,'copy-failed',personal),/Injected post-link failure/)
    const failedCopy=(await runtime.db.query("SELECT artifact_id FROM kipster.artifact_organization_copies WHERE attempt_id=$1 AND call_id='copy-failed'",[attempt.id])).rows[0]
    await assert.rejects(readFile(join(homePath,'artifacts','objects',failedCopy.artifact_id)),/ENOENT/)
    for(let index=0;index<30;index++)await runtime.artifacts.copyToOrganization(attempt.id,incarnation,`copy-extra-${index}`,personal)
    await assert.rejects(runtime.artifacts.copyToOrganization(attempt.id,incarnation,'copy-over-limit',personal),/publication count exceeded/)
    const target={installationId:actor.installationId,callerId:actor.personId,context,chatId,threadId:receipt.threadId}
    assert.equal((await runtime.artifacts.content(actor,copy.artifact.id,target)).bytes.toString(),'initial content')
    await runtime.db.query('DELETE FROM kipster.artifacts WHERE id=$1',[personal])
    await rm(join(homePath,'artifacts','objects',personal))
    assert.equal((await runtime.artifacts.content(actor,copy.artifact.id,target)).bytes.toString(),'initial content')
    await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE id=$1',[receipt.runId])
    await assert.rejects(runtime.artifacts.attachFiles(attempt.id,incarnation,'late',request(['second.txt'])),/not live/)
    assert.equal((await runtime.db.query("SELECT count(*)::int AS n FROM kipster.artifact_file_attachments WHERE call_id='late'")).rows[0].n,0)
  }finally{
    await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true});await rm(folder,{recursive:true,force:true})
  }
})

test('the admin kip copies a file from its chat into any workspace; another kip only into its own', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-admin-copy-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},org=runtime.bootstrap.organizationId,other=randomUUID(),member=randomUUID()
    await runtime.db.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[other,actor.installationId,'Two'])
    await runtime.db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)',[member,actor.installationId,'Member'])
    await runtime.db.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2)',[org,member])
    const started=async(context,agentId,parts)=>{
      const {chatId}=await resolveDirectChat(runtime.db,actor,context,agentId)
      const receipt=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts})
      const incarnation=randomUUID()
      const attempt=await runtime.db.transaction(async client=>{const claim=await claimPreparation(client,receipt.runId,incarnation);assert.equal(await issueAttempt(client,claim),true);await client.query("UPDATE kipster.text_runs SET state='running',current_attempt_id=$2 WHERE id=$1",[receipt.runId,claim.id]);return claim})
      return {chatId,attempt,incarnation}
    }
    const installation={kind:'installation',installationId:actor.installationId}
    const {chatId}=await resolveDirectChat(runtime.db,actor,installation,runtime.bootstrap.rootAgentId)
    const bytes=Buffer.from('brief')
    const uploaded=(await runtime.artifacts.upload(actor,{uploadId:randomUUID(),target:{installationId:actor.installationId,callerId:actor.personId,context:installation,chatId},name:'brief.txt',mimeType:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'attachment'},stream(bytes))).artifact
    const root=await started(installation,runtime.bootstrap.rootAgentId,[{kind:'text',text:'Put this in workspace One'},{kind:'file',artifactId:uploaded.id,purpose:'attachment'}])
    await assert.rejects(runtime.artifacts.copyToOrganization(root.attempt.id,root.incarnation,'no-workspace',uploaded.id),/Name the workspace with workspaceId/)
    await assert.rejects(runtime.artifacts.copyToOrganization(root.attempt.id,root.incarnation,'unknown',uploaded.id,randomUUID()),/Workspace not found/)
    const copy=await runtime.artifacts.copyToOrganization(root.attempt.id,root.incarnation,'copy',uploaded.id,org)
    assert.deepEqual(copy.artifact.ownership,{kind:'organization',id:org})
    await assert.rejects(runtime.artifacts.copyToOrganization(root.attempt.id,root.incarnation,'copy',uploaded.id,other),/replay conflict/)
    const work=await started({kind:'organization',organizationId:org},member,[{kind:'text',text:'Copy it elsewhere'}])
    await assert.rejects(runtime.artifacts.copyToOrganization(work.attempt.id,work.incarnation,'elsewhere',copy.artifact.id,other),/Only the admin kip can copy a file into another workspace/)
    await assert.rejects(runtime.artifacts.copyToOrganization(work.attempt.id,work.incarnation,'not-own',copy.artifact.id),/Source artifact unavailable/)
  }finally{
    await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})
  }
})

test('process death between attached bytes and SQL receipt leaves explicit failure, never a ready artifact', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-output-crash-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
    const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
    const receipt=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'text',text:'Create'}]})
    const incarnation=randomUUID(),attempt=await runtime.db.transaction(async client=>{const claim=await claimPreparation(client,receipt.runId,incarnation);await issueAttempt(client,claim);await client.query("UPDATE kipster.text_runs SET state='running',current_attempt_id=$2 WHERE id=$1",[receipt.runId,claim.id]);return claim})
    const source=join(homePath,'crash.txt'),request={paths:[source],base:homePath,artifactIds:[],requestHash:digest('crash')}
    await writeFile(source,'CRASH_BYTES')
    const proof=join(homePath,'crash-proof.json')
    await writeFile(proof,JSON.stringify({attemptId:attempt.id,incarnation,request}))
    const child=(mode)=>spawn(process.execPath,[new URL('./fixtures/artifact-crash.mjs',import.meta.url).pathname,url.href,homePath,proof,mode],{stdio:'ignore'})
    assert.equal((await death(child('attach'))).signal,'SIGKILL')
    const staged=(await runtime.db.query("SELECT f.state,f.artifact_id,a.state AS file FROM kipster.artifact_file_attachments f JOIN kipster.artifacts a ON a.id=f.artifact_id WHERE f.attempt_id=$1 AND f.call_id='crash-attach'",[attempt.id])).rows[0]
    assert.deepEqual([staged.state,staged.file],['staging','staging'])
    assert.equal(await readFile(join(homePath,'artifacts','objects',staged.artifact_id),'utf8'),'CRASH_BYTES')
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    assert.equal((await runtime.db.query("SELECT state FROM kipster.artifact_file_attachments WHERE attempt_id=$1 AND call_id='crash-attach'",[attempt.id])).rows[0].state,'failed')
    assert.equal((await runtime.db.query('SELECT state FROM kipster.artifacts WHERE id=$1',[staged.artifact_id])).rows[0].state,'failed')
    await assert.rejects(readFile(join(homePath,'artifacts','objects',staged.artifact_id)),/ENOENT/)
    await assert.rejects(runtime.artifacts.attachFiles(attempt.id,incarnation,'crash-attach',request),/pending or failed/)
    const retried=await runtime.artifacts.attachFiles(attempt.id,incarnation,'attach-new',request)
    await runtime.db.transaction(client=>retried.settle(client))
    assert.equal((await runtime.db.query('SELECT state FROM kipster.artifacts WHERE id=$1',[retried.files[0].artifactId])).rows[0].state,'ready')
  }finally{await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})}
})

test('lost SQL commit response never deletes ready attached bytes', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-commit-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
    const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
    const receipt=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'text',text:'Create'}]})
    const incarnation=randomUUID(),attempt=await runtime.db.transaction(async client=>{const claim=await claimPreparation(client,receipt.runId,incarnation);await issueAttempt(client,claim);await client.query("UPDATE kipster.text_runs SET state='running',current_attempt_id=$2 WHERE id=$1",[receipt.runId,claim.id]);return claim})
    await writeFile(join(homePath,'retained.txt'),'RETAINED')
    const attached=await runtime.artifacts.attachFiles(attempt.id,incarnation,'lost-attach',{paths:['retained.txt'],base:homePath,artifactIds:[],requestHash:digest('retained')})
    await assert.rejects(lostCommitDb(runtime.db,"UPDATE kipster.artifacts SET state='ready'").transaction(client=>attached.settle(client)),/Lost commit response/)
    await attached.abandon()
    const saved=(await runtime.db.query("SELECT f.artifact_id,f.state,a.state AS file FROM kipster.artifact_file_attachments f JOIN kipster.artifacts a ON a.id=f.artifact_id WHERE f.attempt_id=$1 AND f.call_id='lost-attach'",[attempt.id])).rows[0]
    assert.deepEqual([saved.state,saved.file],['ready','ready'])
    assert.equal((await readFile(join(homePath,'artifacts','objects',saved.artifact_id),'utf8')),'RETAINED')
  }finally{await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})}
})

test('missing or corrupt historical files are explicit evidence and do not block a later text run', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-history-'))
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname=`/${database}`
  let runtime,dispatcher
  try{
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    const actor={installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},context={kind:'installation',installationId:actor.installationId}
    await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'history-fixture',modelId:'test-model'})])
    const {chatId}=await resolveDirectChat(runtime.db,actor,context,runtime.bootstrap.rootAgentId)
    const target={installationId:actor.installationId,callerId:actor.personId,context,chatId}
    const bytes=Buffer.from('historical bytes'),intent={uploadId:randomUUID(),target,name:'history.txt',mimeType:'text/plain',size:bytes.length,sha256:digest(bytes),purpose:'attachment'}
    const upload=await runtime.artifacts.upload(actor,intent,stream(bytes))
    const otherBytes=Buffer.from('second original'),otherIntent={...intent,uploadId:randomUUID(),name:'second.txt',size:otherBytes.length,sha256:digest(otherBytes)}
    const otherUpload=await runtime.artifacts.upload(actor,otherIntent,stream(otherBytes))
    const first=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'file',artifactId:upload.artifact.id,purpose:'attachment'},{kind:'file',artifactId:otherUpload.artifact.id,purpose:'attachment'}]})
    const contexts=[]
    const adapter={id:'history-fixture',version:'1',contractMajor:1,async execute(execution){contexts.push(execution);return {events:(async function*(){yield {kind:'ended',attemptId:execution.attemptId,confirmed:true}})(),async cancel(){return {acknowledged:true,confirmedEnded:true}},async reconcile(){return 'ended'}}},async close(){}}
    dispatcher=new TextDispatcher(runtime,adapter)
    await dispatcher.start()
    await waitFor(()=>runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[first.runId]).then(result=>result.rows[0]?.state),state=>state==='completed')
    await rm(join(homePath,'artifacts','objects',upload.artifact.id))
    await writeFile(join(homePath,'artifacts','objects',otherUpload.artifact.id),'corrupt bytes')
    await assert.rejects(runtime.artifacts.inputForExecution(actor,upload.artifact.id,{...target,threadId:first.threadId,context:{kind:'organization',organizationId:runtime.bootstrap.organizationId}}),/denied/)
    const reply=await acceptText(runtime.db,runtime.jobs,runtime.artifacts,actor,{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'reply',threadId:first.threadId,parts:[{kind:'text',text:'Continue with text only'}]})
    const later=await waitFor(()=>Promise.resolve(contexts.find(item=>item.runId===reply.runId)),value=>!!value)
    const historical=later.input.find(item=>item.messageId===first.messageId)
    assert.deepEqual(historical.parts,[{kind:'file',purpose:'attachment',artifactId:upload.artifact.id,name:'history.txt',mimeType:'text/plain',size:bytes.length,availability:'unavailable'},{kind:'file',purpose:'attachment',artifactId:otherUpload.artifact.id,name:'second.txt',mimeType:'text/plain',size:otherBytes.length,availability:'unavailable'}])
    assert.equal(later.input.find(item=>item.messageId===reply.messageId).parts[0].text,'Continue with text only')
    await waitFor(()=>runtime.db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[reply.runId]).then(result=>result.rows[0]?.state),state=>state==='completed')
  }finally{await dispatcher?.close();await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})}
})
