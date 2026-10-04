import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

async function notReady(readiness, reason, label) {
  const state = await readiness
  assert.equal(state.ready, false, label)
  assert.match(state.reason, reason, label)
  assert.equal(state.catalog.capabilities.maintenance, false, label)
}

const allowedEnvironment = /^(__CF_USER_TEXT_ENCODING|HOME|CODEX_HOME|OPENAI_API_KEY|OPENAI_BASE_URL|PATH|LANG|LC_[A-Z]+|TZ|TMPDIR|USER|LOGNAME|SHELL|TERM|SSL_CERT_(FILE|DIR)|CODEX_CA_CERTIFICATE|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy)$/
const isolation = ['project_doc_max_bytes=0', 'project_root_markers=[]', 'skills.bundled.enabled=false', 'skills.include_instructions=false', 'features.apps=false', 'features.plugins=false', 'features.remote_plugin=false', 'features.hooks=false', 'features.multi_agent=false', 'features.daemon_auto_start=false']

// The fake reads its behavior from a mode file at startup. Like the real CLI, a `-c mcp_servers.<name>.enabled=false` override switches a configured server off.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-isolation-'))
  const userHome = join(directory, 'user-codex')
  const data = join(directory, 'kipster-data')
  const agentHome = join(directory, 'agent')
  const log = join(directory, 'codex.jsonl')
  const modeFile = join(directory, 'mode')
  await mkdir(join(userHome, 'skills', 'ambient'), { recursive: true })
  await mkdir(agentHome)
  await writeFile(join(userHome, 'config.toml'), '[mcp_servers.ambient]\ncommand = "ambient"\n\n[plugins."ambient@market"]\nenabled = true\n')
  await writeFile(join(userHome, 'AGENTS.md'), 'Ambient instructions\n')
  await writeFile(join(userHome, 'skills', 'ambient', 'SKILL.md'), '---\nname: ambient\n---\n')
  await writeFile(join(userHome, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"user-dummy-key"}\n', { mode: 0o600 })
  await writeFile(join(directory, 'codex'), `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');
const home=process.env.CODEX_HOME;const auth=path.join(home,'auth.json');
const mode=fs.existsSync(${JSON.stringify(modeFile)})?fs.readFileSync(${JSON.stringify(modeFile)},'utf8'):'';
if(mode==='strict'){process.stderr.write('\\u001b[31mError:\\u001b[0m unknown configuration field \\\`features.example\\\` in -c/--config override\\n');process.exit(1)}
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
record({launch:{pid:process.pid,argv:process.argv.slice(2),cwd:process.cwd(),env:process.env,config:fs.readFileSync(path.join(home,'config.toml'),'utf8')}});
const off=mode!=='stuck'&&process.argv.includes('mcp_servers.ambient.enabled=false');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const listed={name:'ambient',tools:{}},offered={name:'ambient',tools:{ambient_tool:{}}};
const mcp=cursor=>({tools:{data:[offered],nextCursor:null},cursor:cursor?{data:[offered],nextCursor:null}:{data:[listed],nextCursor:'next'},malformed:{nextCursor:null}})[mode]??{data:[listed],nextCursor:null};
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);record({method:x.method,params:x.params});
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:mode==='luna'?[{id:'test-model'},{id:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}]:[{id:'test-model'}]}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{ambient:{command:'ambient',...(off?{enabled:false}:{})}}}}});
 else if(x.method==='mcpServerStatus/list'){if(mode==='error')send({id:x.id,error:{code:-32603,message:'listing failed'}});else if(mode!=='silent')send({id:x.id,result:mcp(x.params.cursor)})}
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread-1'}}});
 else if(x.method==='turn/start'){send({id:x.id,result:{turn:{id:'turn-1'}}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})}
});
`)
  await chmod(join(directory, 'codex'), 0o755)
  const previous = { ...process.env }
  Object.assign(process.env, { PATH: `${directory}:${process.env.PATH}`, CODEX_HOME: userHome, OPENAI_API_KEY: 'ambient-key', OPENAI_BASE_URL: 'http://ambient.invalid', CODEX_SQLITE_HOME: join(directory, 'ambient-sqlite') })
  const adapter = createAdapter({ dataDirectory: data, now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  const records = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const context = { runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', workingDirectory: agentHome, instructions: 'Current',prompt:'Current message', settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Hello' }], triggerMessageId: 'message' }
  const mode = value => writeFile(modeFile, value)
  const cleanup = async () => { await adapter.close(); for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); await rm(directory, { recursive: true, force: true }) }
  return { directory, userHome, data, adapter, records, context, mode, cleanup }
}
async function snapshot(root) {
  const files = {}
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name)
      const entry = await lstat(child)
      if (entry.isDirectory()) await visit(child)
      else files[child] = { ino: entry.ino, mode: entry.mode, mtimeMs: entry.mtimeMs, sha256: createHash('sha256').update(await readFile(child)).digest('hex') }
    }
  }
  await visit(root)
  return files
}


