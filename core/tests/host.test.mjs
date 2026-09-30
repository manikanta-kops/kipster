import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateHostConfig, ownControl, control, setup, doctor, launchdTemplate } from '../dist/host.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { adminUrl, noDatabase } from './support/database.mjs'
const cli = new URL('../dist/host.js', import.meta.url).pathname
const names = { owner:'Owner', organization:'Garden', rootAgent:'Root' }
const config = (home,port=43130,databaseUrl='postgresql://kipster@localhost/unused') => ({version:1,home,databaseUrl,listen:{host:'127.0.0.1',port,allowedHosts:[],allowedOrigins:[]},adapters:[]})
const wait = async (read, predicate) => { for(let i=0;i<150;i++){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out') }
function command(args, env={}) {
 const child=spawn(process.execPath,[cli,...args],{env:{...process.env,...env},stdio:['ignore','pipe','pipe']})
 console.log('owned command PID',child.pid,args[0])
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal,output}))})
 return {child,done}
}
test('control ownership is private, bounded, token-bound and refuses stale/foreign state',async t=>{
 const home=await mkdtemp('/tmp/lhc-');t.after(()=>rm(home,{recursive:true,force:true}))
 let stops=0
 const status={state:'running',pid:process.pid,instance:randomUUID()}
 const owner=await ownControl(home,status,()=>stops++)
 t.after(()=>owner.close().catch(()=>{}))
 assert.equal((await stat(join(home,'.host-control'))).mode&0o777,0o700)
 assert.equal((await stat(join(home,'.host-control/owner.json'))).mode&0o777,0o600)
 assert.equal((await control(home,'status')).instance,status.instance)
 await assert.rejects(ownControl(home,{...status,instance:randomUUID()},()=>{}),/ownership already exists/)
 const denied=await new Promise(resolve=>{const req=request({socketPath:join(home,'.host-control/control.sock'),method:'POST',path:'/stop',headers:{authorization:'Bearer wrong-token'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.end()})
 assert.equal(denied,403);assert.equal(stops,0)
 await control(home,'stop');await wait(()=>stops,n=>n===1)
 await owner.close()
 assert.equal(await control(home,'status'),null)
 await mkdir(join(home,'.host-control'),{mode:0o700})
 await writeFile(join(home,'.host-control/owner.json'),JSON.stringify({pid:process.pid,instance:'stale',token:'stale'}),{mode:0o600})
 await owner.close()
 assert.equal(JSON.parse(await readFile(join(home,'.host-control/owner.json'),'utf8')).instance,'stale')
 await assert.rejects(control(home,'stop'),/unreachable/)
 assert.equal(stops,1)
})
test('configuration and launchd template remain explicit and portable',()=>{
 const value=config('/tmp/kipster')
 assert.equal(validateHostConfig(value),value)
 assert.throws(()=>validateHostConfig({...value,listen:{...value.listen,host:'0.0.0.0'}}),/loopback/)
 assert.throws(()=>validateHostConfig({...value,adapters:[{id:'x',root:'/tmp',entry:'../escape'}]}),/adapter/)
 const plist=launchdTemplate('/tmp/config&file.json','/tmp/kipster','/usr/local/bin/node','/tmp/host.js')
 assert.match(plist,/config&amp;file/);assert.match(plist,/SuccessfulExit/);assert.match(plist,/<string>serve<\/string>/);assert.doesNotMatch(plist,/sudo|UserName|DATABASE_URL/)
})
test('repeatable setup, foreground lifecycle, idempotent commands and occupied-port isolation', {skip:noDatabase,timeout:120000},async t=>{
 const admin=new Postgres(adminUrl),database='kipster_host_'+randomUUID().replaceAll('-','')
 await admin.query(`CREATE DATABASE "${database}"`)
 const url=new URL(adminUrl);url.pathname='/'+database
 const home=await mkdtemp('/tmp/lhh-');const owned=[]
 t.after(async()=>{for(const child of owned)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await control(home,'stop').catch(()=>{});await new Promise(r=>setTimeout(r,500));await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})})
 const occupied=createServer((_q,r)=>r.end('foreign-port-owner'))
 await new Promise(r=>occupied.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>occupied.close(r)))
 const value=config(home,occupied.address().port,url.href)
 const first=await setup(value)
 // Authored identity content must survive bootstrap replay.
 const db=new Postgres(url.href)
 const row=(await db.query('SELECT root_agent_id FROM kipster.bootstrap')).rows[0]
 const identity=join(home,'agents',row.root_agent_id,'identity.md')
 const original=await readFile(identity,'utf8');await writeFile(identity,original+'\nAuthored marker\n')
 assert.deepEqual(await setup(value),first)
 assert.match(await readFile(identity,'utf8'),/Authored marker/)
 const passive=await doctor(value)
 assert.ok(passive.some(r=>r.check==='pgvector'&&r.status==='ok'))
 assert.ok(passive.some(r=>r.check==='adapters'&&r.status==='not-configured'))
 const cfg=join(home,'host.json');await writeFile(cfg,JSON.stringify(value))
 let run=command(['serve','--config',cfg]);owned.push(run.child)
 assert.notEqual((await run.done).code,0)
 assert.equal(await control(home,'status'),null)
 assert.equal(await (await fetch(`http://127.0.0.1:${value.listen.port}`)).text(),'foreign-port-owner')
 await new Promise(r=>occupied.close(r))
 run=command(['start','--config',cfg]);owned.push(run.child);const started=await run.done
 assert.equal(started.code,0,started.output)
 const status=await control(home,'status');assert.equal(status.state,'running');console.log('owned foreground PID',status.pid)
 assert.equal((await (await fetch(status.url+'/v1/bootstrap')).json()).installationId,first.installationId)
 run=command(['start','--config',cfg]);owned.push(run.child);assert.equal((await run.done).code,0)
 assert.equal((await control(home,'status')).instance,status.instance)
 run=command(['restart','--config',cfg]);owned.push(run.child);const restarted=await run.done;assert.equal(restarted.code,0,restarted.output)
 assert.notEqual((await control(home,'status')).instance,status.instance)
 console.log('owned restarted PID',(await control(home,'status')).pid)
 run=command(['stop','--config',cfg]);owned.push(run.child);const stopped=await run.done;assert.equal(stopped.code,0,stopped.output)
 assert.equal(await control(home,'status'),null)
 run=command(['stop','--config',cfg]);owned.push(run.child);assert.equal((await run.done).code,0)
 await db.close()
 // A configured synthetic provider failing shutdown cannot leave an owned host indefinitely.
 const provider=join(home,'failing-transcription.mjs')
 await writeFile(provider,`export function createTranscriptionProvider(){return {id:'synthetic',contractMajor:1,inputTypes:['audio/*'],readiness:async()=>({ready:false,reason:'fixture unavailable'}),transcribe:async()=>({status:'unavailable',reason:'unavailable',provider:'synthetic'}),close:async()=>{throw Error('fixture close failure')}}}`)
 await writeFile(cfg,JSON.stringify({...value,transcription:{module:provider,options:{}}}))
 const failing=command(['serve','--config',cfg]);owned.push(failing.child)
 await wait(()=>control(home,'status').catch(()=>null),s=>s?.state==='running')
 const stopAt=Date.now()
 const stopFailure=command(['stop','--config',cfg]);owned.push(stopFailure.child)
 assert.equal((await stopFailure.done).code,0)
 assert.notEqual((await failing.done).code,0)
 assert.ok(Date.now()-stopAt<20000,'failed shutdown remains bounded')
 assert.equal(await control(home,'status'),null)
})

