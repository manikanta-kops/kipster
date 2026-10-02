import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../src/process.mjs'
import { Database } from '../src/database.mjs'
const root = await realpath(await mkdtemp('/tmp/kpi-pg-')), data = join(root, 'data')
let started = false
try {
  const env = { ...process.env, LC_ALL: 'C' }
  await run('initdb', ['-D', data, '-U', 'kipster_installer_test', '-A', 'trust', '-E', 'UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--no-instructions'], { env })
  await run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${root}' -p 55439`, '-w', '-t', '30', 'start'], { env })
  started = true
  const url = `postgresql://kipster_installer_test@localhost:55439/postgres?host=${encodeURIComponent(root)}`
  const db = new Database({ databaseUrl: url })
  if (await db.query("SELECT count(*) FROM pg_available_extensions WHERE name='vector'") !== '1') throw new Error('Install pgvector for PostgreSQL 18 before running installer tests.')
  await run('npm', ['test'], { cwd: new URL('..', import.meta.url).pathname, env: { ...env, KIPSTER_TEST_DATABASE_URL: url }, inherit: true, timeout: 600000 })
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally {
  if (started) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop']).catch(error => { console.error(error.message); process.exitCode = 1 })
  await rm(root, { recursive: true, force: true })
}
