import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Recall and fading: what an agent learned reaches later conversations, and what is never used again fades away.

test('a preference stated on Monday reaches Thursday\'s conversation and recall keeps it fresh', { skip: noDatabase }, async t => {
  const s = await story(t)
  const preference = 'The owner likes meeting notes as bullet points'
  await s.home.chat('For meeting notes I like bullet points, not paragraphs.', { learn: [{ text: preference, subject: 'meeting notes' }] })
  assert.deepEqual(await s.memory(preference).then(m => [m.origin, m.evidence, m.strength]), ['learned', 1, 0.25])

  await s.work(3)
  assert.ok((await s.memory(preference)).strength < 0.25, 'three busy days age it')
  let found, got
  const thursday = await s.home.chat('Please write up the notes from today\'s meeting.', {
    tools: async call => {
      found = await call('memory.search', { query: 'meeting notes' })
      got = await call('memory.get', { id: found[0].record.id })
    },
  })
  assert.deepEqual(thursday.memory.map(item => item.text), [preference], 'automatic context')
  assert.equal(found[0].record.text, preference, 'memory.search')
  assert.equal(got.text, preference, 'memory.get')
  // Recall resets age but is not new evidence.
  assert.deepEqual(await s.memory(preference).then(m => [m.evidence, m.strength]), [1, 0.25])
})

test('two idle months bring one catch-up sleep and forget nothing', { skip: noDatabase }, async t => {
  const s = await story(t)
  const deadline = 'The quarterly report is due on the 15th'
  await s.home.chat('Reminder: the quarterly report is due on the 15th.', { learn: [{ text: deadline, subject: 'reports' }] })
  await s.work(5)
  const before = await s.memory(deadline)

  await s.idle(60)
  const night = await s.night()
  assert.equal(night.state, 'finished')
  assert.equal((await s.rows('SELECT id FROM kipster.memory_sleeps WHERE agent_id=$1', [s.agent])).length, 1, 'one sleep for the whole absence')
  assert.deepEqual(await s.memory(deadline), before, 'nothing aged while nobody worked')
  const back = await s.home.chat('When is the quarterly report due?')
  assert.deepEqual(back.memory.map(item => item.text), [deadline])
})

test('a detail mentioned once fades over busy months, is forgotten, and forms anew when mentioned again', { skip: noDatabase }, async t => {
  const s = await story(t)
  const printer = 'The third-floor printer is broken'
  const standup = 'The team standup is at 9:30'
  const key = 'The spare office key is in the blue drawer'
  await s.home.chat('By the way, the third-floor printer is broken. Standup is at 9:30 as usual. And please save where the spare key is: the blue drawer.', {
    learn: [{ text: printer, subject: 'office' }, { text: standup, subject: 'schedule' }],
    tools: call => call('memory.save', { kind: 'fact', text: key }),
  })
  await s.home.chat('Standup is at 9:30 tomorrow too.', { learn: [{ text: standup, subject: 'schedule' }] })
  const old = await s.memory(printer)
  assert.deepEqual([old.strength, (await s.memory(standup)).strength, (await s.memory(key)).strength], [0.25, 0.375, 0.5])

  // Two busy months: the one-off detail is weak but still there.
  await s.work(60)
  assert.equal((await s.night()).report.forgotten, undefined)
  assert.equal((await s.memory(printer)).strength, 0.0625)

  // Ten more busy days take it below the forget threshold; the sleep deletes it with everything derived from it.
  await s.work(10)
  assert.equal((await s.night()).report.forgotten, 1)
  assert.equal(await s.memory(printer), undefined)
  assert.deepEqual(await s.search(s.home, 'printer'), [])
  for (const table of ['memory_provenance', 'memory_sources', 'memory_index_intents', 'maintenance_candidate_claims']) {
    assert.equal((await s.rows(`SELECT 1 FROM kipster.${table} WHERE memory_id=$1`, [old.id])).length, 0, table)
  }
  assert.deepEqual(await s.memories(), [key, standup], 'the confirmed fact and the deliberate save outlast it')

  // A deliberate save starts stronger, so it lasts longer, but it fades too when it is never used.
  await s.work(30)
  assert.equal((await s.night()).report.forgotten, 1)
  assert.deepEqual(await s.memories(), [standup])

  // Mentioned again, the detail is learned as a new memory, not revived.
  await s.home.chat('The third-floor printer is broken again.', { learn: [{ text: printer, subject: 'office' }] })
  const again = await s.memory(printer)
  assert.notEqual(again.id, old.id)
  assert.deepEqual([again.evidence, again.strength], [1, 0.25])
})

