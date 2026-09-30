import assert from 'node:assert/strict'
import { test } from 'node:test'
import { acceptedReceipt, boundedRead, parseBoundedRead, receiptKey, snapshot, textEvent, textSubmission } from '../dist/protocol/index.js'
import { initialWork, mayAdvanceQueue, nextReady, transition } from '../dist/modules/work/public.js'
import { fixtureAdapter } from './.build/tests/fixtures/deterministic-adapter.js'

const scope = { installationId: 'i', callerId: 'c' }
const base = { version: 1, submissionId: 's', scope, target: { context: { kind: 'organization', organizationId: 'o' }, chatId: 'ch' }, parts: [{ kind: 'text', text: 'hi' }] }
const context = (attemptId) => ({ runId: 'r', attemptId, organizationId: null, agentId: 'agent', instructions: 'current', input: [{ messageId: 'u', text: 'hi' }] })
const host = (calls = []) => ({ now: () => '2026-01-01T00:00:00Z', async invokeTool(request) { calls.push(request); return { ok: true } } })
const step = (s, kind, fields = {}) => transition(s, { kind, ...fields })

test('strict submission, distinct root/reply, scoped receipt and additive reads', () => {
  assert.equal(textSubmission.parse({ ...base, mode: 'root' }).mode, 'root')
  assert.equal(textSubmission.parse({ ...base, mode: 'reply', threadId: 't' }).threadId, 't')
  for (const bad of [{ ...base, mode: 'root', threadId: 't' }, { ...base, mode: 'reply' }, { ...base, mode: 'root', parts: [{ kind: 'text', text: '' }] }, { ...base, mode: 'root', surprise: 1 }]) {
    assert.throws(() => textSubmission.parse(bad), TypeError)
  }
  assert.notEqual(receiptKey(scope, 's'), receiptKey({ ...scope, callerId: 'other' }, 's'))
  assert.deepEqual(acceptedReceipt.parse({ version: 1, status: 'accepted', submissionId: 's', chatId: 'ch', threadId: 't', messageId: 'm', runId: 'r', alreadyAccepted: true, newField: 1 }).alreadyAccepted, true)
  assert.throws(() => parseBoundedRead({ version: 1, scope, context: base.target.context, chatId: 'ch', threadId: 't', before: null, limit: 101 }), TypeError)
  assert.throws(() => boundedRead.parse({ version: 1, scope, context: base.target.context, chatId: 'ch', threadId: 't', before: null, limit: 1000 }), TypeError)
  assert.throws(() => snapshot.parse({ version: 2, scope: { kind: 'application', ...scope }, cursor: 'x', messages: [], next: null }), TypeError)
  const current = snapshot.parse({ version: 1, scope: { kind: 'application', ...scope }, cursor: 'x', messages: [], work: [], queue: [], next: null, futureField: true })
  assert.equal(current.cursor, 'x')
  assert.equal(textEvent.parse({ version: 1, eventId: 'e', scope: { kind: 'thread', ...scope, threadId: 't' }, cursor: 'opaque', occurredAt: '2026-01-01T00:00:00Z', type: 'message-final', resourceId: 'm', revision: 2, data: { id: 'm', threadId: 't', authorId: 'agent', parts: [{ kind: 'text', text: 'done' }], final: true, revision: 2, position: 1 } }).revision, 2)
})

test('parsed JSON prototype keys are rejected at every mutation level', () => {
  for (const path of ['root', 'scope', 'context', 'part']) {
    const payload = JSON.parse(JSON.stringify({ ...base, mode: 'root' }))
    const target = path === 'root' ? payload : path === 'scope' ? payload.scope : path === 'context' ? payload.target.context : payload.parts[0]
    Object.defineProperty(target, '__proto__', { value: 'surprise', enumerable: true })
    assert.throws(() => textSubmission.parse(JSON.parse(JSON.stringify(payload))), TypeError, path)
  }
  for (const key of ['constructor', 'toString']) {
    const payload = JSON.parse(JSON.stringify({ ...base, mode: 'root' }))
    payload[key] = true
    assert.throws(() => textSubmission.parse(payload), TypeError)
  }
})

test('issued uncertainty owns permit, rejects retry, and stale attempts cannot publish', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a1' })
  assert.equal(s.permit, 'none')
  s = step(s, 'prepared', { attemptId: 'a1' })
  s = step(s, 'dispatch-issued', { attemptId: 'a1' })
  s = step(s, 'failed', { attemptId: 'a1', phase: 'issued', confirmedEnded: false, effectsResolved: false })
  assert.equal(s.run, 'recovery-needed')
  assert.equal(s.permit, 'owned')
  assert.throws(() => step(s, 'retry', { attemptId: 'a2', continueAfterSuccess: true }), /reconcile/)
  assert.throws(() => step(s, 'text', { attemptId: 'a1', messageId: 'm', text: 'late', final: true }))
  s = step(s, 'reconciled-safe', { attemptId: 'a1' })
  s = step(s, 'retry', { attemptId: 'a2', continueAfterSuccess: true })
  assert.equal(s.attemptId, 'a2')
})

