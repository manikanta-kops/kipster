import test from 'node:test'
import assert from 'node:assert/strict'
import * as operator from '../../dist/maintenance.js'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Crash and resume: Core can stop at any point of a night. The sleep resumes from its durable state, asks the model
// again only for an answer it never received, and applies every answer exactly once.

test('Core restarting throughout a night resumes the sleep without duplicate links, lessons or identity writes', { skip: noDatabase }, async t => {
  const s = await story(t)
  const tests = 'Deploy only after the tests pass'
  const restarts = 'The staging server restarts at midnight'
  const pauses = 'Staging deploys pause around midnight'
  const lesson = 'Avoid staging deploys around midnight'
  await s.home.chat('Remember: deploy only after the tests pass. Also, the staging server restarts at midnight.', {
    learn: [{ text: tests, subject: 'deploys', explicit: true }, { text: restarts, subject: 'staging' }],
  })
  await s.home.chat('As agreed, deploy only after the tests pass. Staging deploys pause around midnight.', {
    learn: [{ text: tests, subject: 'deploys', explicit: true }, { text: pauses, subject: 'staging' }],
  })
  const seeded = await s.identity.read()

  // Core stops while the model is consolidating. The answer never arrives, so the run waits for reconciliation.
  await s.bedtime()
  await s.tick()
  const first = await s.request()
  await s.startWorking(first)
  await s.restart()
  const run = await s.row(`SELECT id, state FROM kipster.maintenance_runs WHERE task_kind='consolidate'`)
  assert.equal(run.state, 'recovery-needed')
  await s.tick()
  assert.equal(await s.request(), null, 'nothing is asked again before reconciliation')
  assert.deepEqual(await s.lastSleep().then(sleep => [sleep.state, sleep.step]), ['running', 'consolidate'])

  // The operator confirms the provider ended; the model is asked again and its answer applies.
  s.adapter.reconcileScript.push('ended')
  await operator.requestAction({ connectionString: s.url.href, opId: 'reconcile-consolidation', action: 'reconcile', target: { runId: run.id } })
  await s.tick()
  const again = await s.request()
  assert.deepEqual([again.task, again.found.context.attemptGeneration], ['consolidate', 2])
  assert.equal(await s.respond(again, { consolidation: { related: [[restarts, pauses]], lessons: [{ text: lesson, from: [restarts, pauses] }] } }), 'completed')

  // Core stops again before the sleep moves on, and once more after the Learned section is written.
  await s.restart()
  await s.tick()
  const promotion = await s.request()
  assert.deepEqual(promotion.input.memories.map(item => item.text), [tests])
  assert.equal(await s.respond(promotion, { promotion: '- Deploys only after tests pass' }), 'completed')
  await s.restart()
  await s.tick()
  assert.equal(await s.request(), null)

  const sleep = await s.lastSleep()
  assert.deepEqual([sleep.state, sleep.report.consolidation], ['finished', { inputs: 3, absorbed: 0, contradicts: 0, related: 1, lessons: 1, skipped: 0 }])
  assert.deepEqual(await s.modelCalls(), { extract: 2, consolidate: 1, identity: 1 })
  assert.deepEqual(await s.links(), [['related_to', pauses, restarts]])
  assert.equal((await s.rows(`SELECT 1 FROM kipster.memory_records WHERE origin='lesson'`)).length, 1)
  assert.equal(await s.identity.read(), `${seeded}\n<!-- kipster:learned:begin -->\n- Deploys only after tests pass\n<!-- kipster:learned:end -->\n`)
  assert.equal((await s.runtime.home.identity.listBackups(s.agent, 'identity.md')).length, 1)
})
