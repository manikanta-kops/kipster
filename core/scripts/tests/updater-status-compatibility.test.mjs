import test from 'node:test'
import assert from 'node:assert/strict'
import { breakingChanges } from '../protocol-shape.mjs'

test('installer status is Core input while public update results remain client responses', () => {
  const string = { type: 'string', min: 1 }, nullable = { type: 'nullable', of: string }
  const shape = from => ({ type: 'object', exact: false, fields: { from } })
  const snapshot = (status, result) => ({ protocol: { current: 1, oldest: 1 }, requests: {}, responses: { updaterStatusFile: shape(status), updateStatus: shape(result) }, fragments: {} })
  assert.deepEqual(breakingChanges(snapshot(string, string), snapshot(nullable, string)), [])
  assert.match(breakingChanges(snapshot(nullable, string), snapshot(string, string))[0], /updaterStatusFile.from: no longer accepts null/)
  assert.match(breakingChanges(snapshot(string, string), snapshot(nullable, nullable))[0], /updateStatus.from: may now be null/)
})
