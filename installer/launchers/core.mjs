import { access, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const home = dirname(dirname(fileURLToPath(import.meta.url)))
let held = false
try { await access(join(home, 'updates/hold')); held = true } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!held) {
  try {
    const cli = await realpath(join(home, 'current/node_modules/@kipster/core/dist/host.js'))
    const { main } = await import(pathToFileURL(cli).href)
    await main(['serve', '--config', join(home, 'host.json')])
  } catch { console.error('Core failed to start. Inspect the private host configuration and logs.'); process.exitCode = 1 }
}
