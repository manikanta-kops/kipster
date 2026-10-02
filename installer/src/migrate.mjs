// The parent publishes the child PID before granting startup. If the updater
// dies before journaling, stdin closes without the grant and no migration runs.
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { safeError } from './diagnostics.mjs'
let grant = ''
for await (const bytes of process.stdin) {
  grant += bytes
  if (grant.length > 32) throw new Error('Invalid migration startup grant.')
}
if (grant !== 'migrate\n') process.exit(1)
let config
try {
  config = JSON.parse(await readFile(process.argv[3], 'utf8'))
  const { main } = await import(pathToFileURL(process.argv[2]).href)
  await main(['setup', '--config', process.argv[3]])
} catch (error) { console.error(safeError(error, config, process.env)); process.exitCode = 1 }
