import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Organizations: what an agent learns in an organization stays there. Deliberate saves, explicit requests and
// lessons belong to the agent and go everywhere with it.

test('client pricing learned in one organization never surfaces in another or outside organizations', { skip: noDatabase }, async t => {
  const s = await story(t)
  const southwind = await s.organization('Southwind')
  const pricing = 'Acme pays 95 euros per hour for consulting'
  await s.northwind.chat('Acme pays us 95 euros per hour for consulting.', { learn: [{ text: pricing, subject: 'Acme', importance: 1 }] })
  await s.northwind.chat('Acme renewed at 95 euros per hour.', { learn: [{ text: pricing, subject: 'Acme', importance: 1 }] })
  const memory = await s.memory(pricing)
  assert.deepEqual([memory.home, memory.strength], [s.northwind.organizationId, 0.75])
  await southwind.chat('Southwind has not sent Acme a quote yet.', { learn: [{ text: 'Southwind has not quoted Acme yet', subject: 'Acme' }] })

  const elsewhere = await southwind.chat('Has Southwind quoted Acme per hour yet?', {
    tools: async call => ({ found: await call('memory_search', { query: 'Acme per hour' }), got: await call('memory_get', { id: memory.id }) }),
  })
  assert.deepEqual(elsewhere.memory.map(item => item.text), ['Southwind has not quoted Acme yet'])
  assert.deepEqual(elsewhere.used.found.map(hit => hit.record.text), ['Southwind has not quoted Acme yet'])
  assert.equal(elsewhere.used.got, null)
  assert.deepEqual(await s.search(s.home, 'Acme per hour'), [], 'nor outside organizations')
  const inside = await s.northwind.chat('Has Southwind quoted Acme per hour yet?')
  assert.deepEqual(inside.memory.map(item => item.text), [pricing])

  // A sleep never pairs memories from different organizations, and never offers either for identity.
  const night = await s.night()
  assert.deepEqual([night.consolidation.memories.length, night.consolidation.pairs], [2, []])
  assert.equal(night.promotion, undefined)
})

test('a lesson drawn from one organization\'s work is available everywhere, while its facts stay home', { skip: noDatabase }, async t => {
  const s = await story(t)
  const southwind = await s.organization('Southwind')
  const acme = 'Acme approves invoices only with a purchase order number'
  const globex = 'Globex approves invoices only with a purchase order number'
  const lesson = 'Ask for the purchase order number before invoicing'
  await s.northwind.chat('Acme rejected our invoice: they need a purchase order number.', { learn: [{ text: acme, subject: 'invoicing' }] })
  await s.northwind.chat('Globex also wants a purchase order number on invoices.', { learn: [{ text: globex, subject: 'invoicing' }] })
  const night = await s.night({ consolidation: { related: [[acme, globex]], lessons: [{ text: lesson, from: [acme, globex] }] } })
  assert.equal(night.report.consolidation.lessons, 1)
  const learned = await s.memory(lesson)
  assert.deepEqual([learned.origin, learned.home, learned.evidence], ['lesson', null, 2])

  const elsewhere = await southwind.chat('Before invoicing a new client, what should I ask for?')
  assert.deepEqual(elsewhere.memory.map(item => item.text), [lesson])
  const inside = await s.northwind.chat('What does Acme need on our invoices?')
  assert.ok(inside.memory.map(item => item.text).includes(acme))
})

test('a deliberate save and an explicit request made in one organization apply everywhere', { skip: noDatabase }, async t => {
  const s = await story(t)
  const southwind = await s.organization('Southwind')
  const fiscal = 'Our fiscal year starts in April'
  const summaries = 'The owner prefers short summaries'
  const promise = 'I will keep summaries short'
  await s.northwind.chat('Please save this: our fiscal year starts in April.', { tools: call => call('memory_save', { kind: 'fact', text: fiscal }) })
  // Said in passing, the preference stays in the organization; asked to remember it, the agent keeps it everywhere.
  await s.northwind.chat('I prefer short summaries.', { learn: [{ text: summaries, subject: 'summaries' }] })
  assert.equal((await s.memory(summaries)).home, s.northwind.organizationId)
  await s.northwind.chat('Remember: I prefer short summaries.', {
    reply: 'I will keep summaries short.',
    learn: [{ text: summaries, subject: 'summaries', explicit: true }, { text: promise, subject: 'summaries', from: 'agent', explicit: true }],
  })
  const preference = await s.memory(summaries)
  assert.deepEqual([preference.home, preference.importance, preference.evidence], [null, 1, 2])
  const own = await s.memory(promise)
  assert.deepEqual([own.home, own.importance], [s.northwind.organizationId, 0.5], 'only a person\'s request counts as explicit')

  const elsewhere = await southwind.chat('Give me short summaries of the fiscal year plan.')
  assert.deepEqual(elsewhere.memory.map(item => item.text).sort(), [fiscal, summaries])
  assert.deepEqual((await s.search(s.home, 'short summaries fiscal year')).sort(), [fiscal, summaries])
})

test('learning never writes an organization\'s shared memory', { skip: noDatabase }, async t => {
  const s = await story(t)
  const southwind = await s.organization('Southwind')
  const books = 'Northwind closes its books on the 5th'
  await s.northwind.chat('Please share with the team that we close the books on the 5th.', {
    tools: async call => {
      const saved = await call('memory_save', { kind: 'fact', text: books })
      return call('memory_publish', { id: saved.record.id, expectedSourceRevision: 1 })
    },
  })
  const shared = async () => s.rows(`SELECT id, text, revision::int AS revision, published_from IS NOT NULL AS linked, evidence, refreshed_day
    FROM kipster.memory_records WHERE scope='organization'`)
  const [published] = await shared()
  assert.deepEqual([published.text, published.linked], [books, true])

  const early = 'Month-end reports are due on the 3rd'
  const late = 'Late expense claims go into the next month'
  await s.northwind.chat('Month-end reports are due on the 3rd, before we close the books.', { learn: [{ text: early, subject: 'month end' }] })
  await s.northwind.chat('Expense claims after the close go into the next month.', { learn: [{ text: late, subject: 'month end' }] })
  await s.night({ consolidation: { related: [[early, late]], lessons: [{ text: 'Month-end work follows the close date', from: [early, late] }] } })
  // Months of work forget everything the agent itself held: facts, the lesson and its own copy of the save.
  await s.work(200)
  assert.equal((await s.night()).report.forgotten, 4)
  assert.deepEqual(await s.memories(), [])

  const [after] = await shared()
  assert.deepEqual({ ...after, linked: undefined }, { ...published, linked: undefined }, 'the shared memory is unchanged')
  assert.equal(after.linked, false, 'it only lost the link to the agent\'s forgotten copy')
  assert.equal((await s.rows(`SELECT 1 FROM kipster.memory_relationships WHERE owner_kind='organization'`)).length, 0)
  assert.deepEqual((await s.northwind.chat('When do we close the books?')).memory.map(item => item.text), [books])
  assert.deepEqual((await southwind.chat('When do we close the books?')).memory, [])
})
