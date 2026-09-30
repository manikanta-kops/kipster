import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Home, IdentityAccessError, IdentityConflictError, LEARNED_BEGIN, LEARNED_END, learnedSection } from '../dist/platform/home/public.js'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../dist/runtime.js'
import { acceptText, resolveDirectChat } from '../dist/modules/conversations/public.js'
import { identityBackups, identityFile } from '../dist/protocol/index.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Identity file writer mechanics on a real filesystem, plus the owner HTTP routes against PostgreSQL.
const hash = text => createHash('sha256').update(text).digest('hex')

async function agentHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'kipster-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = new Home(root)
  await home.initialize(randomUUID())
  const agentId = randomUUID()
  await home.provisionAgent(agentId)
  const dir = home.agent(agentId)
  return { root, home, agentId, dir, files: home.identity }
}
const live = (ctx, file) => readFile(join(ctx.dir, file), 'utf8')
const backupFiles = async (ctx, file) => (await readdir(join(ctx.dir, 'backups', file)).catch(() => [])).filter(name => !name.startsWith('.')).sort()
const agentFiles = async ctx => (await readdir(ctx.dir)).sort()

test('the Learned section is created when absent and replaced without touching human text', async t => {
  const ctx = await agentHome(t)
  const human = '# Identity\n\nI am Maya, the finance agent.  \nTrailing spaces and\ttabs stay.'
  const first = await ctx.files.write(ctx.agentId, 'identity.md', human, hash('# Identity\n'), 'owner')
  const created = await ctx.files.replaceLearned(ctx.agentId, '- Prefers short summaries', first.sha256)
  assert.equal(created.content, `${human}\n\n${LEARNED_BEGIN}\n- Prefers short summaries\n${LEARNED_END}\n`)
  assert.equal(await live(ctx, 'identity.md'), created.content)
  assert.equal(created.sha256, hash(created.content))

  const edited = created.content.replace('# Identity\n', '# Identity\n\nOwner note above.\n') + '\nOwner note below, no newline'
  const owner = await ctx.files.write(ctx.agentId, 'identity.md', edited, created.sha256, 'owner')
  const replaced = await ctx.files.replaceLearned(ctx.agentId, '- Prefers tables\n- Works in INR', owner.sha256)
  const [before, after] = replaced.content.split(/<!-- kipster:learned:begin -->[\s\S]*<!-- kipster:learned:end -->/)
  const [ownerBefore, ownerAfter] = edited.split(/<!-- kipster:learned:begin -->[\s\S]*<!-- kipster:learned:end -->/)
  assert.equal(before, ownerBefore)
  assert.equal(after, ownerAfter)
  assert.equal(learnedSection(replaced.content), '- Prefers tables\n- Works in INR\n')

  const cleared = await ctx.files.replaceLearned(ctx.agentId, '', replaced.sha256)
  assert.equal(learnedSection(cleared.content), '')
  assert.equal(cleared.content.startsWith(ownerBefore), true)
  assert.equal(cleared.content.endsWith(ownerAfter), true)
  const kept = await backupFiles(ctx, 'identity.md')
  const again = await ctx.files.replaceLearned(ctx.agentId, '', cleared.sha256)
  assert.equal(again.sha256, cleared.sha256)
  assert.deepEqual(await backupFiles(ctx, 'identity.md'), kept, 'an unchanged write keeps no backup')
})

