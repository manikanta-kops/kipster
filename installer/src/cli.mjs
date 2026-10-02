#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Installer, install, prerequisites } from './installer.mjs'
import { json } from './files.mjs'

const usage = `Usage:
  kipster install [--channel stable|next] [--version X] [--home DIR]
    [--config FILE] [--maintenance-config FILE] [--pg-bin DIR]
    [--catalog URL] [--no-launchd]
    [--health-timeout MILLISECONDS]
  kipster apply [--home DIR]
  kipster update [--to X] [--home DIR]
  kipster status [--home DIR]
  kipster rollback [--home DIR] [--yes]

Run as the backend owner. Only initial system service registration uses sudo.
--no-launchd starts Core without registering jobs and prints the generated plists.
Use a private host JSON for database credentials, or KIPSTER_DATABASE_URL.
Core owns automatic update scheduling and idle-work policy.`
export const message = error => error instanceof Error ? error.message : 'Installer failed; inspect the private installation configuration.'
function options(args) {
  const command = args.shift(), result = {}
  const allowed = {
    install: ['channel', 'version', 'home', 'config', 'maintenance-config', 'pg-bin', 'catalog', 'no-launchd', 'health-timeout'],
    apply: ['home'], update: ['to', 'home'], status: ['home'], rollback: ['home', 'yes'], 'self-check': [],
  }
  if (!allowed[command]) throw new Error(usage)
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].slice(2)
    if (!args[i].startsWith('--') || !allowed[command].includes(flag)) throw new Error(usage)
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (['yes', 'no-launchd'].includes(flag)) result[key] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(usage)
      result[key] = flag === 'health-timeout' ? Number(value) : value
    }
  }
  return { command, ...result }
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(usage); return }
  const parsed = options([...args])
  if (parsed.command === 'self-check') {
    const pkg = await json(fileURLToPath(new URL('../package.json', import.meta.url)))
    console.log(JSON.stringify({ version: pkg.version, requestVersion: 1 })); return
  }
  await prerequisites()
  if (parsed.command === 'install') {
    console.log(JSON.stringify(await install(parsed), null, 2))
    const source = parsed.config ? await json(resolve(parsed.config)) : null
    const home = await import('node:fs/promises').then(fs => fs.realpath(parsed.home ?? source?.home ?? join(homedir(), '.kipster')))
    if (parsed.noLaunchd) {
      const { readdir } = await import('node:fs/promises')
      for (const file of await readdir(join(home, 'services'))) console.log(await readFile(join(home, 'services', file), 'utf8'))
    }
    console.log(`Use ${join(home, 'bin/kipster')} for this installation.`)
    return
  }
  const installer = await Installer.open(parsed.home ?? join(homedir(), '.kipster'))
  let result
  if (parsed.command === 'status') { await installer.directories(); result = await installer.status() }
  else if (parsed.command === 'apply') result = await installer.apply()
  else if (parsed.command === 'update') result = await installer.update(parsed.to)
  else {
    await installer.directories()
    const backup = (await installer.backups())[0]
    if (!backup) throw new Error('No backup is available to restore.')
    if (!parsed.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Rollback replaces the database with the latest backup. Use --yes for a scriptable, explicitly confirmed restore.')
      const input = createInterface({ input: process.stdin, output: process.stdout })
      let answer
      try { answer = await input.question(`Restore ${backup.coreVersion} from ${backup.createdAt}? Database changes since then will be replaced. Type restore: `) } finally { input.close() }
      if (answer !== 'restore') { console.log('Rollback cancelled.'); return }
    }
    result = await installer.update(backup.coreVersion, backup.id)
  }
  if (result) console.log(JSON.stringify(result, null, 2))
}
let invoked = false
try { invoked = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { /* imported module */ }
if (invoked) main().catch(error => { console.error(message(error)); process.exitCode = 1 })
