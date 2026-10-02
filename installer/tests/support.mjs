import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from '../src/process.mjs'
import { Database } from '../src/database.mjs'
import { digest, json, save } from '../src/files.mjs'
import { hostCommand, runtimeEnvironment } from '../src/services.mjs'

export const repository = fileURLToPath(new URL('../..', import.meta.url))
export const cli = join(repository, 'installer/src/cli.mjs')
export const adminUrl = process.env.KIPSTER_TEST_DATABASE_URL
export const noDatabase = adminUrl ? false : 'Run npm run test:postgres for real PostgreSQL tests.'
export const hooks = { platformCheck: async () => {} }
export async function database(t) {
  const name = 'installer_' + randomUUID().replaceAll('-', '')
  const role = 'owner_' + randomUUID().replaceAll('-', '')
  const admin = new Database({ databaseUrl: adminUrl })
  await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER`)
  await admin.query(`CREATE DATABASE ${name} OWNER ${role}`)
  const url = new URL(adminUrl); url.pathname = '/' + name
  const database = new Database({ databaseUrl: url.href })
  await database.query('CREATE EXTENSION vector')
  t.after(async () => { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.query(`DROP ROLE ${role}`) })
  url.username = role
  return { database, databaseUrl: url.href }
}
export async function directory(t, prefix = 'kpi-') {
  const path = await realpath(await mkdtemp('/tmp/' + prefix))
  t.after(async () => {
    // Stop owned hosts while their config/release still exist, before deleting
    // their home or the database registered by a later cleanup hook.
    try { await hostCommand(join(path, 'current'), 'stop', path, process.env) } catch {}
    await rm(path, { recursive: true, force: true })
  })
  return path
}
export async function port() {
  const server = netServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}
export async function configuration(t, home, databaseUrl, extras = {}) {
  const config = { version: 1, home, databaseUrl, listen: { host: '127.0.0.1', port: await port(), allowedHosts: [], allowedOrigins: ['tauri://localhost'] }, adapters: [{ id: 'codex-custom', root: home, entry: 'node_modules/@kipster/codex-cli/dist/index.js', config: { retained: true } }], ...extras }
  const path = join(home, 'input.json'); await save(path, config)
  const maintenanceURL = new URL(adminUrl); maintenanceURL.pathname = new URL(databaseUrl).pathname
  const maintenancePath = join(home, 'maintenance-input.json'); await save(maintenancePath, { databaseUrl: maintenanceURL.href })
  t.after(async () => { try { await hostCommand(join(home, 'current'), 'stop', home, runtimeEnvironment(config)) } catch {} })
  return { config, path, maintenancePath }
}
export async function catalogs(t, { versions = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0'], real = false } = {}) {
  const root = await directory(t, 'kpi-catalog-'), packages = {}, files = new Map()
  const catalogs = { stable: { schemaVersion: 1, packages: {} }, next: { schemaVersion: 1, packages: {} }, releases: { schemaVersion: 1, packages } }
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push(request.url)
    const match = /^\/v1\/(stable|next|releases)\.json$/.exec(request.url)
    if (match) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(catalogs[match[1]])); return }
    if (files.has(request.url)) { response.end(await readFile(files.get(request.url))); return }
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/v1/`
  async function pack(name, version, source) {
    const directory = join(root, name + '-' + version)
    await mkdir(directory, { recursive: true })
    if (source) await cp(source, directory, { recursive: true })
    if (name === 'core' && !real) {
      await mkdir(join(directory, 'dist'), { recursive: true })
      await cp(join(repository, 'installer/tests/fixtures/core.mjs'), join(directory, 'dist/host.js'))
      for (const file of ['host-config.js', 'host-control.js']) await cp(join(repository, 'core/dist', file), join(directory, 'dist', file))
    } else if (name !== 'installer' && !real) {
      await mkdir(join(directory, 'dist'), { recursive: true })
      await writeFile(join(directory, 'dist/index.js'), 'export const fixture = true\n')
    }
    const manifest = source ? await json(join(directory, 'package.json')) : { name: '@kipster/' + name, type: 'module' }
    manifest.version = version
    delete manifest.devDependencies; delete manifest.scripts
    await save(join(directory, 'package.json'), manifest)
    const packed = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: directory }))
    const path = join(root, packed[0].filename), archive = await digest(path), route = '/files/' + packed[0].filename
    files.set(route, path)
    const entry = { package: manifest.name, version, prerelease: version.includes('-'), files: [{ name: packed[0].filename, url: new URL(route, base).href, ...archive }] }
    ;(packages[manifest.name] ??= []).unshift(entry)
    return entry
  }
  for (const version of versions) await pack('core', version, real ? join(repository, 'core') : null)
  for (const name of ['codex-cli', 'embedding-ollama', 'transcription-spokenly']) await pack(name, '0.1.0', real ? join(repository, 'adapters', name) : null)
  // Copy only the shipped installer files, avoiding recursive tests/workspaces.
  const installerSource = join(root, 'installer-source')
  await mkdir(installerSource)
  for (const name of ['src', 'launchers', 'package.json']) await cp(join(repository, 'installer', name), join(installerSource, name), { recursive: true })
  await pack('installer', '0.1.0', installerSource)
  function select(version, selectedChannel = 'stable') {
    catalogs[selectedChannel].packages = Object.fromEntries(Object.entries(packages).map(([name, entries]) => [name, name === '@kipster/core' ? entries.find(entry => entry.version === version) : entries.find(entry => selectedChannel === 'next' || !entry.prerelease)]))
  }
  select(versions[0]); select(versions[0], 'next')
  return { root, base, catalogs, packages, files, requests, select, pack, installerSource }
}
