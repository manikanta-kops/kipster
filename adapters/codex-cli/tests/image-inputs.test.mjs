import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,access,rm,copyFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {decode} from 'jpeg-js'
import {ImageInputs} from '../dist/image-inputs.js'
const fixture=new URL('./fixtures/red.heic',import.meta.url)
const part=(path,mimeType='image/heic')=>({kind:'file',artifactId:'image',purpose:'attachment',name:'photo.heic',mimeType,size:1024,availability:'available',readablePath:path})
const messages=parts=>[{messageId:'message',text:'Inspect',parts}]

test('extensionless HEIC becomes a correctly oriented JPEG; original retained and derivative cleaned',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kipster-image-test-')),source=join(dir,'original')
  await copyFile(fixture,source)
  const before=await readFile(source),images=new ImageInputs()
  try {
    const prepared=await images.prepare(messages([part(source),part(source)]))
    assert.equal(prepared[1].type,'localImage')
    assert.equal(prepared[1].path,prepared[3].path)
    assert.match(prepared[0].text,/message.*part 1.*artifact/)
    const {data,width,height}=decode(await readFile(prepared[1].path),{maxResolutionInMP:1,maxMemoryUsageInMB:32})
    assert.equal(width,48);assert.equal(height,32)
    assert.ok(data[0]>180&&data[1]<60&&data[2]<60,'decoded primary image remains red')
    assert.deepEqual(await readFile(source),before)
    await images.close()
    await assert.rejects(access(prepared[1].path))
  } finally {await images.close();await rm(dir,{recursive:true,force:true})}
})
test('native images pass through, unavailable and ordinary attachments do not become images',async()=>{
  const images=new ImageInputs()
  try {
    const native={...part('/original.png','image/png'),name:'original.png'}
    const prepared=await images.prepare(messages([native,{...native,availability:'unavailable'},{...native,mimeType:'text/plain'},{...native,purpose:'voice_note'}]))
    assert.equal(prepared.length,2);assert.equal(prepared[1].path,'/original.png')
  }finally{await images.close()}
})
test('corrupt HEIC reports failure while later images remain available',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'kipster-image-bad-')),source=join(dir,'broken')
  await writeFile(source,'not a HEIC')
  const images=new ImageInputs()
  try {
    const prepared=await images.prepare(messages([part(source),{...part('/ok.jpg','image/jpeg'),name:'ok.jpg'}]))
    assert.match(prepared[0].text,/Image preparation failed; original retained/)
    assert.equal(prepared[2].type,'localImage')
    assert.equal(prepared[2].path,'/ok.jpg')
  }finally{await images.close();await rm(dir,{recursive:true,force:true})}
})
test('closing stops active preparation and prevents subsequent work',async()=>{
  const images=new ImageInputs()
  const pending=images.prepare(messages([part(new URL('./fixtures/red.heic',import.meta.url).pathname)]))
  await images.close()
  await assert.rejects(pending,/cancelled/)
  await images.close()
})
