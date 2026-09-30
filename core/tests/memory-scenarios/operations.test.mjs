import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Operations: learning switches, sleep times, an embedding outage and conversations during sleep.

test('learning switches: off captures nothing and nobody sleeps; one agent can stay off while another learns', { skip: noDatabase }, async t => {
  const s = await story(t)
  const scout = await s.hire('Scout', { organizations: [s.northwind] })
  await s.runtime.learning.setInstallation(s.owner, { enabled: false })

  const unheard = await s.northwind.chat('Our warehouse moved to Rotterdam.', { learn: [{ text: 'The warehouse is in Rotterdam' }] })
  assert.equal(unheard.learned, undefined, 'nothing is captured')
  await s.northwind.chat('Scout, the warehouse is in Rotterdam now.', { agent: scout, learn: [{ text: 'The warehouse is in Rotterdam' }] })
  const quiet = await s.night()
  assert.equal(quiet.day, undefined, 'nobody sleeps')
  assert.deepEqual(await s.modelCalls(), {}, 'no model call')

  // Learning back on, with Scout switched off and sleeping later than everyone else.
  await s.runtime.learning.setInstallation(s.owner, { enabled: true })
  await s.runtime.learning.setAgent(s.owner, scout, { enabled: false, sleepTime: '03:30' })
  const heard = await s.northwind.chat('The Rotterdam warehouse opens at seven.', { learn: [{ text: 'The Rotterdam warehouse opens at seven' }] })
  assert.equal(heard.learned, 'committed')
  assert.equal((await s.northwind.chat('It opens at seven, Scout.', { agent: scout, learn: [{ text: 'The Rotterdam warehouse opens at seven' }] })).learned, undefined)
  assert.deepEqual(await s.memories(), ['The Rotterdam warehouse opens at seven'], 'the conversation held while learning was off is never learned')
  assert.deepEqual(await s.memories(scout), [])

  const night = await s.night()
  assert.deepEqual([night.day, night.state], ['2026-03-04', 'finished'])
  assert.equal(await s.lastSleep(scout), undefined)

  // Switched back on in the morning, Scout catches up on the night it missed at once, then keeps its own time:
  // not at one in the morning, but at half past three.
  await s.runtime.learning.setAgent(s.owner, scout, { enabled: true })
  await s.tick()
  assert.equal((await s.lastSleep(scout)).day, '2026-03-04')
  await s.bedtime([1, 0])
  await s.tick()
  assert.equal((await s.lastSleep()).day, '2026-03-05')
  await s.bedtime([3, 29])
  await s.tick()
  assert.equal((await s.lastSleep(scout)).day, '2026-03-04')
  await s.bedtime([3, 30])
  await s.tick()
  assert.deepEqual(await s.lastSleep(scout).then(sleep => [sleep.day, sleep.state]), ['2026-03-05', 'finished'])
})

test('an embedding outage delays consolidation but loses nothing', { skip: noDatabase }, async t => {
  const s = await story(t)
  const expiry = 'The VPN certificate expires in June'
  const renewal = 'The VPN certificate must be renewed in May'
  s.embedding.down = true
  await s.home.chat('Heads up: the VPN certificate expires in June.', { learn: [{ text: expiry, subject: 'vpn' }] })
  await s.home.chat('Let us renew the VPN certificate in May.', { learn: [{ text: renewal, subject: 'vpn' }] })
  await s.index()
  assert.deepEqual((await s.rows(`SELECT status FROM kipster.memory_index_intents ORDER BY status`)).map(row => row.status), ['failed', 'failed'])

  // The memories are still recalled by their words, and the night passes without consolidating them.
  const asked = await s.home.chat('When does the VPN certificate expire?')
  assert.deepEqual(asked.memory.map(item => item.text).sort(), [expiry, renewal].sort())
  const night = await s.night()
  assert.deepEqual([night.state, night.consolidation], ['finished', undefined])

  // Once the service is back, the next night indexes and consolidates them.
  s.embedding.down = false
  const later = await s.night({ consolidation: { related: [[expiry, renewal]] } })
  assert.deepEqual(later.consolidation.memories.map(item => item.text).sort(), [expiry, renewal].sort())
  assert.deepEqual(await s.links(), [['related_to', expiry, renewal]])
})

test('conversations keep flowing while the agent sleeps; the sleep waits for them to finish', { skip: noDatabase }, async t => {
  const s = await story(t)
  const lunch = 'The canteen serves lunch from noon'
  const menu = 'The canteen menu changes on Mondays'
  await s.home.chat('The canteen serves lunch from noon.', { learn: [{ text: lunch, subject: 'canteen' }] })
  await s.home.chat('The canteen menu changes every Monday.', { learn: [{ text: menu, subject: 'canteen' }] })
  await s.bedtime()
  await s.tick()
  const request = await s.request()
  assert.equal(request.task, 'consolidate')

  // A person writes while the model is still consolidating: the conversation runs and completes.
  const late = await s.send(s.home, 'Is the canteen open on Sundays?')
  const live = await s.execution(late.runId)
  assert.equal((await s.lastSleep()).state, 'running')
  assert.equal(await s.respond(request, { consolidation: { related: [[lunch, menu]] } }), 'completed')
  assert.deepEqual(await s.links(), [['related_to', menu, lunch]], 'the answer applies at once')
  await s.tick()
  assert.deepEqual(await s.lastSleep().then(sleep => [sleep.state, sleep.step]), ['running', 'consolidate'], 'the sleep waits for the conversation')

  live.finish('No, it is closed on Sundays.')
  await s.completed(late.runId)
  await s.tick()
  assert.equal((await s.lastSleep()).state, 'finished')
  assert.equal(await s.extract(late.runId, [{ text: 'The canteen is closed on Sundays', subject: 'canteen', from: 'agent' }]), 'committed')
})
