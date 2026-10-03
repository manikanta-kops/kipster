import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appEnvironment } from '../local-app.mjs'
import { configuration } from '../local-backend.mjs'
import { exists, initializeHome, locked } from '../local-common.mjs'

test('app build disables ambient development-server configuration', () => {
  const env = appEnvironment({ PATH: '/bin', TAURI_CONFIG: '{"identifier":"wrong"}', CARGO_TARGET_DIR: '/tmp/wrong' })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.TAURI_CONFIG, undefined)
  assert.equal(env.CARGO_TARGET_DIR, undefined)
})

test('regenerating host configuration preserves user settings and isolates database/provider state', () => {
  const old = { listen: { host: '127.0.0.1', port: 43121, allowedHosts: [], allowedOrigins: ['tauri://localhost'] }, embedding: { module: '/installed/embedding/dist/index.js', options: { endpoint: 'http://127.0.0.1:11434', model: 'saved-model' } }, environment: { CUSTOM: 'saved' }, adapters: [{ id: 'other', root: '/somewhere', entry: 'index.js' }] }
  const config = configuration('/tmp/kip ster', '/tmp/new-build', old)
  assert.deepEqual(config.listen, old.listen)
  assert.deepEqual(config.embedding, old.embedding)
  assert.equal(config.adapters[0].root, '/tmp/new-build')
  assert.deepEqual(config.adapters[2], old.adapters[0])
  assert.equal(config.environment.CUSTOM, 'saved')
  assert.equal(config.adapters[0].config, undefined)
  const url = new URL(config.databaseUrl)
  assert.equal(url.searchParams.get('host'), '/tmp/kip ster/pg-socket')
  assert.equal(new URL(config.taskDataUrl).username, 'kipster_task')
})

test('development home refuses unrelated data and concurrent startup preserves the first lock', async t => {
  const home = await mkdtemp('/tmp/kipster-launch-test-')
  t.after(() => rm(home, { recursive: true, force: true }))
  await writeFile(join(home, 'keep.txt'), 'unrelated')
  await assert.rejects(initializeHome(home), /unrecognized/)
  assert.equal(await readFile(join(home, 'keep.txt'), 'utf8'), 'unrelated')
  await rm(join(home, 'keep.txt'))
  await locked(join(home, '.command-lock'), async () => {
    await initializeHome(home)
    await assert.rejects(locked(join(home, '.command-lock'), async () => {}), /Another command/)
    assert.equal(await exists(join(home, '.command-lock')), true)
  })
  assert.equal(await exists(join(home, '.command-lock')), false)
  assert.deepEqual(await initializeHome(home), { kind: 'kipster-development', version: 1 })
})

test('regenerating the install preserves adapter-owned settings', () => {
  const custom = { codexHome: '/absolute/custom/home', executable: '/absolute/custom/codex', environment: { PLUGIN_OPTION: 'value' } }
  const saved = { adapters: [{ id: 'codex-cli', root: '/old', entry: 'old.js', config: custom }] }
  const next = configuration('/tmp/kipster', '/new', saved)
  assert.deepEqual(next.adapters.map(adapter => adapter.id), ['codex-cli', 'claude-cli'], 'Codex stays the default adapter')
  assert.equal(next.adapters[0].root, '/new')
  assert.deepEqual(next.adapters[0].config, custom)
  assert.deepEqual(next.adapters[1], { id: 'claude-cli', root: '/new', entry: 'node_modules/@kipster/claude-cli/dist/index.js' })
})
