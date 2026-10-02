import { applyAdminApproval, approvedInstall, recordInstall } from '../../workflows/admin-approvals.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import type { Runtime } from '../../runtime.js'
import type { TrustedActor } from '../../modules/identity/public.js'
import { resolveDirectChat, acceptText } from '../../modules/conversations/public.js'
import { eventSignals, snapshot, readEvents, markNotificationRead, type Stream, type SnapshotPage } from '../../modules/synchronization/public.js'
import { AgentNotArchivedError, OperationConflictError, OrderConflictError, readDirectory } from '../../modules/administration/public.js'
import { administrationRoute, ServiceUnavailableError } from './admin.js'
import { UpdateRefusedError } from '../../modules/updates/public.js'
import { protocolRange } from '../../protocol/version.js'
import { context as contextSchema, textSubmission, controlCommand, interactionResponseCommand, learningUpdate, agentLearningUpdate, identityWrite, identityRestore, type Context } from '../../protocol/text.js'
import type { TextDispatcher, ControlInput } from '../../workflows/text-dispatch.js'
import { answerInteraction, interactionReceipt, type InteractionAnswer } from '../../modules/work/public.js'
import { MAX_UPLOAD_BYTES, type ArtifactTarget, type UploadIntent } from '../../modules/artifacts/public.js'
import { listIdentityBackups, readIdentityBackup, readIdentityFile, readInterfacePreferences, restoreIdentityBackup, writeIdentityFile, writeInterfacePreferences } from '../../modules/settings/public.js'
import { interfacePreferencesWrite } from '../../protocol/admin.js'
import { IdentityConflictError, MAX_IDENTITY_BYTES, type IdentityFileName } from '../../platform/home/public.js'
import { RefusedError } from '../../platform/errors/public.js'

export interface TextServer { url: string; close(): Promise<void> }
const maxBodyBytes = 64 * 1024

