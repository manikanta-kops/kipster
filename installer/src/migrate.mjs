// The parent publishes the child PID before granting startup. If the updater
// dies before journaling, stdin closes without the grant and no migration runs.
import { pathToFileURL } from 'node:url'
let grant = ''
for await (const bytes of process.stdin) {
  grant += bytes
  if (grant.length > 32) throw new Error('Invalid migration startup grant.')
}
if (grant !== 'migrate\n') process.exit(1)
try {
  const { main } = await import(pathToFileURL(process.argv[2]).href)
  await main(['setup', '--config', process.argv[3]])
} catch { console.error('Core setup failed. Inspect database readiness and migration history.'); process.exitCode = 1 }
