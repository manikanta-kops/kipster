import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAdapter } from '../dist/index.js'

// A fake Codex app server records the offered tool names and the answer to each tool call, and
// calls an administration tool in every turn.
async function fakeCodex(directory) {
  const executable = join(directory, 'codex')
  const log = join(directory, 'log.jsonl')
  await writeFile(executable, `#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const record=x=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(x.method==='initialize')send({id:x.id,result:{}});
else if(x.method==='model/list')send({id:x.id,result:{data:[{id:'test-model'}]}});
else if(x.method==='mcpServerStatus/list')send({id:x.id,result:{data:[],nextCursor:null}});
else if(x.method==='config/read')send({id:x.id,result:{config:{mcp_servers:{}}}});
else if(x.method==='thread/start'){record({tools:x.params.dynamicTools.map(t=>t.name),schemas:x.params.dynamicTools});send({id:x.id,result:{thread:{id:'thread-1'}}})}
else if(x.method==='turn/start'){
 record({input:x.params.input});
 send({id:x.id,result:{turn:{id:'turn-1'}}});
 setTimeout(()=>send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'create-1',tool:'admin_agents_create',arguments:{operationId:'stable-create',name:'Scout',organizationId:'org-1'}}}),10);
}else if(x.id===101){record({answer:101,success:x.result.success});send({id:102,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'read-1',tool:'admin_organizations_instructions_get',arguments:{organizationId:'org-1'}}})}
else if(x.id===102){record({answer:102,success:x.result.success});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}})}
});
`)
  await chmod(executable, 0o755)
  return async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

async function run(administrationEnabled) {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-admin-'))
  const read = await fakeCodex(directory)
  const previous = process.env.PATH
  process.env.PATH = `${directory}:${previous}`
  process.env.CODEX_HOME = join(directory, 'user-codex')
  await mkdir(process.env.CODEX_HOME, { recursive: true })
  const calls = []
  const adapter = createAdapter({ dataDirectory: join(directory, 'codex-data'), now: () => new Date().toISOString(), async invokeTool(request) { calls.push(request); return { ok: true } } })
  try {
    assert.equal((await adapter.readiness()).ready, true)
    const handle = await adapter.execute({ runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'admin', workingDirectory: directory, instructions: 'Current', ...(administrationEnabled === undefined ? {} : { administrationEnabled, ...(administrationEnabled ? { administrationReceipts: { receipts: [{ operationId: 'saved-operation', kind: 'agent.create', state: 'succeeded', result: { agent: { id: 'saved-agent' } } }], hasMore: false } } : {}) }), settings: { adapterId: 'codex-cli', modelId: 'test-model' }, input: [{ messageId: 'message', text: 'Add Scout' }] })
    const events = []
    for await (const event of handle.events) events.push(event)
    return { calls, events, log: await read() }
  } finally {
    await adapter.close()
    process.env.PATH = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('administration tools are offered and forwarded only when administration is enabled', async () => {
  const enabled = await run(true)
  const offered = enabled.log[0].tools.filter(name => name.startsWith('admin_'))
  assert.deepEqual(offered.sort(), [
    'admin_adapters_list', 'admin_adapters_refresh', 'admin_agents_create', 'admin_agents_get', 'admin_agents_restore', 'admin_agents_archive', 'admin_agents_delete', 'admin_organizations_delete', 'admin_agents_update',
    'admin_appearances_add', 'admin_appearances_remove', 'admin_appearances_reorder', 'admin_directory_get',
    'admin_groups_create', 'admin_groups_delete', 'admin_groups_rename', 'admin_groups_reorder',
    'admin_memberships_add', 'admin_memberships_remove', 'admin_operations_get',
    'admin_organizations_create', 'admin_organizations_get', 'admin_organizations_instructions_get', 'admin_organizations_instructions_set', 'admin_organizations_update',
    'admin_settings_clear', 'admin_settings_effective', 'admin_settings_list', 'admin_settings_set',
  ].sort())
  assert.ok(enabled.log[0].schemas.find(t => t.name === 'admin_agents_create').inputSchema.required.includes('operationId'))
  assert.ok(!enabled.log[0].schemas.find(t => t.name === 'admin_agents_delete').inputSchema.required.includes('operationId'))
  assert.deepEqual(enabled.calls, [
    { attemptId: 'attempt', callId: 'create-1', name: 'admin.agents.create', arguments: { operationId: 'stable-create', name: 'Scout', organizationId: 'org-1' } },
    { attemptId: 'attempt', callId: 'read-1', name: 'admin.organizations.instructions_get', arguments: { organizationId: 'org-1' } },
  ])
  assert.deepEqual(enabled.log.filter(item => item.answer), [{ answer: 101, success: true }, { answer: 102, success: true }])
  assert.match(JSON.stringify(enabled.log.find(item => item.input)), /saved-operation/)
  assert.match(JSON.stringify(enabled.log.find(item => item.input)), /saved-agent/)
  assert.equal(enabled.events.at(-1).kind, 'ended')

  for (const setting of [false, undefined]) {
    const disabled = await run(setting)
    assert.equal(disabled.log[0].tools.some(name => name.startsWith('admin_')), false)
    assert.deepEqual(disabled.calls, [], 'an administration call is refused before it reaches Core')
    assert.deepEqual(disabled.log.filter(item => item.answer), [{ answer: 101, success: false }, { answer: 102, success: false }])
    assert.equal(disabled.events.at(-1).kind, 'ended')
  }
})
