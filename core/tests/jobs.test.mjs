import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Jobs } from '../dist/platform/jobs/public.js'

class FakeBoss extends EventEmitter {
  starts = 0
  stops = 0
  failQueue = true
  async start() { this.starts++; return this }
  async stop() { this.stops++ }
  async createQueue() { if (this.failQueue) throw new Error('queue setup failed') }
  async send() { return 'job-id' }
  async work(name, options, handler) { this.handler = handler }
}
test('partial job startup is stopped, background errors do not fail sends and clear when the worker receives jobs, and reopen works', async () => {
  const boss = new FakeBoss()
  const reported = []
  const jobs = new Jobs('unused', error => reported.push(error.message), boss)
  await assert.rejects(jobs.start(), /queue setup failed/)
  assert.equal(boss.starts, 1)
  assert.equal(boss.stops, 1)
  boss.failQueue = false
  await jobs.start()
  assert.equal(boss.starts, 2)
  boss.emit('error', new Error('background failure'))
  assert.equal(jobs.error.message, 'background failure')
  assert.deepEqual(reported, ['background failure'])
  assert.equal(await jobs.send({ query: async () => ({ rows: [], rowCount: 0 }) }, 'intent'), 'job-id')
  assert.equal(jobs.error.message, 'background failure', 'a send does not show that the worker recovered')
  const handled = []
  await jobs.work(async id => { handled.push(id) })
  await boss.handler([{ data: { intentId: 'intent' } }])
  assert.deepEqual(handled, ['intent'])
  assert.equal(jobs.error, null, 'the worker receiving jobs clears the background error')
  boss.emit('error', new Error('later failure'))
  boss.send = async () => { throw new Error('send failed') }
  await assert.rejects(jobs.send({ query: async () => ({ rows: [], rowCount: 0 }) }, 'intent'), /send failed/)
  assert.equal(jobs.error.message, 'later failure')
  assert.deepEqual(reported, ['background failure', 'later failure'])
  delete boss.send
  await jobs.stop()
  assert.equal(boss.stops, 2)
  await jobs.start()
  assert.equal(jobs.error, null)
  assert.equal(await jobs.send({ query: async () => ({ rows: [], rowCount: 0 }) }, 'intent'), 'job-id')
  await jobs.stop()
})

test('job startup retains original failure if cleanup also fails', async () => {
  const boss = new FakeBoss()
  boss.stop = async () => { throw new Error('cleanup failed') }
  const jobs = new Jobs('unused', undefined, boss)
  const error = await jobs.start().then(() => null, error => error)
  assert.ok(error instanceof AggregateError)
  assert.equal(error.cause.message, 'queue setup failed')
  assert.match(error.errors[1].message, /cleanup failed/)
})

test('failed engine start still attempts owned cleanup', async () => {
  const boss = new FakeBoss()
  boss.start = async () => { boss.starts++; throw new Error('engine start failed') }
  const jobs = new Jobs('unused', undefined, boss)
  await assert.rejects(jobs.start(), /engine start failed/)
  assert.equal(boss.stops, 1)
})
