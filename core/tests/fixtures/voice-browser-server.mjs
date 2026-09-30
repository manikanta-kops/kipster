import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Postgres} from '../../dist/platform/postgres/public.js'
import {openRuntime,startTextServer,TextDispatcher} from '../../dist/runtime.js'
import { adminUrl } from '../support/database.mjs'

if(!adminUrl)throw new Error('KIPSTER_TEST_DATABASE_URL is required')
const admin=new Postgres(adminUrl)
const database=`kipstervoicebrowser_${randomUUID().replaceAll('-','')}`
const home=await mkdtemp(join(tmpdir(),'kipster-voice-browser-'))
let runtime,dispatcher,server,stopping=false
async function stop(){
 if(stopping)return;stopping=true
 try{await server?.close()}finally{try{await dispatcher?.close()}finally{try{await runtime?.close()}finally{await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(()=>{});await admin.close();await rm(home,{recursive:true,force:true})}}}
}
try{
 await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname=`/${database}`
 const provider={id:'fixture-unavailable',contractMajor:1,inputTypes:['audio/*','video/*'],async readiness(){return {ready:true}},async transcribe(){await new Promise(resolve=>setTimeout(resolve,1200));return {status:'unavailable',reason:'provider-error',provider:'fixture-unavailable'}},async close(){}}
 runtime=await openRuntime({connectionString:url.href,home,names:{owner:'Owner',organization:'Org',rootAgent:'Root'},transcription:provider})
 await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[runtime.bootstrap.rootAgentId,JSON.stringify({adapterId:'voice-browser-adapter',modelId:'fixture-model'})])
 const adapter={id:'voice-browser-adapter',version:'1',contractMajor:1,async execute(context){
  const current=context.input.find(item=>item.messageId===context.triggerMessageId)
  const file=current?.parts?.find(part=>part.kind==='file')
  const text=`Fixture received ${file?.purpose??'none'}; original ${file?.availability??'missing'}; transcription ${file?.transcription?.status??'missing'}; caption ${current?.text??''}`
  return {events:(async function*(){yield {kind:'text',attemptId:context.attemptId,messageId:'fixture-voice-result',text,final:true};yield {kind:'ended',attemptId:context.attemptId,confirmed:true}})(),async cancel(){return {acknowledged:true,confirmedEnded:true}},async reconcile(){return 'ended'}}
 },async close(){}}
 dispatcher=new TextDispatcher(runtime,adapter)
 server=await startTextServer(runtime,{installationId:runtime.bootstrap.installationId,personId:runtime.bootstrap.ownerId},{host:'127.0.0.1',port:55464,allowedOrigins:['http://127.0.0.1:4187'],dispatcher})
 await dispatcher.start()
 process.stdout.write(`VOICE_BROWSER_READY ${server.url}\n`)
 process.on('SIGTERM',()=>{void stop().then(()=>process.exit(0),()=>process.exit(1))})
 process.on('SIGINT',()=>{void stop().then(()=>process.exit(0),()=>process.exit(1))})
}catch(error){await stop();throw error}
