import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '../dist/protocol/index.js'

const { bootstrap, pluginAccount, pluginDefaultAccountWrite, pluginDetail, pluginError, pluginErrorCodes, pluginList, pluginPaths, pluginSignInRequest, pluginSignInStart, pluginSignInStatus, pluginSummary, pluginAccountRename, pluginAccountRemoval } = protocol
const at = '2026-10-13T09:00:00.000Z'
const summary = { id: 'aha', name: 'Aha!', description: 'Roadmaps', category: 'product', website: 'https://www.aha.io', signIn: ['dcr', 'cimd'], available: false, unavailableReason: 'Service unreachable', probe: { result: 'unreachable', signIn: [], checkedOn: '2026-10-01', reason: 'Service unreachable' }, verification: 'probe', needsAddress: true, addressPrompt: 'Your Aha! subdomain', accountCount: 0 }
const account = { id: 'acc-1', plugin: 'aha', label: 'Work', issuer: 'https://acme.aha.io', identityVerified: false, identitySource: 'none', status: 'reconnect-needed', isDefault: false, serverUrl: 'https://acme.aha.io/mcp', createdAt: at, updatedAt: at }

test('plugin summaries, accounts and details read the plugin server\'s JSON', () => {
  assert.deepEqual(pluginSummary.parse(summary), summary)
  assert.deepEqual(pluginAccount.parse(account), account)
  assert.deepEqual(pluginDetail.parse({ ...summary, accounts: [account] }).accounts, [account])
  const minimal = { id: 'x', name: 'X', category: 'other', signIn: ['dcr'], available: true, probe: null, verification: null, needsAddress: false, accountCount: 2 }
  assert.deepEqual(pluginList.parse({ version: 1, plugins: [minimal] }), { version: 1, plugins: [minimal] })
  assert.deepEqual(pluginAccount.parse({ id: 'a', plugin: 'x', label: 'L', status: 'working', isDefault: true, createdAt: at }).status, 'working')
  for (const broken of [{ ...summary, id: '' }, { ...summary, available: 'yes' }, { ...summary, accountCount: -1 }, (({ needsAddress, ...rest }) => rest)(summary)])
    assert.throws(() => pluginSummary.parse(broken), TypeError)
  assert.throws(() => pluginAccount.parse({ ...account, createdAt: 'yesterday' }), TypeError)
  assert.throws(() => pluginList.parse({ plugins: [summary] }), TypeError)
})

test('responses keep unknown fields and read unknown choices as unknown', () => {
  const grown = { ...summary, signIn: ['dcr', 'passkey'], verification: 'manual', probe: { ...summary.probe, result: 'rate-limited', latencyMs: 12 }, costs: 'free', tools: [{ name: 'list' }] }
  const parsed = pluginSummary.parse(grown)
  assert.deepEqual(parsed.signIn, ['dcr', 'unknown'])
  assert.equal(parsed.verification, 'unknown')
  assert.equal(parsed.probe.result, 'unknown')
  assert.equal(parsed.probe.latencyMs, 12)
  assert.equal(parsed.costs, 'free')
  assert.deepEqual(parsed.tools, [{ name: 'list' }])
  const accountParsed = pluginAccount.parse({ ...account, status: 'suspended', scopes: ['read'] })
  assert.deepEqual([accountParsed.status, accountParsed.scopes], ['unknown', ['read']])
  assert.equal(pluginList.parse({ version: 1, plugins: [], nextCursor: null }).nextCursor, null)
  assert.equal(pluginAccountRemoval.parse({ version: 1, removed: true, revoked: true, at }).at, at)
})

