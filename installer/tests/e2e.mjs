import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/process.mjs'
import { save, json } from '../src/files.mjs'
import { cli, database, directory, configuration, catalogs, noDatabase, repository } from './support.mjs'

test('macOS CLI installs and updates locally built Core/adapter tarballs without system registration', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' || noDatabase, timeout: 180000 }, async t => {
  await run('npm', ['run', 'build', '-w', 'adapters/codex-cli', '-w', 'adapters/embedding-ollama', '-w', 'adapters/transcription-spokenly'], { cwd: repository })
  const home = await directory(t, 'kpi-e2e-'), { database: db, databaseUrl } = await database(t)
  const catalog = await catalogs(t, { real: true, versions: ['0.0.0', '0.0.1'] })
  const { config, path, maintenancePath } = await configuration(t, home, databaseUrl, { adapters: [{ id: 'codex-cli', root: home, entry: 'node_modules/@kipster/codex-cli/dist/index.js', config: { executable: '/usr/bin/false', codexHome: join(home, 'fixture-codex') } }] })
  const installed = await run(process.execPath, [cli, 'install', '--home', home, '--config', path, '--maintenance-config', maintenancePath, '--catalog', catalog.base, '--no-launchd'], { timeout: 120000 })
  assert.match(installed, /<key>UserName<\/key>/)
  const launcher = join(home, 'bin/kipster')
  const before = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(before.coreVersion, '0.0.0')
  await db.query("CREATE TABLE public.installer_e2e_marker(note text); INSERT INTO public.installer_e2e_marker VALUES('authored data')")
  catalog.select('0.0.1')
  await run(process.execPath, [launcher, 'update', '--to', '0.0.1'], { timeout: 120000 })
  const upgraded = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(upgraded.coreVersion, '0.0.1'); assert.equal(upgraded.installationId, before.installationId)
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  await assert.rejects(run(process.execPath, [launcher, 'rollback']), /failed/)
  await run(process.execPath, [launcher, 'rollback', '--yes'], { timeout: 120000 })
  const restored = await (await fetch(`http://127.0.0.1:${config.listen.port}/v1/bootstrap`)).json()
  assert.equal(restored.coreVersion, '0.0.0'); assert.equal(restored.installationId, before.installationId)
  assert.equal(await db.query('SELECT note FROM public.installer_e2e_marker'), 'authored data')
  const status = JSON.parse(await run(process.execPath, [launcher, 'status']))
  assert.equal(status.update.state, 'done')
  const plists = await readdir(join(home, 'services'))
  for (const file of plists) await run('/usr/bin/plutil', ['-lint', join(home, 'services', file)])
  const output = process.env.KIPSTER_INSTALLER_E2E_OUTPUT
  if (output) {
    await mkdir(output, { recursive: true, mode: 0o700 })
    for (const file of plists) await cp(join(home, 'services', file), join(output, file))
    await save(join(output, 'result.json'), { tested: ['CLI install', 'verified local catalogs and locally built tarballs', 'Core setup and migrations', 'exact bootstrap versions', 'CLI update', 'confirmed CLI rollback', 'authored database data and installation identity preserved', 'plutil lint'], services: 'generated only; /Library/LaunchDaemons untouched', versions: [before.coreVersion, upgraded.coreVersion, restored.coreVersion], plists })
    console.log(`Generated plists and verification result: ${output}`)
  }
})
