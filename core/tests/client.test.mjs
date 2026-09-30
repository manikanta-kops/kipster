import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineClientOptions } from '../src/protocol/client/index.ts'

test('normalizes an HTTP(S) address without mutating its input', () => {
  const input = { baseUrl: 'HTTPS://KIPSTER.EXAMPLE:443/core/' }
  const options = defineClientOptions(input)
  assert.deepEqual(options, { baseUrl: 'https://kipster.example/core/' })
  assert.deepEqual(input, { baseUrl: 'HTTPS://KIPSTER.EXAMPLE:443/core/' })
  assert.equal(Object.isFrozen(options), true)
  assert.deepEqual(defineClientOptions({ baseUrl: 'http://127.0.0.1:3000' }), {
    baseUrl: 'http://127.0.0.1:3000/',
  })
})

test('rejects relative addresses and non-HTTP transports', () => {
  for (const baseUrl of ['/core', 'not a URL', 'file:///tmp/kipster', 'ftp://example.com', 'javascript:void(0)']) {
    assert.throws(() => defineClientOptions({ baseUrl }), TypeError)
  }
})
