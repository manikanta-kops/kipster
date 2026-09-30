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

test('attempt-scoped output tools fence replays and Stop; organization copy owns independent bytes', {skip:noDatabase}, async()=>{
  const admin=new Postgres(adminUrl),database=`kipster_artifacts_${randomUUID().replaceAll('-','')}`
  const homePath=await mkdtemp(join(tmpdir(),'kipster_artifacts-output-'))
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
    const file=await runtime.artifacts.writeOutput(attempt.id,incarnation,'write-1','report.txt','initial content')
    assert.equal(file.status,'completed')
    assert.equal((await runtime.artifacts.writeOutput(attempt.id,incarnation,'write-1','report.txt','initial content')).outputId,file.outputId)
    await assert.rejects(runtime.artifacts.writeOutput(attempt.id,incarnation,'write-1','report.txt','changed'),/replay conflict/)
    await assert.rejects(runtime.artifacts.writeOutput(attempt.id,incarnation,'escape','../escape.txt','x'),/Invalid artifact write/)
    const personal=await runtime.artifacts.publishOutput(attempt.id,incarnation,'publish-1',file.outputId)
    assert.equal(personal.artifact.ownership.kind,'agent')
    const outputPath=join(runtime.home.output(runtime.bootstrap.rootAgentId,receipt.threadId,attempt.id),file.outputId)
    await writeFile(outputPath,'mutated after publication')
    const copy=await runtime.artifacts.copyToOrganization(attempt.id,incarnation,'copy-1',personal.artifact.id)
    assert.equal(copy.artifact.ownership.kind,'organization')
    const second=await runtime.artifacts.writeOutput(attempt.id,incarnation,'write-2','second.txt','second content')
    const failAfterLink=new ArtifactService(runtime.db,runtime.home,{afterPublishLink:async()=>{throw new Error('Injected post-link failure')}})
    await assert.rejects(failAfterLink.publishOutput(attempt.id,incarnation,'publish-failed',second.outputId),/Injected post-link failure/)
    const failedPublish=(await runtime.db.query("SELECT artifact_id FROM kipster.artifact_publications WHERE attempt_id=$1 AND call_id='publish-failed'",[attempt.id])).rows[0]
    await assert.rejects(readFile(join(homePath,'artifacts','objects',failedPublish.artifact_id)),/ENOENT/)
    await assert.rejects(failAfterLink.copyToOrganization(attempt.id,incarnation,'copy-failed',personal.artifact.id),/Injected post-link failure/)
    const failedCopy=(await runtime.db.query("SELECT artifact_id FROM kipster.artifact_organization_copies WHERE attempt_id=$1 AND call_id='copy-failed'",[attempt.id])).rows[0]
    await assert.rejects(readFile(join(homePath,'artifacts','objects',failedCopy.artifact_id)),/ENOENT/)
    for(let index=0;index<28;index++)await runtime.artifacts.copyToOrganization(attempt.id,incarnation,`copy-extra-${index}`,personal.artifact.id)
    await assert.rejects(runtime.artifacts.copyToOrganization(attempt.id,incarnation,'copy-over-limit',personal.artifact.id),/publication count exceeded/)
    const target={installationId:actor.installationId,callerId:actor.personId,context,chatId,threadId:receipt.threadId}
    assert.equal((await runtime.artifacts.content(actor,copy.artifact.id,target)).bytes.toString(),'initial content')
    await runtime.db.query('DELETE FROM kipster.artifacts WHERE id=$1',[personal.artifact.id])
    await rm(join(homePath,'artifacts','objects',personal.artifact.id))
    assert.equal((await runtime.artifacts.content(actor,copy.artifact.id,target)).bytes.toString(),'initial content')
    const interrupted=new ArtifactService(runtime.db,runtime.home,{afterWriteLink:async()=>{await runtime.db.query('UPDATE kipster.text_runs SET stop_requested=true WHERE id=$1',[receipt.runId])}})
    await assert.rejects(interrupted.writeOutput(attempt.id,incarnation,'stop-mid-write','stopped.txt','never ready'),/not live/)
    const stopped=(await runtime.db.query("SELECT id,state FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND call_id='stop-mid-write'",[attempt.id])).rows[0]
    assert.equal(stopped.state,'failed')
    await assert.rejects(readFile(join(runtime.home.output(runtime.bootstrap.rootAgentId,receipt.threadId,attempt.id),stopped.id)),/ENOENT/)
    await assert.rejects(runtime.artifacts.writeOutput(attempt.id,incarnation,'late','late.txt','late'),/not live/)
    await assert.rejects(runtime.artifacts.publishOutput(attempt.id,incarnation,'late-publish',file.outputId),/not live/)
  }finally{
    await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})
  }
})

