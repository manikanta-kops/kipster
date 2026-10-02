import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story, until } from './story.mjs'

// Provenance: every learned memory records exactly which message it came from and who wrote it.

test('a learned memory cites the exact message it came from, and a quote nobody wrote is refused', { skip: noDatabase }, async t => {
  const s = await story(t)
  const fact = 'The Lyon supplier ships on Tuesdays and Thursdays'
  const told = await s.northwind.chat('Our supplier in Lyon ships on Tuesdays and Thursdays.', { learn: [{ text: fact, subject: 'suppliers', excerpt: 'ships on Tuesdays and Thursdays' }] })
  const source = await s.row(`SELECT r.thread_id, m.id AS message_id, m.revision, m.author_id FROM kipster.text_runs r
    JOIN kipster.messages m ON m.id=r.input_message_id WHERE r.id=$1`, [told.runId])
  const memory = await s.memory(fact)
  const cited = await s.rows(`SELECT source_message_id, source_message_revision::int AS revision, source_thread_id, source_organization_id, author_id, excerpt
    FROM kipster.memory_provenance WHERE memory_id=$1`, [memory.id])
  assert.deepEqual(cited, [{
    source_message_id: source.message_id, revision: Number(source.revision), source_thread_id: source.thread_id,
    source_organization_id: s.northwind.organizationId, author_id: s.owner.personId, excerpt: 'ships on Tuesdays and Thursdays',
  }])

  // The agent can trace the memory back to its conversation.
  const later = await s.northwind.chat('Which days does the Lyon supplier ship?', { tools: call => call('memory_get', { id: memory.id }) })
  assert.deepEqual(later.used.provenance.map(item => [item.sourceThreadId, item.authorId]), [[source.thread_id, s.owner.personId]])

  // An answer quoting words the person never wrote is refused as a whole; nothing is learned from it.
  const guessed = await s.northwind.chat('Maybe they ship on Fridays as well?', {
    learn: [{ text: 'The Lyon supplier ships every day', subject: 'suppliers', excerpt: 'ships every day' }],
  })
  assert.equal(guessed.learned, 'refused: citation_excerpt_mismatch')
  assert.deepEqual(await s.memories(), [fact])
})

test('delegated work is learned by the agent that did it, with each message credited to its author', { skip: noDatabase }, async t => {
  const s = await story(t)
  const scout = await s.hire('Scout', { organizations: [s.northwind] })
  const run = await s.send(s.northwind, 'Ask Scout what the supplier quoted for steel.')
  const lead = await s.execution(run.runId)
  await lead.call('agents_delegate', { recipientId: scout, request: 'What did the supplier quote for the steel order?' })
  lead.handle.release({ kind: 'waiting', attemptId: lead.context.attemptId, for: 'child', interactionId: 'delegation' })
  lead.finish('Asking Scout.')
  const delegated = await until(async () => (await s.row('SELECT child_run_id FROM kipster.delegations WHERE parent_run_id=$1', [run.runId]))?.child_run_id, Boolean, 'delegated run')
  ;(await s.execution(delegated)).finish('The supplier quoted 1,200 euros per tonne.')
  await s.completed(delegated)
  ;(await s.execution(run.runId, 1)).finish('Scout says the supplier quoted 1,200 euros per tonne.')
  await s.completed(run.runId)

  // Scout learns from its own conversation: its report as its own words, the request as the lead agent's.
  const quote = 'The supplier quoted 1,200 euros per tonne of steel'
  const request = 'The lead agent needs the steel quote'
  assert.equal(await s.extract(delegated, [{ text: quote, subject: 'steel', from: 'agent' }, { text: request, subject: 'steel', from: s.agent }]), 'committed')
  const credits = async (text, agent) => (await s.rows(`SELECT p.author_id FROM kipster.memory_provenance p JOIN kipster.memory_records m ON m.id=p.memory_id
    WHERE m.owner_id=$1 AND m.text=$2`, [agent, text])).map(item => item.author_id)
  assert.deepEqual(await credits(quote, scout), [scout])
  assert.deepEqual(await credits(request, scout), [s.agent])
  assert.equal((await s.memory(quote, scout)).home, s.northwind.organizationId)
  assert.deepEqual(await s.memories(), [], 'nothing from Scout\'s conversation lands in the lead agent\'s memory')

  // The lead agent learns only from its own conversation, where the relayed quote is its own message.
  await s.extract(run.runId, [{ text: 'Scout reported a steel quote of 1,200 euros per tonne', subject: 'steel', from: 'agent' }])
  assert.deepEqual(await credits('Scout reported a steel quote of 1,200 euros per tonne', s.agent), [s.agent])
})

test('the agent repeating its own guess does not make the guess stronger', { skip: noDatabase }, async t => {
  const s = await story(t)
  const guess = 'The nightly build probably fails because of a stale cache'
  for (const question of ['Why did the nightly build fail?', 'The nightly build failed again, any idea?', 'Same failure last night. What do you think?']) {
    await s.home.chat(question, { reply: 'It probably fails because of a stale cache.', learn: [{ text: guess, subject: 'builds', from: 'agent' }] })
  }
  const memory = await s.memory(guess)
  assert.equal((await s.rows('SELECT 1 FROM kipster.memory_provenance WHERE memory_id=$1', [memory.id])).length, 3, 'every repetition is recorded')
  assert.deepEqual([memory.evidence, memory.strength], [1, 0.25], 'but its own words count once')
})
