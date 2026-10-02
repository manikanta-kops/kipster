import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AdapterRegistry } from '../dist/runtime.js'

const fixture = `import { value } from '../dependency.mjs'
export function createAdapter() {
  return {
    id: 'fixture', version: value, contractMajor: 1,
    async readiness() { return { ready: value !== 'fail', catalog: { models: [{ id: 'test' }], capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false } } } },
    async execute(context) {
      let ended = false
      return {
        events: (async function* () { await new Promise(resolve => setTimeout(resolve, 100)); ended = true; yield { kind: 'text', attemptId: context.attemptId, messageId: 'native', text: value, final: true }; yield { kind: 'ended', attemptId: context.attemptId, confirmed: true } })(),
        async cancel() { return { acknowledged: true, confirmedEnded: ended } },
        async reconcile() { return ended ? 'ended' : 'active' },
      }
    },
    async close() {},
  }
}`
const context = id => ({ runId: id, attemptId: id, organizationId: null, agentId: 'agent', instructions: '', settings: { adapterId: 'fixture', modelId: 'test' }, triggerMessageId: 'input', input: [{ messageId: 'input', text: 'hello' }] })

test('a symlinked current root registers and switches releases while existing generations keep their bytes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'kipster-registry-link-'))
  const registry = new AdapterRegistry({ now: () => '', async invokeTool() {} }, join(home, 'generations'))
  t.after(async () => { await registry.close(); await rm(home, { recursive: true, force: true }) })
  for (const version of ['one', 'two']) {
    const root = join(home, version)
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    await writeFile(join(root, 'dependency.mjs'), `export const value = '${version}'`)
    await writeFile(join(root, 'dist/index.mjs'), fixture)
  }
  const current = join(home, 'current')
  await symlink(join(home, 'one'), current)
  assert.equal((await registry.register('fixture', current, 'dist/index.mjs')).readiness.ready, true)
  const old = registry.selected('fixture', 'old')
  const handle = await old.adapter.execute(context('old'))
  await symlink(join(home, 'two'), join(home, 'next-current'))
  await rename(join(home, 'next-current'), current)
  assert.equal((await registry.register('fixture', current, 'dist/index.mjs')).readiness.ready, true)
  assert.equal(registry.adapters()[0].version, 'two')
  const events = []; for await (const event of handle.events) events.push(event)
  assert.equal(events.find(event => event.kind === 'text').text, 'one')
  old.release('old')
})

