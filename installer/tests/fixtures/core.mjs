import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { control, ownControl } from './host-control.js'
export { control, recoverStoppedControl } from './host-control.js'
export { validateHostConfig } from './host-config.js'
const cli = fileURLToPath(import.meta.url)
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
const exists = async path => { try { await access(path); return true } catch { return false } }
function query(config, sql) {
  const url = new URL(config.databaseUrl)
  const env = { ...process.env, PGHOST: url.searchParams.get('host') ?? url.hostname, PGPORT: url.port, PGUSER: url.username, PGDATABASE: url.pathname.slice(1) }
  return execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, encoding: 'utf8' }).trim()
}
async function settings(home) { return await exists(join(home, 'fixture.json')) ? JSON.parse(await readFile(join(home, 'fixture.json'))) : {} }
export async function main(args) {
  const [command, , path] = args, config = JSON.parse(await readFile(path)), home = config.home
  if (command === 'setup') {
    const owner = await ownControl(home, { pid: process.pid, instance: randomUUID(), state: 'starting' }, () => {})
    try {
      const table = 'migration_' + pkg.version.replaceAll(/[^a-zA-Z0-9]/g, '_')
      query(config, `CREATE SCHEMA IF NOT EXISTS fixture; CREATE TABLE IF NOT EXISTS fixture.${table}(id int); CREATE TABLE IF NOT EXISTS fixture.items(id int PRIMARY KEY, note text)`)
      query(config, 'CREATE TABLE IF NOT EXISTS fixture.installation(id uuid)')
      let id = query(config, 'SELECT id FROM fixture.installation')
      if (!id) { id = randomUUID(); query(config, `INSERT INTO fixture.installation VALUES('${id}')`) }
      const marker = join(home, 'installation.json')
      if (await exists(marker) && JSON.parse(await readFile(marker)).installationId !== id) throw new Error('Home belongs to another installation')
      await writeFile(marker, JSON.stringify({ installationId: id }), { mode: 0o600 })
      for (const name of ['agents', 'organizations', 'system', 'artifacts']) {
        await mkdir(join(home, name), { recursive: true, mode: 0o700 })
        await writeFile(join(home, name, 'fixture-created.txt'), 'Core setup state', { mode: 0o600 })
      }
      if ((await settings(home)).migrationCrash === pkg.version) process.exit(81)
      if ((await settings(home)).migrationFailure === pkg.version) {
        query(config, 'CREATE SCHEMA failed_migration; CREATE TABLE failed_migration.new_table(id int REFERENCES fixture.items(id))')
        throw new Error('Injected failed migration')
      }
      console.log('{}')
    } finally { await owner.close() }
  } else if (command === 'serve') {
    if (await exists(join(home, 'updates/hold'))) return
    const state = { pid: process.pid, instance: randomUUID(), state: 'running' }
    let end
    const stopped = new Promise(resolve => { end = resolve })
    const owner = await ownControl(home, state, () => { state.state = 'stopping'; setTimeout(end, 20) })
    const server = createServer(async (request, response) => {
      if (request.url !== '/v1/bootstrap') { response.writeHead(404); response.end(); return }
      const failure = (await settings(home)).healthFailure === pkg.version
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ version: 1, coreVersion: failure ? '0.0.0' : pkg.version }))
    })
    process.on('SIGTERM', end); process.on('SIGINT', end)
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listen.port, config.listen.host, resolve) })
      await stopped
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await owner.close() }
  } else if (command === 'stop') {
    const state = await control(home, 'stop')
    if (state) for (let i = 0; i < 100; i++) { if (!await control(home, 'status')) break; await delay(20) }
  } else if (command === 'start') {
    if (await exists(join(home, 'updates/hold'))) throw new Error('Held')
    if (await control(home, 'status')) return
    await mkdir(join(home, 'logs'), { recursive: true })
    const output = await open(join(home, 'logs/fixture.log'), 'a', 0o600)
    const child = spawn(process.execPath, [cli, 'serve', '--config', path], { detached: true, env: process.env, stdio: ['ignore', output.fd, output.fd] })
    child.unref(); await output.close()
    for (let i = 0; i < 100; i++) {
      await delay(20)
      try { if ((await control(home, 'status'))?.state === 'running') return } catch { /* startup publishing */ }
    }
    throw new Error('Fixture startup failed')
  } else if (command === 'status') console.log(JSON.stringify(await control(home, 'status')))
}
if (process.argv[1] && await realpath(process.argv[1]) === cli) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
