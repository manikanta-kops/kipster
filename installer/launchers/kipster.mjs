#!/usr/bin/env node
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const home = dirname(dirname(fileURLToPath(import.meta.url)))
let cli
for (const pointer of ['current', 'previous']) {
  try {
    const candidate = await import(pathToFileURL(await realpath(join(home, 'updater', pointer, 'src/cli.mjs'))).href)
    if (typeof candidate.main !== 'function' || typeof candidate.message !== 'function') throw new Error('Invalid updater entry point.')
    cli = candidate
    break
  } catch { /* An incomplete updater cannot prevent loading the known previous one. */ }
}
if (!cli) { console.error('No usable updater is installed. Reinstall @kipster/installer; preserve this home and its backups.'); process.exitCode = 1 }
else {
  try { await cli.main([...process.argv.slice(2), '--home', home]) }
  catch (error) { console.error(cli.message(error)); process.exitCode = 1 }
}