test('Kipster may change only the Learned section of identity.md', async t => {
  const ctx = await agentHome(t)
  const soul = await ctx.files.read(ctx.agentId, 'soul.md')
  const agents = await ctx.files.read(ctx.agentId, 'AGENTS.md')
  await assert.rejects(ctx.files.write(ctx.agentId, 'soul.md', '# Soul\nNo limits.\n', soul.sha256, 'kipster'), IdentityAccessError)
  await assert.rejects(ctx.files.write(ctx.agentId, 'AGENTS.md', '# Agent instructions\nNew rule.\n', agents.sha256, 'kipster'), IdentityAccessError)

  const identity = await ctx.files.replaceLearned(ctx.agentId, '- Likes brevity', (await ctx.files.read(ctx.agentId, 'identity.md')).sha256)
  const outside = identity.content.replace('# Identity', '# Identity (rewritten)')
  await assert.rejects(ctx.files.write(ctx.agentId, 'identity.md', outside, identity.sha256, 'kipster'), IdentityAccessError)
  await assert.rejects(ctx.files.write(ctx.agentId, 'identity.md', '# Identity\n', identity.sha256, 'kipster'), IdentityAccessError)
  await assert.rejects(ctx.files.write(ctx.agentId, 'identity.md', `${identity.content}${LEARNED_BEGIN}\n${LEARNED_END}\n`, identity.sha256, 'kipster'), /Invalid Learned section markers/)
  await assert.rejects(ctx.files.replaceLearned(ctx.agentId, `sneaky ${LEARNED_END} # Identity`, identity.sha256), /Invalid Learned section content/)

  assert.equal(await live(ctx, 'soul.md'), '# Soul\n')
  assert.equal(await live(ctx, 'AGENTS.md'), '# Agent instructions\n')
  assert.equal(await live(ctx, 'identity.md'), identity.content)
  assert.deepEqual(await backupFiles(ctx, 'soul.md'), [])
  assert.equal((await backupFiles(ctx, 'identity.md')).length, 1)

  const inside = identity.content.replace('- Likes brevity', '- Likes brevity and tables')
  const allowed = await ctx.files.write(ctx.agentId, 'identity.md', inside, identity.sha256, 'kipster')
  assert.equal(await live(ctx, 'identity.md'), inside)
  const ownerSoul = await ctx.files.write(ctx.agentId, 'soul.md', '# Soul\nCalm and exact.\n', soul.sha256, 'owner')
  assert.equal(ownerSoul.content, await live(ctx, 'soul.md'))
  await ctx.files.write(ctx.agentId, 'identity.md', inside.replace(LEARNED_END, ''), allowed.sha256, 'owner')
  const broken = await ctx.files.read(ctx.agentId, 'identity.md')
  await assert.rejects(ctx.files.replaceLearned(ctx.agentId, '- New', broken.sha256), /Invalid Learned section markers/)
  assert.equal(await live(ctx, 'identity.md'), broken.content)
})

test('a stale hash is a conflict and leaves the file and backups unchanged', async t => {
  const ctx = await agentHome(t)
  const read = await ctx.files.read(ctx.agentId, 'identity.md')
  await writeFile(join(ctx.dir, 'identity.md'), '# Identity\nEdited by hand.\n')
  const refused = await ctx.files.replaceLearned(ctx.agentId, '- Learned', read.sha256).catch(error => error)
  assert.ok(refused instanceof IdentityConflictError)
  assert.equal(refused.currentSha256, hash('# Identity\nEdited by hand.\n'))
  await assert.rejects(ctx.files.write(ctx.agentId, 'identity.md', 'Owner text\n', read.sha256, 'owner'), IdentityConflictError)
  assert.equal(await live(ctx, 'identity.md'), '# Identity\nEdited by hand.\n')
  assert.deepEqual(await backupFiles(ctx, 'identity.md'), [])

  const current = await ctx.files.read(ctx.agentId, 'soul.md')
  const racing = await Promise.allSettled(['# Soul\nA\n', '# Soul\nB\n', '# Soul\nC\n'].map(text => ctx.files.write(ctx.agentId, 'soul.md', text, current.sha256, 'owner')))
  const won = racing.filter(result => result.status === 'fulfilled')
  assert.equal(won.length, 1)
  assert.ok(racing.filter(result => result.status === 'rejected').every(result => result.reason instanceof IdentityConflictError))
  assert.equal(await live(ctx, 'soul.md'), won[0].value.content)
  assert.deepEqual(await backupFiles(ctx, 'soul.md'), ['1.md'])
  assert.equal(await readFile(join(ctx.dir, 'backups', 'soul.md', '1.md'), 'utf8'), '# Soul\n')
})