test('generation refresh pins transitive bytes, rolls back failed readiness and drains removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-test-'))
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  try {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'dist/index.mjs'), fixture)
    await writeFile(join(root, 'dependency.mjs'), "export const value = 'one'\n")
    const first = await registry.register('fixture', root, 'dist/index.mjs')
    const old = registry.selected('fixture', 'old')
    const reserved = registry.selected('fixture', 'reserved')
    const oldHandle = await old.adapter.execute(context('old'))
    assert.deepEqual(await oldHandle.cancel(), { acknowledged: true, confirmedEnded: false })
    await writeFile(join(root, 'dependency.mjs'), "export const value = 'two'\n")
    const second = await registry.register('fixture', root, 'dist/index.mjs')
    const reservedHandle = await reserved.adapter.execute(context('reserved'))
    assert.notEqual(first.installationDigest, second.installationDigest)
    const current = registry.selected('fixture', 'current')
    assert.notEqual(old.generationId, current.generationId)
    const currentHandle = await current.adapter.execute(context('current'))
    await writeFile(join(root, 'dependency.mjs'), "export const value = 'fail'\n")
    await assert.rejects(registry.register('fixture', root, 'dist/index.mjs'), /not ready/)
    await writeFile(join(root, 'dist/index.mjs'), `export function createAdapter(){return {id:'fixture',version:'bad',contractMajor:1,async readiness(){return {ready:true,catalog:{models:[{id:''}],capabilities:{text:true,publication:false,cancellation:true,steering:false,nativeResume:false}}}},async close(){}}}`)
    await assert.rejects(registry.register('fixture', root, 'dist/index.mjs'), /readiness mismatch/)
    assert.equal(registry.selected('fixture', 'probe').generationId, second.generationId)
    registry.selected('fixture', 'probe').release('probe')
    await registry.remove('fixture')
    assert.equal(registry.selected('fixture', 'later'), undefined)
    const oldEvents = []; for await (const event of oldHandle.events) oldEvents.push(event)
    const reservedEvents = []; for await (const event of reservedHandle.events) reservedEvents.push(event)
    const newEvents = []; for await (const event of currentHandle.events) newEvents.push(event)
    assert.equal(oldEvents.find(x => x.kind === 'text').text, 'one')
    assert.equal(reservedEvents.find(x => x.kind === 'text').text, 'one')
    assert.equal(newEvents.find(x => x.kind === 'text').text, 'two')
    old.release('old')
    reserved.release('reserved')
    current.release('current')
  } finally {
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('lost execute acknowledgement retains generation reservation and snapshot through removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-lost-ack-'))
  const installation = join(root, 'installation')
  const marker = join(root, 'issued.marker')
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } }, join(root, 'generations'), 80)
  let selected
  try {
    await mkdir(join(installation, 'dist'), { recursive: true })
    await writeFile(join(installation, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(installation, 'dist/index.mjs'), `import { writeFileSync } from 'node:fs'; export function createAdapter(){return {id:'fixture',version:'1',contractMajor:1,async readiness(){return {ready:true,catalog:{models:[{id:'test'}],capabilities:{text:true,publication:false,cancellation:true,steering:false,nativeResume:false}}}},async execute(context){writeFileSync(context.settings.options.marker,'issued');return new Promise(()=>{})},async close(){}}}`)
    await registry.register('fixture', installation, 'dist/index.mjs')
    selected = registry.selected('fixture', 'lost')
    await assert.rejects(selected.adapter.execute({ ...context('lost'), settings: { adapterId: 'fixture', modelId: 'test', options: { marker } } }), /timed out/)
    assert.equal(await readFile(marker, 'utf8'), 'issued')
    assert.equal(selected.adapter.active.has('lost'), true)
    await registry.remove('fixture')
    assert.equal((await lstat(selected.installationRoot)).isDirectory(), true)
  } finally {
    selected?.release('lost') // The test owns and has settled its harmless marker effect.
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('runner exit before execute handle leaves unknown ownership and closed admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-early-exit-'))
  const installation = join(root, 'installation')
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } }, join(root, 'generations'))
  let selected
  try {
    await mkdir(join(installation, 'dist'), { recursive: true })
    await writeFile(join(installation, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(installation, 'dist/index.mjs'), `export function createAdapter(){return {id:'fixture',version:'1',contractMajor:1,async readiness(){return {ready:true,catalog:{models:[{id:'test'}],capabilities:{text:true,publication:false,cancellation:true,steering:false,nativeResume:false}}}},async execute(){process.exit(42)},async close(){}}}`)
    await registry.register('fixture', installation, 'dist/index.mjs')
    selected = registry.selected('fixture', 'early-exit')
    await assert.rejects(selected.adapter.execute(context('early-exit')), /runner (disconnected|exited)/)
    assert.equal(selected.adapter.active.has('early-exit'), true)
    assert.equal(registry.selected('fixture', 'new'), undefined)
    await registry.remove('fixture')
    assert.equal((await lstat(selected.installationRoot)).isDirectory(), true)
  } finally {
    selected?.release('early-exit')
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('tool publication survives runner IPC disconnect without an unhandled send or replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-tool-disconnect-'))
  const installation = join(root, 'installation')
  const marker = join(root, 'publication.marker')
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  let release
  const barrier = new Promise(resolve => { release = resolve })
  let publications = 0
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { started(); await barrier; publications++; await writeFile(marker, 'committed'); return { status: 'completed' } } }, join(root, 'generations'))
  let selected
  try {
    await mkdir(join(installation, 'dist'), { recursive: true })
    await writeFile(join(installation, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(installation, 'dist/index.mjs'), `export function createAdapter(host){return {id:'fixture',version:'1',contractMajor:1,async readiness(){return {ready:true,catalog:{models:[{id:'test'}],capabilities:{text:true,publication:true,cancellation:true,steering:false,nativeResume:false}}}},async execute(context){void host.invokeTool({attemptId:context.attemptId,callId:'publish-1',name:'conversation.publish',arguments:{text:'saved'}}).catch(()=>{});return {events:(async function*(){await new Promise(()=>{})})(),async cancel(){return {acknowledged:false,confirmedEnded:false}},async reconcile(){return 'unknown'}}},async close(){}}}`)
    await registry.register('fixture', installation, 'dist/index.mjs')
    selected = registry.selected('fixture', 'tool-flight')
    const handle = await selected.adapter.execute(context('tool-flight'))
    await Promise.race([startedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Tool did not start')), 1000))])
    selected.adapter.child.disconnect()
    release()
    await assert.rejects(async () => { for await (const event of handle.events) void event }, /disconnected/)
    for (let n = 0; n < 100; n++) { try { if (await readFile(marker, 'utf8') === 'committed') break } catch {} await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal(await readFile(marker, 'utf8'), 'committed')
    assert.equal(publications, 1)
    assert.equal(selected.adapter.active.has('tool-flight'), true)
    await registry.remove('fixture')
    assert.equal((await lstat(selected.installationRoot)).isDirectory(), true)
  } finally {
    release?.()
    selected?.release('tool-flight')
    await Promise.race([registry.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Registry shutdown timed out')), 2000))])
    await rm(root, { recursive: true, force: true })
  }
})

test('runner death leaves descendant ownership uncertain and never replays execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-crash-'))
  const marker = join(root, 'descendant.pid')
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  let descendant
  let selected
  try {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'dist/index.mjs'), `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs';
      export function createAdapter() { return { id:'fixture', version:'1', contractMajor:1,
        async readiness() { return { ready:true, catalog:{ models:[{id:'test'}], capabilities:{text:true,publication:false,cancellation:true,steering:false,nativeResume:false} } } },
        async execute(context) { const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); child.unref(); writeFileSync(context.settings.options.marker,String(child.pid)); return { events:(async function*(){await new Promise(()=>{})})(), async cancel(){return {acknowledged:true,confirmedEnded:false}},async reconcile(){return 'unknown'} } },
        async close() {} } }`)
    await registry.register('fixture', root, 'dist/index.mjs')
    selected = registry.selected('fixture', 'crashed')
    const handle = await selected.adapter.execute({ ...context('crashed'), settings: { adapterId: 'fixture', modelId: 'test', options: { marker } } })
    for (let n = 0; n < 100; n++) { try { descendant = Number(await readFile(marker, 'utf8')); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) } }
    assert.ok(descendant)
    selected.adapter.child.kill('SIGKILL')
    await assert.rejects(async () => { for await (const event of handle.events) void event }, /runner (disconnected|exited)/)
    assert.doesNotThrow(() => process.kill(descendant, 0))
    assert.equal(await handle.reconcile().catch(() => 'unknown'), 'unknown')
    assert.equal(selected.adapter.active.has('crashed'), true)
    assert.equal((await lstat(selected.installationRoot)).isDirectory(), true)
    assert.equal(registry.selected('fixture', 'new'), undefined)
  } finally {
    if (descendant) { try { process.kill(-descendant, 'SIGKILL') } catch {} }
    selected?.release('crashed')
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a registered adapter forgets provider state when it can, and says so when it cannot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-forget-'))
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  const record = join(root, 'forgotten.json')
  const adapter = (id, forget) => `import { writeFile } from 'node:fs/promises'
export function createAdapter() {
  return {
    id: ${JSON.stringify(id)}, version: '1', contractMajor: 1,
    async readiness() { return { ready: true, catalog: { models: [{ id: 'test' }], capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false } } } },
    async execute() { throw new Error('unused') },
    ${forget ? `async forgetProviderState(request) { await writeFile(${JSON.stringify(record)}, JSON.stringify(request.threadIds)) },` : ''}
    async close() {},
  }
}`
  try {
    for (const [id, forget] of [['forgetting', true], ['plain', false]]) {
      await mkdir(join(root, id))
      await writeFile(join(root, id, 'package.json'), JSON.stringify({ type: 'module' }))
      await writeFile(join(root, id, 'index.mjs'), adapter(id, forget))
      await registry.register(id, join(root, id), 'index.mjs')
    }
    assert.equal(await registry.forgetProviderState('forgetting', ['thread-a', 'thread-b']), 'forgotten')
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), ['thread-a', 'thread-b'])
    assert.equal(await registry.forgetProviderState('plain', ['thread-c']), 'unsupported')
    assert.equal(await registry.forgetProviderState('missing', ['thread-d']), 'unavailable')
  } finally {
    await registry.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('initialization cancellation bounds an uncooperative close to the owned runner', {timeout:15000}, async t => {
  const root=await mkdtemp(join(tmpdir(),'kipster-init-close-'))
  const marker=join(root,'runner-pid'), installation=join(root,'installation')
  await mkdir(installation)
  await writeFile(join(installation,'index.mjs'),`import {writeFileSync} from 'node:fs';export function createAdapter(){return {id:'fixture',version:'1',contractMajor:1,readiness:async()=>{writeFileSync(${JSON.stringify(marker)},String(process.pid));await new Promise(()=>{setInterval(()=>{},1000)})},close:async()=>new Promise(()=>{})}}`)
  const registry=new AdapterRegistry({now:()=>new Date().toISOString(),invokeTool:async()=>{throw Error('Unexpected tool')}},join(root,'generations'))
  const abort=new AbortController()
  const pending=registry.register('fixture',installation,'index.mjs',abort.signal)
  const settled=pending.catch(error=>error)
  t.after(async()=>{abort.abort();await settled;await registry.close();await rm(root,{recursive:true,force:true})})
  let pid
  for(let i=0;i<150&&!pid;i++){pid=Number(await readFile(marker,'utf8').catch(()=>''));if(!pid)await new Promise(resolve=>setTimeout(resolve,20))}
  assert.ok(pid,'readiness reached the barrier')
  const started=Date.now();abort.abort()
  assert.ok(await settled instanceof Error)
  assert.ok(Date.now()-started<8000,'cooperative close has a bounded fallback')
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
  assert.deepEqual(registry.adapters(),[])
})

test('adapter configuration crosses the runner boundary and remains pinned per generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-config-'))
  const registry = new AdapterRegistry({ now: () => '', async invokeTool() {} })
  try {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'dependency.mjs'), "export const value = 'fixture'\n")
    await writeFile(join(root, 'dist/index.mjs'), fixture.replace('createAdapter()', 'createAdapter(host, config)').replace("text: value, final: true", "text: JSON.stringify(config), final: true"))
    await registry.register('fixture', root, 'dist/index.mjs', undefined, { providerSpecific: { home: '/first' } })
    const old = registry.selected('fixture', 'old-config')
    const oldHandle = await old.adapter.execute(context('old-config'))
    await registry.register('fixture', root, 'dist/index.mjs', undefined, { providerSpecific: { home: '/second' } })
    const next = registry.selected('fixture', 'new-config')
    const newHandle = await next.adapter.execute(context('new-config'))
    const events = []; for await (const event of oldHandle.events) events.push(event)
    const updated = []; for await (const event of newHandle.events) updated.push(event)
    assert.equal(JSON.parse(events.find(event => event.kind === 'text').text).providerSpecific.home, '/first')
    assert.equal(JSON.parse(updated.find(event => event.kind === 'text').text).providerSpecific.home, '/second')
    old.release('old-config'); next.release('new-config')
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }) }
})

test('an adapter receives the data directory Core reserves for it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kipster-registry-data-'))
  const registry = new AdapterRegistry({ now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'index.mjs'), `export function createAdapter(host) {
  return { id: 'fixture', version: '1', contractMajor: 1,
    async readiness() { return { ready: true, catalog: { models: [{ id: String(host.dataDirectory) }], capabilities: { text: true, publication: false, cancellation: true, steering: false, nativeResume: false } } } },
    async execute() { throw new Error('Unexpected execution') }, async close() {} }
}`)
    const data = join(root, 'providers', 'fixture')
    assert.equal((await registry.register('fixture', root, 'index.mjs', undefined, undefined, data)).readiness.catalog.models[0].id, data)
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }) }
})
