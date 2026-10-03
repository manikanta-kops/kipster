import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createAdapter } from '../dist/index.js'

const allowedEnvironment = /^(__CF_USER_TEXT_ENCODING|HOME|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|PATH|LANG|LC_[A-Z]+|TZ|TMPDIR|USER|LOGNAME|SHELL|TERM|SSL_CERT_(FILE|DIR)|CODEX_CA_CERTIFICATE|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/
const profile = ['features.apps=false', 'features.plugins=false', 'features.shell_tool=false', 'features.unified_exec=false', 'features.image_generation=false', 'features.view_image=false', 'web_search="disabled"']
const author = '6f1c2a57-3f0e-4a8e-9a55-0d7f4f3b9c11'
const output = { candidates: [{ kind: 'fact', text: 'The Amsterdam office opens at nine', subject: 'office hours', author_id: author, author_class: 'human', citations: [{ message_id: 'message-1', revision: 1, parts_hash: 'hash-1', excerpt: 'opens at nine' }] }] }
const unweighted = { kind: 'observation', text: 'The office is in Amsterdam', subject: 'office location', author_id: author, author_class: 'human', citations: [{ message_id: 'message-1', revision: 1, parts_hash: 'hash-1', excerpt: 'Amsterdam office' }] }
const weighted = { candidates: [{ ...output.candidates[0], importance: 0.8 }, { ...unweighted, importance: null }] }
const promoted = { section: '- Prefers short summaries' }
const consolidated = { verdicts: [{ pair: 'p1', verdict: 'same' }, { pair: 'p2', verdict: 'none' }], lessons: [{ text: 'Offices open early in the week', memories: ['m1', 'm2'] }] }

// A scripted App Server. Its behavior after turn/start comes from the mode file, read at launch.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-maintenance-'))
  const userHome = join(directory, 'user-codex')
  const data = join(directory, 'kipster-data')
  const log = join(directory, 'codex.jsonl')
  const modeFile = join(directory, 'mode')
  const launcherFile = join(directory, 'launcher')
  await mkdir(userHome)
  await writeFile(join(userHome, 'config.toml'), '[mcp_servers.ambient]\ncommand = "ambient"\n')
  await writeFile(join(userHome, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"user-dummy-key"}\n', { mode: 0o600 })
  await writeFile(join(directory, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs');const readline=require('node:readline');
const mode=fs.existsSync(${JSON.stringify(modeFile)})?fs.readFileSync(${JSON.stringify(modeFile)},'utf8'):'ok';
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
if(fs.existsSync(${JSON.stringify(launcherFile)})&&!process.env.FAKE_CODEX_CHILD){
 const child=require('node:child_process').spawn(process.execPath,[__filename,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,FAKE_CODEX_CHILD:'1'}});
 record({launcher:process.pid,child:child.pid});child.on('exit',code=>process.exit(code??1));return;
}
record({launch:{pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),env:process.env,entries:fs.readdirSync(process.env.CODEX_HOME).sort()}});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const thread='thread-'+process.pid;
const item=(method,item)=>send({method,params:{threadId:thread,turnId:'turn-1',item}});
const message=(id,text)=>{item('item/started',{type:'agentMessage',id,text:''});item('item/completed',{type:'agentMessage',id,text})};
const complete=status=>send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn-1',status}}});
if(mode==='hang')setTimeout(()=>process.exit(0),60000);
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);record({method:x.method,params:x.params,id:x.id,error:x.error});
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
 else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:thread}}});
 else if(x.method==='turn/start'){
  send({id:x.id,result:{turn:{id:'turn-1'}}});
  item('item/started',{type:'userMessage',id:'input'});
  item('item/completed',{type:'reasoning',id:'reasoning'});
  if(mode==='ok')message('answer',${JSON.stringify(JSON.stringify(output))});
  if(mode==='importance')message('answer',${JSON.stringify(JSON.stringify(weighted))});
  if(mode==='consolidate')message('answer',${JSON.stringify(JSON.stringify(consolidated))});
  if(mode==='identity')message('answer',${JSON.stringify(JSON.stringify(promoted))});
  if(mode==='malformed')message('answer','Here is what I found: nothing');
  if(mode==='multiple'){message('first','{"candidates":[]}');message('second','{"candidates":[]}')}
  if(mode==='tool'){item('item/started',{type:'commandExecution',id:'command',command:'ls ~'});setTimeout(()=>{message('answer','{"candidates":[]}');complete('completed')},500);return}
  if(mode==='request'){send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:'turn-1',itemId:'command'}});return}
  if(mode==='hang')return;
  complete(mode==='failed'?'failed':'completed');
 }
});
`)
  await chmod(join(directory, 'codex'), 0o755)
  const previous = { ...process.env }
  Object.assign(process.env, { PATH: `${directory}:${process.env.PATH}`, CODEX_HOME: userHome, OPENAI_API_KEY: 'ambient-key' })
  const adapters = []
  const adapter = () => { const created = createAdapter({ dataDirectory: data, now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } }); adapters.push(created); return created }
  const records = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const mode = value => writeFile(modeFile, value)
  const launcher = () => writeFile(launcherFile, '')
  const cleanup = async () => {
    for (const created of adapters) await created.close()
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await rm(directory, { recursive: true, force: true })
  }
  return { directory, userHome, data, adapter, records, mode, launcher, cleanup }
}
const extractionSchema = { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', maxItems: 8 } } }
const context = (attemptId = 'attempt-1') => ({ kind: 'maintenance', runId: 'maintenance-run', attemptId, organizationId: null, agentId: 'agent', maintenance: { task: 'extract', sourceRunId: 'source-run', sourceRevision: 1, contextKind: 'installation', contextId: 'installation', instructions: 'Extract durable memory candidates.\n--- message message-1 ---\nThe Amsterdam office opens at nine.', sources: [{ messageId: 'message-1', position: 1, revision: 1, partsHash: 'hash-1', authorId: author, authorClass: 'human', text: 'The Amsterdam office opens at nine.' }], outputSchema: extractionSchema, settings: { adapterId: 'codex-cli', modelId: 'test-model', effort: 'low' } } })
async function collect(handle) { const events = []; for await (const event of handle.events) events.push(event); return events }
async function run(f, mode) {
  await f.mode(mode)
  const adapter = f.adapter()
  await adapter.readiness()
  return collect(await adapter.execute(context()))
}
const gone = pid => { try { process.kill(-pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(`Timed out: ${label}`)
}
async function hashes(root) {
  const files = {}
  for (const name of (await readdir(root)).sort()) files[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex')
  return files
}
const ref = (providerIds, overrides = {}) => ({ adapterId: 'codex-cli', contractMajor: 1, recoveryVersion: 1, stateScope: 'shared-codex-home', providerIds, ...overrides })

test('readiness declares maintenance with durable recovery', async () => {
  const f = await fixture()
  try {
    const ready = await f.adapter().readiness()
    assert.equal(ready.catalog.capabilities.maintenance, true)
    assert.deepEqual(ready.recoveryVersions, [1])
    assert.deepEqual(ready.recoveryStateScopes, ['shared-codex-home'])
  } finally { await f.cleanup() }
})

test('extraction runs as an isolated, tool-free, ephemeral thread and returns the structured result', async () => {
  const f = await fixture()
  try {
    const before = await hashes(f.userHome)
    const events = await run(f, 'ok')
    assert.deepEqual(events.map(event => event.kind), ['provider', 'text', 'ended'])
    const [provider, text] = events
    assert.equal(text.final, true)
    assert.equal(text.text, JSON.stringify(output), 'the result reaches Core unchanged')
    assert.equal(provider.threadId.startsWith('thread-'), true)
    assert.equal(provider.providerStateScope, 'shared-codex-home')
    assert.equal(provider.modelId, 'test-model')
    assert.equal(provider.effort, 'low')
    assert.equal(provider.workingDirectory, join(f.data, 'maintenance', 'workspace'))
    assert.deepEqual(await readdir(provider.workingDirectory), [])
    assert.deepEqual(await hashes(f.userHome), before)

    const records = await f.records()
    const launch = records.filter(record => record.launch).at(-1).launch
    assert.equal(launch.pid, provider.processId)
    assert.deepEqual(launch.argv.slice(0, 3), ['app-server', '--stdio', '--strict-config'])
    for (const setting of profile) assert.ok(launch.argv.some((value, index) => value === setting && launch.argv[index - 1] === '-c'), setting)
    assert.equal(launch.env.CODEX_HOME, await realpath(f.userHome))
    assert.equal(launch.env.HOME, homedir())
    assert.equal(launch.env.OPENAI_API_KEY, 'ambient-key')
    assert.deepEqual(Object.keys(launch.env).filter(key => !allowedEnvironment.test(key)), [])

    const calls = records.filter(record => record.method && !record.launch)
    const methods = calls.map(record => record.method)
    assert.deepEqual(methods.slice(methods.lastIndexOf('initialize')), ['initialize', 'initialized', 'config/read', 'thread/start', 'mcpServerStatus/list', 'turn/start'])
    const thread = calls.findLast(record => record.method === 'thread/start').params
    assert.equal(thread.ephemeral, true)
    assert.equal(thread.sandbox, 'read-only')
    assert.equal(thread.approvalPolicy, 'never')
    assert.equal(thread.model, 'test-model')
    assert.equal(thread.cwd, provider.workingDirectory)
    assert.equal('dynamicTools' in thread, false)
    const turn = calls.findLast(record => record.method === 'turn/start').params
    assert.equal(turn.model, 'test-model')
    assert.equal(turn.effort, 'low')
    assert.deepEqual(turn.input, [{ type: 'text', text: context().maintenance.instructions }])
    assert.deepEqual(turn.outputSchema, extractionSchema, 'Core supplies the output schema')
    await until(() => gone(provider.processId), 'process exit')
    assert.deepEqual(await readdir(join(f.data, 'maintenance', 'processes')), [])
  } finally { await f.cleanup() }
})

const consolidationSchema = { type: 'object', additionalProperties: false, required: ['verdicts', 'lessons'], properties: { verdicts: { type: 'array', maxItems: 2 }, lessons: { type: 'array', maxItems: 3 } } }
const consolidation = { kind: 'maintenance', runId: 'consolidation-run', attemptId: 'attempt-2', organizationId: null, agentId: 'agent', maintenance: { task: 'consolidate', instructions: 'Consolidate memories.\n\nMemories:\nm1 (new): The office opens at nine\nm2: The office opens at 9am\nm4: Invoices go out on Fridays\n\nPairs:\np1: m1 m2\np2: m1 m4', memories: [{ ref: 'm1', text: 'The office opens at nine' }, { ref: 'm2', text: 'The office opens at 9am' }, { ref: 'm4', text: 'Invoices go out on Fridays' }], pairs: [{ ref: 'p1', memories: ['m1', 'm2'] }, { ref: 'p2', memories: ['m1', 'm4'] }], lessonsMax: 3, outputSchema: consolidationSchema, settings: { adapterId: 'codex-cli', modelId: 'test-model', effort: 'low' } } }

test('consolidation runs in the same isolated thread with the schema Core supplies', async () => {
  const f = await fixture()
  try {
    await f.mode('consolidate')
    const adapter = f.adapter()
    await adapter.readiness()
    const events = await collect(await adapter.execute(consolidation))
    assert.deepEqual(events.map(event => event.kind), ['provider', 'text', 'ended'])
    assert.deepEqual(JSON.parse(events[1].text), consolidated, 'the result reaches Core unchanged')
    const calls = (await f.records()).filter(record => record.method && !record.launch)
    const thread = calls.findLast(record => record.method === 'thread/start').params
    assert.equal(thread.ephemeral, true)
    assert.equal('dynamicTools' in thread, false)
    const turn = calls.findLast(record => record.method === 'turn/start').params
    assert.deepEqual(turn.input, [{ type: 'text', text: consolidation.maintenance.instructions }])
    assert.equal(turn.model, 'test-model')
    assert.equal(turn.effort, 'low')
    assert.deepEqual(turn.outputSchema, consolidationSchema, 'Core supplies the output schema')
    await until(() => gone(events[0].processId), 'process exit')
    const unknown = await collect(await adapter.execute({ ...consolidation, attemptId: 'attempt-3', maintenance: { ...consolidation.maintenance, task: 'summarize' } }))
    assert.deepEqual(unknown, [{ kind: 'failed', attemptId: 'attempt-3', confirmedEnded: true, message: 'Unsupported maintenance task' }])
  } finally { await f.cleanup() }
})

const promotion = { kind: 'maintenance', runId: 'identity-run', attemptId: 'attempt-4', organizationId: null, agentId: 'agent', maintenance: { task: 'identity', instructions: 'Rewrite the Learned section.\n\nMemories, strongest first:\nm1: Prefers short summaries\n\nCurrent section:\n(empty)', memories: [{ ref: 'm1', text: 'Prefers short summaries' }], section: '', sectionMaxBytes: 2048, outputSchema: { type: 'object', additionalProperties: false, required: ['section'], properties: { section: { type: 'string' } } }, settings: { adapterId: 'codex-cli', modelId: 'test-model' } } }

test('identity promotion runs in the same isolated thread with the schema Core supplies', async () => {
  const f = await fixture()
  try {
    await f.mode('identity')
    const adapter = f.adapter()
    await adapter.readiness()
    const events = await collect(await adapter.execute(promotion))
    assert.deepEqual(events.map(event => event.kind), ['provider', 'text', 'ended'])
    assert.deepEqual(JSON.parse(events[1].text), promoted, 'the result reaches Core unchanged')
    const calls = (await f.records()).filter(record => record.method && !record.launch)
    const thread = calls.findLast(record => record.method === 'thread/start').params
    assert.equal(thread.ephemeral, true)
    assert.equal('dynamicTools' in thread, false)
    const turn = calls.findLast(record => record.method === 'turn/start').params
    assert.deepEqual(turn.input, [{ type: 'text', text: promotion.maintenance.instructions }])
    assert.equal(turn.model, 'test-model')
    assert.deepEqual(turn.outputSchema, { type: 'object', additionalProperties: false, required: ['section'], properties: { section: { type: 'string' } } })
    await until(() => gone(events[0].processId), 'process exit')
  } finally { await f.cleanup() }
})

test('emitted importance values, including null, reach Core unchanged', async () => {
  const f = await fixture()
  try {
    const events = await run(f, 'importance')
    assert.deepEqual(events.map(event => event.kind), ['provider', 'text', 'ended'])
    const result = JSON.parse(events[1].text)
    assert.deepEqual(result, { candidates: [{ ...output.candidates[0], importance: 0.8 }, { ...unweighted, importance: null }] })
  } finally { await f.cleanup() }
})

test('malformed, missing and repeated results reach Core unchanged for its bounded failures', async () => {
  const f = await fixture()
  try {
    const malformed = await run(f, 'malformed')
    assert.deepEqual(malformed.map(event => event.kind), ['provider', 'text', 'ended'])
    assert.equal(malformed[1].text, 'Here is what I found: nothing')
    assert.deepEqual((await run(f, 'zero')).map(event => event.kind), ['provider', 'ended'])
    const multiple = await run(f, 'multiple')
    assert.deepEqual(multiple.map(event => event.kind), ['provider', 'text', 'text', 'ended'])
    assert.ok(multiple.slice(1, 3).every(event => event.final))
    const failed = await run(f, 'failed')
    assert.deepEqual(failed.at(-1), { kind: 'failed', attemptId: 'attempt-1', confirmedEnded: true, message: 'Codex turn failed' })
  } finally { await f.cleanup() }
})

test('a tool item or server request ends the attempt without a result', async () => {
  const f = await fixture()
  try {
    const tool = await run(f, 'tool')
    assert.deepEqual(tool.map(event => event.kind), ['provider', 'failed'])
    assert.equal(tool[1].confirmedEnded, true)
    assert.match(tool[1].message, /commandExecution item/)
    assert.ok(gone(tool[0].processId))
    const request = await run(f, 'request')
    assert.deepEqual(request.map(event => event.kind), ['provider', 'failed'])
    assert.match(request[1].message, /requestApproval/)
  } finally { await f.cleanup() }
})

test('cancellation and process death are confirmed ends', async () => {
  const f = await fixture()
  try {
    await f.mode('hang')
    const adapter = f.adapter()
    await adapter.readiness()
    const cancelled = await adapter.execute(context('cancelled'))
    const iterator = cancelled.events[Symbol.asyncIterator]()
    const provider = (await iterator.next()).value
    assert.equal(await cancelled.reconcile(), 'active')
    assert.deepEqual(await cancelled.cancel(), { acknowledged: true, confirmedEnded: true })
    assert.deepEqual((await iterator.next()).value, { kind: 'failed', attemptId: 'cancelled', confirmedEnded: true, message: 'Maintenance cancelled' })
    assert.ok(gone(provider.processId))
    assert.equal(await cancelled.reconcile(), 'ended')

    const killed = await adapter.execute(context('killed'))
    const events = killed.events[Symbol.asyncIterator]()
    const { processId } = (await events.next()).value
    process.kill(-processId, 'SIGKILL')
    assert.deepEqual((await events.next()).value, { kind: 'failed', attemptId: 'killed', confirmedEnded: true, message: 'Codex process exited before the turn completed' })
  } finally { await f.cleanup() }
})

test('after host loss, recovery reports the recorded process as active until it is gone', async () => {
  const f = await fixture()
  try {
    await f.mode('hang')
    const host = spawn(process.execPath, ['--input-type=module', '-e', `
      import { createAdapter } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)}
      const adapter = createAdapter({ dataDirectory: ${JSON.stringify(f.data)}, now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
      await adapter.readiness()
      for await (const event of (await adapter.execute(${JSON.stringify(context('lost'))})).events) process.stdout.write(JSON.stringify(event) + '\\n')
    `], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] })
    const provider = await new Promise((resolve, reject) => {
      createInterface({ input: host.stdout }).once('line', line => resolve(JSON.parse(line)))
      host.once('exit', code => reject(new Error(`host exited ${code}`)))
    })
    host.kill('SIGKILL')
    await new Promise(resolve => host.once('exit', resolve))

    const record = join(f.data, 'maintenance', 'processes', `${provider.threadId}.json`)
    assert.equal((await lstat(record)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(join(f.data, 'maintenance', 'processes')), [`${provider.threadId}.json`])
    const recovered = f.adapter()
    const recoveryRef = ref({ threadId: provider.threadId, processId: provider.processId })
    assert.deepEqual(await recovered.durableReconcile({ recoveryRef }), { outcome: 'active', evidence: 'Codex process is running', generationMismatch: false })
    process.kill(-provider.processId, 'SIGKILL')
    await until(() => gone(provider.processId), 'orphan exit')
    assert.deepEqual(await recovered.durableReconcile({ recoveryRef }), { outcome: 'ended', evidence: 'Codex process group is gone', generationMismatch: false })
    await assert.rejects(lstat(record), { code: 'ENOENT' })
  } finally { await f.cleanup() }
})

test('an end is confirmed only when the whole process group is gone', async () => {
  const f = await fixture()
  try {
    await f.mode('hang')
    await f.launcher()
    const adapter = f.adapter()
    assert.equal((await adapter.readiness()).ready, true)
    const handle = await adapter.execute(context('launched'))
    const events = handle.events[Symbol.asyncIterator]()
    const provider = (await events.next()).value
    const { child } = (await f.records()).findLast(record => record.launcher === provider.processId)
    process.kill(provider.processId, 'SIGKILL')
    const failed = (await events.next()).value
    assert.equal(gone(child) && gone(provider.processId), true, 'the child in the group is gone before the end is confirmed')
    assert.deepEqual(failed, { kind: 'failed', attemptId: 'launched', confirmedEnded: true, message: 'Codex process exited before the turn completed' })
    assert.equal(await handle.reconcile(), 'ended')
  } finally { await f.cleanup() }
})

test('recovery tells a reused process ID from the original process and leaves incomplete identities unknown', async () => {
  const f = await fixture()
  const other = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    const adapter = f.adapter()
    const processes = join(f.data, 'maintenance', 'processes')
    await mkdir(processes, { recursive: true })
    const started = process.platform === 'linux'
      ? `${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${(await readFile(`/proc/${other.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]}`
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(other.pid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' } }).toString().trim()
    const recoveryRef = ref({ threadId: 'thread-recorded', processId: other.pid })
    const reconcile = () => adapter.durableReconcile({ recoveryRef })

    assert.deepEqual(await reconcile(), { outcome: 'unknown', evidence: 'Codex process identity is unavailable', generationMismatch: false })
    await writeFile(join(processes, 'thread-recorded.json'), '{')
    assert.equal((await reconcile()).outcome, 'unknown')
    await writeFile(join(processes, 'thread-recorded.json'), JSON.stringify({ processId: other.pid, started }))
    assert.equal((await reconcile()).outcome, 'active')
    await writeFile(join(processes, 'thread-recorded.json'), JSON.stringify({ processId: other.pid, started: 'Thu Jan  1 00:00:00 1970' }))
    assert.deepEqual(await reconcile(), { outcome: 'ended', evidence: 'Codex process is gone; its process ID was reused', generationMismatch: false })

    const leader = spawn('sh', ['-c', 'sleep 30 & exit 0'], { detached: true, stdio: 'ignore' })
    await new Promise(resolve => leader.once('exit', resolve))
    assert.deepEqual(await adapter.durableReconcile({ recoveryRef: ref({ threadId: 'thread-leader', processId: leader.pid }) }), { outcome: 'active', evidence: 'Codex process group is still running', generationMismatch: false })
    process.kill(-leader.pid, 'SIGKILL')

    for (const incomplete of [ref({ threadId: 'thread-recorded' }), ref({ threadId: '../escape', processId: other.pid }), ref({ threadId: 'thread-recorded', processId: 1 }), ref({ threadId: 'thread-recorded', processId: other.pid }, { stateScope: 'other' })]) {
      assert.equal((await adapter.durableReconcile({ recoveryRef: incomplete })).outcome, 'unknown')
    }
    await assert.rejects(lstat(join(processes, 'thread-recorded.json')), { code: 'ENOENT' })
  } finally { other.kill('SIGKILL'); await f.cleanup() }
})

test('unavailable settings fail as confirmed ends without launching Codex', async () => {
  const f = await fixture()
  try {
    const adapter = f.adapter()
    await adapter.readiness()
    const launches = (await f.records()).filter(record => record.launch).length
    for (const [settings, message] of [[{ modelId: 'other-model' }, 'Codex model is unavailable'], [{ effort: 'extreme' }, 'Codex effort is unsupported'], [{ options: { speed: 'fast' } }, 'Codex options are unsupported']]) {
      const base = context()
      const events = await collect(await adapter.execute({ ...base, maintenance: { ...base.maintenance, settings: { ...base.maintenance.settings, ...settings } } }))
      assert.deepEqual(events, [{ kind: 'failed', attemptId: 'attempt-1', confirmedEnded: true, message }])
    }
    assert.equal((await f.records()).filter(record => record.launch).length, launches)
  } finally { await f.cleanup() }
})