test('only the latest five backups are kept, and a restore is a write that keeps a backup', async t => {
  const ctx = await agentHome(t)
  let sha = (await ctx.files.read(ctx.agentId, 'soul.md')).sha256
  for (let version = 1; version <= 7; version++) sha = (await ctx.files.write(ctx.agentId, 'soul.md', `# Soul\nVersion ${version}\n`, sha, 'owner')).sha256
  assert.deepEqual(await backupFiles(ctx, 'soul.md'), ['3.md', '4.md', '5.md', '6.md', '7.md'])
  const backups = await ctx.files.listBackups(ctx.agentId, 'soul.md')
  assert.deepEqual(backups.map(backup => backup.id), ['7', '6', '5', '4', '3'])
  const expected = ['# Soul\nVersion 6\n', '# Soul\nVersion 5\n', '# Soul\nVersion 4\n', '# Soul\nVersion 3\n', '# Soul\nVersion 2\n']
  assert.deepEqual(backups.map(backup => backup.sha256), expected.map(hash))
  assert.deepEqual(backups.map(backup => backup.size), expected.map(text => Buffer.byteLength(text)))
  assert.ok(backups.every(backup => !Number.isNaN(Date.parse(backup.createdAt))))
  assert.equal((await ctx.files.readBackup(ctx.agentId, 'soul.md', '3')).content, '# Soul\nVersion 2\n')

  await assert.rejects(ctx.files.restore(ctx.agentId, 'soul.md', '3', hash('stale')), IdentityConflictError)
  const restored = await ctx.files.restore(ctx.agentId, 'soul.md', '3', sha)
  assert.equal(restored.content, '# Soul\nVersion 2\n')
  assert.equal(await live(ctx, 'soul.md'), '# Soul\nVersion 2\n')
  const after = await ctx.files.listBackups(ctx.agentId, 'soul.md')
  assert.deepEqual(after.map(backup => backup.id), ['8', '7', '6', '5', '4'])
  assert.equal((await ctx.files.readBackup(ctx.agentId, 'soul.md', '8')).content, '# Soul\nVersion 7\n')
  await assert.rejects(ctx.files.readBackup(ctx.agentId, 'soul.md', '3'), /Identity backup not found/)
  await assert.rejects(ctx.files.readBackup(ctx.agentId, 'soul.md', '../identity.md'), /Identity backup not found/)
  assert.deepEqual(await ctx.files.listBackups(ctx.agentId, 'AGENTS.md'), [])
})

