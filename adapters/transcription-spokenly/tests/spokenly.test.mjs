import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SpokenlyAdapter,validateSpokenlyConfig} from '../dist/index.js'
async function fixture(mode){
  const dir=await mkdtemp(join(tmpdir(),'kipster-spokenly-'))
  const executable=join(dir,'spokenly')
  await writeFile(executable,`#!/usr/bin/env node\nif(process.argv[2]==='--version'){process.stdout.write('spokenly 2.28.5+548\\n');process.exit(0)};if(process.argv[2]!=='transcribe'||process.argv[4]!=='--format'||process.argv[5]!=='text')process.exit(9);\nconst mode=${JSON.stringify(mode)};if(mode==='success')process.stdout.write('hello from audio\\n');else if(mode==='empty')process.exit(0);else if(mode==='failure')process.exit(7);else if(mode==='large')process.stdout.write('x'.repeat(50000));else setInterval(()=>{},1000);\n`)
  await chmod(executable,0o700)
  const audio=join(dir,'clip.wav');await writeFile(audio,'RIFFtest')
  return {dir,executable,audio}
}
function adapter(executable,timeoutMs=1000,maxOutputBytes=1024){return new SpokenlyAdapter({executable,timeoutMs,maxOutputBytes})}
const input=(path,signal)=>({path,mimeType:'audio/wav',size:8,signal})
test('options default and ignore unknown keys while rejecting invalid values',()=>{
  const valid={executable:'/bin/true',timeoutMs:1000,maxOutputBytes:100}
  assert.deepEqual(validateSpokenlyConfig({...valid,ignored:true}),{...valid})
  assert.deepEqual(validateSpokenlyConfig({executable:'/bin/true'}),{executable:'/bin/true',timeoutMs:60000,maxOutputBytes:1048576})
  for(const changed of [{executable:'spokenly'},{timeoutMs:0},{timeoutMs:1.5},{maxOutputBytes:0},{ffmpegExecutable:'ffmpeg'}])assert.throws(()=>validateSpokenlyConfig({...valid,...changed}))
})
for(const [mode,status,reason] of [['success','succeeded',undefined],['empty','no-speech',undefined],['failure','unavailable','provider-error'],['large','unavailable','output-limit'],['hang','unavailable','timeout']])test(`Spokenly ${mode} result is bounded`,async()=>{
  const f=await fixture(mode),provider=adapter(f.executable)
  try {const result=await provider.transcribe(input(f.audio,new AbortController().signal));assert.equal(result.status,status);if(reason)assert.equal(result.reason,reason);if(mode==='success')assert.equal(result.text,'hello from audio')}finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
test('abort terminates a hung owned CLI',async()=>{
  const f=await fixture('hang'),provider=adapter(f.executable,10000),controller=new AbortController()
  try {const pending=provider.transcribe(input(f.audio,controller.signal));await new Promise(resolve=>setTimeout(resolve,100));controller.abort();const result=await pending;assert.equal(result.reason,'cancelled')}finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
test('readiness rejects a hung version probe and terminates it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kipster-spokenly-version-'))
  const executable=join(dir,'spokenly')
  await writeFile(executable,'#!/usr/bin/env node\nsetInterval(()=>{},1000)\n')
  await chmod(executable,0o700)
  const provider=adapter(executable)
  try {const started=Date.now();const result=await provider.readiness();assert.equal(result.ready,false);assert.ok(Date.now()-started<4000)}finally{await provider.close();await rm(dir,{recursive:true,force:true})}
})

test('extensionless supported input gets a temporary extension and preserves original',async()=>{
  const {readFile,access}=await import('node:fs/promises')
  const f=await fixture('success'),provider=adapter(f.executable)
  const source=join(f.dir,'original'),seen=join(f.dir,'seen')
  await writeFile(source,'original bytes')
  await writeFile(f.executable,`#!/usr/bin/env node\nconst fs=require('fs');if(process.argv[2]==='--version'){console.log('spokenly 1');process.exit(0)}const p=process.argv[3];fs.writeFileSync(${JSON.stringify(seen)},p);if(!p.endsWith('.wav')||fs.readFileSync(p,'utf8')!=='original bytes')process.exit(7);console.log('accepted');`)
  try {
    assert.equal((await provider.transcribe(input(source,new AbortController().signal))).text,'accepted')
    assert.equal(await readFile(source,'utf8'),'original bytes')
    await assert.rejects(access(await readFile(seen,'utf8')))
  } finally {await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
for(const mode of ['success','failure','hang','cancel'])test(`WebM conversion ${mode} is bounded and cleaned`,async()=>{
  const {readFile,access}=await import('node:fs/promises')
  const f=await fixture('success'),seen=join(f.dir,'converted-path'),converter=join(f.dir,'ffmpeg')
  await writeFile(converter,`#!/usr/bin/env node\nconst fs=require('fs');const p=process.argv.at(-1);fs.writeFileSync(${JSON.stringify(seen)},p);if(${JSON.stringify(mode)}==='failure')process.exit(7);if(['hang','cancel'].includes(${JSON.stringify(mode)})){setInterval(()=>{},1000)}else{fs.writeFileSync(p,'RIFFconverted')}`)
  await chmod(converter,0o700)
  const provider=new SpokenlyAdapter({executable:f.executable,ffmpegExecutable:converter,timeoutMs:1000,maxOutputBytes:1024})
  const controller=new AbortController()
  try {
    const pending=provider.transcribe({...input(f.audio,controller.signal),mimeType:'audio/webm;codecs=opus'})
    if(mode==='cancel') {for(let i=0;i<100;i++){try{await access(seen);break}catch{await new Promise(r=>setTimeout(r,10))}}controller.abort()}
    const result=await pending
    assert.equal(result.status,mode==='success'?'succeeded':'unavailable')
    if(mode!=='success')assert.equal(result.reason,({failure:'provider-error',hang:'timeout',cancel:'cancelled'})[mode])
    await assert.rejects(access(await readFile(seen,'utf8')))
    assert.equal(await readFile(f.audio,'utf8'),'RIFFtest')
  }finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
test('unsupported input without a converter reports unavailable',async()=>{
  const f=await fixture('success'),provider=adapter(f.executable)
  try{assert.equal((await provider.transcribe({...input(f.audio,new AbortController().signal),mimeType:'audio/webm'})).reason,'unavailable')}
  finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})

test('oversized conversion is rejected before transcription and cleaned',async()=>{
  const {readFile,access}=await import('node:fs/promises')
  const f=await fixture('success'),converter=join(f.dir,'ffmpeg'),seen=join(f.dir,'seen')
  await writeFile(converter,`#!/usr/bin/env node\nconst fs=require('fs');const p=process.argv.at(-1);fs.writeFileSync(${JSON.stringify(seen)},p);fs.writeFileSync(p,'');fs.truncateSync(p,100*1024*1024);`)
  await chmod(converter,0o700)
  const provider=new SpokenlyAdapter({executable:f.executable,ffmpegExecutable:converter,timeoutMs:1000,maxOutputBytes:1024})
  try {
    assert.equal((await provider.transcribe({...input(f.audio,new AbortController().signal),mimeType:'audio/webm'})).reason,'output-limit')
    await assert.rejects(access(await readFile(seen,'utf8')))
  }finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
test('configured converter must exist and use an absolute path',async()=>{
  const f=await fixture('success')
  const config={executable:f.executable,timeoutMs:1000,maxOutputBytes:1024}
  assert.throws(()=>validateSpokenlyConfig({...config,ffmpegExecutable:'ffmpeg'}))
  const provider=new SpokenlyAdapter({...config,ffmpegExecutable:join(f.dir,'missing')})
  try {assert.equal((await provider.readiness()).ready,false)}finally{await provider.close();await rm(f.dir,{recursive:true,force:true})}
})