test('process death between output bytes and SQL receipt leaves explicit failure, never a ready artifact', {skip:noDatabase}, async()=>{
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
    const proof=join(homePath,'crash-proof.json')
    await writeFile(proof,JSON.stringify({attemptId:attempt.id,incarnation,content:'CRASH_BYTES'}))
    const child=(mode)=>spawn(process.execPath,[new URL('./fixtures/artifact-crash.mjs',import.meta.url).pathname,url.href,homePath,proof,mode],{stdio:'ignore'})
    assert.equal((await death(child('write'))).signal,'SIGKILL')
    assert.equal((await runtime.db.query("SELECT state FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND call_id='crash-write'",[attempt.id])).rows[0].state,'staging')
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    assert.equal((await runtime.db.query("SELECT state FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND call_id='crash-write'",[attempt.id])).rows[0].state,'failed')
    await assert.rejects(runtime.artifacts.writeOutput(attempt.id,incarnation,'crash-write','crash.txt','CRASH_BYTES'),/pending or failed/)
    const written=await runtime.artifacts.writeOutput(attempt.id,incarnation,'write-new','complete.txt','NEW_BYTES')
    await writeFile(proof,JSON.stringify({attemptId:attempt.id,incarnation,outputId:written.outputId}))
    assert.equal((await death(child('publish'))).signal,'SIGKILL')
    const staged=(await runtime.db.query("SELECT artifact_id,state FROM kipster.artifact_publications WHERE attempt_id=$1 AND call_id='crash-publish'",[attempt.id])).rows[0]
    assert.equal(staged.state,'staging')
    await runtime.close();runtime=null
    runtime=await openRuntime({connectionString:url.href,home:homePath,names:{owner:'Owner',organization:'One',rootAgent:'Root'}})
    assert.equal((await runtime.db.query('SELECT state FROM kipster.artifacts WHERE id=$1',[staged.artifact_id])).rows[0].state,'failed')
    assert.equal((await runtime.db.query("SELECT state FROM kipster.artifact_publications WHERE attempt_id=$1 AND call_id='crash-publish'",[attempt.id])).rows[0].state,'failed')
    await assert.rejects(runtime.artifacts.publishOutput(attempt.id,incarnation,'crash-publish',written.outputId),/pending or failed/)
    for(let index=0;index<30;index++)await runtime.artifacts.writeOutput(attempt.id,incarnation,`zero-${index}`,`empty-${index}.txt`,'')
    await assert.rejects(runtime.artifacts.writeOutput(attempt.id,incarnation,'zero-over-limit','extra.txt',''),/output count exceeded/)
    for(let index=0;index<31;index++)await runtime.artifacts.publishOutput(attempt.id,incarnation,`publish-repeat-${index}`,written.outputId)
    await assert.rejects(runtime.artifacts.publishOutput(attempt.id,incarnation,'publish-over-limit',written.outputId),/publication count exceeded/)
  }finally{await runtime?.close();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(homePath,{recursive:true,force:true})}
})

test('lost SQL commit response never deletes ready generated bytes', {skip:noDatabase}, async()=>{
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
    const service=new ArtifactService(lostCommitDb(runtime.db,"UPDATE kipster.artifact_output_writes SET state='ready'"),runtime.home)
    await assert.rejects(service.writeOutput(attempt.id,incarnation,'lost-write','retained.txt','RETAINED'),/Lost commit response/)
    const written=(await runtime.db.query("SELECT id,state FROM kipster.artifact_output_writes WHERE attempt_id=$1 AND call_id='lost-write'",[attempt.id])).rows[0]
    assert.equal(written.state,'ready')
    assert.equal((await readFile(join(runtime.home.output(runtime.bootstrap.rootAgentId,receipt.threadId,attempt.id),written.id),'utf8')),'RETAINED')
    const publishing=new ArtifactService(lostCommitDb(runtime.db,"UPDATE kipster.artifacts SET state='ready'"),runtime.home)
    await assert.rejects(publishing.publishOutput(attempt.id,incarnation,'lost-publish',written.id),/Lost commit response/)
    const published=(await runtime.db.query("SELECT artifact_id,state FROM kipster.artifact_publications WHERE attempt_id=$1 AND call_id='lost-publish'",[attempt.id])).rows[0]
    assert.equal(published.state,'ready')
    assert.equal((await readFile(join(homePath,'artifacts','objects',published.artifact_id),'utf8')),'RETAINED')
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