test('a crash between writing and renaming leaves the previous file intact', async t => {
  const ctx = await agentHome(t)
  const before = await ctx.files.read(ctx.agentId, 'identity.md')
  const next = `# Identity\n${'Learned detail. '.repeat(3000)}\n`
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fsp from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    const [moduleUrl, root, agentId, content, sha] = process.argv.slice(1)
    fsp.rename = () => { process.send('renaming'); setInterval(() => {}, 1000); return new Promise(() => {}) }
    syncBuiltinESMExports()
    const { Home } = await import(moduleUrl)
    await new Home(root).identity.write(agentId, 'identity.md', content, sha, 'owner')
  `, new URL('../dist/platform/home/public.js', import.meta.url).href, ctx.root, ctx.agentId, next, before.sha256], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve(signal)))
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(new Error('writer exited before renaming'))) })
  child.kill('SIGKILL')
  assert.equal(await exited, 'SIGKILL')

  assert.equal(await live(ctx, 'identity.md'), before.content)
  const leftovers = (await agentFiles(ctx)).filter(name => name.startsWith('.identity.md.'))
  assert.equal(leftovers.length, 1)
  assert.equal(await readFile(join(ctx.dir, leftovers[0]), 'utf8'), next, 'the complete temporary file was never published')
  const resumed = await ctx.files.write(ctx.agentId, 'identity.md', next, before.sha256, 'owner')
  assert.equal(await live(ctx, 'identity.md'), next)
  assert.equal(resumed.sha256, hash(next))
})

test('a failed rename in process removes its temporary file and backup', async t => {
  const ctx = await agentHome(t)
  const fsp = (await import('node:fs/promises')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const rename = fsp.rename
  t.after(() => { fsp.rename = rename; syncBuiltinESMExports() })
  fsp.rename = async () => { throw Object.assign(new Error('simulated I/O failure'), { code: 'EIO' }) }
  syncBuiltinESMExports()
  const before = await ctx.files.read(ctx.agentId, 'identity.md')
  await assert.rejects(ctx.files.replaceLearned(ctx.agentId, '- Learned', before.sha256), /simulated I\/O failure/)
  fsp.rename = rename
  syncBuiltinESMExports()
  assert.equal(await live(ctx, 'identity.md'), before.content)
  assert.deepEqual((await agentFiles(ctx)).filter(name => name.endsWith('.tmp')), [])
  assert.deepEqual(await backupFiles(ctx, 'identity.md'), [])
  assert.deepEqual((await readdir(join(ctx.dir, 'backups', 'identity.md'))), [])
})

test('an edit made while a write is in progress wins over the write', async t => {
  const ctx = await agentHome(t)
  const fsp = (await import('node:fs/promises')).default
  const { syncBuiltinESMExports } = await import('node:module')
  const link = fsp.link
  t.after(() => { fsp.link = link; syncBuiltinESMExports() })
  fsp.link = async (from, to) => {
    await writeFile(join(ctx.dir, 'identity.md'), '# Identity\nSaved in an editor meanwhile.\n')
    return link(from, to)
  }
  syncBuiltinESMExports()
  const before = await ctx.files.read(ctx.agentId, 'identity.md')
  const refused = await ctx.files.replaceLearned(ctx.agentId, '- Learned', before.sha256).catch(error => error)
  fsp.link = link
  syncBuiltinESMExports()
  assert.ok(refused instanceof IdentityConflictError)
  assert.equal(refused.currentSha256, hash('# Identity\nSaved in an editor meanwhile.\n'))
  assert.equal(await live(ctx, 'identity.md'), '# Identity\nSaved in an editor meanwhile.\n')
  assert.deepEqual(await backupFiles(ctx, 'identity.md'), [])
  assert.deepEqual((await agentFiles(ctx)).filter(name => name.endsWith('.tmp')), [])
})

test('symlinked, oversized and unknown identity files are refused', async t => {
  const ctx = await agentHome(t)
  const outside = join(ctx.root, 'outside.md')
  await writeFile(outside, '# Outside\n')
  await rm(join(ctx.dir, 'soul.md'))
  await symlink(outside, join(ctx.dir, 'soul.md'))
  await assert.rejects(ctx.files.read(ctx.agentId, 'soul.md'), /Unsafe identity file/)
  await assert.rejects(ctx.files.write(ctx.agentId, 'soul.md', 'x', hash('# Outside\n'), 'owner'), /Unsafe identity file/)
  assert.equal(await readFile(outside, 'utf8'), '# Outside\n')

  const identity = await ctx.files.read(ctx.agentId, 'identity.md')
  await assert.rejects(ctx.files.write(ctx.agentId, 'identity.md', 'x'.repeat(64 * 1024 + 1), identity.sha256, 'owner'), /Invalid identity file size/)
  await writeFile(join(ctx.dir, 'AGENTS.md'), 'y'.repeat(64 * 1024 + 1))
  await assert.rejects(ctx.files.read(ctx.agentId, 'AGENTS.md'), /Invalid identity file size/)
  await assert.rejects(ctx.files.read(ctx.agentId, 'notes.md'), /Unknown identity file/)
  await assert.rejects(ctx.files.read(ctx.agentId, '../identity.md'), /Unknown identity file/)
  await assert.rejects(ctx.files.listBackups(ctx.agentId, '../../agents'), /Unknown identity file/)
  await assert.rejects(ctx.files.readBackup(ctx.agentId, '..', '1'), /Unknown identity file/)
  assert.equal(await live(ctx, 'identity.md'), identity.content)
})

test('the owner edits identity files over HTTP and the next execution reads the new content', { skip: noDatabase }, async t => {
  const admin = new Postgres(adminUrl)
  const database = `kipster_identity_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-identity-home-'))
  const runtime = await openRuntime({ connectionString: url.href, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
  const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
  const agentId = runtime.bootstrap.rootAgentId
  await runtime.db.query('UPDATE kipster.agents SET settings=$2::jsonb WHERE id=$1', [agentId, JSON.stringify({ adapterId: 'deterministic-fixture', modelId: 'fixture-model' })])
  const executions = []
  let dispatcher
  const inner = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  dispatcher = new TextDispatcher(runtime, { ...inner, async execute(value) { const handle = await inner.execute(value); executions.push({ context: value, handle }); return handle } })
  const servers = []
  t.after(async () => {
    for (const server of servers) await server.close()
    await dispatcher.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0 })
    servers.push(server)
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const call = await serve(actor)
  const base = `/v1/agents/${agentId}/identity`

  const read = identityFile.parse((await call('GET', `${base}/soul.md`)).data)
  assert.deepEqual({ agentId: read.agentId, file: read.file, content: read.content, sha256: read.sha256 }, { agentId, file: 'soul.md', content: '# Soul\n', sha256: hash('# Soul\n') })
  const saved = await call('PUT', `${base}/soul.md`, { version: 1, content: '# Soul\nSpeaks plainly.\n', expectedSha256: read.sha256 })
  assert.equal(saved.status, 200)
  assert.equal(identityFile.parse(saved.data).sha256, hash('# Soul\nSpeaks plainly.\n'))
  const stale = await call('PUT', `${base}/soul.md`, { version: 1, content: '# Soul\nLost update.\n', expectedSha256: read.sha256 })
  assert.equal(stale.status, 409)
  assert.equal(stale.data.code, 'conflict')

  const identity = identityFile.parse((await call('GET', `${base}/identity.md`)).data)
  await runtime.home.identity.replaceLearned(agentId, '- Reports in bullet points', identity.sha256)

  const { chatId } = await resolveDirectChat(runtime.db, actor, { kind: 'installation', installationId: actor.installationId }, agentId)
  await dispatcher.start()
  await acceptText(runtime.db, runtime.jobs, runtime.artifacts, actor, {
    version: 1, submissionId: randomUUID(), scope: { installationId: actor.installationId, callerId: actor.personId },
    target: { context: { kind: 'installation', installationId: actor.installationId }, chatId }, mode: 'root', parts: [{ kind: 'text', text: 'Hello' }],
  })
  for (let i = 0; i < 400 && !executions.length; i++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(executions.length, 1)
  assert.match(executions[0].context.instructions, /# Soul\nSpeaks plainly\.\n/)
  assert.match(executions[0].context.instructions, /<!-- kipster:learned:begin -->\n- Reports in bullet points\n<!-- kipster:learned:end -->/)
  const { context, handle } = executions[0]
  handle.release({ kind: 'text', attemptId: context.attemptId, messageId: 'answer', text: 'Hi', final: true })
  handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })

  const list = identityBackups.parse((await call('GET', `${base}/soul.md/backups`)).data)
  assert.deepEqual(list.backups.map(backup => [backup.id, backup.sha256]), [['1', hash('# Soul\n')]])
  const backup = identityFile.parse((await call('GET', `${base}/soul.md/backups/1`)).data)
  assert.equal(backup.content, '# Soul\n')
  const restored = await call('POST', `${base}/soul.md/backups/1/restore`, { version: 1, expectedSha256: hash('# Soul\nSpeaks plainly.\n') })
  assert.equal(restored.status, 200)
  assert.equal(identityFile.parse(restored.data).content, '# Soul\n')
  assert.deepEqual(identityBackups.parse((await call('GET', `${base}/soul.md/backups`)).data).backups.map(item => item.id), ['2', '1'])
  assert.equal((await call('GET', `${base}/soul.md/backups/9`)).status, 404)
  assert.equal((await call('GET', `${base}/notes.md`)).status, 404)
  assert.equal((await call('GET', `/v1/agents/${randomUUID()}/identity/soul.md`)).status, 404)

  const stranger = await serve({ installationId: actor.installationId, personId: randomUUID() })
  assert.equal((await stranger('GET', `${base}/soul.md`)).status, 403)
  assert.equal((await stranger('PUT', `${base}/soul.md`, { version: 1, content: 'x', expectedSha256: hash('# Soul\n') })).status, 403)
  assert.equal(await readFile(join(runtime.home.agent(agentId), 'soul.md'), 'utf8'), '# Soul\n')
})
