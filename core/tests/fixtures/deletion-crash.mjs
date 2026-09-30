import { openRuntime, TextDispatcher } from '../../dist/runtime.js'

// Runs a started agent deletion and dies with SIGKILL once the n-th batch of a step has committed
// (`after:<step>:<n>`), or exits after the operation finished (`never`).
// Usage: deletion-crash.mjs <database-url> <home> <operation-id> <kill>
const [url, home, operationId, kill] = process.argv.slice(2)
const batches = new Map()
const runtime = await openRuntime({ connectionString: url, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
// Every run has ended; this adapter only answers for the provider state it cannot forget.
const adapter = { id: 'deterministic-fixture', version: '1', contractMajor: 1, async execute() { throw new Error('unused') }, async close() {} }
const dispatcher = new TextDispatcher(runtime, adapter, undefined, {
  async afterOperationStep(_id, step) {
    const n = (batches.get(step) ?? 0) + 1
    batches.set(step, n)
    if (kill === `after:${step}:${n}`) { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}) }
  },
})
await dispatcher.start()
for (;;) {
  const { state } = (await runtime.db.query('SELECT state FROM kipster.admin_operations WHERE operation_id=$1', [operationId])).rows[0]
  if (state === 'succeeded' || state === 'failed') break
  await new Promise(resolve => setTimeout(resolve, 50))
}
await dispatcher.close()
await runtime.close()