test('conversations about other things let an old detail fade, while talking about it keeps it', { skip: noDatabase }, async t => {
  const s = await story(t)
  const printer = 'The third-floor printer is broken'
  const coffee = 'The coffee machine is descaled on Fridays'
  await s.home.chat('The third-floor printer is broken, and the coffee machine gets descaled on Fridays.', {
    learn: [{ text: printer, subject: 'office' }, { text: coffee, subject: 'office' }],
  })

  // Everyday conversations share only common words with the printer, or a single word among many: neither brings
  // it into context, so neither keeps it alive.
  await s.work(35)
  assert.deepEqual((await s.home.chat('What is on the agenda for the team meeting this week?')).memory, [])
  await s.work(20)
  const aged = await s.memory(printer)
  const supplies = await s.home.chat('We need printer paper, pens, folders, staplers and envelopes for the new desks.', {
    tools: call => call('memory.search', { query: 'printer paper, pens, folders and envelopes' }),
  })
  assert.deepEqual(supplies.memory, [])
  assert.deepEqual(supplies.used.map(hit => hit.record.text), [printer], 'a search still finds the loose match')
  assert.deepEqual(await s.memory(printer), aged, 'but it does not keep the memory alive')
  // Asked about the coffee machine, the agent recalls that memory, which keeps it fresh.
  const asked = await s.home.chat('Has the coffee machine been descaled yet?')
  assert.deepEqual(asked.memory.map(item => item.text), [coffee])

  await s.work(15)
  assert.equal((await s.night()).report.forgotten, 1)
  assert.deepEqual(await s.memories(), [coffee])
})

test('the same fact told in three conversations becomes one memory with three pieces of evidence', { skip: noDatabase }, async t => {
  const s = await story(t)
  const fact = 'Invoices are sent on the first working day of the month'
  for (const message of ['Invoices go out on the first working day of the month.', 'Remember that invoices are sent on the first working day.', 'As always, invoices on the first working day of the month.']) {
    await s.home.chat(message, { learn: [{ text: fact, subject: 'billing' }] })
  }
  assert.deepEqual(await s.memories(), [fact])
  assert.deepEqual(await s.memory(fact).then(m => [m.evidence, m.strength]), [3, 0.4375])
})

test('one fact phrased three ways is merged into the oldest memory while the agent sleeps', { skip: noDatabase }, async t => {
  const s = await story(t)
  const first = 'The office opens at nine'
  const second = 'The office opens at 9 am'
  const third = 'Office hours start at nine in the morning'
  await s.home.chat('The office opens at nine.', { learn: [{ text: first, subject: 'office hours' }] })
  await s.home.chat('Doors open at 9 am.', { learn: [{ text: second, subject: 'office hours' }] })
  await s.home.chat('We start at nine in the morning.', { learn: [{ text: third, subject: 'office hours' }] })

  const night = await s.night({ consolidation: { same: [[first, second], [first, third]] } })
  assert.deepEqual(night.report.consolidation, { inputs: 3, absorbed: 2, contradicts: 0, related: 0, lessons: 0, skipped: 0 })
  assert.deepEqual(await s.memories(), [first])
  const merged = await s.memory(first)
  assert.deepEqual([merged.revision, merged.evidence], [1, 3], 'the text is kept and the evidence of all three conversations moves to it')
  assert.equal((await s.rows('SELECT 1 FROM kipster.memory_provenance WHERE memory_id=$1', [merged.id])).length, 3)
})
