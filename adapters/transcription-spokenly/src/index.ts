import { spawn, type ChildProcess } from 'node:child_process'
import { access, constants, copyFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { TranscriptionInput, TranscriptionProvider, TranscriptionResult } from '@kipster/core/transcription'

export interface SpokenlyConfig {
  executable: string
  ffmpegExecutable?: string
  timeoutMs?: number
  maxOutputBytes?: number
}
export interface ResolvedSpokenlyConfig { executable: string; ffmpegExecutable?: string; timeoutMs: number; maxOutputBytes: number }
export function validateSpokenlyConfig(value: unknown): ResolvedSpokenlyConfig {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (typeof row.executable !== 'string' || !isAbsolute(row.executable) ||
      (row.timeoutMs !== undefined && (!Number.isSafeInteger(row.timeoutMs) || Number(row.timeoutMs) < 1)) ||
      (row.maxOutputBytes !== undefined && (!Number.isSafeInteger(row.maxOutputBytes) || Number(row.maxOutputBytes) < 1)) ||
      (row.ffmpegExecutable !== undefined && (typeof row.ffmpegExecutable !== 'string' || !isAbsolute(row.ffmpegExecutable)))) throw new Error('Invalid Spokenly transcription configuration')
  return {executable:row.executable, ...(row.ffmpegExecutable !== undefined ? {ffmpegExecutable:row.ffmpegExecutable as string} : {}), timeoutMs:(row.timeoutMs as number | undefined) ?? 60000, maxOutputBytes:(row.maxOutputBytes as number | undefined) ?? 1048576}
}
function killOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch { /* already gone */ } }
}
export class SpokenlyAdapter implements TranscriptionProvider {
  readonly id = 'spokenly-cli'
  readonly contractMajor = 1 as const
  readonly inputTypes = ['audio/*','video/*'] as const
  private readonly config: ResolvedSpokenlyConfig
  private readonly active = new Set<ChildProcess>()
  constructor(config: SpokenlyConfig) { this.config = validateSpokenlyConfig(config) }
  async readiness(): Promise<{ready:boolean;reason?:string}> {
    try { await access(this.config.executable, constants.X_OK) }
    catch { return {ready:false,reason:'Spokenly executable unavailable'} }
    if (this.config.ffmpegExecutable) {
      try { await access(this.config.ffmpegExecutable, constants.X_OK) }
      catch { return {ready:false,reason:'FFmpeg executable unavailable'} }
    }
    return new Promise(resolve=>{
      const child=spawn(this.config.executable,['--version'],{stdio:['ignore','pipe','pipe'],detached:true})
      this.active.add(child)
      let version='',done=false
      const finish=(ready:boolean)=>{if(done)return;done=true;clearTimeout(timer);resolve(ready?{ready:true}:{ready:false,reason:'Spokenly CLI version check failed'})}
      const terminate=()=>{killOwned(child,'SIGTERM');setTimeout(()=>killOwned(child,'SIGKILL'),2000).unref();finish(false)}
      const timer=setTimeout(terminate,2000)
      child.stdout!.on('data',(chunk:Buffer)=>{version+=chunk.toString('utf8');if(version.length>1024)terminate()})
      child.stderr!.resume()
      child.once('error',()=>{this.active.delete(child);finish(false)})
      child.once('close',code=>{this.active.delete(child);finish(code===0&&/^spokenly [0-9]/.test(version.trim()))})
    })
  }
  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (input.signal.aborted) return {status:'unavailable',reason:'cancelled',provider:this.id}
    if (!isAbsolute(input.path) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > 100 * 1024 * 1024) return {status:'unavailable',reason:'invalid-input',provider:this.id}
    if (!(await this.readiness()).ready) return {status:'unavailable',reason:'unavailable',provider:this.id}
    const deadline = Date.now() + this.config.timeoutMs
    let directory: string | undefined
    try {
      if (input.signal.aborted) return {status:'unavailable',reason:'cancelled',provider:this.id}
      directory = await mkdtemp(join(tmpdir(), 'kipster-spokenly-input-'))
      const mime = input.mimeType.split(';')[0].trim().toLowerCase()
      const extensions: Record<string,string> = {'audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/flac':'flac','audio/x-flac':'flac','audio/ogg':'ogg','audio/opus':'opus','video/mp4':'mp4','video/quicktime':'mov'}
      const extension = extensions[mime]
      const prepared = join(directory, extension ? `input.${extension}` : 'input.wav')
      if (extension) {
        await copyFile(input.path, prepared)
      } else {
        if (!this.config.ffmpegExecutable) return {status:'unavailable',reason:'unavailable',provider:this.id}
        // Restrict decoding to the local input, with no playlist/network protocols.
        // Bound disk use as well as elapsed time; never transcribe a truncated output.
        const limit = 100 * 1024 * 1024
        const converted = await this.run(this.config.ffmpegExecutable, ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',input.path,'-map','0:a:0','-vn','-ac','1','-ar','48000','-c:a','pcm_s16le','-fs',String(limit),prepared], input.signal, deadline)
        if (converted.status === 'unavailable') return converted
        if ((await stat(prepared)).size >= limit) return {status:'unavailable',reason:'output-limit',provider:this.id}
      }
      return await this.run(this.config.executable, ['transcribe',prepared,'--format','text'], input.signal, deadline)
    } catch {
      return {status:'unavailable',reason:input.signal.aborted?'cancelled':'provider-error',provider:this.id}
    } finally {
      if (directory) await rm(directory,{recursive:true,force:true})
    }
  }
  private async run(executable: string, args: string[], signal: AbortSignal, deadline: number): Promise<TranscriptionResult> {
    if (signal.aborted) return {status:'unavailable',reason:'cancelled',provider:this.id}
    if (Date.now() >= deadline) return {status:'unavailable',reason:'timeout',provider:this.id}
    return new Promise(resolve => {
      let child: ChildProcess
      try { child = spawn(executable,args,{stdio:['ignore','pipe','pipe'],detached:true,env:process.env}) }
      catch { resolve({status:'unavailable',reason:'unavailable',provider:this.id});return }
      this.active.add(child)
      let done = false, output = '', bytes = 0, reason: 'timeout'|'cancelled'|'output-limit'|null = null
      const finish = (result: TranscriptionResult) => { if (done) return; done=true; clearTimeout(timer); signal.removeEventListener('abort',abort); this.active.delete(child); resolve(result) }
      const abort = () => { reason='cancelled'; killOwned(child,'SIGTERM'); setTimeout(()=>killOwned(child,'SIGKILL'),2000).unref() }
      const timer = setTimeout(()=>{reason='timeout';killOwned(child,'SIGTERM');setTimeout(()=>killOwned(child,'SIGKILL'),2000).unref()},Math.max(1,deadline-Date.now()))
      signal.addEventListener('abort',abort,{once:true})
      if (signal.aborted) abort()
      child.stdout!.on('data',(chunk:Buffer)=>{ bytes+=chunk.length; if(bytes>this.config.maxOutputBytes){reason='output-limit';killOwned(child,'SIGTERM');setTimeout(()=>killOwned(child,'SIGKILL'),2000).unref();return} output+=chunk.toString('utf8') })
      child.stderr!.on('data',()=>{})
      child.once('error',()=>finish({status:'unavailable',reason:'unavailable',provider:this.id}))
      child.once('close',code=>{ if(reason) finish({status:'unavailable',reason,provider:this.id}); else if(code!==0) finish({status:'unavailable',reason:'provider-error',provider:this.id}); else {const text=output.trim();finish({status:text?'succeeded':'no-speech',text,provider:this.id})} })
    })
  }
  async close(): Promise<void> {
    const children=[...this.active]
    if(!children.length)return
    const closed=Promise.all(children.map(child=>new Promise<void>(resolve=>child.once('close',()=>resolve()))))
    for(const child of children)killOwned(child,'SIGTERM')
    await Promise.race([closed,new Promise<void>(resolve=>setTimeout(resolve,2000))])
    for(const child of children)killOwned(child,'SIGKILL')
    await Promise.race([closed,new Promise<void>(resolve=>setTimeout(resolve,2000))])
  }
}
export function createTranscriptionProvider(config: unknown): TranscriptionProvider { return new SpokenlyAdapter(config as SpokenlyConfig) }
