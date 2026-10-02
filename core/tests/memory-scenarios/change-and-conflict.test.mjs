import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Change and conflict: when facts change, both versions are kept; the one that keeps getting support wins, and the
// other fades on its own.

test('the office moves from Pune to Hyderabad: both are kept, Hyderabad ranks first and Pune fades', { skip: noDatabase }, async t => {
  const s = await story(t)
  const pune = 'The office is in Pune'
  const hyderabad = 'The office is in Hyderabad'
  await s.home.chat('Our office is in Pune.', { learn: [{ text: pune, subject: 'office' }] })
  await s.work(20)
  await s.home.chat('Big news: we moved the office to Hyderabad.', { learn: [{ text: hyderabad, subject: 'office' }] })
  await s.home.chat('Visitors should now come to the Hyderabad office.', { learn: [{ text: hyderabad, subject: 'office' }] })

  const night = await s.night({ consolidation: { contradicts: [[pune, hyderabad]] } })
  assert.equal(night.report.consolidation.contradicts, 1)
  assert.deepEqual(await s.search(s.home, 'office'), [hyderabad, pune], 'both kept, the better supported one first')

  // Asked where the office is, the agent sees both, marked as contradicting each other.
  const asked = await s.home.chat('Where is the office?')
  const [first, second] = asked.memory
  assert.deepEqual([first.text, second.text], [hyderabad, pune])
  assert.deepEqual([first.contradicts, second.contradicts], [second.id, first.id])

  // Nobody mentions Pune again. It is forgotten along with its link; Hyderabad stays.
  await s.work(70)
  assert.equal((await s.night()).report.forgotten, 1)
  assert.deepEqual(await s.memories(), [hyderabad])
  assert.deepEqual(await s.links(), [])
})

test('returning to an earlier choice strengthens the original memory, which ranks first again', { skip: noDatabase }, async t => {
  const s = await story(t)
  const fridays = 'Demos are on Fridays'
  const wednesdays = 'Demos are on Wednesdays'
  await s.home.chat('Let us run the demos on Fridays.', { learn: [{ text: fridays, subject: 'demos' }] })
  const original = await s.memory(fridays)
  await s.home.chat('Change of plan: demos move to Wednesdays.', { learn: [{ text: wednesdays, subject: 'demos' }] })
  await s.home.chat('The Wednesday demo went well, let us keep it.', { learn: [{ text: wednesdays, subject: 'demos' }] })
  assert.deepEqual(await s.search(s.home, 'demos'), [wednesdays, fridays])

  await s.home.chat('Wednesdays clash with planning. Demos go back to Fridays.', { learn: [{ text: fridays, subject: 'demos' }] })
  await s.home.chat('Confirmed: demos are on Fridays again.', { learn: [{ text: fridays, subject: 'demos' }] })
  const restored = await s.memory(fridays)
  assert.deepEqual([restored.id, restored.evidence], [original.id, 3], 'the same memory gains support')
  assert.deepEqual(await s.search(s.home, 'demos'), [fridays, wednesdays])
})

test('learned facts never edit a deliberate save: a contradiction is linked and a repetition is absorbed into the save', { skip: noDatabase }, async t => {
  const s = await story(t)
  const saved = 'Invoices are due within 30 days'
  const contrary = 'Invoices are due within 45 days'
  const repeated = 'Invoices are due 30 days after issue'
  await s.home.chat('Please save our payment terms: invoices are due within 30 days.', {
    tools: call => call('memory_save', { kind: 'fact', text: saved, subject: 'payment terms' }),
  })
  const save = await s.memory(saved)
  assert.deepEqual([save.origin, save.importance, save.strength], ['deliberate', 1, 0.5])

  await s.home.chat('A client told me invoices are due within 45 days now.', { learn: [{ text: contrary, subject: 'payment terms' }] })
  await s.home.chat('Reminder: invoices are due 30 days after issue.', { learn: [{ text: repeated, subject: 'payment terms' }] })
  const night = await s.night({ consolidation: { contradicts: [[contrary, saved]], same: [[repeated, saved]] }, promotion: '- Invoices are due within 30 days' })
  assert.deepEqual(night.report.consolidation, { inputs: 2, absorbed: 1, contradicts: 1, related: 0, lessons: 0, skipped: 0 })
  assert.deepEqual(night.promotion.memories.map(item => item.text), [saved], 'the confirmed save is now strong enough for identity')

  // The save keeps its words and revision; the repetition became evidence for it.
  const after = await s.memory(saved)
  assert.deepEqual([after.id, after.revision, after.origin, after.evidence], [save.id, 1, 'deliberate', 2])
  assert.deepEqual(await s.memories(), [contrary, saved].sort())
  assert.deepEqual(await s.links(), [['contradicts', saved, contrary]])

  // Asked about payment terms, the agent sees the save next to the contradicting fact.
  const asked = await s.home.chat('When are invoices due?')
  const shown = Object.fromEntries(asked.memory.map(item => [item.text, item]))
  assert.equal(shown[saved].contradicts, shown[contrary].id)
  assert.equal(shown[contrary].contradicts, shown[saved].id)
})

test('a slip corrected in conversation stays corrected when the old wording comes up again', { skip: noDatabase }, async t => {
  const s = await story(t)
  const slip = 'The new CFO is Maria Lopez'
  const corrected = 'The new CFO is Maria Lopes'
  await s.home.chat('Our new CFO is Maria Lopez.', { learn: [{ text: slip, subject: 'CFO' }] })
  const learned = await s.memory(slip)
  await s.home.chat('Sorry, a typo: the CFO is Maria Lopes, with an s.', {
    tools: call => call('memory_correct', { id: learned.id, expectedRevision: 1, text: corrected }),
  })
  const fixed = await s.memory(corrected)
  assert.deepEqual([fixed.id, fixed.revision], [learned.id, 2])

  // The old wording turns up in a later conversation. It neither returns nor strengthens the corrected memory.
  const repeated = await s.home.chat('Maria Lopez joins the budget call on Monday.', { learn: [{ text: slip, subject: 'CFO' }] })
  assert.equal(repeated.learned, 'committed')
  assert.deepEqual(await s.memories(), [corrected])
  assert.deepEqual(await s.memory(corrected), fixed)
  assert.equal((await s.rows('SELECT 1 FROM kipster.memory_provenance WHERE memory_id=$1', [learned.id])).length, 2, 'no evidence from the slip')
})