test('sign-in start and status distinguish their states and read new ones as unknown', () => {
  const redirect = { version: 1, status: 'redirect', id: 's1', method: 'cimd', authorizationUrl: 'https://auth.example/authorize', serverUrl: 'https://mcp.example/mcp', expiresAt: at }
  assert.deepEqual(pluginSignInStart.parse(redirect), redirect)
  assert.deepEqual(pluginSignInStart.parse({ version: 1, status: 'needs-client-metadata-document' }), { version: 1, status: 'needs-client-metadata-document' })
  assert.deepEqual(pluginSignInStart.parse({ version: 1, status: 'device-code', userCode: 'ABCD' }), { version: 1, status: 'unknown', userCode: 'ABCD' })
  assert.equal(pluginSignInStart.parse({ ...redirect, method: 'passkey' }).method, 'unknown')
  assert.throws(() => pluginSignInStart.parse({ status: 'redirect' }), TypeError)

  assert.deepEqual(pluginSignInStatus.parse({ version: 1, id: 's1', status: 'pending', plugin: 'aha' }), { version: 1, id: 's1', status: 'pending', plugin: 'aha' })
  const completed = pluginSignInStatus.parse({ version: 1, id: 's1', status: 'completed', plugin: 'aha', account, duplicate: true })
  assert.equal(completed.status === 'completed' && completed.duplicate, true)
  for (const code of protocol.pluginSignInFailureCodes.concat('consent-timeout'))
    assert.deepEqual(pluginSignInStatus.parse({ version: 1, id: 's1', status: 'failed', plugin: 'aha', code }), { version: 1, id: 's1', status: 'failed', plugin: 'aha', code })
  assert.deepEqual(pluginSignInStatus.parse({ version: 1, id: 's1', status: 'cancelled' }), { version: 1, id: 's1', status: 'unknown' })
  assert.throws(() => pluginSignInStatus.parse({ version: 1, status: 'pending', plugin: 'aha' }), TypeError)
})

test('requests are exact and take the plugin server\'s body with or without version', () => {
  assert.deepEqual(pluginSignInRequest.parse({}), {})
  assert.deepEqual(pluginSignInRequest.parse({ version: 1, address: 'acme', returnAddress: 'https://kipster.example/plugins/callback' }), { version: 1, address: 'acme', returnAddress: 'https://kipster.example/plugins/callback' })
  assert.deepEqual(pluginAccountRename.parse({ label: 'Work' }), { label: 'Work' })
  assert.deepEqual(pluginDefaultAccountWrite.parse({ version: 1, account: null }), { version: 1, account: null })
  for (const [schema, value] of [[pluginSignInRequest, { address: '' }], [pluginSignInRequest, { address: 'acme', extra: true }], [pluginSignInRequest, { version: 2 }],
    [pluginAccountRename, { label: '' }], [pluginAccountRename, { label: 'x'.repeat(65) }], [pluginAccountRename, {}], [pluginDefaultAccountWrite, {}], [pluginDefaultAccountWrite, { account: 7 }]])
    assert.throws(() => schema.parse(value), TypeError, JSON.stringify(value))
})

test('errors keep any code and the named codes and paths are stable', () => {
  assert.equal(pluginError.parse({ version: 1, code: 'unknown-plugin', message: 'Unknown plugin', requestId: 'r', detail: 1 }).code, 'unknown-plugin')
  assert.deepEqual(Object.values(pluginErrorCodes), ['plugins-unavailable', 'invalid-return-address', 'loopback-only', 'needs-client-metadata-document', 'return-address-refused'])
  assert.deepEqual([pluginPaths.plugins, pluginPaths.plugin('aha'), pluginPaths.signIn('aha'), pluginPaths.signInStatus('s1'), pluginPaths.accounts(), pluginPaths.accounts('aha'), pluginPaths.account('a1'), pluginPaths.defaultAccount('aha'), pluginPaths.callback],
    ['/v1/plugins', '/v1/plugins/aha', '/v1/plugins/aha/sign-in', '/v1/plugins/sign-ins/s1', '/v1/plugins/accounts', '/v1/plugins/accounts?plugin=aha', '/v1/plugins/accounts/a1', '/v1/plugins/aha/default-account', '/plugins/callback'])
})

test('bootstrap reads the plugins capability, and a Core without it as false', () => {
  const base = { version: 1, coreVersion: '0.8.0', protocol: { current: 1, oldest: 1 }, installationId: 'i', callerId: 'c', organizationId: 'o', rootAgentId: 'k' }
  assert.equal(bootstrap.parse({ ...base, capabilities: { voiceRecording: true, updates: true, memoryCards: true } }).capabilities.plugins, false)
  assert.equal(bootstrap.parse({ ...base, capabilities: { voiceRecording: false, plugins: true, futureFlag: true } }).capabilities.plugins, true)
  assert.equal(bootstrap.parse({ ...base, capabilities: { voiceRecording: false, plugins: false } }).capabilities.plugins, false)
  assert.throws(() => bootstrap.parse({ ...base, capabilities: { voiceRecording: false, plugins: 'yes' } }), TypeError)
  assert.deepEqual(bootstrap.describe().fields.capabilities.fields.plugins, { type: 'optional', of: { type: 'boolean' } })
})