test('conversations share user config; maintenance uses the user login with integrations switched off', async () => {
  const f = await fixture()
  try {
    const before = await snapshot(f.userHome)
    assert.equal((await f.adapter.readiness()).catalog.capabilities.maintenance, true)
    const events = []; for await (const event of (await f.adapter.execute(f.context)).events) events.push(event)
    assert.equal(events.at(-1).kind, 'ended')
    assert.deepEqual(await snapshot(f.userHome), before)
    const launches = (await f.records()).filter(row => row.launch).map(row => row.launch)
    assert.equal(launches.length, 4)
    for (const launch of [launches[0], launches[3]]) {
      assert.equal(launch.env.CODEX_HOME, await realpath(f.userHome))
      assert.match(launch.config, /mcp_servers.ambient/)
      assert.equal(launch.argv.includes('features.plugins=false'), false)
      assert.ok(launch.argv.includes('features.memories=false'), 'Codex memories stay off in conversations')
      assert.equal(launch.env.OPENAI_API_KEY, 'ambient-key')
      assert.equal(launch.env.CODEX_SQLITE_HOME, undefined)
    }
    const [reader, maintenance] = [launches[1], launches[2]]
    for (const launch of [reader, maintenance]) {
      assert.equal(launch.env.CODEX_HOME, await realpath(f.userHome))
      assert.equal(launch.env.HOME, homedir())
      assert.equal(launch.env.OPENAI_API_KEY, 'ambient-key')
      assert.equal(launch.cwd, await realpath(f.data))
      assert.deepEqual(Object.keys(launch.env).filter(key => !allowedEnvironment.test(key)), [])
      for (const setting of isolation) assert.ok(launch.argv.includes(setting), setting)
      assert.ok(launch.argv.includes('features.shell_tool=false'))
    }
    assert.equal(reader.argv.includes('mcp_servers.ambient.enabled=false'), false)
    assert.ok(maintenance.argv.includes('mcp_servers.ambient.enabled=false'))
    const thread = (await f.records()).find(row => row.method === 'thread/start').params
    assert.deepEqual([thread.sandbox, thread.approvalPolicy, thread.approvalsReviewer], ['read-only', 'untrusted', 'user'], 'a context without a permission mode runs supervised')
    const ledger = JSON.parse(await readFile(join(f.data, 'conversation-sessions/thread-1.json'), 'utf8'))
    assert.equal(ledger.home, await realpath(f.userHome))
  } finally { await f.cleanup() }
})

test('MCP isolation failures disable maintenance without disabling conversations', async () => {
  const f = await fixture()
  try {
    for (const mode of ['stuck', 'tools', 'cursor', 'malformed', 'error']) {
      await f.mode(mode)
      const ready = await f.adapter.readiness()
      assert.equal(ready.ready, true, mode)
      assert.equal(ready.catalog.capabilities.maintenance, false, mode)
      assert.match(ready.reason, /Maintenance unavailable/)
      const events = []; for await (const event of (await f.adapter.execute(f.context)).events) events.push(event)
      assert.equal(events.at(-1).kind, 'ended')
    }
  } finally { await f.cleanup() }
})

