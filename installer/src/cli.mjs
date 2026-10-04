#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { Installer, install, prerequisites } from './installer.mjs'
import { exists, json } from './files.mjs'
import { installedApp } from './backend.mjs'
import { run } from './process.mjs'
import { templates } from './services.mjs'

const usage = `Usage:
  kipster install [--channel stable|next] [--version X] [--home DIR]
    [--config FILE] [--maintenance-config FILE] [--pg-bin DIR]
    [--catalog URL] [--no-launchd]
    [--health-timeout MILLISECONDS]
  kipster apply [--home DIR]
  kipster update [--to X] [--home DIR]
  kipster status [--home DIR]
  kipster rollback [--home DIR] [--yes]
  kipster uninstall [--home DIR] [--delete-data] [--yes]
  kipster permissions [--home DIR]
  kipster runtime --node FILE [--home DIR]

Run as the backend owner, without sudo. Core and the updater are login services
in ~/Library/LaunchAgents: they start when the owner logs in and keep running
while the screen is locked. They run through the Kipster app at
<home>/backend/Kipster.app, so macOS shows their access as Kipster. permissions
opens Full Disk Access for it. runtime selects the Node it starts.
--no-launchd starts Core without registering jobs and prints the generated plists.
Use a private host JSON for database credentials, or KIPSTER_DATABASE_URL.
Core owns automatic update scheduling and idle-work policy.`
export const message = error => error instanceof Error ? error.message : 'Installer failed; inspect the private installation configuration.'
function options(args) {
  const command = args.shift(), result = {}
  const allowed = {
    install: ['channel', 'version', 'home', 'config', 'maintenance-config', 'pg-bin', 'catalog', 'no-launchd', 'health-timeout'],
    apply: ['home'], update: ['to', 'home'], status: ['home'], rollback: ['home', 'yes'], uninstall: ['home', 'delete-data', 'yes'], 'self-check': [],
    permissions: ['home'], runtime: ['node', 'home'],
  }
  if (!allowed[command]) throw new Error(usage)
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].slice(2)
    if (!args[i].startsWith('--') || !allowed[command].includes(flag)) throw new Error(usage)
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (['yes', 'no-launchd', 'delete-data'].includes(flag)) result[key] = true
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) throw new Error(usage)
      result[key] = flag === 'health-timeout' ? Number(value) : value
    }
  }
  if (command === 'runtime' && !result.node) throw new Error(usage)
  return { command, ...result }
}
export const fullDiskAccess = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
/** Shows the installed Kipster app and opens Full Disk Access so the owner can enable it. */
export async function permissions(home, { runCommand = run, log = console.log } = {}) {
  const app = installedApp(home)
  if (!await exists(app)) throw new Error(`${app} is missing. Reinstall Kipster.`)
  await runCommand('/usr/bin/open', ['-R', app], { label: 'Finder' })
  await runCommand('/usr/bin/open', [fullDiskAccess], { label: 'System Settings' })
  log(`In Full Disk Access, drag Kipster from the Finder window into the list (or click + and press Command-Shift-G for ${app}), then turn Kipster on.`)
  log(`Kips get the access when Core next starts; to restart it now: launchctl kickstart -k gui/${process.getuid()}/${templates(home, {})[0].label}`)
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
    const result = await install(parsed)
    console.log(JSON.stringify(result, null, 2))
    if (result.alreadyInstalled) { console.log(`Kipster Core ${result.coreVersion} is already installed at ${result.home}.`); return }
    const home = result.home
    if (parsed.noLaunchd) {
      const { readdir } = await import('node:fs/promises')
      for (const file of await readdir(join(home, 'services'))) console.log(await readFile(join(home, 'services', file), 'utf8'))
    }
    console.log(`Use ${join(home, 'bin/kipster')} for this installation.`)
    if (!parsed.noLaunchd) console.log(`To give your kips access to your files, run ${join(home, 'bin/kipster')} permissions and enable Kipster in Full Disk Access.`)
    return
  }
  const home = parsed.home ?? join(homedir(), '.kipster')
  if (parsed.command === 'uninstall' && !await exists(join(home, 'updater.json'))) {
    const marker = join(home, 'updates/uninstalled.json')
    if (!await exists(marker) || (await json(marker)).state !== 'uninstalling') { console.log(`Kipster is already uninstalled at ${home}.`); return }
  }
  if (parsed.command === 'permissions') { await permissions(await realpath(home)); return }
  const installer = await Installer.open(home)
  let result
  if (parsed.command === 'status') { await installer.directories(); result = await installer.status() }
  else if (parsed.command === 'apply') result = await installer.apply()
  else if (parsed.command === 'update') result = await installer.update(parsed.to)
  else if (parsed.command === 'runtime') result = await installer.selectRuntime(resolve(parsed.node))
  else if (parsed.command === 'uninstall') {
    if (parsed.deleteData && !parsed.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Uninstall --delete-data deletes the dedicated database contents and home files. Use --yes only to confirm this deletion in a script.')
      const input = createInterface({ input: process.stdin, output: process.stdout })
      let answer
      try { answer = await input.question(`Delete all database contents and home data at ${installer.home}? Type delete: `) } finally { input.close() }
      if (answer !== 'delete') { console.log('Uninstall cancelled.'); return }
    }
    result = await installer.uninstall({ deleteData: parsed.deleteData })
  } else {
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
