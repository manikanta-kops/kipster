import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safeError } from '../src/diagnostics.mjs'
import { run } from '../src/process.mjs'
import { save } from '../src/files.mjs'
import { hostCommand } from '../src/services.mjs'
import { directory } from './support.mjs'

test('diagnostics retain the cause and redact configuration and URL credentials', () => {
  const config = { databaseUrl: 'postgresql://private-user:p%40ssword@host/private-db', adapters: [{ config: { apiKey: 'provider-key', credentials: { value: 'private-value' } } }] }
  const error = new Error(`Migration 015 rejected: ${config.databaseUrl}; password p@ssword; provider-key private-value; https://login:other-password@host/path; Bearer auth-value; token=unconfigured-secret`)
  const message = safeError(error, config)
  assert.match(message, /Migration 015 rejected/)
  for (const secret of ['postgresql://', 'private-db', 'private-user', 'p%40ssword', 'p@ssword', 'provider-key', 'private-value', 'login', 'other-password', 'auth-value', 'unconfigured-secret']) assert.ok(!message.includes(secret), secret)
})

test('migration stderr and the parent setup error expose a sanitized underlying cause', async t => {
  const home = await directory(t), release = join(home, 'release'), dist = join(release, 'node_modules/@kipster/core/dist')
  await mkdir(dist, { recursive: true })
  await save(join(home, 'host.json'), { databaseUrl: 'postgresql://private-user:database-password@host/private-db', environment: { PROVIDER_API_KEY: 'provider-secret' } })
  await writeFile(join(dist, 'host.js'), `import {readFile} from 'node:fs/promises'; export async function main(args) { const config = JSON.parse(await readFile(args[2])); throw new Error('Home belongs to another installation: ' + config.databaseUrl + ' provider-secret'); }`)
  await writeFile(join(dist, '../package.json'), '{"type":"module"}')
  const child = spawn(process.execPath, [new URL('../src/migrate.mjs', import.meta.url).pathname, join(dist, 'host.js'), join(home, 'host.json')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', bytes => { stderr += bytes })
  child.stdin.end('migrate\n')
  const code = await new Promise(resolve => child.once('close', resolve))
  assert.equal(code, 1)
  assert.match(stderr, /Home belongs to another installation/)
  assert.doesNotMatch(stderr, /postgresql:|private-user|database-password|private-db|provider-secret/)
  await assert.rejects(hostCommand(release, 'setup', home, process.env), error => {
    assert.match(error.message, /Core setup failed.*Home belongs to another installation/)
    assert.doesNotMatch(error.message, /postgresql:|private-user|database-password|private-db|provider-secret/)
    return true
  })
  // Other subprocesses can emit SQL; their stderr remains hidden by default.
  await assert.rejects(run(process.execPath, ['-e', "console.error('private SQL'); process.exit(1)"]), error => !error.message.includes('private SQL'))
})
