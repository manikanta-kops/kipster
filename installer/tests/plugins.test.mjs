import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { install, Installer, managedConfiguration } from '../src/installer.mjs'
import { withPlugins } from '../src/plugins.mjs'
import { json } from '../src/files.mjs'
import { run } from '../src/process.mjs'
import { catalogs, configuration, database, directory, hooks, noDatabase } from './support.mjs'

const module = home => join(home, 'current/node_modules/@kipster/plugins/dist/server/cli.js')

/**
 * Publishes a fake @kipster/plugins release from a second loopback "repository" host, as
 * kipster-plugins publishes its tarballs from its own GitHub releases. The package carries an
 * npm dependency; it is bundled so installing it needs no registry.
 */
async function pluginsRepository(t, catalog) {
  const root = await directory(t, 'kpi-plugins-'), requests = [], files = new Map()
  const server = createServer(async (request, response) => {
    requests.push(request.url)
    if (!files.has(request.url)) { response.writeHead(404); response.end(); return }
    response.end(await readFile(files.get(request.url)))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  async function publish(version) {
    const source = join(root, 'source-' + version), dependency = join(source, 'node_modules/plugins-fixture-dependency')
    await mkdir(join(source, 'dist/server'), { recursive: true }); await mkdir(dependency, { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: '@kipster/plugins', version, type: 'module', dependencies: { 'plugins-fixture-dependency': '1.0.0' }, bundleDependencies: ['plugins-fixture-dependency'] }))
    await writeFile(join(source, 'dist/server/cli.js'), "import { name } from 'plugins-fixture-dependency'\nconsole.log(name)\n")
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'plugins-fixture-dependency', version: '1.0.0', type: 'module', main: 'index.js' }))
    await writeFile(join(dependency, 'index.js'), "export const name = 'fixture plugin server'\n")
    const entry = await catalog.pack('plugins', version, source), file = entry.files[0]
    const route = `/releases/download/plugins-v${version}/${file.name}`
    files.set(route, catalog.files.get(new URL(file.url).pathname))
    file.url = base + route
    return entry
  }
  return { publish, requests }
}

async function setup(t, { versions = ['0.1.0', '0.2.0', '0.3.0'] } = {}) {
  const home = await directory(t), { databaseUrl } = await database(t)
  const catalog = await catalogs(t, { versions, adapters: ['codex-cli'] })
  // Offline npm proves the plugins package installs from its verified tarball alone.
  const { path, maintenancePath } = await configuration(t, home, databaseUrl, { environment: { npm_config_offline: 'true' } })
  const options = { home, config: path, maintenanceConfig: maintenancePath, catalog: catalog.base, noLaunchd: true, healthTimeout: 1000 }
  return { home, catalog, options, plugins: await pluginsRepository(t, catalog) }
}
const installedPackages = async home => (await json(join(home, 'current/release.json'))).packages.map(item => `${item.package}@${item.version}`).sort()

test('host.json names the plugin server only once its channel has released it', () => {
  const config = { version: 1, home: '/tmp/home', adapters: [] }
  const unreleased = withPlugins(config, '/tmp/home', false)
  assert.equal(unreleased.config, config)
  assert.match(unreleased.report, /@kipster\/plugins has no release on this channel yet; Kipster runs without plugins/)
  assert.deepEqual(withPlugins(config, '/tmp/home', true), { config: { ...config, plugins: { module: module('/tmp/home') } }, report: null })
  const replaced = withPlugins({ ...config, plugins: { module: '/elsewhere/node_modules/@kipster/plugins/dist/server/cli.js' } }, '/tmp/home', true)
  assert.deepEqual(replaced.config.plugins, { module: module('/tmp/home') })
})

test('managed configuration moves the plugins module through current and names its package', () => {
  for (const path of ['/old/release/node_modules/@kipster/plugins/dist/server/cli.js', '/checkout/plugins/dist/server/cli.js']) {
    const result = managedConfiguration({ adapters: [], plugins: { module: path } }, '/tmp/home')
    assert.deepEqual(result.names, ['@kipster/plugins'])
    assert.deepEqual(result.config.plugins, { module: module('/tmp/home') })
  }
  assert.equal(managedConfiguration({ adapters: [] }, '/tmp/home').config.plugins, undefined)
  for (const path of ['/checkout/kipster-plugins/dist/server/cli.js', '/x/node_modules/@kipster/plugins/../escape.js', 42]) {
    assert.throws(() => managedConfiguration({ adapters: [], plugins: { module: path } }, '/tmp/home'), /plugins module paths/)
  }
  assert.throws(() => managedConfiguration({ adapters: [], plugins: { module: '/x/node_modules/@kipster/core/dist/host.js' } }, '/tmp/home'), /not Core/)
})

