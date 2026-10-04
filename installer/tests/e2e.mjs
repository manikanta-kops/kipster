import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/process.mjs'
import { save, json } from '../src/files.mjs'
import { cli, database, directory, configuration, catalogs, noDatabase, repository, testApp } from './support.mjs'
import { install, Installer } from '../src/installer.mjs'
import { hostCommand } from '../src/services.mjs'
import { updaterStatusFile, updateStatus } from '../../core/dist/protocol/index.js'

async function codex(t) {
  const root = await directory(t, 'kpi-codex-'), executable = join(root, 'codex')
  await writeFile(executable, `#!${process.execPath}\nimport {createInterface} from 'node:readline';
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === 'model/list') result = {data: [{id: 'gpt-5.4', supportedReasoningEfforts: [{reasoningEffort: 'medium'}]}]};
  else if (request.method === 'config/read') result = {config: {mcp_servers: {}}};
  else if (request.method === 'mcpServerStatus/list') result = {data: []};
  console.log(JSON.stringify({id: request.id, result}));
}\n`)
  await chmod(executable, 0o700)
  return executable
}
async function available(config) {
  const base = `http://127.0.0.1:${config.listen.port}`
  const response = await fetch(base + '/v1/execution-adapters')
  assert.equal(response.status, 200)
  const adapters = await response.json()
  const adapter = adapters.adapters.find(adapter => adapter.id === 'codex-cli')
  const diagnostic = adapter?.available ? '' : await readFile(join(config.home, 'logs/host.log'), 'utf8')
  assert.equal(adapter?.available, true, JSON.stringify(adapters) + '\n' + diagnostic)
}
async function installedStatus(home, config) {
  const file = await json(join(home, 'updates/status.json'))
  assert.deepEqual(updaterStatusFile.parse(file), file)
  assert.equal(file.from, null); assert.equal(file.state, 'done')
  for (let i = 0; i < 100; i++) {
    const status = updateStatus.parse(await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/updates`)).json())
    if (status.core.state === 'idle') { assert.equal(status.core.error, null); assert.equal(status.core.lastResult, null); return }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('Core did not accept the completed first-install status')
}

test('macOS CLI installs and updates locally built Core/adapter tarballs without system registration', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' || noDatabase, timeout: 180000 }, async t => {
  await run('npm', ['run', 'build', '-w', 'adapters/codex-cli', '-w', 'adapters/embedding-ollama', '-w', 'adapters/transcription-spokenly'], { cwd: repository })
  const home = await directory(t, 'kpi-e2e-'), { database: db, databaseUrl } = await database(t)
  const catalog = await catalogs(t, { real: true, versions: ['0.0.0', '0.0.1'] })
  const executable = await codex(t)
  await mkdir(join(home, 'fixture-codex'), { mode: 0o700 })
  const { config, path, maintenancePath } = await configuration(t, home, databaseUrl, { adapters: [{ id: 'codex-cli', root: home, entry: 'node_modules/@kipster/codex-cli/dist/index.js', config: { executable, codexHome: join(home, 'fixture-codex') } }] })
  const installed = await run(process.execPath, [cli, 'install', '--home', home, '--config', path, '--maintenance-config', maintenancePath, '--catalog', catalog.base, '--no-launchd'], { timeout: 120000 })
  assert.match(installed, /<key>UserName<\/key>/)
  assert.match(installed, /backend\/Kipster\.app\/Contents\/MacOS\/Kipster<\/string><string>--role<\/string><string>host/)
  assert.equal((await json(join(home, 'runtime.json'))).node, process.execPath)
  // bin/kipster runs through the Kipster app when this checkout has built it.
  const launcher = join(home, 'bin/kipster')
  if (await lstat(join(repository, 'installer/launchers/macos/Kipster.app')).then(() => true, () => false)) assert.ok(await lstat(join(home, 'backend/Kipster.app/Contents/MacOS/Kipster')))
  const before = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(before.coreVersion, '0.0.0')
  assert.equal((await json(join(home, 'host.json'))).updates.managed, true)
  assert.equal((await lstat(join(home, 'current'))).isSymbolicLink(), true)
  await available(config)
  await installedStatus(home, config)
  assert.match(await run(process.execPath, [cli, 'install', '--home', home, '--config', path, '--maintenance-config', maintenancePath, '--catalog', catalog.base, '--no-launchd']), /already installed/)
  await db.query("CREATE TABLE public.installer_e2e_marker(note text); INSERT INTO public.installer_e2e_marker VALUES('authored data')")
  const legacyConfig = await json(join(home, 'host.json'))
  legacyConfig.updates = { channelUrl: catalog.base }
  await save(join(home, 'host.json'), legacyConfig)
  catalog.select('0.0.1')
  await run(launcher, ['update', '--to', '0.0.1'], { timeout: 120000 })
  const upgraded = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(upgraded.coreVersion, '0.0.1'); assert.equal(upgraded.installationId, before.installationId)
  await available(config)
  assert.deepEqual((await json(join(home, 'host.json'))).updates, { channelUrl: catalog.base, managed: true })
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  await assert.rejects(run(launcher, ['rollback']), /failed/)
  await run(launcher, ['rollback', '--yes'], { timeout: 120000 })
  const restored = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(restored.coreVersion, '0.0.0'); assert.equal(restored.installationId, before.installationId)
  await available(config)
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  assert.equal((await json(join(home, 'host.json'))).updates.managed, true)
  const requestPath = join(home, 'updates/request.json'), requestBytes = await readFile(requestPath, 'utf8')
  assert.equal(JSON.parse(requestBytes).action, 'restore')
  const status = JSON.parse(await run(launcher, ['status']))
  assert.equal(status.update.state, 'done')
  await run(launcher, ['apply'], { timeout: 120000 })
  assert.equal(await readFile(requestPath, 'utf8'), requestBytes)
  assert.deepEqual(JSON.parse(await run(launcher, ['status'])).backups, status.backups)
  const plists = await readdir(join(home, 'services'))
  for (const file of plists) await run('/usr/bin/plutil', ['-lint', join(home, 'services', file)])
  const output = process.env.KIPSTER_INSTALLER_E2E_OUTPUT
  if (output) {
    await mkdir(output, { recursive: true, mode: 0o700 })
    for (const file of plists) await cp(join(home, 'services', file), join(output, file))
    await save(join(output, 'result.json'), { tested: ['CLI install', 'verified local catalogs and locally built tarballs', 'Core setup and migrations', 'exact bootstrap versions', 'CLI update', 'confirmed CLI rollback', 'authored database data and installation identity preserved', 'plutil lint'], services: 'generated only; /Library/LaunchDaemons untouched', versions: [before.coreVersion, upgraded.coreVersion, restored.coreVersion], plists })
    console.log(`Generated plists and verification result: ${output}`)
  }
  await run(process.execPath, [cli, 'uninstall', '--home', home], { timeout: 120000 })
  await assert.rejects(lstat(join(home, 'current')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(home, 'releases')), { code: 'ENOENT' })
  assert.equal((await json(join(home, 'installation.json'))).installationId, before.installationId)
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  await run(process.execPath, [cli, 'uninstall', '--home', home])
  await run(process.execPath, [cli, 'install', '--home', home, '--config', path, '--maintenance-config', maintenancePath, '--catalog', catalog.base, '--no-launchd'], { timeout: 120000 })
  const reinstalled = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(reinstalled.installationId, before.installationId)
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  await available(config)
  await installedStatus(home, config)
})

test('real macOS Core first-install failures restore home and database and then retry successfully', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' || noDatabase, timeout: 240000 }, async t => {
  const catalog = await catalogs(t, { real: true, versions: ['0.0.0'] }), executable = await codex(t), app = { source: await testApp(t), requireTeam: false }
  for (const stage of ['download', 'sudo registration', 'Core setup', 'health check']) await t.test(stage, async t => {
    const home = await directory(t, 'kpi-e2e-retry-'), { database: db, databaseUrl } = await database(t)
    await mkdir(join(home, 'fixture-codex'), { mode: 0o700 })
    const { config, path, maintenancePath } = await configuration(t, home, databaseUrl, { adapters: [{ id: 'codex-cli', root: home, entry: 'node_modules/@kipster/codex-cli/dist/index.js', config: { executable, codexHome: join(home, 'fixture-codex') } }] })
    await db.query("CREATE TABLE public.before_install(note text); INSERT INTO public.before_install VALUES('retained')")
    await mkdir(join(home, 'system'), { mode: 0o700 })
    await writeFile(join(home, 'system/instructions.md'), 'Authored system instructions', { mode: 0o600 })
    const options = { home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: stage !== 'sudo registration', healthTimeout: 1000 }
    const legacy = stage === 'sudo registration' ? await directory(t, 'kpi-legacy-home-') : null
    let failing = true
    const hooks = { app,
      registerServices: async () => {
        if (failing) {
          for (const name of ['installation.json', 'agents', 'organizations', 'system']) await cp(join(home, name), join(legacy, name), { recursive: true })
          throw new Error('System service registration timed out.')
        }
      },
      onStep: async step => {
        if (step === 'migrating' && stage === 'Core setup' && failing) { await rm(join(home, 'system/instructions.md')); await symlink('/dev/null', join(home, 'system/instructions.md')) }
        if (step === 'checking' && stage === 'sudo registration') await hostCommand(join(home, 'current'), 'start', home, process.env)
        if (step === 'checking' && stage === 'health check' && failing) await hostCommand(join(home, 'current'), 'stop', home, process.env)
      },
    }
    const file = catalog.packages['@kipster/core'][0].files[0], url = file.url
    if (stage === 'download') file.url = new URL('/missing.tgz', catalog.base).href
    await assert.rejects(install(options, hooks), /Download.*404|registration timed out|Core setup failed.*Unsafe home file|health check/)
    assert.equal(await db.query('SELECT note FROM public.before_install'), 'retained')
    assert.equal(await db.query("SELECT count(*) FROM pg_namespace WHERE nspname='kipster'"), '0')
    for (const name of ['installation.json', 'agents', 'organizations', 'artifacts', 'adapter-generations', 'providers']) await assert.rejects(lstat(join(home, name)), { code: 'ENOENT' })
    assert.equal(await readFile(join(home, 'system/instructions.md'), 'utf8'), 'Authored system instructions')
    const status = await json(join(home, 'updates/status.json'))
    assert.deepEqual(updaterStatusFile.parse(status), status)
    if (stage === 'Core setup') assert.match(status.error, /Unsafe home file/)
    // Reproduce a failed install left by the shipped installer, which restored
    // its database but retained Core's home. The retry must preserve and repair it.
    if (legacy) for (const name of ['installation.json', 'agents', 'organizations', 'system']) await cp(join(legacy, name), join(home, name), { recursive: true })
    failing = false; file.url = url
    await install(options, hooks)
    if (legacy) {
      const saved = (await readdir(join(home, 'backups'))).find(name => name.startsWith('failed-install-home-'))
      assert.ok(saved)
      assert.deepEqual(await json(join(home, 'backups', saved, 'installation.json')), await json(join(legacy, 'installation.json')))
    }
    await available(config)
    await installedStatus(home, config)
    await Installer.open(home, { ...hooks, unregisterServices: async () => {} }).then(installer => installer.uninstall())
  })
})
