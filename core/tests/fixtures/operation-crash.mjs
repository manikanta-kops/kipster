import { openRuntime, TextDispatcher } from '../../dist/runtime.js'

// Runs administration operations of the kind `test.steps` and dies with SIGKILL at a chosen point:
// `after:<step>:<n>` once the n-th batch of the step has committed, `inside:<step>:<n>` during that
// batch before it commits, or `never`, which exits after the operation finished.
// Usage: operation-crash.mjs <database-url> <home> <operation-row-id> <kill>
const [url, home, operationRowId, kill] = process.argv.slice(2)
const die = () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}) }
const batches = new Map()
const counted = step => { const n = (batches.get(step) ?? 0) + 1; batches.set(step, n); return n }
const at = (moment, step, n) => kill === `${moment}:${step}:${n}`

// Every effect is written in the batch's transaction, so it commits together with the step progress.
const steps = [
  { name: 'collect', async run(client) {
    const n = counted('collect')
    const done = Number((await client.query(`SELECT count(*)::int AS n FROM public.engine_effects WHERE step='collect'`)).rows[0].n)
    for (let item = done + 1; item <= Math.min(done + 2, 5); item++) await client.query(`INSERT INTO public.engine_effects(step, item) VALUES ('collect', $1)`, [item])
    if (at('inside', 'collect', n)) await die()
    return done + 2 >= 5 ? { status: 'done', result: { collected: 5 } } : { status: 'more' }
  } },
  { name: 'await', async run() {
    counted('await')
    const { rows } = await runtime.db.query('SELECT 1 FROM public.engine_gate')
    return rows.length ? { status: 'done' } : { status: 'wait', reason: 'Waiting for the provider to end' }
  } },
  { name: 'finish', async run(client) {
    counted('finish')
    await client.query(`INSERT INTO public.engine_effects(step, item) VALUES ('finish', 1)`)
    return { status: 'done', result: { finished: true } }
  } },
]

const runtime = await openRuntime({ connectionString: url, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
const adapter = { id: 'unused', version: '1', contractMajor: 1, async execute() { throw new Error('unused') }, async close() {} }
const dispatcher = new TextDispatcher(runtime, adapter, undefined, {
  async afterOperationStep(operationId, step) { if (at('after', step, batches.get(step))) await die() },
})
dispatcher.operations.register('test.steps', steps)
await dispatcher.start()
for (;;) {
  const { state } = (await runtime.db.query('SELECT state FROM kipster.admin_operations WHERE id=$1', [operationRowId])).rows[0]
  if (state === 'succeeded' || state === 'failed') break
  await new Promise(resolve => setTimeout(resolve, 50))
}
await dispatcher.close()
await runtime.close()
