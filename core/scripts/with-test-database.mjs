// Runs a command against a throwaway PostgreSQL cluster, then removes the cluster.
// Usage: node scripts/with-test-database.mjs <command> [args...]
// Requires initdb and pg_ctl from PostgreSQL 18 on PATH, with the pgvector extension installed.
// The server accepts only Unix socket connections in a private (0700) directory, so other local users cannot connect.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')
const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('Usage: node scripts/with-test-database.mjs <command> [args...]')
  process.exit(2)
}

const superuser = 'kipster_test'
const taskDataRole = 'kipster_test_task_data'
const port = 5432
const root = mkdtempSync(join(tmpdir(), 'kipster-test-db-'))
const data = join(root, 'data')
const log = join(root, 'server.log')
// A valid locale keeps the macOS postmaster from aborting at startup.
const serverEnv = { ...process.env, LC_ALL: 'C' }
let started = false

function run(program, programArgs) {
  const result = spawnSync(program, programArgs, { env: serverEnv, encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') throw new Error(`${program} not found on PATH; add the PostgreSQL 18 bin directory to PATH`)
  if (result.status !== 0) throw new Error(`${program} failed:\n${result.stderr || result.stdout}`)
}

function cleanup() {
  if (started) {
    try { run('pg_ctl', ['-D', data, '-m', 'fast', '-w', '-t', '60', 'stop']) } catch {
      try { run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']) } catch (error) { console.error(error.message) }
    }
    started = false
  }
  rmSync(root, { recursive: true, force: true })
}

async function prepare() {
  // Unix socket paths are limited to about 100 bytes.
  if (join(root, `.s.PGSQL.${port}`).length > 100) throw new Error(`Temporary directory path is too long for a socket: set TMPDIR to a shorter directory such as /tmp`)
  run('initdb', ['-D', data, '-U', superuser, '-A', 'trust', '-E', 'UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--no-sync', '--no-instructions'])
  appendFileSync(join(data, 'postgresql.conf'), `\nlisten_addresses = ''\nport = ${port}\nunix_socket_directories = '${root.replaceAll("'", "''")}'\n`)
  try {
    run('pg_ctl', ['-D', data, '-l', log, '-w', '-t', '60', 'start'])
  } catch (error) {
    try { error.message += `\n${readFileSync(log, 'utf8')}` } catch {}
    throw error
  }
  started = true
  const url = `postgresql://${superuser}@localhost:${port}/postgres?host=${encodeURIComponent(root)}`
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const vector = await client.query("SELECT 1 FROM pg_available_extensions WHERE name='vector'")
    if (!vector.rows.length) throw new Error('The pgvector extension is not installed for this PostgreSQL server')
    await client.query(`CREATE ROLE ${taskDataRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
  } finally { await client.end() }
  return url
}

let child
let exitCode = 1
const stop = signal => { if (child) child.kill(signal); else { cleanup(); process.exit(128 + constants.signals[signal]) } }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop)
try {
  const url = await prepare()
  child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, KIPSTER_TEST_DATABASE_URL: url } })
  exitCode = await new Promise(resolve => {
    child.once('error', error => { console.error(error.message); resolve(1) })
    child.once('exit', (code, signal) => resolve(code ?? 128 + (constants.signals[signal] ?? 0)))
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
} finally {
  cleanup()
}
process.exit(exitCode)
