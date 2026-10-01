import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, realpath } from 'node:fs/promises'
import { dependencies, exists, initializeHome, json, locked, privateDirectory, repository, run, saveJSON } from './local-common.mjs'
import { checkDatabase, databaseURL, postgresBinaries, postgresClient, prepareDatabase, stopDatabase } from './local-database.mjs'

export function configuration(home, installation, previous = {}) {
  return {
    ...previous,
    version: 1, home, databaseUrl: databaseURL(home), taskDataUrl: databaseURL(home, 'kipster', 'kipster_task'),
    listen: previous.listen ?? { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: ['tauri://localhost'] },
    adapters: [
      { id: 'codex-cli', root: installation, entry: 'node_modules/@kipster/codex-cli/dist/index.js', ...codex(previous) },
      ...(previous.adapters ?? []).filter(adapter => adapter.id !== 'codex-cli'),
    ],
  }
}
function codex(previous) {
  const config = (previous.adapters ?? []).find(adapter => adapter.id === 'codex-cli')?.config
  return config ? { config } : {}
}
export async function buildBackend(home) {
  const core = join(repository, 'core'), adapter = join(repository, 'adapters/codex-cli')
  console.log('Building Core and the Codex adapter…')
  await dependencies()
  await run('npm', ['run', 'build'], { cwd: core })
  await run('npm', ['run', 'build'], { cwd: adapter })
  const build = join(home, 'builds', randomUUID()), installation = join(build, 'packages')
  await mkdir(installation, { recursive: true, mode: 0o700 })
  const tarballs = []
  for (const cwd of [core, adapter]) {
    // Builds ran explicitly above; avoid running the full test suite on every launch.
    const packed = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', build], { cwd, capture: true })
    tarballs.push(join(build, JSON.parse(packed.output)[0].filename))
  }
  await saveJSON(join(installation, 'package.json'), { name: 'kipster-development-runtime', private: true })
  await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', ...tarballs], { cwd: installation })
  return installation
}
const cli = installation => join(installation, 'node_modules/@kipster/core/dist/host.js')
export async function hostCommand(installation, configPath, action, capture = true) {
  const result = await run(process.execPath, [cli(installation), action, '--config', configPath], { capture })
  return capture ? JSON.parse(result.output) : undefined
}
async function portAvailable(listen) {
  const server = createServer()
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listen.port, listen.host, resolve) })
  } catch { throw new Error(`Backend port ${listen.port} is occupied. Its owner was not stopped. Change listen.port in host.json and retry.`) }
  finally { if (server.listening) await new Promise(resolve => server.close(resolve)) }
}
async function currentState(home) {
  const file = join(home, 'active.json')
  if (!await exists(file)) return undefined
  const state = await json(file)
  if (typeof state.installation !== 'string' || !resolve(state.installation).startsWith(join(home, 'builds') + '/')) throw new Error('Development runtime path is invalid.')
  return state
}
export async function activateBackend(home, installation, pgBin) {
  const configPath = join(home, 'host.json')
  const previous = await exists(configPath) ? await json(configPath) : undefined
  if (previous && previous.home !== home) throw new Error('host.json belongs to a different home; it was not changed.')
  const config = configuration(home, installation, previous)
  const host = await import(pathToFileURL(cli(installation)).href)
  host.validateHostConfig(config)
  const state = await host.control(home, 'status')
  if (!state) await portAvailable(config.listen)
  // A failed build or invalid configuration above never stops the current host.
  if (state) {
    console.log('Restarting the development backend…')
    await hostCommand(installation, configPath, 'stop')
    await portAvailable(config.listen)
  }
  await saveJSON(configPath, config)
  // Keep the command usable for status/stop even if provider startup later fails.
  await saveJSON(join(home, 'active.json'), { installation, pgBin })
  await hostCommand(installation, configPath, 'setup')
  const started = await hostCommand(installation, configPath, 'start')
  const response = await fetch(`${started.url}/v1/bootstrap`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok || (await response.json()).installationId !== started.installationId) throw new Error('Backend started but its readiness check failed. Inspect the logs.')
  return started
}
export async function backend(inputHome, action) {
  if (Buffer.byteLength(join(inputHome, '.host-control/control.sock')) > 103) throw new Error('Development home is too long for a macOS control socket. Use a shorter home folder path.')
  if (action && !await exists(inputHome)) { console.log('Development backend and database are stopped (not initialized).'); return }
  await privateDirectory(inputHome)
  const home = await realpath(inputHome)
  if (Buffer.byteLength(join(home, '.host-control/control.sock')) > 103) throw new Error('Resolved development home is too long for a macOS control socket. Use a shorter home folder path.')
  return locked(join(home, '.command-lock'), async () => {
    await initializeHome(home)
    const current = await currentState(home)
    if (action) {
      if (!current) { console.log('No backend runtime is active. Rerun npm run backend to finish setup.'); return }
      const Client = postgresClient(current.installation)
      if (action === '--stop') {
        await hostCommand(current.installation, join(home, 'host.json'), 'stop')
        await stopDatabase(home, current.pgBin, Client)
        console.log('Development backend and database stopped. Data preserved.')
      } else {
        console.log(JSON.stringify(await hostCommand(current.installation, join(home, 'host.json'), 'status'), null, 2))
        console.log(`PostgreSQL: ${await checkDatabase(home, current.pgBin, Client) ? 'running' : 'stopped'}\nData: ${home}`)
      }
      return
    }
    await privateDirectory(join(home, 'logs'))
    const pgBin = await postgresBinaries()
    const installation = await buildBackend(home)
    // Record first setup before database startup, so --stop works after an interrupted setup.
    if (!current) {
      await saveJSON(join(home, 'active.json'), { installation, pgBin })
      if (!await exists(join(home, 'host.json'))) await saveJSON(join(home, 'host.json'), configuration(home, installation))
    }
    await prepareDatabase(home, pgBin, postgresClient(installation))
    const started = await activateBackend(home, installation, pgBin)
    const codex = started.adapters?.find(adapter => adapter.id === 'codex-cli')
    console.log(`\nBackend running: ${started.url}\nData: ${home}\nLogs: ${join(home, 'logs/host.log')}`)
    console.log(codex?.available ? 'Codex: ready. Agents use its default model until you choose another in Settings.' : 'Codex: unavailable. Check your Codex CLI/account and the host log, then rerun npm run backend.')
    const config = await json(join(home, 'host.json'))
    if (!config.embedding) console.log('Embeddings: not configured. Configure an embedding provider module and options in host.json to enable indexed memory.')
    if (!config.transcription) console.log('Voice transcription: not configured.')
    console.log('You can close this terminal. Use npm run backend -- --stop to stop this installation.')
  })
}