function json(response: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' })
  response.end(data)
}
function errorCode(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : 'Unexpected failure'
  if (message === 'resync-required') return { status: 409, code: 'resync-required', message }
  if (error instanceof RefusedError) return { status: error.code === 'membership-removed' ? 403 : error.code === 'agent-archived' ? 409 : 410, code: error.code, message }
  if (error instanceof ServiceUnavailableError) return { status: 503, code: 'unavailable', message }
  if (error instanceof UpdateRefusedError) return { status: 409, code: error.code, message }
  if (error instanceof IdentityConflictError || error instanceof OperationConflictError || error instanceof OrderConflictError || error instanceof AgentNotArchivedError) return { status: 409, code: 'conflict', message }
  if (/denied|mismatch|unauthorized/i.test(message)) return { status: 403, code: 'forbidden', message }
  if (/not found/i.test(message)) return { status: 404, code: 'not-found', message }
  if (/Invalid|Expected|Unknown|Future|missing|required/i.test(message) || error instanceof SyntaxError || error instanceof TypeError) return { status: 400, code: 'invalid', message }
  return { status: 500, code: 'unavailable', message: 'Request failed' }
}
async function body(request: IncomingMessage, limit = maxBodyBytes): Promise<unknown> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > limit) throw new Error('Invalid request body size')
    chunks.push(part)
  }
  if (!bytes) throw new Error('Invalid empty request body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
function directChatInput(value: unknown): { version: 1; context: Context; agentId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid direct chat request')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['version','context','agentId'].includes(key)) || row.version !== 1 || typeof row.agentId !== 'string' || !row.agentId) throw new Error('Invalid direct chat request')
  return { version: 1, context: contextSchema.parse(row.context), agentId: row.agentId }
}
function mediaTarget(value: unknown): ArtifactTarget {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid media target')
  const row=value as Record<string,unknown>
  if(Object.keys(row).some(key=>!['installationId','callerId','context','chatId','threadId'].includes(key))||typeof row.installationId!=='string'||typeof row.callerId!=='string'||typeof row.chatId!=='string'||(row.threadId!==undefined&&typeof row.threadId!=='string'))throw new Error('Invalid media target')
  return {installationId:row.installationId,callerId:row.callerId,context:contextSchema.parse(row.context),chatId:row.chatId,...(typeof row.threadId==='string'?{threadId:row.threadId}:{})}
}
function mediaIntent(value: unknown): UploadIntent {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid upload intent')
  const row=value as Record<string,unknown>
  if(Object.keys(row).some(key=>!['uploadId','target','name','mimeType','size','sha256','purpose'].includes(key))||typeof row.uploadId!=='string'||typeof row.name!=='string'||typeof row.mimeType!=='string'||typeof row.sha256!=='string'||typeof row.size!=='number'||(row.purpose!=='attachment'&&row.purpose!=='voice_note'))throw new Error('Invalid upload intent')
  return {uploadId:row.uploadId,target:mediaTarget(row.target),name:row.name,mimeType:row.mimeType,size:row.size,sha256:row.sha256,purpose:row.purpose}
}
function mediaQuery(url: URL): ArtifactTarget {const value=url.searchParams.get('target');if(!value||value.length>4096)throw new Error('Invalid media target');return mediaTarget(JSON.parse(value))}
function scope(actor: TrustedActor, path: string): Stream | null {
  if (path === '/v1/app/snapshot' || path === '/v1/app/events') return { kind: 'application', installationId: actor.installationId, callerId: actor.personId }
  const match = /^\/v1\/threads\/([0-9a-f-]{36})\/(snapshot|events)$/.exec(path)
  return match ? { kind: 'thread', installationId: actor.installationId, callerId: actor.personId, threadId: match[1]! } : null
}
export function drainOrClose(response: ServerResponse, timeoutMs = 5000): Promise<boolean> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (drained: boolean) => {
      clearTimeout(timer)
      response.off('drain', onDrain)
      response.off('close', onClose)
      resolve(drained)
    }
    const onDrain = () => finish(true)
    const onClose = () => finish(false)
    response.once('drain', onDrain)
    response.once('close', onClose)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

/** Canonical HTTP authority, without accepting a path, credentials or forwarded headers. */
function authority(value: string): string {
  if (!value || /[\s/\\?#@]/.test(value)) throw new Error('Invalid allowed host')
  const parsed = new URL(`http://${value}`)
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Invalid allowed host')
  return parsed.host
}

/** Trusted-owner HTTP binding. Public network authentication belongs to installation assembly. */
export async function startTextServer(runtime: Runtime, actor: TrustedActor, options: { host: string; port: number; allowedOrigins?: readonly string[]; allowedHosts?: readonly string[]; afterAccepted?: (runId: string) => Promise<void>; dispatcher?: TextDispatcher }): Promise<TextServer> {
  const coreVersion = (JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version
  const streams = new Map<ServerResponse, () => void>()
  const allowedHosts = new Set((options.allowedHosts ?? []).map(authority))
  let listeningOrigin = ''
  let listeningAuthority = ''
  const allowedOrigins = new Set((options.allowedOrigins ?? []).map(origin => {
    // The packaged macOS client uses this exact non-opaque WebKit origin.
    // It is trusted only when the installation explicitly lists it.
    if (origin === 'tauri://localhost') return origin
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('Invalid allowed origin')
    return origin
  }))
  const signals = await eventSignals(runtime.db)
  const server = createServer(async (request, response) => {
    const requestId = randomUUID()
    try {
      response.setHeader('Vary', 'Origin')
      let host: string
      try { host = authority(request.headers.host ?? '') } catch {
        json(response, 403, { version: 1, code: 'forbidden', message: 'Host is not allowed', requestId }); return
      }
      if (host !== listeningAuthority && !allowedHosts.has(host)) {
        json(response, 403, { version: 1, code: 'forbidden', message: 'Host is not allowed', requestId }); return
      }
      const target = request.url ?? '/'
      if (!target.startsWith('/') || target.startsWith('//')) throw new Error('Invalid request target')
      const url = new URL(target, listeningOrigin)
      const path = url.pathname
      const origin = request.headers.origin
      const sameOrigin = origin === listeningOrigin
      if (origin && !sameOrigin && !allowedOrigins.has(origin)) {
        json(response, 403, { version: 1, code: 'forbidden', message: 'Origin is not allowed', requestId })
        return
      }
      if (origin && (sameOrigin || allowedOrigins.has(origin))) {
        response.setHeader('Access-Control-Allow-Origin', origin)
        if (request.method === 'OPTIONS') {
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
          response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
          response.setHeader('Access-Control-Max-Age', '600')
          response.writeHead(204)
          response.end()
          return
        }
      }
      if (request.method === 'OPTIONS') {
        json(response, 403, { version: 1, code: 'forbidden', message: 'Origin is not allowed', requestId })
        return
      }
      if (request.method === 'GET' && path === '/v1/bootstrap') { const voiceRecording=runtime.transcription ? (await runtime.transcription.readiness()).ready && runtime.transcription.inputTypes.some(type=>type.trim().toLowerCase().startsWith('audio/')) : false; json(response, 200, { version: 1, coreVersion, protocol: protocolRange, installationId: runtime.bootstrap.installationId, callerId: runtime.bootstrap.ownerId, organizationId: runtime.bootstrap.organizationId, rootAgentId: runtime.bootstrap.rootAgentId, capabilities:{voiceRecording,updates:true,interfacePreferences:true} }); return }
      if(request.method==='GET'&&path==='/conversations/media/capabilities'){json(response,200,{maxUploadBytes:MAX_UPLOAD_BYTES});return}
      const uploadMatch=/^\/conversations\/media\/uploads\/([0-9a-f-]{36})$/.exec(path)
      if(uploadMatch&&request.method==='PUT'){
        const raw=url.searchParams.get('intent')
        if(!raw||raw.length>4096)throw new Error('Invalid upload intent')
        const intent=mediaIntent(JSON.parse(raw))
        if(intent.uploadId!==uploadMatch[1])throw new Error('Upload identity mismatch')
        const length=request.headers['content-length']
        if(length===undefined||!/^\d+$/.test(length)||Number(length)!==intent.size||Number(length)>MAX_UPLOAD_BYTES)throw new Error('Invalid upload size')
        if(request.headers['content-type']!=='application/octet-stream')throw new Error('Invalid upload content type')
        json(response,200,await runtime.artifacts.upload(actor,intent,request));return
      }
      if(uploadMatch&&request.method==='GET'){json(response,200,await runtime.artifacts.uploadReceipt(actor,uploadMatch[1]!,mediaQuery(url)));return}
      const artifactMatch=/^\/conversations\/media\/artifacts\/([0-9a-f-]{36})(\/content)?$/.exec(path)
      if(artifactMatch&&request.method==='GET'){
        const target=mediaQuery(url),id=artifactMatch[1]!
        if(!artifactMatch[2]){json(response,200,await runtime.artifacts.get(actor,id,target));return}
        const file=await runtime.artifacts.content(actor,id,target)
        const filename=encodeURIComponent(file.metadata.name)
        response.writeHead(200,{'content-type':'application/octet-stream','content-length':file.bytes.length,'content-disposition':`attachment; filename="download"; filename*=UTF-8''${filename}`,'x-content-type-options':'nosniff','content-security-policy':'sandbox','cache-control':'no-store'})
        response.end(file.bytes);return
      }
      if (request.method === 'POST' && path === '/v1/direct-chats') {
        const input = directChatInput(await body(request))
        const result = await resolveDirectChat(runtime.db, actor, input.context, input.agentId)
        json(response, 200, { version: 1, ...result }); return
      }
      if (request.method === 'POST' && path === '/v1/text/submissions') {
        const input = textSubmission.parse(await body(request))
        const receipt = await acceptText(runtime.db, runtime.jobs, runtime.artifacts, actor, input)
        await options.afterAccepted?.(receipt.runId)
        json(response, 202, receipt); return
      }
      if (request.method === 'POST' && (path === '/v1/work/controls' || path === '/v1/work/controls/receipt')) {
        if (!options.dispatcher) throw new Error('Work controls unavailable')
        const row=controlCommand.parse(await body(request))
        const input: ControlInput = { operationId: row.operationId, context: row.context, chatId: row.chatId, threadId: row.threadId, runId: row.runId, action: row.action, ...(typeof row.attemptId==='string'?{attemptId:row.attemptId}:{}) }
        json(response, 200, path.endsWith('/receipt') ? await options.dispatcher.controlReceipt(actor,input) : await options.dispatcher.control(actor, input)); return
      }
      if (request.method === 'POST' && (path === '/v1/work/interactions/answer' || path === '/v1/work/interactions/receipt')) {
        const row=interactionResponseCommand.parse(await body(request))
        const target={ operationId: row.operationId, interactionId: row.interactionId, threadId: row.threadId, runId: row.runId, attemptId: row.attemptId }
        const result=path.endsWith('/receipt')?await interactionReceipt(runtime.db,actor,target):await answerInteraction(runtime.db, runtime.jobs, actor, { ...target, ...(row.proposalId ? { proposalId: row.proposalId } : {}), answer: row.answer as InteractionAnswer }, (client, card) => applyAdminApproval(client, runtime.jobs, actor, card))
        // An approved Core install starts once the answer is saved; its operation ID makes a repeated start return the first result.
        const install = 'outcome' in result && result.outcome === 'accepted' ? await approvedInstall(runtime.db, actor, row.interactionId) : null
        if (install) {
          try { await recordInstall(runtime.db, row.interactionId, await runtime.updates.install(actor, { version: 1, operationId: install.operationId, ...install.install })) }
          catch (error) { await recordInstall(runtime.db, row.interactionId, { error: error instanceof Error ? error.message : String(error) }) }
        }
        json(response, 200, { version: 1, operationId: row.operationId, ...result }); return
      }
      if (request.method === 'GET' && path === '/v1/directory') { json(response, 200, await readDirectory(runtime.db, actor)); return }
      const administration = await administrationRoute(runtime, actor, request.method ?? '', path, url.searchParams, limit => body(request, limit), options.dispatcher)
      if (administration) { json(response, 200, administration); return }
      if (path === '/v1/settings/interface' && request.method === 'GET') { json(response, 200, await readInterfacePreferences(runtime.db, actor)); return }
      if (path === '/v1/settings/interface' && request.method === 'PUT') { json(response, 200, await writeInterfacePreferences(runtime.db, actor, interfacePreferencesWrite.parse(await body(request)))); return }
      if (path === '/v1/settings/learning' && request.method === 'GET') { json(response, 200, { version: 1, ...await runtime.learning.get(actor) }); return }
      if (path === '/v1/settings/learning' && request.method === 'PUT') {
        const { version: _, ...update } = learningUpdate.parse(await body(request))
        json(response, 200, { version: 1, ...await runtime.learning.setInstallation(actor, update) }); return
      }
      const agentLearningMatch = /^\/v1\/agents\/([0-9a-f-]{36})\/learning$/.exec(path)
      if (agentLearningMatch && request.method === 'PUT') {
        const { version: _, ...update } = agentLearningUpdate.parse(await body(request))
        json(response, 200, { version: 1, ...await runtime.learning.setAgent(actor, agentLearningMatch[1]!, update) }); return
      }
      const identityMatch = /^\/v1\/agents\/([0-9a-f-]{36})\/identity\/(AGENTS\.md|soul\.md|identity\.md)(?:\/(backups)(?:\/([^/]+)(\/restore)?)?)?$/.exec(path)
      if (identityMatch) {
        const agentId = identityMatch[1]!, file = identityMatch[2] as IdentityFileName, backupId = identityMatch[4]
        const reply = (value: object) => json(response, 200, { version: 1, agentId, ...value })
        if (!identityMatch[3] && request.method === 'GET') { reply(await readIdentityFile(runtime.db, runtime.home, actor, agentId, file)); return }
        if (!identityMatch[3] && request.method === 'PUT') {
          const input = identityWrite.parse(await body(request, 8 * MAX_IDENTITY_BYTES))
          reply(await writeIdentityFile(runtime.db, runtime.home, actor, agentId, file, input.content, input.expectedSha256)); return
        }
        if (identityMatch[3] && !backupId && request.method === 'GET') { reply({ file, backups: await listIdentityBackups(runtime.db, runtime.home, actor, agentId, file) }); return }
        if (backupId && !identityMatch[5] && request.method === 'GET') { reply(await readIdentityBackup(runtime.db, runtime.home, actor, agentId, file, backupId)); return }
        if (backupId && identityMatch[5] && request.method === 'POST') {
          const input = identityRestore.parse(await body(request))
          reply(await restoreIdentityBackup(runtime.db, runtime.home, actor, agentId, file, backupId, input.expectedSha256)); return
        }
      }
      const receiptMatch = /^\/v1\/text\/receipts\/([^/]+)$/.exec(path)
      if (request.method === 'GET' && receiptMatch) {
        const allowed = await runtime.db.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [actor.installationId, actor.personId])
        if (!allowed.rows.length) throw new Error('Owner access denied')
        const found = await runtime.db.query<{ receipt: Record<string, unknown> }>('SELECT receipt FROM kipster.receipts WHERE installation_id=$1 AND caller_id=$2 AND submission_id=$3', [actor.installationId, actor.personId, decodeURIComponent(receiptMatch[1]!)])
        if (!found.rows[0]) throw new Error('Receipt not found')
        json(response, 200, { ...found.rows[0].receipt, version: 1, status: 'accepted', alreadyAccepted: true }); return
      }
      const notificationMatch = /^\/v1\/notifications\/([0-9a-f-]{36})\/read$/.exec(path)
      if (request.method === 'POST' && notificationMatch) {
        const input = await body(request)
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || (input as { version?: unknown }).version !== 1) throw new Error('Invalid read request')
        await markNotificationRead(runtime.db, { kind: 'application', installationId: actor.installationId, callerId: actor.personId }, notificationMatch[1]!)
        json(response, 200, { version: 1, status: 'read', notificationId: notificationMatch[1] }); return
      }
      const streamScope = scope(actor, path)
      if (request.method === 'GET' && streamScope && path.endsWith('/snapshot')) {
        const nonnegative = (name: string): number | undefined => {
          const value = url.searchParams.get(name)
          if (value === null) return undefined
          if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid page position')
          return Number(value)
        }
        const uuid = (name: string): string | undefined => {
          const value = url.searchParams.get(name)
          if (value === null) return undefined
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid page ID')
          return value
        }
        const page: SnapshotPage = {}
        const afterThreadId = uuid('afterThreadId'), afterNotificationId = uuid('afterNotificationId')
        const afterMessagePosition = nonnegative('afterMessagePosition'), afterWorkPosition = nonnegative('afterWorkPosition')
        if (afterThreadId) page.afterThreadId = afterThreadId
        if (afterNotificationId) page.afterNotificationId = afterNotificationId
        if (afterMessagePosition !== undefined) page.afterMessagePosition = afterMessagePosition
        if (afterWorkPosition !== undefined) page.afterWorkPosition = afterWorkPosition
        const atCursor = url.searchParams.get('at')
        if (atCursor !== null) page.atCursor = atCursor
        if ((afterThreadId || afterNotificationId || afterMessagePosition !== undefined || afterWorkPosition !== undefined) && !atCursor) throw new Error('Invalid missing snapshot cursor')
        const limit = nonnegative('limit')
        if (limit !== undefined) page.limit = limit
        json(response, 200, await snapshot(runtime.db, streamScope, page)); return
      }
      if (request.method === 'GET' && streamScope && path.endsWith('/events')) {
        const after = url.searchParams.get('after')
        if (!after) throw new Error('Invalid missing stream cursor')
        let closed = false
        let dirty = true
        let wake: (() => void) | undefined
        const signal = () => { dirty = true; wake?.() }
        const onClose = () => { closed = true; wake?.() }
        // Subscribe before any read. A notification during a read leaves dirty=true.
        const unsubscribe = signals.subscribe(streamScope.kind === 'thread' ? `t:${streamScope.threadId}` : `a:${streamScope.installationId}`, signal)
        response.on('close', onClose)
        let heartbeat: NodeJS.Timeout | undefined
        let fallback: NodeJS.Timeout | undefined
        let heartbeatDue = false
        let cursor = after
        try {
          await readEvents(runtime.db, streamScope, after, 1, 128 * 1024)
          if (closed) return
          response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
          response.flushHeaders()
          streams.set(response, onClose)
          heartbeat = setInterval(() => { heartbeatDue = true; wake?.() }, 20000)
          fallback = setInterval(signal, 30000)
          while (!closed) {
            if (heartbeatDue) {
              heartbeatDue = false
              if (!response.write(': heartbeat\n\n') && !await drainOrClose(response)) break
            }
            if (!dirty) {
              await new Promise<void>(resolve => { wake = resolve })
              wake = undefined
              continue
            }
            dirty = false
            const page = await readEvents(runtime.db, streamScope, cursor, 50, 128 * 1024)
            for (const event of page.events) {
              if (closed) break
              const frame = `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
              if (Buffer.byteLength(frame) > 256 * 1024) throw new Error('resync-required')
              if (!response.write(frame) && !await drainOrClose(response)) { closed = true; break }
              cursor = event.cursor
            }
            if (page.events.length) dirty = true
          }
        } catch (failure) {
          if (!response.headersSent) throw failure
          const code = errorCode(failure).code
          if (!closed && (code === 'resync-required' || code === 'gone')) response.write(`event: ${code}\ndata: {"version":1,"code":"${code}"}\n\n`)
        } finally {
          clearInterval(heartbeat)
          clearInterval(fallback)
          unsubscribe()
          response.off('close', onClose)
          streams.delete(response)
          if (response.headersSent) response.end()
        }
        return
      }
      json(response, 404, { version: 1, code: 'not-found', message: 'Route not found', requestId })
    } catch (failure) {
      if (response.headersSent) { response.destroy(); return }
      const mapped = errorCode(failure)
      json(response, mapped.status, { version: 1, code: mapped.code, message: mapped.message, requestId })
    }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, () => {
    server.off('error', reject)
    const address = server.address() as AddressInfo
    const hostname = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host
    const listening = new URL(`http://${hostname}:${address.port}`)
    listeningOrigin = listening.origin
    listeningAuthority = listening.host
    resolve()
  }) }).catch(error => { signals.close(); throw error })
  return { url: listeningOrigin, async close() {
    for (const [response, stop] of streams) { stop(); response.end() }
    signals.close()
    streams.clear()
    const deadline = setTimeout(() => server.closeAllConnections(), 1000)
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) } finally { clearTimeout(deadline) }
  } }
}
