import { join } from 'node:path'
import { chmod, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { atomic, digest, json, save, syncDirectory } from './files.mjs'
import { run } from './process.mjs'

const hostname = url => url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
export function databaseEnvironment(databaseUrl, environment = process.env) {
  const url = new URL(databaseUrl)
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) throw new Error('Configure a PostgreSQL databaseUrl in a private --config file or KIPSTER_DATABASE_URL.')
  const env = { ...environment, PGHOST: hostname(url), PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5' }
  // Keep the configured URL authoritative over inherited libpq routing settings.
  for (const key of ['PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE']) delete env[key]
  const options = { host: 'PGHOST', port: 'PGPORT', dbname: 'PGDATABASE', user: 'PGUSER', password: 'PGPASSWORD', sslmode: 'PGSSLMODE', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', sslrootcert: 'PGSSLROOTCERT', sslcrl: 'PGSSLCRL', options: 'PGOPTIONS', application_name: 'PGAPPNAME' }
  for (const [key, value] of url.searchParams) {
    if (!options[key]) throw new Error(`Unsupported databaseUrl parameter: ${key}. Use standard libpq connection parameters.`)
    env[options[key]] = value
  }
  env.PGOPTIONS = `${env.PGOPTIONS ?? ''} -c statement_timeout=120000`
  return env
}
export function databaseEndpoint(databaseUrl) {
  const url = new URL(databaseUrl)
  return JSON.stringify([url.searchParams.get('host') ?? hostname(url), (url.searchParams.get('port') ?? url.port) || '5432', url.searchParams.get('dbname') ?? decodeURIComponent(url.pathname.slice(1))])
}
export class Database {
  constructor(config, bin, environment) {
    this.env = databaseEnvironment(config.databaseUrl, environment)
    this.bin = bin
  }
  program(name) { return this.bin ? join(this.bin, name) : name }
  query(sql) { return run(this.program('psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: this.env, timeout: 15000, label: 'PostgreSQL query' }) }
  async check() {
    let result
    try { result = JSON.parse(await this.query("SELECT json_build_object('major',current_setting('server_version_num')::int/10000,'vector',EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector'),'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user))")) }
    catch { throw new Error('PostgreSQL is unreachable. Install PostgreSQL 18 and pgvector, start the server, and check the private databaseUrl and login with psql.') }
    if (result.major !== 18) throw new Error(`PostgreSQL ${result.major} is unsupported. Prepare PostgreSQL 18; do not point this installer at a different major version.`)
    if (!result.vector) throw new Error('pgvector is missing. Install pgvector for PostgreSQL 18, then run CREATE EXTENSION vector in the configured database.')
    if (!result.superuser) throw new Error('Backup/restore needs a PostgreSQL superuser maintenance login to recreate pgvector and preserve table ownership and grants. Pass a private --maintenance-config JSON with databaseUrl for this same dedicated database. Core can keep its normal database login.')
    for (const program of ['pg_dump', 'pg_restore', 'psql']) {
      let output
      try { output = await run(this.program(program), ['--version'], { env: this.env, timeout: 10000 }) }
      catch { throw new Error(`Install PostgreSQL 18 client tools and add its bin directory to PATH, or pass --pg-bin; ${program} is unavailable.`) }
      if (!/\b18(?:\.|\b)/.test(output)) throw new Error(`${program} must match PostgreSQL 18. Use --pg-bin with the PostgreSQL 18 bin directory (for Homebrew: /opt/homebrew/opt/postgresql@18/bin).`)
    }
  }
  async backup(directory, metadata) {
    const temporary = join(directory, `${randomUUID()}.dump.tmp`), destination = join(directory, 'database.dump')
    try {
      await run(this.program('pg_dump'), ['-Fc', '--no-password', '--file', temporary], { env: this.env, timeout: 300000, label: 'Database backup' })
      await chmod(temporary, 0o600)
      const fd = await open(temporary, 'r'); try { await fd.sync() } finally { await fd.close() }
      const archive = await digest(temporary)
      await rename(temporary, destination); await syncDirectory(directory)
      await save(join(directory, 'backup.json'), { ...metadata, archive })
    } finally { await rm(temporary, { force: true }) }
  }
  async restore(directory, scratch) {
    const metadata = await json(join(directory, 'backup.json')), archive = join(directory, 'database.dump')
    const actual = await digest(archive)
    if (actual.size !== metadata.archive.size || actual.sha256 !== metadata.archive.sha256) throw new Error('Database backup size or sha256 mismatch. Recovery is held; preserve the backup and inspect storage.')
    const sql = join(scratch, randomUUID() + '.restore.sql'), reset = join(scratch, randomUUID() + '.reset.sql')
    try {
      const toc = await run(this.program('pg_restore'), ['--list', archive], { env: this.env })
      await run(this.program('pg_restore'), ['--file', sql, archive], { env: this.env, timeout: 300000, label: 'Prepare database restore' })
      await chmod(sql, 0o600)
      // --clean alone does not remove tables/schemas added after the dump. Both
      // reset and restore run inside the same psql transaction, including errors.
      const cleanup = `DO $$ DECLARE item record; BEGIN
        FOR item IN SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' LOOP EXECUTE format('DROP EXTENSION %I CASCADE',item.extname); END LOOP;
        FOR item IN SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' LOOP EXECUTE format('DROP SCHEMA %I CASCADE',item.nspname); END LOOP;
      END $$;
      SELECT lo_unlink(oid) FROM pg_largeobject_metadata;
      ${/\bSCHEMA - public\b/.test(toc) ? '' : 'CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;'}\n`
      await atomic(reset, cleanup)
      await run(this.program('psql'), ['-X', '--no-password', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', reset, '-f', sql], { env: this.env, timeout: 300000, label: 'Database restore', limit: 32 * 1024 * 1024 })
    } finally { await rm(sql, { force: true }); await rm(reset, { force: true }) }
  }
}
