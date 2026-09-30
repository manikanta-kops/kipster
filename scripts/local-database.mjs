import { createRequire } from 'node:module'
import { appendFile, readFile, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, privateDirectory, run } from './local-common.mjs'

export const databaseName = 'kipster'
export function databaseURL(home, database = databaseName, user = 'kipster_dev') {
  const url = new URL(`postgresql://${user}@localhost:5432/${database}`)
  url.searchParams.set('host', join(home, 'pg-socket'))
  return url.href
}
export async function postgresBinaries() {
  const installedBrew = await exists('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : await exists('/usr/local/bin/brew') ? '/usr/local/bin/brew' : undefined
  if (!installedBrew) throw new Error('Install Homebrew first, then rerun npm run backend. It will install PostgreSQL 18 and pgvector as needed.')
  const prefix = (await run(installedBrew, ['--prefix', 'postgresql@18'], { capture: true })).output
  const bin = join(prefix, 'bin')
  if (!await exists(join(bin, 'initdb'))) await run(installedBrew, ['install', 'postgresql@18'])
  const shared = (await run(join(bin, 'pg_config'), ['--sharedir'], { capture: true })).output
  if (!await exists(join(shared, 'extension/vector.control'))) await run(installedBrew, ['install', 'pgvector'])
  if (!await exists(join(shared, 'extension/vector.control'))) throw new Error('pgvector is not installed for PostgreSQL 18. Repair that installation, then rerun npm run backend.')
  return bin
}
export function postgresClient(installation) {
  return createRequire(join(installation, 'node_modules/@kipster/core/package.json'))('pg').Client
}
export async function checkDatabase(home, bin, Client) {
  if (!await exists(join(home, 'postgres/PG_VERSION'))) return false
  const version = (await readFile(join(home, 'postgres/PG_VERSION'), 'utf8')).trim()
  if (version !== '18') throw new Error(`Existing PostgreSQL data uses version ${version}; automatic major-version migration is not supported. Data was preserved.`)
  const status = await run(join(bin, 'pg_ctl'), ['-D', join(home, 'postgres'), 'status'], { capture: true, allowFailure: true })
  if (status.code === 3) return false
  if (status.code !== 0) throw new Error(`Unable to inspect the development database: ${status.error || status.output}`)
  const client = new Client({ connectionString: databaseURL(home, 'postgres'), connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    const { rows: [row] } = await client.query("SELECT current_setting('data_directory') AS data, current_setting('listen_addresses') AS listen")
    if (await realpath(row.data) !== await realpath(join(home, 'postgres')) || row.listen !== '') throw new Error('Database does not match the private development cluster. It was not modified.')
  } finally { await client.end() }
  return true
}
export async function prepareDatabase(home, bin, Client) {
  const data = join(home, 'postgres'), socket = join(home, 'pg-socket')
  await privateDirectory(socket)
  if (Buffer.byteLength(join(socket, '.s.PGSQL.5432')) > 100) throw new Error('Development home is too long for a PostgreSQL socket; use a shorter home folder path.')
  if (!await exists(data)) {
    const staged = join(home, 'postgres-initializing')
    if (await exists(staged)) throw new Error(`An interrupted database initialization remains at ${staged}. Inspect it before removing it and retrying.`)
    await run(join(bin, 'initdb'), ['-D', staged, '-U', 'kipster_dev', '-A', 'trust', '-E', 'UTF8', '--locale-provider=builtin', '--builtin-locale=C.UTF-8', '--no-instructions'], { env: { ...process.env, LC_ALL: 'C' }, capture: true })
    await appendFile(join(staged, 'postgresql.conf'), `\nlisten_addresses = ''\nport = 5432\nunix_socket_directories = '${socket.replaceAll("'", "''")}'\n`)
    await rename(staged, data)
  }
  if (!await exists(join(data, 'PG_VERSION'))) throw new Error(`Incomplete PostgreSQL directory at ${data}; it was preserved.`)
  if (!await checkDatabase(home, bin, Client)) {
    console.log('Starting the private development database…')
    await run(join(bin, 'pg_ctl'), ['-D', data, '-l', join(home, 'logs/postgres.log'), '-w', '-t', '60', 'start'], { env: { ...process.env, LC_ALL: 'C' } })
    await checkDatabase(home, bin, Client)
  }
  const admin = new Client({ connectionString: databaseURL(home, 'postgres'), connectionTimeoutMillis: 3000 })
  try {
    await admin.connect()
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount) await admin.query('CREATE DATABASE kipster')
    if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='kipster_task'")).rowCount) await admin.query('CREATE ROLE kipster_task LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS')
    await admin.query('REVOKE TEMPORARY ON DATABASE kipster FROM PUBLIC')
  } finally { await admin.end() }
  const db = new Client({ connectionString: databaseURL(home), connectionTimeoutMillis: 3000 })
  try {
    await db.connect()
    await db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await db.query('CREATE EXTENSION IF NOT EXISTS vector')
  } finally { await db.end() }
  console.log('PostgreSQL and pgvector ready; existing data preserved.')
}
export async function stopDatabase(home, bin, Client) {
  if (await checkDatabase(home, bin, Client)) await run(join(bin, 'pg_ctl'), ['-D', join(home, 'postgres'), '-m', 'fast', '-w', '-t', '60', 'stop'])
}
