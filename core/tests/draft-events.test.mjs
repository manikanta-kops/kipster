import test from 'node:test'
import assert from 'node:assert/strict'
import { coalesceDrafts } from '../dist/workflows/draft-events.js'

test('a pending final supersedes drafts while other messages retain their identity', async () => {
  let continueInput
  const gate = new Promise(resolve => { continueInput = resolve })
  async function* source() {
    yield { kind: 'text', attemptId: 'a', messageId: 'one', text: 'first', final: false }
    await gate
    for (let i = 0; i < 3; i++) yield { kind: 'text', attemptId: 'a', messageId: 'one', text: String(i), final: false }
    yield { kind: 'text', attemptId: 'a', messageId: 'two', text: 'second', final: false }
    yield { kind: 'text', attemptId: 'a', messageId: 'one', text: 'final', final: true }
    yield { kind: 'text', attemptId: 'a', messageId: 'one', text: 'late', final: false }
    yield { kind: 'ended', attemptId: 'a', confirmed: true }
  }
  const iterator = coalesceDrafts(source())
  assert.equal((await iterator.next()).value.text, 'first')
  continueInput()
  await new Promise(resolve => setImmediate(resolve))
  const rest = []; for await (const event of iterator) rest.push(event)
  assert.deepEqual(rest.map(e => e.text ?? e.kind), ['final', 'second', 'ended'])
})
