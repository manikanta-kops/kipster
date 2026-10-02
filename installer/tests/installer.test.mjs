import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { install, Installer, managedConfiguration, request } from '../src/installer.mjs'
import { channelFor, version } from '../src/catalog.mjs'
import { locked, json, save } from '../src/files.mjs'
import { templates } from '../src/services.mjs'
import { run } from '../src/process.mjs'
import { Database, databaseEndpoint } from '../src/database.mjs'
import { database, directory, configuration, catalogs, hooks, noDatabase, cli, repository } from './support.mjs'

test('request validation trusts only version strings and preserves the shared shape', () => {
  const input = { version: 1, id: 'request/opaque-id', action: 'install', target: '0.2.0-next.1', reason: 'automatic', requestedAt: new Date().toISOString(), url: 'https://untrusted.invalid', root: '/etc' }
  assert.deepEqual(Object.keys(request(input)), ['version', 'id', 'action', 'target', 'reason', 'requestedAt'])
  assert.throws(() => request({ ...input, target: { version: '0.1.0', url: input.url } }), /semver/)
  assert.throws(() => request({ ...input, backupId: '../../etc' }), /backupId/)
  for (const value of ['../x', '01.0.0', '1.0.0-next.01', '1.0']) assert.throws(() => version(value), /semver/)
  assert.equal(channelFor('1.0.0+build'), 'stable'); assert.equal(channelFor('1.0.0-next.1'), 'next')
})
test('system templates fence startup, run as the owner and exclude credentials', () => {
  const jobs = templates('/tmp/kipster&home', { PATH: '/runtime/bin', PASSWORD: 'secret' }, '/runtime/node', 'owner')
  assert.match(jobs[0].contents, /<key>UserName<\/key><string>owner/)
  assert.match(jobs[0].contents, /PathState/); assert.match(jobs[0].contents, /kipster&amp;home\/updates\/hold/)
  assert.doesNotMatch(jobs[0].contents, /SuccessfulExit|secret|PASSWORD/)
  assert.match(jobs[1].contents, /StartInterval<\/key><integer>60/)
  assert.match(jobs[1].contents, /updates\/request.json/)
})
test('provider roots move with current while retaining provider options', () => {
  const result = managedConfiguration({ adapters: [{ id: 'custom', entry: 'node_modules/@kipster/codex-cli/dist/index.js', root: '/old', config: { model: 'chosen' } }], embedding: { module: '/old/embedding-ollama/dist/index.js', options: { model: 'chosen' } } }, '/tmp/home')
  assert.deepEqual(result.names, ['@kipster/codex-cli', '@kipster/embedding-ollama'])
  assert.equal(result.config.adapters[0].root, '/tmp/home/current')
  assert.equal(result.config.adapters[0].config.model, 'chosen')
  assert.equal(result.config.embedding.module, '/tmp/home/current/node_modules/@kipster/embedding-ollama/dist/index.js')
})
test('malformed provider paths remain bounded and reject traversal', { timeout: 1000 }, () => {
  for (const entry of ['@kipster/a/a' + '/@kipster/a/a'.repeat(300) + '\n', '@kipster/a/a' + '/@kipster/a/a'.repeat(10000), 'node_modules/@kipster/a/../escape.js', 'node_modules/@kipster/a/dist\\escape.js']) {
    assert.throws(() => managedConfiguration({ adapters: [{ id: 'a', root: '/tmp', entry }] }, '/tmp/home'), /Configured adapters/)
  }
})
test('IPv6 PostgreSQL URLs control the backup and restore endpoint', { skip: noDatabase || !process.env.KIPSTER_TEST_IPV6_DATABASE_URL, timeout: 30000 }, async t => {
  const home = await directory(t), { database: db, databaseUrl } = await database(t)
  const url = new URL(process.env.KIPSTER_TEST_IPV6_DATABASE_URL); url.pathname = new URL(databaseUrl).pathname
  assert.equal(databaseEndpoint(url.href), databaseEndpoint(`postgresql://other@localhost${url.pathname}?host=::1&port=${url.port}`))
  const ipv6 = new Database({ databaseUrl: url.href }, undefined, { ...process.env, PGHOSTADDR: '127.0.0.1', PGSERVICE: 'unrelated-service', PGSERVICEFILE: join(home, 'missing-service.conf') })
  await ipv6.check()
  await ipv6.query('CREATE TABLE ipv6_probe (value integer); INSERT INTO ipv6_probe VALUES (1)')
  const backup = join(home, 'snapshot'); await mkdir(backup, { mode: 0o700 })
  await ipv6.backup(backup, { coreVersion: '0.1.0', createdAt: new Date().toISOString() })
  await ipv6.query('UPDATE ipv6_probe SET value=2')
  await ipv6.restore(backup, home)
  assert.equal(await ipv6.query('SELECT value FROM ipv6_probe'), '1')
  assert.equal(await db.query('SELECT value FROM ipv6_probe'), '1')
})
test('process locks exclude overlapping commands and release after a killed owner', async t => {
  const home = await directory(t)
  await locked(home, async () => {
    await assert.rejects(locked(home, async () => {}), /Another installer/)
    assert.equal(await locked(home, async () => {}, true), null)
  })
  const file = join(home, 'locked')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {locked,atomic} from ${JSON.stringify(new URL('../src/files.mjs', import.meta.url).href)}; await locked(${JSON.stringify(home)},async()=>{await atomic(${JSON.stringify(file)},'ready'); await new Promise(()=>setInterval(()=>{},10000))})`], { stdio: 'ignore' })
  const done = new Promise(resolve => child.once('exit', resolve))
  for (let i = 0; i < 100; i++) { try { await stat(file); break } catch { await delay(20) } }
  child.kill('SIGKILL'); await done
  await locked(home, async () => assert.ok(true))
})
test('success, verification failure, migration/health rollback, restore and retention', { skip: noDatabase, timeout: 180000 }, async t => {
  const home = await directory(t), { database: db, databaseUrl } = await database(t), catalog = await catalogs(t)
  const { path, maintenancePath } = await configuration(t, home, databaseUrl, {
    embedding: { module: join(home, 'embedding-ollama/dist/index.js'), options: { model: 'kept' } },
    transcription: { module: join(home, 'transcription-spokenly/dist/index.js'), options: { executable: '/usr/bin/false' } },
  })
  const options = { home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }
  await assert.rejects(install({ ...options, maintenanceConfig: undefined }, hooks), /superuser maintenance login/)
  const first = await install(options, hooks)
  assert.equal(first.coreVersion, '0.1.0'); assert.equal(first.update.state, 'done')
  assert.equal((await stat(join(home, 'host.json'))).mode & 0o777, 0o600)
  assert.equal(await db.query("INSERT INTO fixture.items VALUES(1,'saved before update') RETURNING note"), 'saved before update')
  const installer = await Installer.open(home, hooks)
  catalog.select('0.2.0')
  const core = catalog.catalogs.stable.packages['@kipster/core']
  const sha = core.files[0].sha256; core.files[0].sha256 = '0'.repeat(64)
  await assert.rejects(installer.update(), /sha256/)
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.equal((await installer.status()).update.state, 'failed')
  assert.equal((await installer.backups()).length, 1)
  core.files[0].sha256 = sha
  await save(join(home, 'fixture.json'), { migrationFailure: '0.2.0' })
  await assert.rejects(installer.update(), /Core setup failed/)
  assert.equal((await installer.status()).update.state, 'rolled-back')
  assert.equal(await db.query("SELECT note FROM fixture.items WHERE id=1"), 'saved before update')
  assert.equal(await db.query("SELECT count(*) FROM pg_namespace WHERE nspname='failed_migration'"), '0')
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  await save(join(home, 'fixture.json'), { migrationCrash: '0.2.0' })
  await assert.rejects(installer.update(), /Core setup failed/)
  assert.equal((await installer.status()).update.state, 'rolled-back')
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  // The refreshed backup must include a write committed during staging.
  installer.onStep = async step => { if (step === 'installing') await db.query("INSERT INTO fixture.items VALUES(2,'committed during staging') ON CONFLICT DO NOTHING") }
  await save(join(home, 'fixture.json'), { healthFailure: '0.2.0' })
  await assert.rejects(installer.update(), /health check/)
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.equal((await installer.status()).update.state, 'rolled-back')
  assert.equal(await db.query('SELECT note FROM fixture.items WHERE id=2'), 'committed during staging')
  installer.onStep = undefined
  await save(join(home, 'fixture.json'), {})
  assert.equal((await installer.update()).coreVersion, '0.2.0')
  const old = (await installer.backups())[0]
  await db.query("UPDATE fixture.items SET note='new version writes' WHERE id=1")
  assert.equal((await installer.update(old.coreVersion, old.id)).coreVersion, '0.1.0')
  assert.equal(await db.query('SELECT note FROM fixture.items WHERE id=1'), 'saved before update')
  // Select the newest configured adapter, including provider options and modules.
  const adapter = await catalog.pack('codex-cli', '0.2.0', null)
  await catalog.pack('installer', '0.2.0', catalog.installerSource)
  const interruptedBackup = join(home, 'backups', '00000000-0000-0000-0000-000000000000')
  await mkdir(interruptedBackup)
  await writeFile(join(interruptedBackup, '00000000-0000-0000-0000-000000000000.dump.tmp'), 'partial dump')
  for (const target of ['0.3.0', '0.4.0', '0.5.0', '0.6.0']) { catalog.select(target); await installer.update() }
  assert.equal((await json(join(home, 'current/node_modules/@kipster/codex-cli/package.json'))).version, adapter.version)
  assert.equal((await json(join(home, 'host.json'))).adapters[0].config.retained, true)
  assert.equal((await installer.backups()).length, 3)
  assert.equal((await readdir(join(home, 'backups'))).length, 3)
  assert.equal((await readdir(join(home, 'releases'))).length, 2)
  const status = (await installer.status()).update
  assert.deepEqual(Object.keys(status), ['version', 'requestId', 'state', 'step', 'from', 'to', 'error', 'updatedAt', 'backups'])
  assert.equal(status.step, null); assert.equal(status.error, null)
  assert.equal((await json(join(home, 'updater/current/package.json'))).version, '0.2.0')
  assert.equal((await json(join(home, 'updater/previous/package.json'))).version, '0.1.0')
  assert.equal((await readdir(join(home, 'updater/versions'))).length, 2)
  // A terminal request is idempotent: no new snapshots or package installation.
  const before = (await installer.backups()).map(item => item.id)
  await installer.apply(); assert.deepEqual((await installer.backups()).map(item => item.id), before)
  await assert.rejects(installer.update('0.1.0', '00000000-0000-0000-0000-000000000000'), /Restore target/)
  assert.equal((await installer.status()).update.state, 'failed')
  assert.equal((await installer.status()).coreVersion, '0.6.0')
  assert.ok(catalog.requests.includes('/v1/stable.json'))
  await writeFile(join(catalog.installerSource, 'src/cli.mjs'), 'invalid javascript {')
  await catalog.pack('installer', '0.3.0', catalog.installerSource); catalog.select('0.6.0')
  await assert.rejects(installer.update(), /Updater self-check/)
  assert.equal((await installer.status()).coreVersion, '0.6.0')
  assert.equal((await json(join(home, 'updater/current/package.json'))).version, '0.2.0')
  // A broken current import falls back to the preserved previous updater.
  await writeFile(join(home, 'updater/current/src/cli.mjs'), 'invalid javascript {')
  assert.match(await run(process.execPath, [join(home, 'bin/kipster'), '--help']), /Usage:/)
})
test('failed restore keeps the hold and journal until recovery succeeds', { skip: noDatabase, timeout: 120000 }, async t => {
  const home = await directory(t), { database: db, databaseUrl } = await database(t), catalog = await catalogs(t, { versions: ['0.1.0', '0.2.0'] })
  const { path, maintenancePath } = await configuration(t, home, databaseUrl)
  await install({ home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }, hooks)
  await db.query("INSERT INTO fixture.items VALUES(1,'safe')")
  catalog.select('0.2.0'); await save(join(home, 'fixture.json'), { migrationFailure: '0.2.0' })
  let archive, original
  const installer = await Installer.open(home, { ...hooks, onStep: async (step, journal) => {
    if (step === 'migrating') {
      archive = join(home, 'backups', journal.backupId, 'database.dump')
      original = await readFile(archive); await writeFile(archive, 'damaged archive')
    }
  } })
  await assert.rejects(installer.update(), /Core setup failed/)
  assert.equal((await installer.status()).update.state, 'failed')
  assert.ok(await stat(join(home, 'updates/journal.json')))
  assert.ok(await stat(join(home, 'updates/hold')))
  await assert.rejects(installer.apply(), /Recovery is incomplete/)
  await writeFile(archive, original)
  installer.onStep = undefined
  await installer.apply()
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.equal((await installer.status()).update.state, 'rolled-back')
  assert.equal(await db.query('SELECT note FROM fixture.items'), 'safe')
  await assert.rejects(stat(join(home, 'updates/journal.json')), { code: 'ENOENT' })
})
test('interrupted activation recovers on the next apply and preserves newer requests', { skip: noDatabase, timeout: 120000 }, async t => {
  const home = await directory(t), { database: db, databaseUrl } = await database(t), catalog = await catalogs(t, { versions: ['0.1.0', '0.2.0', '0.3.0'] })
  const { path, maintenancePath } = await configuration(t, home, databaseUrl)
  await install({ home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }, hooks)
  await db.query("INSERT INTO fixture.items VALUES(1,'retained')")
  catalog.select('0.2.0')
  const ready = join(home, 'interrupted')
  const code = `import {Installer} from ${JSON.stringify(new URL('../src/installer.mjs', import.meta.url).href)};
    import {atomic} from ${JSON.stringify(new URL('../src/files.mjs', import.meta.url).href)};
    const installer=await Installer.open(${JSON.stringify(home)},{platformCheck:async()=>{},onStep:async step=>{if(step==='migrating'){await atomic(${JSON.stringify(ready)},'ready'); await new Promise(()=>setInterval(()=>{},10000))}}}); await installer.update('0.2.0');`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: 'ignore' })
  const done = new Promise(resolve => child.once('exit', resolve))
  for (let i = 0; i < 1000; i++) { try { await stat(ready); break } catch { await delay(20) } }
  await stat(ready)
  child.kill('SIGKILL'); await done
  assert.ok(await stat(join(home, 'updates/hold')))
  const installer = await Installer.open(home, hooks)
  await installer.apply()
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.equal((await installer.status()).update.state, 'rolled-back')
  assert.equal(await db.query('SELECT note FROM fixture.items'), 'retained')
  await assert.rejects(stat(join(home, 'updates/hold')), { code: 'ENOENT' })
  catalog.select('0.3.0')
  const wanted = { version: 1, id: 'new-request', action: 'install', target: '0.3.0', reason: 'manual', requestedAt: new Date().toISOString(), downloadUrl: 'http://not-trusted.invalid' }
  await save(join(home, 'updates/request.json'), wanted)
  await installer.apply()
  assert.equal((await installer.status()).coreVersion, '0.3.0')
  assert.equal((await installer.status()).update.requestId, wanted.id)
})
test('restore can download a pruned release and honors pinned provider versions', { skip: noDatabase, timeout: 120000 }, async t => {
  const home = await directory(t), { databaseUrl } = await database(t), catalog = await catalogs(t, { versions: ['0.1.0', '0.2.0', '0.3.0'] })
  const { path, maintenancePath } = await configuration(t, home, databaseUrl)
  await install({ home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }, hooks)
  const installer = await Installer.open(home, hooks)
  catalog.select('0.2.0'); await installer.update()
  const backup = (await installer.backups())[0]
  const metadataPath = join(home, 'backups', backup.id, 'backup.json')
  const rotated = structuredClone(backup)
  const previousURL = new URL(rotated.config.databaseUrl); previousURL.password = 'old-secret'
  rotated.config.databaseUrl = previousURL.href
  await save(metadataPath, rotated)
  await catalog.pack('codex-cli', '0.2.0', null)
  catalog.select('0.3.0'); await installer.update()
  await assert.rejects(stat(join(home, 'releases/0.1.0')), { code: 'ENOENT' })
  await installer.update(backup.coreVersion, backup.id)
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.equal((await json(join(home, 'host.json'))).databaseUrl, databaseUrl)
  assert.equal((await json(join(home, 'current/node_modules/@kipster/codex-cli/package.json'))).version, '0.1.0')
  assert.ok(catalog.requests.includes('/v1/releases.json'))
})
test('failed first installation restores its database and can be retried', { skip: noDatabase, timeout: 120000 }, async t => {
  const home = await directory(t), { database: db, databaseUrl } = await database(t), catalog = await catalogs(t, { versions: ['0.1.0'] })
  const { path, maintenancePath } = await configuration(t, home, databaseUrl)
  await db.query("CREATE TABLE public.existing_data(note text); INSERT INTO public.existing_data VALUES('retained')")
  await save(join(home, 'fixture.json'), { migrationFailure: '0.1.0' })
  const options = { home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }
  await assert.rejects(install(options, hooks), /Core setup failed/)
  assert.equal(await db.query('SELECT note FROM public.existing_data'), 'retained')
  assert.equal(await db.query("SELECT count(*) FROM pg_namespace WHERE nspname='fixture'"), '0')
  await assert.rejects(stat(join(home, 'current')), { code: 'ENOENT' })
  assert.ok(await stat(join(home, 'updates/hold')))
  await save(join(home, 'fixture.json'), {})
  await install(options, hooks)
  assert.equal((await Installer.open(home, hooks).then(installer => installer.status())).coreVersion, '0.1.0')
  await assert.rejects(stat(join(home, 'updates/hold')), { code: 'ENOENT' })
})