test('an installation without plugins on its channel gains them through an update once released', { skip: noDatabase, timeout: 180000 }, async t => {
  const { home, catalog, options, plugins } = await setup(t)
  const first = await install(options, hooks)
  assert.equal(first.update.state, 'done')
  assert.match(first.plugins, /no release on this channel yet/)
  assert.equal((await json(join(home, 'host.json'))).plugins, undefined)
  assert.deepEqual(await installedPackages(home), ['@kipster/codex-cli@0.1.0', '@kipster/core@0.1.0'])

  // A prerelease reaches next only; the stable installation stays without plugins.
  await plugins.publish('0.3.0-next.1')
  catalog.select('0.2.0'); catalog.select('0.2.0', 'next')
  assert.equal(catalog.catalogs.stable.packages['@kipster/plugins'], undefined)
  assert.equal(catalog.catalogs.next.packages['@kipster/plugins'].version, '0.3.0-next.1')
  const installer = await Installer.open(home, hooks)
  assert.match((await installer.update()).plugins, /no release on this channel yet/)
  assert.equal((await json(join(home, 'host.json'))).plugins, undefined)
  assert.deepEqual(plugins.requests, [])

  // A corrupt plugins tarball fails verification and the installation keeps its configuration.
  await plugins.publish('0.2.0')
  catalog.select('0.3.0')
  const entry = catalog.catalogs.stable.packages['@kipster/plugins']
  assert.equal(entry.version, '0.2.0')
  const sha256 = entry.files[0].sha256
  entry.files[0].sha256 = '0'.repeat(64)
  await assert.rejects(installer.update(), /sha256 mismatch for @kipster\/plugins/)
  assert.equal((await installer.status()).coreVersion, '0.2.0')
  assert.equal((await json(join(home, 'host.json'))).plugins, undefined)

  entry.files[0].sha256 = sha256
  const updated = await installer.update()
  assert.equal(updated.coreVersion, '0.3.0'); assert.equal(updated.plugins, undefined)
  assert.deepEqual((await json(join(home, 'host.json'))).plugins, { module: module(home) })
  assert.deepEqual(await installedPackages(home), ['@kipster/codex-cli@0.1.0', '@kipster/core@0.3.0', '@kipster/plugins@0.2.0'])
  assert.deepEqual(plugins.requests, ['/releases/download/plugins-v0.2.0/kipster-plugins-0.2.0.tgz', '/releases/download/plugins-v0.2.0/kipster-plugins-0.2.0.tgz'], 'downloaded from the plugins repository host')
  assert.equal(await run(process.execPath, [module(home)]), 'fixture plugin server', 'the server runs with its npm dependency')
})

test('a new installation on a channel with plugins configures and installs them; updates refuse a withdrawn release', { skip: noDatabase, timeout: 180000 }, async t => {
  const { home, catalog, options, plugins } = await setup(t, { versions: ['0.1.0', '0.2.0'] })
  await plugins.publish('0.2.0')
  catalog.select('0.1.0')
  const first = await install(options, hooks)
  assert.equal(first.update.state, 'done'); assert.equal(first.plugins, undefined)
  const host = await json(join(home, 'host.json'))
  assert.deepEqual(host.plugins, { module: module(home) })
  assert.deepEqual(host.environment, { npm_config_offline: 'true' })
  assert.deepEqual(await installedPackages(home), ['@kipster/codex-cli@0.1.0', '@kipster/core@0.1.0', '@kipster/plugins@0.2.0'])
  assert.equal(await run(process.execPath, [module(home)]), 'fixture plugin server')

  // host.json names the package, so an update never proceeds without its release.
  catalog.select('0.2.0')
  delete catalog.catalogs.stable.packages['@kipster/plugins']
  const installer = await Installer.open(home, hooks)
  await assert.rejects(installer.update(), /Publish a stable release for @kipster\/plugins/)
  assert.equal((await installer.status()).coreVersion, '0.1.0')
  assert.deepEqual((await json(join(home, 'host.json'))).plugins, { module: module(home) })
})
