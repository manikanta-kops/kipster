// Run via core/scripts/with-test-database.mjs after building Core's test fixture.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Postgres } from '../../../core/dist/platform/postgres/public.js'
const database = new Postgres(process.env.KIPSTER_TEST_DATABASE_URL)
const names = async () =>
  (
    await database.query(
      "SELECT datname FROM pg_database WHERE datname LIKE 'kipster_ui_%' ORDER BY datname",
    )
  ).rows.map((row) => row.datname)
const homes = async () =>
  (await readdir(tmpdir()))
    .filter((name) => name.startsWith('kipster-ui-real-'))
    .sort()
const occupied = createServer((_request, response) => {
  response.writeHead(503)
  response.end('Port occupied by test')
})
let child
try {
  await new Promise((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(4198, '127.0.0.1', resolve)
  })
  const beforeDatabases = await names()
  const beforeHomes = await homes()
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./real-core-lifecycle.mjs', import.meta.url))],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (bytes) => {
    output += bytes
  })
  child.stderr.on('data', (bytes) => {
    output += bytes
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, 30000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(timedOut, false, output)
  assert.notEqual(code, 0, output)
  assert.match(output, /Vite exited before the lifecycle fixture was ready/)
  assert.deepEqual(
    await names(),
    beforeDatabases,
    'failed startup must remove its database',
  )
  assert.deepEqual(
    await homes(),
    beforeHomes,
    'failed startup must remove its temporary home',
  )
  assert.equal(occupied.listening, true, 'do not terminate another port owner')
  console.log(
    'PASS: occupied Vite port exits promptly, removes fixture database/home, and preserves the port owner',
  )
} finally {
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill('SIGTERM')
  await new Promise((resolve) => occupied.close(resolve))
  await database.close()
}