test('explicit executable and home override environment without editing user config', async () => {
  const f = await fixture()
  const adapter = createAdapter({ dataDirectory: f.data, now: () => '', async invokeTool() {} }, { executable: join(f.directory, 'codex'), codexHome: f.userHome, environment: { CUSTOM_PLUGIN_SETTING: 'configured' } })
  try {
    const before = await snapshot(f.userHome)
    process.env.CODEX_HOME = '/nonexistent/should-not-be-used'
    assert.equal((await adapter.readiness()).ready, true)
    for await (const event of (await adapter.execute(f.context)).events) {}
    const records = await f.records()
    assert.equal(records.find(row => row.launch).launch.env.CUSTOM_PLUGIN_SETTING, 'configured')
    assert.deepEqual(await snapshot(f.userHome), before)
  } finally { await adapter.close(); await f.cleanup() }
})

test('each permission mode starts the thread with its sandbox, approval policy and reviewer', async () => {
  const askOutsideSandbox = { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true, request_permissions: true, skill_approval: true } }
  const expected = {
    supervised: ['read-only', 'untrusted', 'user'],
    acceptEdits: ['workspace-write', askOutsideSandbox, 'user'],
    auto: ['workspace-write', askOutsideSandbox, 'auto_review'],
    fullAccess: ['danger-full-access', 'never', 'user'],
    future: ['read-only', 'untrusted', 'user'],
  }
  for (const [permissionMode, settings] of Object.entries(expected)) {
    const f = await fixture()
    try {
      assert.equal((await f.adapter.readiness()).ready, true)
      for await (const event of (await f.adapter.execute({ ...f.context, permissionMode })).events) {}
      const thread = (await f.records()).find(row => row.method === 'thread/start').params
      assert.deepEqual([thread.sandbox, thread.approvalPolicy, thread.approvalsReviewer], settings, permissionMode)
      assert.equal(thread.cwd, f.context.workingDirectory)
    } finally { await f.cleanup() }
  }
})

test('configuration rejects unknown keys, relative paths and the removed permission keys', () => {
  const host = { dataDirectory: '/tmp/kipster-codex-data', now: () => '', async invokeTool() {} }
  for (const config of [{ unknown: true }, { codexHome: 'relative' }, { dataDirectory: '/tmp/data' }, { maintenanceAuth: 'linked' }, { executable: 'codex --bad' }, { sandbox: 'workspace-write' }, { approvalPolicy: 'never' }, { environment: { HOME: '/tmp' } }]) assert.throws(() => createAdapter(host, config))
  for (const dataDirectory of [undefined, 'relative']) assert.throws(() => createAdapter({ ...host, dataDirectory }, {}), /data directory/)
})

test('a launch failure reports a bounded Codex diagnostic', async () => {
  const f = await fixture()
  try {
    await f.mode('strict')
    const ready = await f.adapter.readiness()
    assert.equal(ready.ready, false)
    assert.match(ready.reason, /unknown configuration field/)
  } finally { await f.cleanup() }
})

for (const timing of ['pending readiness', 'pending launch']) {
  test(`close owns subprocesses during ${timing}`, { timeout: 15000 }, async () => {
    const f = await fixture()
    try {
      await f.mode('silent')
      const readiness = f.adapter.readiness()
      if (timing === 'pending readiness') {
        for (let i = 0; i < 150; i++) {
          if ((await f.records()).some(row => row.method === 'mcpServerStatus/list')) break
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      await f.adapter.close()
      assert.equal((await readiness).ready, false)
      for (const { launch } of (await f.records()).filter(row => row.launch)) assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' })
    } finally { await f.cleanup() }
  })
}

test('readiness reports gpt-6-luna with high effort as the default model only when Codex lists it', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.adapter.readiness()).catalog.defaultModel, undefined)
    await f.mode('luna')
    assert.deepEqual((await f.adapter.readiness()).catalog.defaultModel, { id: 'gpt-6-luna', effort: 'high' })
  } finally { await f.cleanup() }
})
