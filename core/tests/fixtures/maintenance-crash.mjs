// Owned fixture process for real coordinator death; no production provider claim.
import { openRuntime, TextDispatcher, textPublicationHost } from '../../dist/runtime.js'
import { MaintenanceService } from '../../dist/modules/memory/public.js'
import { fixtureAdapter } from '../.build/tests/fixtures/deterministic-adapter.js'
const [phase, connectionString, home] = process.argv.slice(2)
const runtime = await openRuntime({ connectionString, home, embedding: { id: 'ollama', contractMajor: 1, model: 'fixture-embedding', async embed() { return [1, 0] } } })
await runtime.memory.stopIndexing()
const pause = async stage => { process.send({ stage }); await new Promise(() => {}) }
if (phase === 'intent') {
  await runtime.db.transaction(async client => {
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE', [runtime.bootstrap.installationId])
    await new MaintenanceService(runtime.db, runtime.bootstrap.installationId).claimIntent(client)
  })
  await pause('intent')
} else {
  let dispatcher
  const fixture = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
  const adapter = { ...fixture, async execute(context) {
    const handle = await fixture.execute(context)
    if (context.kind === 'maintenance') {
      const attemptId = context.attemptId
      handle.release({ kind: 'provider', attemptId, threadId: 'fixture-crash', processId: process.pid, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
      if (phase === 'commit') {
        const source = context.maintenance.sources[0]
        handle.release({ kind: 'text', attemptId, messageId: 'output', final: true, text: JSON.stringify({ candidates: [{ kind: 'fact', text: 'Crash proof retained fact', subject: 'crash proof', author_id: source.authorId, author_class: source.authorClass, citations: [{ message_id: source.messageId, revision: source.revision, parts_hash: source.partsHash, excerpt: source.text.slice(0, 40) }] }] }) })
        handle.release({ kind: 'ended', attemptId, confirmed: true })
      }
    }
    return handle
  } }
  dispatcher = new TextDispatcher(runtime, adapter, undefined, {
    ...(phase === 'claim' ? { afterMaintenanceClaim: () => pause('claim') } : {}),
    ...(phase === 'provider' ? { afterMaintenanceProvider: () => pause('provider') } : {}),
    ...(phase === 'commit' ? { afterMaintenanceSettlement: (_id, outcome) => outcome === 'committed' ? pause('commit') : Promise.reject(new Error(`unexpected ${outcome}`)) } : {}),
  })
  await dispatcher.start()
}
