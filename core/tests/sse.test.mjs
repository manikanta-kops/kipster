import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { drainOrClose } from '../dist/transport/http/text.js'

test('slow SSE writer releases drain listeners and timers on close or timeout', async () => {
  const closed = new EventEmitter()
  const closeWait = drainOrClose(closed, 1000)
  closed.emit('close')
  assert.equal(await closeWait, false)
  assert.equal(closed.listenerCount('drain'), 0)
  assert.equal(closed.listenerCount('close'), 0)
  const slow = new EventEmitter()
  const started = Date.now()
  assert.equal(await drainOrClose(slow, 20), false)
  assert.ok(Date.now() - started < 500)
  assert.equal(slow.listenerCount('drain'), 0)
  assert.equal(slow.listenerCount('close'), 0)
  const resumed = new EventEmitter()
  const resumeWait = drainOrClose(resumed, 1000)
  resumed.emit('drain')
  assert.equal(await resumeWait, true)
  assert.equal(resumed.listenerCount('drain'), 0)
  assert.equal(resumed.listenerCount('close'), 0)
})
