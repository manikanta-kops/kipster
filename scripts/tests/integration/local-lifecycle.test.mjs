import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { activateBackend, buildBackend, configuration, hostCommand } from '../../local-backend.mjs'
import { checkDatabase, databaseURL, postgresBinaries, postgresClient, prepareDatabase, stopDatabase } from '../../local-database.mjs'
import { initializeHome, json, privateDirectory, repository, run, saveJSON } from '../../local-common.mjs'

test('real local database and host survive repeat startup, stop and occupied-port failure', { timeout: 240000 }, async t => {
  // The launcher always uses ~/.kipster/dev, so the commands run with a disposable HOME.
  const user = await realpath(await mkdtemp('/tmp/kipster-local-'))
  const home = join(user, '.kipster/dev')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const bin = await postgresBinaries()
  let installation, Client, configured = false
  t.after(async () => {
    if (configured) await hostCommand(installation, join(home, 'host.json'), 'stop').catch(() => {})
    if (Client) await stopDatabase(home, bin, Client)
    await rm(user, { recursive: true, force: true })
  })
  await initializeHome(home)
  await privateDirectory(join(home, 'logs'))
  installation = await buildBackend(home)
  Client = postgresClient(installation)
  // Exercise the real adapter's unavailable path without accessing any provider account.
  const fakeBin = join(home, 'test-bin'); await mkdir(fakeBin)
  await writeFile(join(fakeBin, 'codex'), '#!/bin/sh\necho "No provider in local lifecycle test" >&2\nexit 1\n', { mode: 0o700 })
  const occupied = createServer((_request, response) => response.end('foreign-owner'))
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => occupied.listening ? new Promise(resolve => occupied.close(resolve)) : undefined)
  const port = occupied.address().port
  const config = configuration(home, installation)
  config.listen.port = port
  config.environment = { PATH: `${fakeBin}:${process.env.PATH}` }
  await saveJSON(join(home, 'host.json'), config); configured = true
  await prepareDatabase(home, bin, Client)
  assert.equal(await checkDatabase(home, bin, Client), true)
  await assert.rejects(activateBackend(home, installation, bin), /occupied/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'foreign-owner')
  await new Promise(resolve => occupied.close(resolve))
  const first = await activateBackend(home, installation, bin)
  assert.equal(first.state, 'running')
  const db = new Client({ connectionString: databaseURL(home) }); await db.connect()
  let identity, before
  try {
    const agent = (await db.query('SELECT root_agent_id FROM kipster.bootstrap')).rows[0].root_agent_id
    identity = join(home, 'agents', agent, 'identity.md')
    before = await readFile(identity, 'utf8') + '\nRetain authored identity\n'
    await writeFile(identity, before)
    await db.query('CREATE TABLE public.local_launch_test (value text)')
    await db.query("INSERT INTO public.local_launch_test VALUES ('saved data')")
  } finally { await db.end() }
  const postgresPID = await readFile(join(home, 'postgres/postmaster.pid'), 'utf8')
  await prepareDatabase(home, bin, Client)
  const second = await activateBackend(home, installation, bin)
  assert.equal(second.installationId, first.installationId)
  assert.notEqual(second.instance, first.instance)
  assert.equal(await readFile(join(home, 'postgres/postmaster.pid'), 'utf8'), postgresPID)
  assert.equal(await readFile(identity, 'utf8'), before)
  assert.equal((await json(join(home, 'host.json'))).environment.PATH, config.environment.PATH)
  // A rejected new configuration leaves the already running backend untouched.
  const saved = await json(join(home, 'host.json'))
  await saveJSON(join(home, 'host.json'), { ...saved, listen: { ...saved.listen, host: '0.0.0.0' } })
  await assert.rejects(activateBackend(home, installation, bin), /loopback/)
  await saveJSON(join(home, 'host.json'), saved)
  assert.equal((await hostCommand(installation, join(home, 'host.json'), 'status')).instance, second.instance)
  const command = async (args = [], extraEnv = {}) => run(process.execPath, [join(repository, 'scripts/local.mjs'), 'backend', ...args], { capture: true, env: { ...process.env, npm_config_cache: process.env.npm_config_cache || join(homedir(), '.npm'), ...extraEnv, HOME: user } })
  assert.match((await command(['--status'])).output, /PostgreSQL: running/)
  await writeFile(join(fakeBin, 'npm'), '#!/bin/sh\necho "Intentional build failure" >&2\nexit 1\n', { mode: 0o700 })
  await assert.rejects(command([], { PATH: `${fakeBin}:${process.env.PATH}` }), /failed/)
  assert.equal((await hostCommand(installation, join(home, 'host.json'), 'status')).instance, second.instance)
  await rm(join(fakeBin, 'npm'))
  const rebuilt = await command()
  assert.match(rebuilt.output, /Backend running:/)
  assert.match(rebuilt.output, /Codex: unavailable/)
  assert.equal(await readFile(join(home, 'postgres/postmaster.pid'), 'utf8'), postgresPID)
  assert.equal(await readFile(identity, 'utf8'), before)
  await command(['--stop'])
  assert.equal(await checkDatabase(home, bin, Client), false)
  assert.match((await command(['--status'])).output, /PostgreSQL: stopped/)
  await prepareDatabase(home, bin, Client)
  const third = await activateBackend(home, installation, bin)
  assert.equal(third.installationId, first.installationId)
  const restored = new Client({ connectionString: databaseURL(home) }); await restored.connect()
  try { assert.equal((await restored.query('SELECT value FROM public.local_launch_test')).rows[0].value, 'saved data') }
  finally { await restored.end() }
})
