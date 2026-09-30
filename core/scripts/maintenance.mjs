// Local operator wrapper around the shipped @kipster/core/maintenance entry.
// Usage (from core/ after npm run build):
//   node scripts/maintenance.mjs status --config /path/to/host.json
//   node scripts/maintenance.mjs list --config ... [--status ready] [--limit 50]
//   node scripts/maintenance.mjs inspect --config ... --source-run <uuid> [--source-revision 1]
//   node scripts/maintenance.mjs run --config ... --run <uuid>
//   node scripts/maintenance.mjs action --config ... --op <id> --action skip-source|requeue-source|cancel|reconcile
//     [--source-run <uuid>] [--source-revision N] [--run <uuid>] [--reason text]
// The database comes from the host configuration's databaseUrl. --installation <uuid> selects one of
// several installations. --json prints raw JSON.
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const entry = await import(path.join(root, '..', 'dist', 'maintenance.js'))
const { readHostConfig } = await import(path.join(root, '..', 'dist', 'host-config.js'))

function flag(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
function fail(message) {
  console.error(message)
  process.exitCode = 2
}

const command = process.argv[2]
const installationId = flag('installation')
const json = process.argv.includes('--json')
const show = (value) => console.log(json ? JSON.stringify(value) : JSON.stringify(value, null, 2))
try {
  if (!flag('config')) throw new Error('Missing --config (the host configuration file)')
  const connectionString = (await readHostConfig(flag('config'))).config.databaseUrl
  const target = { connectionString, ...(installationId ? { installationId } : {}) }
  if (command === 'status') show(await entry.status(target))
  else if (command === 'list') {
    show(await entry.list({
      ...target,
      ...(flag('status') ? { status: flag('status') } : {}),
      ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
    }))
  } else if (command === 'inspect') {
    const sourceRunId = flag('source-run')
    if (!sourceRunId) throw new Error('Missing --source-run')
    show(await entry.inspect({
      ...target, sourceRunId,
      ...(flag('source-revision') ? { sourceRevision: Number(flag('source-revision')) } : {}),
    }))
  } else if (command === 'run') {
    const runId = flag('run')
    if (!runId) throw new Error('Missing --run')
    show(await entry.inspectRun({ ...target, runId }))
  } else if (command === 'action') {
    const opId = flag('op')
    const action = flag('action')
    if (!opId || !action) throw new Error('Missing --op or --action')
    const subject = {
      ...(flag('source-run') ? { sourceRunId: flag('source-run') } : {}),
      ...(flag('source-revision') ? { sourceRevision: Number(flag('source-revision')) } : {}),
      ...(flag('run') ? { runId: flag('run') } : {}),
    }
    show(await entry.requestAction({ ...target, opId, action, target: subject, ...(flag('reason') ? { reason: flag('reason') } : {}) }))
  } else {
    throw new Error(`Unknown command: ${command ?? '(none)'}`)
  }
} catch (error) {
  fail(String(error instanceof Error ? error.message : error))
}
