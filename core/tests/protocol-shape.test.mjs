import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as protocol from '../dist/protocol/index.js'
import { array, boolean, boundedString, integer, literal, nonempty, nullable, object, optional, string, union } from '../dist/protocol/schema.js'
import { breakingChanges, expand, format, snapshot, verdict } from '../scripts/protocol-shape.mjs'

const range = { current: 1, oldest: 1 }
const state = union(literal('queued'), literal('done'))
const item = object({ id: nonempty(), state, note: nullable(string()), tags: array(string()) }, false)
const base = {
  protocolRange: range,
  item,
  event: union(object({ type: literal('item-changed'), data: item }, false), object({ type: literal('item-removed'), id: nonempty() }, false)),
  createItem: object({ version: literal(1), name: boundedString(1, 100), state: optional(state) }),
}
const changes = (head) => breakingChanges(snapshot(base), snapshot({ ...base, ...head }))

test('the committed protocol shape matches the current protocol', () => {
  const committed = readFileSync(new URL('../protocol-shape.json', import.meta.url), 'utf8')
  assert.equal(committed, `${format(snapshot(protocol))}\n`, 'Run: npm run protocol:shape -w core')
})

test('shared shapes are written once and expand back to every schema exactly', () => {
  const shape = snapshot(protocol)
  assert.deepEqual(shape.protocol, protocol.protocolRange)
  assert.ok(shape.responses.textEvent && shape.requests.textSubmission && !shape.responses.streamScope)
  assert.match(JSON.stringify(shape.responses.textEvent), /"ref":"threadMessage"/)
  const expanded = expand(shape)
  for (const kind of ['requests', 'responses'])
    for (const [name, value] of Object.entries(expanded[kind])) assert.deepEqual(value, protocol[name].describe(), name)
})

test('responses and events may gain fields, values and kinds', () => {
  const grown = object({ id: nonempty(), state: union(literal('queued'), literal('done'), literal('paused')), note: string(), tags: array(nonempty()), owner: optional(string()) }, false)
  assert.deepEqual(changes({
    item: grown,
    event: union(object({ type: literal('item-changed'), data: grown }, false), object({ type: literal('item-removed'), id: nonempty() }, false), object({ type: literal('item-moved'), id: nonempty() }, false)),
  }), [])
})

test('responses must not lose, loosen or retype what clients read', () => {
  assert.deepEqual(changes({
    item: object({ id: integer(), state: union(literal('queued')), note: optional(nullable(string())) }, false),
  }), ['item.id: changed from string to integer', 'item.state: no longer sends "done"', 'item.note: may now be absent', 'item.tags: removed'])
  assert.deepEqual(changes({ event: union(object({ type: literal('item-changed'), data: object({ id: nonempty(), state, note: nullable(string()), tags: array(string()), extra: boolean() }, false) }, false)) }),
    ['event: no longer sends <type=item-removed>'])
  assert.deepEqual(changes({ item: object({ id: nonempty(), state: string(), note: nullable(string()), tags: array(nullable(string())) }, false) }),
    ['item.state: no longer sends "queued"', 'item.state: no longer sends "done"', 'item.state: may now be string', 'item.tags[]: may now be null'])
})

test('requests must keep accepting what released clients send', () => {
  assert.deepEqual(changes({ createItem: object({ version: literal(1), name: boundedString(1, 200), state: optional(union(literal('queued'), literal('done'), literal('paused'))), color: optional(string()) }) }), [])
  assert.deepEqual(changes({ createItem: object({ version: literal(1), name: boundedString(1, 50), state, priority: integer() }) }),
    ['createItem.name: narrowed what it accepts', 'createItem.state: now required', 'createItem.priority: new required field'])
  assert.deepEqual(changes({ createItem: object({ version: literal(1), name: boundedString(1, 100) }) }), ['createItem.state: no longer accepted'])
  assert.deepEqual(changes({ createItem: undefined }), ['createItem: request schema removed'])
})

test('a raised protocol allows breaking changes while the previous number is still served', () => {
  const before = snapshot(base)
  const breaking = { ...base, item: object({ id: nonempty() }, false) }
  assert.deepEqual(verdict(before, snapshot(breaking)).problems, ['item.state: removed', 'item.note: removed', 'item.tags: removed'])
  const raised = verdict(before, snapshot({ ...breaking, protocolRange: { current: 2, oldest: 1 } }))
  assert.deepEqual([raised.raised, raised.problems, raised.changes.length], [true, [], 3])
  assert.match(verdict(before, snapshot({ ...breaking, protocolRange: { current: 2, oldest: 2 } })).problems[0], /keep serving protocol 1/)
})
