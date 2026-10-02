import test from 'node:test'
import assert from 'node:assert/strict'
import { safeHostError } from '../dist/host-diagnostics.js'

test('Core adapter and background diagnostics retain errors without connection/provider secrets', () => {
  const config = { databaseUrl: 'postgresql://private-user:p%40ssword@host/private-db', adapters: [{ config: { apiKey: 'provider-key' } }], environment: { ACCESS_TOKEN: 'access-secret' } }
  const message = safeHostError(new Error(`ERR_FS_CP_NON_DIR_TO_DIR: ${config.databaseUrl}, password p@ssword, provider-key, access-secret, Bearer hidden-token`), config)
  assert.match(message, /ERR_FS_CP_NON_DIR_TO_DIR/)
  assert.doesNotMatch(message, /postgresql:|private-user|private-db|p%40ssword|p@ssword|provider-key|access-secret|hidden-token/)
})
