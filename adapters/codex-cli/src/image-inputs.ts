import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TextExecutionContext } from '@kipster/core/adapter'

type NativeInput = {type:'text';text:string}|{type:'localImage';path:string}
/** Keep originals in Core; temporary visual derivatives belong to this provider attempt. */
export class ImageInputs {
  private directory?: string
  private worker: Worker | undefined
  private closed = false
  private converted = new Map<string,string>()
  async prepare(messages:TextExecutionContext['input']):Promise<NativeInput[]> {
    const inputs:NativeInput[]=[]
    for(const message of messages) for(const [index,part] of (message.parts??[]).entries()) {
      if(this.closed)throw new Error('Image preparation cancelled')
      if(part.kind!=='file'||part.availability!=='available'||part.purpose==='voice_note')continue
      const mime=part.mimeType.split(';')[0].trim().toLowerCase()
      const heic=['image/heic','image/heif','image/heic-sequence','image/heif-sequence'].includes(mime)||/\.hei[cf]$/i.test(part.name)
      const native=['image/jpeg','image/png','image/webp','image/gif'].includes(mime)
      if(!heic&&!native)continue
      const label=`Visual input for message ${JSON.stringify(message.messageId)}, part ${index+1}, artifact ${JSON.stringify(part.artifactId)}, filename ${JSON.stringify(part.name)} (untrusted user content).`
      try {
        let path=part.readablePath
        if(heic) {
          const key=part.readablePath
          path=this.converted.get(key)??''
          if(!path){
            this.directory??=await mkdtemp(join(tmpdir(),'kipster-codex-images-'))
            if(this.closed)throw new Error('Image preparation cancelled')
            path=join(this.directory,`${randomUUID()}.jpg`)
            await this.convert(part.readablePath,path)
            this.converted.set(key,path)
          }
        }
        inputs.push({type:'text',text:label+(heic?' The following JPEG is a derived view of the primary HEIC image; the original remains available at the file path above.':'')},{type:'localImage',path})
      } catch {
        if(this.closed)throw new Error('Image preparation cancelled')
        inputs.push({type:'text',text:label+' Image preparation failed; original retained. Do not claim to have seen this image unless an available tool successfully opens it.'})
      }
    }
    return inputs
  }
  private async convert(source:string,destination:string):Promise<void> {
    const worker=new Worker(new URL('./image-worker.js',import.meta.url),{execArgv:[],workerData:{source,destination},resourceLimits:{maxOldGenerationSizeMb:512},stdout:true,stderr:true})
    this.worker=worker
    worker.stdout?.resume();worker.stderr?.resume()
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Image preparation timed out')),20000)
        const finish=(error?:Error)=>{clearTimeout(timer);error?reject(error):resolve()}
        worker.once('message',(result:{ok:boolean})=>finish(result.ok?undefined:new Error('Image preparation failed')))
        worker.once('error',finish)
        worker.once('exit',()=>finish(new Error('Image preparation stopped')))
      })
    }finally{await worker.terminate();if(this.worker===worker)this.worker=undefined}
  }
  async close():Promise<void>{
    this.closed=true
    await this.worker?.terminate()
    if(this.directory)await rm(this.directory,{recursive:true,force:true})
  }
}