for (const phase of ['module-release', 'module-blocked', 'adapter-blocked']) {
 test(`Stop during ${phase} fences queued work and bounds startup cleanup`, {skip:noDatabase,timeout:45000}, async t => {
  const admin=new Postgres(adminUrl), database='kipster_startstop_'+randomUUID().replaceAll('-','')
  await admin.query(`CREATE DATABASE "${database}"`)
  const url=new URL(adminUrl);url.pathname='/'+database
  const home=await mkdtemp('/tmp/lhs-');let run
  t.after(async()=>{if(run&&run.child.exitCode===null&&run.child.signalCode===null){run.child.kill('SIGKILL');await run.done}const childPid=Number(await readFile(join(home,'readiness-child-pid'),'utf8').catch(()=>''));if(childPid)try{process.kill(childPid,'SIGTERM')}catch{}await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.close();await rm(home,{recursive:true,force:true})})
  const {openRuntime,startTextServer}=await import('../dist/runtime.js')
  const core=await openRuntime({connectionString:url.href,home,names})
  const actor={installationId:core.bootstrap.installationId,personId:core.bootstrap.ownerId}
  await core.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1',[core.bootstrap.rootAgentId,JSON.stringify({adapterId:'delayed',modelId:'fixture'})])
  const seed=await startTextServer(core,actor,{host:'127.0.0.1',port:0})
  const port=Number(new URL(seed.url).port),context={kind:'installation',installationId:actor.installationId}
  const post=async(path,body)=>{const response=await fetch(seed.url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok);return response.json()}
  const {chatId}=await post('/v1/direct-chats',{version:1,context,agentId:core.bootstrap.rootAgentId})
  const receipt=await post('/v1/text/submissions',{version:1,submissionId:randomUUID(),scope:{installationId:actor.installationId,callerId:actor.personId},target:{context,chatId},mode:'root',parts:[{kind:'text',text:'Must stay queued during stopped startup'}]})
  await seed.close();await core.close()
  const entered=join(home,'entered'),release=join(home,'release'),executed=join(home,'executed'),listened=join(home,'listened'),factory=join(home,'factory'),dispatcherStarted=join(home,'dispatcher-started'),runnerPid=join(home,'runner-pid'),readinessChild=join(home,'readiness-child-pid'),readinessClosed=join(home,'readiness-closed')
  const provider=join(home,'transcription.mjs')
  await writeFile(provider,`
import {writeFileSync,existsSync} from 'node:fs';import {Server} from 'node:net';import {setTimeout as delay} from 'node:timers/promises';
import {TextDispatcher} from ${JSON.stringify(new URL('../dist/runtime.js',import.meta.url).href)};
const start=TextDispatcher.prototype.start;TextDispatcher.prototype.start=function(...args){writeFileSync(${JSON.stringify(dispatcherStarted)},'started');return start.apply(this,args)};
const listen=Server.prototype.listen;Server.prototype.listen=function(...args){if(args[0]?.port===${port})writeFileSync(${JSON.stringify(listened)},'opened');return listen.apply(this,args)};
${phase.startsWith('module-')?`writeFileSync(${JSON.stringify(entered)},'module');while(!existsSync(${JSON.stringify(release)}))await delay(10);`:''}
export function createTranscriptionProvider(){writeFileSync(${JSON.stringify(factory)},'created');return {id:'synthetic',contractMajor:1,inputTypes:['audio/*'],readiness:async()=>({ready:false}),transcribe:async()=>({status:'unavailable',reason:'unavailable',provider:'synthetic'}),close:async()=>{}}}
`)
  const adapterRoot=join(home,'adapter');await mkdir(adapterRoot)
  await writeFile(join(adapterRoot,'index.mjs'),`
import {writeFileSync,existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
export function createAdapter(){let child,exited,closed=false;writeFileSync(${JSON.stringify(runnerPid)},String(process.pid));return {id:'delayed',version:'1',contractMajor:1,
readiness:async()=>{child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});exited=new Promise(resolve=>child.once('exit',resolve));writeFileSync(${JSON.stringify(readinessChild)},String(child.pid));writeFileSync(${JSON.stringify(entered)},'adapter');while(!existsSync(${JSON.stringify(release)})&&!closed)await delay(10);if(closed)throw Error('closed');return {ready:true,catalog:{models:[{id:'fixture'}],capabilities:{text:true,publication:false,cancellation:true,steering:false,nativeResume:false}}}},
execute:async()=>{writeFileSync(${JSON.stringify(executed)},'executed');throw Error('Unexpected execution')},close:async()=>{closed=true;if(child){child.kill('SIGTERM');await exited}writeFileSync(${JSON.stringify(readinessClosed)},'closed')}}}
`)
  const value={...config(home,port,url.href),transcription:{module:provider,options:{}},adapters:[{id:'delayed',root:adapterRoot,entry:'index.mjs'}]}
  const cfg=join(home,'host.json');await writeFile(cfg,JSON.stringify(value))
  run=command(['serve','--config',cfg])
  await wait(()=>stat(entered).then(()=>true).catch(()=>false),Boolean)
  const at=Date.now()
  if(phase==='module-blocked')run.child.kill('SIGTERM')
  else {await control(home,'stop');if(phase==='module-release')assert.equal((await control(home,'status')).state,'stopping');await writeFile(release,'released after accepted Stop')}
  const result=await Promise.race([run.done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Stop exceeded 20 seconds')),20000);timer.unref()})])
  assert.ok(Date.now()-at<20000,'startup shutdown uses the shutdown deadline')
  assert.equal(result.code,phase==='module-blocked'?1:0,result.output)
  assert.doesNotMatch(result.output,/"state":"running"/)
  for(const path of [executed,listened,dispatcherStarted])await assert.rejects(stat(path),{code:'ENOENT'})
  if(phase.startsWith('module-'))await assert.rejects(stat(factory),{code:'ENOENT'})
  if(phase==='adapter-blocked'){
   const pid=Number(await readFile(runnerPid,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
   const child=Number(await readFile(readinessChild,'utf8'));assert.throws(()=>process.kill(child,0),{code:'ESRCH'});assert.equal(await readFile(readinessClosed,'utf8'),'closed')
   const {readdir}=await import('node:fs/promises');assert.deepEqual(await readdir(join(home,'adapter-generations')),[])
  }
  const db=new Postgres(url.href)
  try {assert.equal((await db.query('SELECT state FROM kipster.text_runs WHERE id=$1',[receipt.runId])).rows[0].state,'queued');assert.equal((await db.query('SELECT count(*)::int AS count FROM kipster.attempts WHERE intent_id=$1',[receipt.runId])).rows[0].count,0)}finally{await db.close()}
  if(phase==='module-blocked')await assert.rejects(control(home,'status'),/unreachable/)
  else assert.equal(await control(home,'status'),null)
 })
}

test('host configuration accepts opaque adapter settings but rejects non-object payloads', () => {
 const value = config('/tmp/kipster-config')
 const adapter = {id:'custom',root:'/absolute/install',entry:'dist/index.js',config:{vendorSetting:{path:'/custom/home'}}}
 assert.deepEqual(validateHostConfig({...value,adapters:[adapter]}).adapters[0].config,adapter.config)
 for(const invalid of [null,[],true,'value'])assert.throws(()=>validateHostConfig({...value,adapters:[{...adapter,config:invalid}]}),/Configure adapter/)
 for(const id of ['','../escape','a/b','.hidden'])assert.throws(()=>validateHostConfig({...value,adapters:[{...adapter,id}]}),/Configure adapter/)
 for(const databaseUrl of [undefined,'KIPSTER_DATABASE_URL','http://localhost/db','not a url'])assert.throws(()=>validateHostConfig({...value,databaseUrl}),/PostgreSQL database URLs/)
 assert.throws(()=>validateHostConfig({...value,taskDataUrl:'mysql://localhost/db'}),/PostgreSQL database URLs/)
 assert.equal(validateHostConfig({...value,taskDataUrl:'postgres://task@localhost/db'}).taskDataUrl,'postgres://task@localhost/db')
})