test('final text survives failure; retry continuation applies only to exact attempt/generation', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a1' })
  s = step(s, 'dispatch-issued', { attemptId: 'a1' })
  s = step(s, 'started', { attemptId: 'a1' })
  s = step(s, 'text', { attemptId: 'a1', messageId: 'm', text: 'useful', final: true })
  s = step(s, 'failed', { attemptId: 'a1', phase: 'issued', confirmedEnded: true, effectsResolved: true })
  assert.equal(s.output[0].text, 'useful')
  assert.equal(s.queueHold, true)
  s = step(s, 'retry', { attemptId: 'a2', continueAfterSuccess: true })
  assert.throws(() => step(s, 'text', { attemptId: 'a1', messageId: 'late', text: 'bad', final: true }), /obsolete/)
  s = step(s, 'dispatch-issued', { attemptId: 'a2' })
  s = step(s, 'started', { attemptId: 'a2' })
  s = step(s, 'provider-ended', { attemptId: 'a2', confirmed: true })
  assert.equal(mayAdvanceQueue(s), true)
  assert.equal(nextReady([{ id: 'later', state: 'queued', acceptanceOrder: 2 }, { id: 'head', state: 'preparing', acceptanceOrder: 1 }], s), null)
  assert.equal(nextReady([{ id: 'later', state: 'queued', acceptanceOrder: 2 }, { id: 'head', state: 'queued', acceptanceOrder: 1 }], s)?.id, 'head')
  assert.equal(mayAdvanceQueue(step(s, 'stop')), false)
})

test('confirmed provider end alone does not authorize retry of unresolved effects', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'dispatch-issued', { attemptId: 'a' })
  s = step(s, 'started', { attemptId: 'a' })
  s = step(s, 'failed', { attemptId: 'a', phase: 'issued', confirmedEnded: true, effectsResolved: false })
  assert.equal(s.permit, 'none')
  assert.equal(s.run, 'recovery-needed')
  assert.throws(() => step(s, 'retry', { attemptId: 'b', continueAfterSuccess: false }), /reconcile/)
})

test('question and cancellation do not imply completion or release', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'dispatch-issued', { attemptId: 'a' })
  s = step(s, 'started', { attemptId: 'a' })
  s = step(s, 'await', { attemptId: 'a', pending: 'question' })
  s = step(s, 'provider-ended', { attemptId: 'a', confirmed: true })
  assert.equal(s.run, 'waiting')
  assert.equal(s.permit, 'none')
  s = step(s, 'continuation-ready', { attemptId: 'a' })
  assert.equal(s.run, 'queued')
  let c = step(initialWork('c'), 'admit', { attemptId: 'a' })
  c = step(c, 'dispatch-issued', { attemptId: 'a' })
  c = step(c, 'started', { attemptId: 'a' })
  c = step(c, 'cancel-requested', { attemptId: 'a' })
  assert.equal(c.permit, 'owned')
  assert.notEqual(c.run, 'cancelled')
  c = step(c, 'cancel-confirmed', { attemptId: 'a' })
  assert.equal(c.run, 'cancelled')
  assert.equal(step(c, 'resume').run, 'cancelled')
  assert.equal(mayAdvanceQueue(step(c, 'resume')), true)
})

test('Stop fences queued, preparing and waiting continuation; Resume releases only follow-ups', () => {
  const queued = step(initialWork('r'), 'stop')
  assert.equal(queued.run, 'cancelled')
  assert.throws(() => step(queued, 'admit', { attemptId: 'late' }))
  assert.equal(nextReady([{ id: 'next', state: 'queued', acceptanceOrder: 1 }], step(queued, 'resume'))?.id, 'next')

  let preparing = step(initialWork('p'), 'admit', { attemptId: 'a' })
  preparing = step(preparing, 'stop')
  assert.equal(preparing.run, 'cancelled')
  assert.equal(preparing.permit, 'none')
  assert.throws(() => step(preparing, 'dispatch-issued', { attemptId: 'a' }))

  let waiting = step(initialWork('w'), 'admit', { attemptId: 'a' })
  waiting = step(waiting, 'dispatch-issued', { attemptId: 'a' })
  waiting = step(waiting, 'started', { attemptId: 'a' })
  waiting = step(waiting, 'await', { attemptId: 'a', pending: 'child' })
  waiting = step(waiting, 'provider-ended', { attemptId: 'a', confirmed: true })
  waiting = step(waiting, 'stop')
  assert.equal(waiting.run, 'cancelled')
  assert.throws(() => step(waiting, 'continuation-ready', { attemptId: 'a' }))
  assert.throws(() => step(step(waiting, 'resume'), 'admit', { attemptId: 'b' }))
})

