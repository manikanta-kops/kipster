import { openRuntime, startTextServer, TextDispatcher, textPublicationHost } from '../../dist/runtime.js'
import { fixtureAdapter } from '../.build/tests/fixtures/deterministic-adapter.js'
const [mode, connectionString, home] = process.argv.slice(2)
const pause = async stage => { process.send({ stage }); await new Promise(() => {}) }
const runtime = await openRuntime({ connectionString, home, ...(mode === 'index' ? { embedding: { id: 'ollama', contractMajor: 1, model: 'fixture-embedding', embed: () => pause('index') } } : {}) })
if (mode !== 'index') {
 let dispatcher
 const base = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
 const adapter = { ...base, async execute(context) {
  const handle = await base.execute(context)
  process.send({ stage: 'executing', context })
  if (mode === 'stopped') process.once('message', message => {
   if (message.action === 'confirm-end') handle.release({ kind: 'failed', attemptId: context.attemptId, confirmedEnded: true, message: 'Fixture confirmed interruption' })
  })
  handle.release({ kind: 'provider', attemptId: context.attemptId, threadId: 'owned-fixture', processId: process.pid, providerStateScope: 'shared-codex-home', workingDirectory: home, modelId: 'fixture-model' })
  handle.release({ kind: 'text', attemptId: context.attemptId, messageId: 'stream', text: 'Persisted partial output', final: false })
  if (mode === 'waiting') setTimeout(async () => {
   try {
    const card = await dispatcher.askToolInteraction(context.attemptId, 'question', { kind: 'question', prompt: 'Continue?', options: [{ id: 'yes', label: 'Yes' }], freeText: false })
    handle.release({ kind: 'ended', attemptId: context.attemptId, confirmed: true })
    process.send({ stage: 'question', card })
   } catch (error) { console.error(error); process.exitCode = 1 }
  }, 20)
  return handle
 } }
 dispatcher = new TextDispatcher(runtime, adapter)
 const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
 const server = await startTextServer(runtime, actor, { host: '127.0.0.1', port: 0, dispatcher })
 await dispatcher.start()
 process.send({ stage: 'ready', url: server.url })
}
