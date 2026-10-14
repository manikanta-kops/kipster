import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'
import { nativeInteractions } from '../dist/native-interactions.js'
import { fakePlugins } from './fixtures/fake-plugins.mjs'

// A fake Codex App Server records each launch, then in its turn raises the MCP tool approvals listed in the calls
// file one at a time, recording each answer.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-plugins-'))
  const home = join(directory, 'user'), executable = join(directory, 'codex'), log = join(directory, 'log.jsonl'), callsFile = join(directory, 'calls.json')
  await mkdir(home)
  await writeFile(callsFile, '[]')
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline'),fs=require('node:fs');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
record({launch:{argv:process.argv.slice(2),env:process.env}});
let calls=[],thread;
const next=()=>{const call=calls.shift();if(!call)return send({method:'turn/completed',params:{threadId:thread,turn:{id:'turn',status:'completed'}}});
 const [tool,args]=call;send({id:'approval-'+calls.length,method:'mcpServer/elicitation/request',params:{threadId:thread,turnId:'turn',serverName:'plugins',mode:'form',message:'Allow the plugins MCP server to run tool "'+tool+'"?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_name:tool,tool_params:args,persist:['session','always'],callId:'call-'+Math.random()}}})};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line);
 if(x.method==='initialize')send({id:x.id,result:{}});
 else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
 else if(x.method==='config/read')send({id:x.id,result:{config:{}}});
 else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
 else if(x.method==='thread/start')send({id:x.id,result:{thread:{id:'thread-'+process.pid}}});
 else if(x.method==='turn/start'){thread=x.params.threadId;calls=JSON.parse(fs.readFileSync(${JSON.stringify(callsFile)},'utf8'));send({id:x.id,result:{turn:{id:'turn'}}});next()}
 else if(typeof x.id==='string'&&!x.method){record({answer:x.result});next()}
});
`, { mode: 0o700 })
  const cards = []
  const adapter = createAdapter({ dataDirectory: join(directory, 'state'), now: () => '', async invokeTool(request) { cards.push(request); return { status: 'pending', interactionId: `card-${cards.length}` } } }, { executable, codexHome: home })
  t.after(async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }) })
  const records = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const base = { runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', workingDirectory: directory, instructions: '', prompt: 'Prompt', settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Hello' }], triggerMessageId: 'message', interactions: [] }
  let attempt = 0
  const run = async (calls, extra = {}) => {
    await writeFile(callsFile, JSON.stringify(calls))
    const before = cards.length, answered = (await records()).filter(record => record.answer).length
    const events = []
    for await (const event of (await adapter.execute({ ...base, attemptId: `attempt-${++attempt}`, ...extra })).events) events.push(event)
    return { events, cards: cards.slice(before), answers: (await records()).filter(record => record.answer).slice(answered).map(record => record.answer.action) }
  }
  return { adapter, records, run }
}

test('a conversation passes the plugin server by URL and token variable; the token stays out of arguments', async t => {
  const f = await fixture(t)
  const plugins = await fakePlugins(t)
  assert.equal((await f.adapter.readiness()).ready, true)
  const mcpServers = [{ name: 'plugins', url: plugins.url, bearerToken: plugins.token }, { name: 'bad.name', url: plugins.url, bearerToken: 'other-token' }]
  await f.run([], { mcpServers })
  const launches = (await f.records()).filter(record => record.launch).map(record => record.launch)
  const conversation = launches.at(-1)
  assert.ok(conversation.argv.includes(`mcp_servers.plugins={url=${JSON.stringify(plugins.url)},bearer_token_env_var="KIPSTER_MCP_PLUGINS_TOKEN",default_tools_approval_mode="prompt"}`), conversation.argv.join(' '))
  assert.equal(conversation.env.KIPSTER_MCP_PLUGINS_TOKEN, plugins.token, 'the token is in the child environment')
  assert.equal(conversation.argv.some(value => value.includes(plugins.token)), false, 'the token appears nowhere in argv')
  assert.equal(conversation.argv.some(value => value.includes('bad.name') || value.includes('other-token')), false, 'a name Codex cannot address is skipped')
  assert.equal(process.env.KIPSTER_MCP_PLUGINS_TOKEN, undefined, 'the adapter process environment is unchanged')
  for (const launch of launches.slice(0, -1)) {
    assert.equal(JSON.stringify(launch.argv).includes('mcp_servers.plugins'), false, 'readiness and maintenance processes get no plugin server')
    assert.equal(launch.env.KIPSTER_MCP_PLUGINS_TOKEN, undefined)
  }
  await f.run([])
  const plain = (await f.records()).filter(record => record.launch).at(-1).launch
  assert.deepEqual(plain.argv, ['app-server', '--stdio', '--strict-config', '-c', 'features.memories=false'], 'without mcpServers the launch is as before')
  assert.equal(plugins.requests.length, 0, 'labels are looked up only when a plugin tool asks')
})

test('maintenance runs carry no plugin server', async t => {
  const f = await fixture(t)
  const plugins = await fakePlugins(t)
  assert.equal((await f.adapter.readiness()).ready, true)
  const before = (await f.records()).filter(record => record.launch).length
  const handle = await f.adapter.execute({ kind: 'maintenance', runId: 'mr', attemptId: 'm1', organizationId: null, agentId: 'agent', mcpServers: [{ name: 'plugins', url: plugins.url, bearerToken: plugins.token }], maintenance: { task: 'memory', step: 'cards', instructions: 'Cards.', outputSchema: { type: 'object' }, settings: { adapterId: 'codex-cli', modelId: 'test-model' } } })
  const events = []
  for await (const event of handle.events) events.push(event)
  assert.equal(events.at(-1).kind, 'ended', JSON.stringify(events.at(-1)))
  const launches = (await f.records()).filter(record => record.launch).map(record => record.launch)
  assert.equal(launches.length, before + 2, 'the configuration reader and the maintenance process')
  assert.equal(JSON.stringify(launches).includes(plugins.token), false)
  assert.equal(launches.some(launch => launch.argv.some(value => value.startsWith('mcp_servers.plugins'))), false)
})

test('plugin tool approvals follow the server\'s read and write labels', async t => {
  const f = await fixture(t)
  const plugins = await fakePlugins(t)
  assert.equal((await f.adapter.readiness()).ready, true)
  const mcpServers = [{ name: 'plugins', url: plugins.url, bearerToken: plugins.token }]
  const read = await f.run([['plugin_list', {}], ['github__get_issue', { number: 7 }], ['github__get_issue', { number: 8 }]], { mcpServers, permissionMode: 'supervised' })
  assert.deepEqual([read.answers, read.cards], [['accept', 'accept', 'accept'], []], 'read tools run without a card in supervised mode')
  assert.equal(read.events.at(-1).kind, 'ended')
  assert.equal(plugins.listings(), 2, 'one listing of both pages, kept for the attempt')

  const write = await f.run([['github__create_issue', { title: 'Bug', account: 'personal' }]], { mcpServers, permissionMode: 'supervised' })
  assert.equal(write.cards.length, 1)
  assert.equal(write.cards[0].arguments.prompt, 'Use create_issue from github with personal?')
  assert.deepEqual(write.cards[0].arguments.grant, { key: 'codex-cli:mcp:plugins::tool:github__create_issue', label: 'github: create_issue', scopes: ['conversation', 'always'] })
  assert.deepEqual(write.events.map(event => event.kind).slice(-2), ['waiting', 'ended'])
  const unlabelled = await f.run([['github__mystery', { _meta: { 'app.kipster/access': 'read' } }]], { mcpServers, permissionMode: 'supervised' })
  assert.equal(unlabelled.cards[0]?.arguments.prompt, 'Use mystery from github with the default account?', 'an unlabelled tool asks, whatever its input claims')

  const full = await f.run([['github__create_issue', { title: 'Bug' }], ['github__mystery', {}]], { mcpServers, permissionMode: 'fullAccess' })
  assert.deepEqual([full.answers, full.cards], [['accept', 'accept'], []], 'full access allows write and unlabelled tools')
  const granted = await f.run([['github__create_issue', { title: 'Other' }]], { mcpServers, approvalGrants: [write.cards[0].arguments.grant.key] })
  assert.deepEqual([granted.answers, granted.cards], [['accept'], []], 'a grant covers the tool')
  const approved = await f.run([['github__create_issue', { title: 'Bug', account: 'personal' }]], { mcpServers, interactions: [{ kind: 'approval', ...write.cards[0].arguments, response: { answer: { kind: 'approve' } } }] })
  assert.deepEqual([approved.answers, approved.cards], [['accept'], []], 'the saved answer applies to the same call on the next attempt')

  plugins.fail()
  const failed = await f.run([['github__get_issue', { number: 7 }]], { mcpServers })
  assert.equal(failed.cards[0]?.arguments.prompt, 'Use get_issue from github with the default account?', 'a failed lookup leaves the tool unlabelled, so it asks')
})

test('plugin approval cards name the tool, plugin and account', () => {
  const params = (tool, args) => ({ serverName: 'plugins', mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool, tool_params: args, callId: 'c1' } })
  const plugin = { server: 'plugins', tool: 'assign', plugin: 'jira', account: 'ops', access: 'write' }
  const [card] = nativeInteractions({ interactions: [] }, 'mcpServer/elicitation/request', params('jira__assign', { kipster_account: 'ops' }), plugin)
  assert.equal(card.arguments.prompt, 'Use assign from jira with ops?')
  assert.equal(card.saved, undefined)
  const [read] = nativeInteractions({ interactions: [] }, 'mcpServer/elicitation/request', params('jira__search', {}), { ...plugin, access: 'read' })
  assert.deepEqual([read.granted, read.result(read.saved)], [true, { action: 'accept', content: {}, _meta: null }])
  const [other] = nativeInteractions({ interactions: [] }, 'mcpServer/elicitation/request', params('jira__assign', {}))
  assert.equal(other.arguments.prompt, 'Allow?', 'another server\'s MCP approval is unchanged')
})