test('Stop on active or uncertain execution retains permit until confirmed safe settlement', () => {
  let running = step(initialWork('r'), 'admit', { attemptId: 'a' })
  running = step(running, 'dispatch-issued', { attemptId: 'a' })
  running = step(running, 'started', { attemptId: 'a' })
  running = step(running, 'stop')
  assert.equal(running.attempt, 'cancellation-requested')
  assert.equal(running.permit, 'owned')
  assert.throws(() => step(running, 'text', { attemptId: 'a', messageId: 'late', text: 'late', final: true }))
  assert.equal(mayAdvanceQueue(step(running, 'resume')), false)
  running = step(running, 'provider-ended', { attemptId: 'a', confirmed: false })
  assert.equal(running.run, 'recovery-needed')
  assert.equal(running.permit, 'owned')
  running = step(running, 'reconciled-safe', { attemptId: 'a' })
  assert.equal(running.run, 'cancelled')
  assert.equal(running.permit, 'none')
  assert.equal(mayAdvanceQueue(step(running, 'resume')), true)
})

test('retry continuation is superseded by Stop; Resume never revives that attempt', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'failed', { attemptId: 'a', phase: 'preparation', confirmedEnded: true, effectsResolved: true })
  s = step(s, 'retry', { attemptId: 'b', continueAfterSuccess: true })
  assert.equal(s.retryContinue.attemptId, 'b')
  s = step(s, 'stop')
  assert.equal(s.retryContinue, null)
  assert.equal(s.run, 'cancelled')
  s = step(s, 'resume')
  assert.equal(mayAdvanceQueue(s), true)
  assert.throws(() => step(s, 'dispatch-issued', { attemptId: 'b' }))
})

test('Resume releases follow-ups after safely settled failure and keeps failed result', () => {
  let preparation = step(initialWork('p'), 'admit', { attemptId: 'a' })
  preparation = step(preparation, 'failed', { attemptId: 'a', phase: 'preparation', confirmedEnded: true, effectsResolved: true })
  assert.equal(mayAdvanceQueue(preparation), false)
  preparation = step(preparation, 'resume')
  assert.equal(preparation.run, 'failed')
  assert.equal(mayAdvanceQueue(preparation), true)

  let issued = step(initialWork('i'), 'admit', { attemptId: 'a' })
  issued = step(issued, 'dispatch-issued', { attemptId: 'a' })
  issued = step(issued, 'failed', { attemptId: 'a', phase: 'issued', confirmedEnded: true, effectsResolved: true })
  assert.equal(mayAdvanceQueue(step(issued, 'resume')), true)

  let unresolved = step(initialWork('u'), 'admit', { attemptId: 'a' })
  unresolved = step(unresolved, 'dispatch-issued', { attemptId: 'a' })
  unresolved = step(unresolved, 'failed', { attemptId: 'a', phase: 'issued', confirmedEnded: true, effectsResolved: false })
  assert.equal(mayAdvanceQueue(step(unresolved, 'resume')), false)
})

test('retry authorization follows required continuation attempts without releasing ordinary queue', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'failed', { attemptId: 'a', phase: 'preparation', confirmedEnded: true, effectsResolved: true })
  s = step(s, 'retry', { attemptId: 'b', continueAfterSuccess: true })
  s = step(s, 'dispatch-issued', { attemptId: 'b' })
  s = step(s, 'started', { attemptId: 'b' })
  s = step(s, 'await', { attemptId: 'b', pending: 'question' })
  s = step(s, 'provider-ended', { attemptId: 'b', confirmed: true })
  assert.equal(mayAdvanceQueue(s), false)
  s = step(s, 'continuation-ready', { attemptId: 'b' })
  assert.equal(s.run, 'queued')
  assert.equal(mayAdvanceQueue(s), false)
  assert.throws(() => step(s, 'admit', { attemptId: 'b' }), /already used/)
  s = step(s, 'admit', { attemptId: 'c' })
  assert.equal(s.retryContinue.attemptId, 'b')
  assert.equal(s.retryContinue.currentAttemptId, 'c')
  assert.throws(() => step(s, 'text', { attemptId: 'b', messageId: 'late', text: 'late', final: true }), /obsolete/)
  s = step(s, 'dispatch-issued', { attemptId: 'c' })
  s = step(s, 'started', { attemptId: 'c' })
  s = step(s, 'provider-ended', { attemptId: 'c', confirmed: true })
  assert.equal(mayAdvanceQueue(s), true)
  assert.equal(mayAdvanceQueue(step(s, 'stop')), false)
})

test('normal continuations and later retries never reuse an earlier attempt identity', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'dispatch-issued', { attemptId: 'a' })
  s = step(s, 'started', { attemptId: 'a' })
  s = step(s, 'await', { attemptId: 'a', pending: 'question' })
  s = step(s, 'provider-ended', { attemptId: 'a', confirmed: true })
  s = step(s, 'continuation-ready', { attemptId: 'a' })
  assert.throws(() => step(s, 'admit', { attemptId: 'a' }), /already used/)
  s = step(s, 'admit', { attemptId: 'b' })
  assert.throws(() => step(s, 'text', { attemptId: 'a', messageId: 'late', text: 'late', final: true }), /obsolete/)
  s = step(s, 'failed', { attemptId: 'b', phase: 'preparation', confirmedEnded: true, effectsResolved: true })
  assert.throws(() => step(step(s, 'resume'), 'retry', { attemptId: 'c', continueAfterSuccess: false }), /reconcile/)
  assert.throws(() => step(s, 'retry', { attemptId: 'a', continueAfterSuccess: false }), /already used/)
  assert.throws(() => step(s, 'retry', { attemptId: 'b', continueAfterSuccess: false }), /already used/)
  assert.equal(step(s, 'retry', { attemptId: 'c', continueAfterSuccess: false }).attemptId, 'c')
})

test('stopped pending child clears after safe terminal failure regardless of end route', () => {
  let s = step(initialWork('r'), 'admit', { attemptId: 'a' })
  s = step(s, 'dispatch-issued', { attemptId: 'a' })
  s = step(s, 'started', { attemptId: 'a' })
  s = step(s, 'await', { attemptId: 'a', pending: 'child' })
  s = step(s, 'stop')
  s = step(s, 'failed', { attemptId: 'a', phase: 'issued', confirmedEnded: true, effectsResolved: true })
  assert.equal(s.run, 'cancelled')
  assert.equal(s.pending, 'none')
  assert.equal(mayAdvanceQueue(step(s, 'resume')), true)
})

test('deterministic adapter streams correlated output and closes cleanly', async () => {
  const toolCalls = []
  const adapter = fixtureAdapter(host(toolCalls))
  const handle = await adapter.execute(context('a'))
  const observed = []
  let state = step(initialWork('r'), 'admit', { attemptId: 'a' })
  state = step(state, 'dispatch-issued', { attemptId: 'a' })
  state = step(state, 'started', { attemptId: 'a' })
  const collecting = (async () => { for await (const event of handle.events) {
    observed.push(event)
    if (event.kind === 'text') state = step(state, 'text', event)
    if (event.kind === 'ended') state = step(state, 'provider-ended', { attemptId: event.attemptId, confirmed: event.confirmed })
  } })()
  assert.deepEqual(await handle.cancel(), { acknowledged: true, confirmedEnded: false })
  assert.deepEqual(await handle.callTool('call', 'demo', { x: 1 }), { ok: true })
  assert.deepEqual(toolCalls[0], { attemptId: 'a', callId: 'call', name: 'demo', arguments: { x: 1 } })
  handle.release({ kind: 'text', attemptId: 'a', messageId: 'm', text: 'draft', final: false })
  handle.release({ kind: 'text', attemptId: 'a', messageId: 'm', text: 'final', final: true })
  handle.release({ kind: 'ended', attemptId: 'a', confirmed: true })
  await collecting
  assert.deepEqual(observed.map(x => x.kind), ['text', 'text', 'ended'])
  assert.equal(state.run, 'completed')
  assert.deepEqual(state.output, [{ messageId: 'm', text: 'final', final: true }])
  assert.equal(await handle.reconcile(), 'ended')
  await adapter.close()
  assert.equal(adapter.activeCount, 0)
  await assert.rejects(() => adapter.execute(context('b')), /closed/)
})

test('fixture failure and uncertain shutdown are controlled barriers', async () => {
  const adapter = fixtureAdapter(host())
  const failed = await adapter.execute(context('a'))
  const seen = []
  const consume = (async () => { for await (const event of failed.events) seen.push(event) })()
  failed.release({ kind: 'failed', attemptId: 'a', confirmedEnded: true, message: 'provider failed' })
  await consume
  assert.equal(seen[0].confirmedEnded, true)
  const unknown = await adapter.execute(context('b'))
  assert.equal(await unknown.reconcile(), 'unknown')
  assert.deepEqual(await unknown.cancel(), { acknowledged: true, confirmedEnded: false })
  await adapter.close()
  assert.equal(adapter.activeCount, 0)
  assert.equal(await unknown.reconcile(), 'unknown')
})
