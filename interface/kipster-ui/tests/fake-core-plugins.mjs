import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as protocol from '@kipster/core/protocol'
import { createFakeCore } from '../src/fake-core/index.ts'

const origin = 'https://demo.kipster.invalid'
const { pluginPaths, pluginErrorCodes } = protocol
const returnAddress = `${origin}${pluginPaths.callback}`

function harness(t, options = {}) {
  const core = createFakeCore({
    autoAdvance: false,
    testControls: true,
    ...options,
  })
  t.after(() => core.dispose())
  const request = (path, method = 'GET', body) =>
    core.handle(
      new Request(origin + path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    )
  const json = async (path, schema, method = 'GET', body) => {
    const response = await request(path, method, body)
    const value = await response.json()
    assert.ok(
      response.ok,
      `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
    )
    return schema.parse(value)
  }
  /** A refused request: its status and the public plugin error envelope. */
  const refused = async (path, status, code, method = 'GET', body) => {
    const response = await request(path, method, body)
    assert.equal(response.status, status, `${method} ${path}`)
    const error = protocol.pluginError.parse(await response.json())
    assert.equal(error.code, code)
    return error
  }
  const control = async (body) => {
    const response = await request('/__demo/plugins', 'POST', body)
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    )
    return response.json()
  }
  const start = (pluginId, body = { returnAddress }) =>
    json(pluginPaths.signIn(pluginId), protocol.pluginSignInStart, 'POST', {
      version: 1,
      ...body,
    })
  const signIn = (id) =>
    json(pluginPaths.signInStatus(id), protocol.pluginSignInStatus)
  const detail = async (pluginId) =>
    (await json(pluginPaths.plugin(pluginId), protocol.pluginResult)).plugin
  return { core, request, json, refused, control, start, signIn, detail }
}

test('bootstrap reports plugins, and every plugin route answers 503 while they are off', async (t) => {
  const { request, json, refused, control } = harness(t)
  const bootstrap = protocol.bootstrap.parse(
    await (await request('/v1/bootstrap')).json(),
  )
  assert.equal(bootstrap.capabilities.plugins, true)
  await json(pluginPaths.plugins, protocol.pluginList)

  await control({ enabled: false })
  const off = protocol.bootstrap.parse(
    await (await request('/v1/bootstrap')).json(),
  )
  assert.equal(off.capabilities.plugins, false)
  for (const [path, method, body] of [
    [pluginPaths.plugins, 'GET'],
    [pluginPaths.plugin('linear'), 'GET'],
    [pluginPaths.signIn('linear'), 'POST', { version: 1 }],
    [pluginPaths.signInStatus('signin-1'), 'GET'],
    [pluginPaths.accounts(), 'GET'],
    [pluginPaths.account('acct-notion-work'), 'DELETE'],
    [pluginPaths.defaultAccount('notion'), 'DELETE'],
  ])
    await refused(path, 503, pluginErrorCodes.unavailable, method, body)

  const disabled = createFakeCore({ autoAdvance: false, plugins: false })
  t.after(() => disabled.dispose())
  const initial = await (
    await disabled.handle(new Request(origin + '/v1/bootstrap'))
  ).json()
  assert.equal(initial.capabilities.plugins, false)
  await json('/__demo/reset', { parse: (v) => v }, 'POST', {})
  assert.equal(
    protocol.bootstrap.parse(await (await request('/v1/bootstrap')).json())
      .capabilities.plugins,
    true,
  )
})

test('the catalogue has categories, availability, an address prompt and account counts', async (t) => {
  const { json, refused, detail } = harness(t)
  const { plugins } = await json(pluginPaths.plugins, protocol.pluginList)
  assert.ok(new Set(plugins.map((p) => p.category)).size >= 3)
  const byId = Object.fromEntries(plugins.map((p) => [p.id, p]))
  assert.equal(byId.jira.available, false)
  assert.ok(byId.jira.unavailableReason)
  assert.equal(byId.sentry.needsAddress, true)
  assert.ok(byId.sentry.addressPrompt)
  assert.equal(byId.notion.accountCount, 2)
  assert.equal(byId.linear.accountCount, 0)
  assert.ok(plugins.every((p) => !('behavior' in p)))

  const notion = await detail('notion')
  assert.deepEqual(
    notion.accounts.map((a) => [a.label, a.status, a.isDefault]),
    [
      ['Work', 'working', true],
      ['Personal', 'reconnect-needed', false],
    ],
  )
  await refused(pluginPaths.plugin('missing'), 404, 'unknown-plugin')
  await refused(pluginPaths.accounts('missing'), 404, 'unknown-plugin')
  const all = await json(pluginPaths.accounts(), protocol.pluginAccountList)
  assert.equal(all.accounts.length, 2)
  const filtered = await json(
    pluginPaths.accounts('linear'),
    protocol.pluginAccountList,
  )
  assert.deepEqual(filtered.accounts, [])
})

test('a sign-in redirects to the return address, which completes it; a second one adds an account', async (t) => {
  const { request, start, signIn, detail, json } = harness(t)
  const first = await start('linear')
  assert.equal(first.status, 'redirect')
  assert.ok(Date.parse(first.expiresAt) > Date.now())
  const url = new URL(first.authorizationUrl)
  assert.equal(url.origin + url.pathname, returnAddress)
  assert.equal(url.searchParams.get('state'), first.id)
  assert.equal((await signIn(first.id)).status, 'pending')

  const page = await request(url.pathname + url.search)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /^text\/html/)
  const done = await signIn(first.id)
  assert.equal(done.status, 'completed')
  assert.equal(done.duplicate, false)
  assert.equal(done.account.label, 'Linear')
  assert.equal(done.account.isDefault, true)

  const second = await start('linear')
  await request(
    new URL(second.authorizationUrl).pathname +
      new URL(second.authorizationUrl).search,
  )
  const added = await signIn(second.id)
  assert.equal(added.account.label, 'Linear 2')
  assert.equal(added.account.isDefault, false)
  const linear = await detail('linear')
  assert.equal(linear.accountCount, 2)
  assert.deepEqual(
    linear.accounts.map((a) => a.isDefault),
    [true, false],
  )
  const list = await json(pluginPaths.plugins, protocol.pluginList)
  assert.equal(list.plugins.find((p) => p.id === 'linear').accountCount, 2)
})

test('sign-ins reconnect, deny, expire and refuse return addresses and methods like Core', async (t) => {
  const { request, refused, control, start, signIn, detail } = harness(t)
  const reconnect = await start('notion')
  await control({ signIn: reconnect.id, outcome: 'complete' })
  const reconnected = await signIn(reconnect.id)
  assert.equal(reconnected.status, 'completed')
  assert.equal(reconnected.duplicate, true)
  assert.equal(reconnected.account.id, 'acct-notion-home')
  assert.equal(reconnected.account.status, 'working')
  assert.equal((await detail('notion')).accountCount, 2)

  const denied = await start('linear')
  const url = new URL(denied.authorizationUrl)
  url.searchParams.delete('code')
  url.searchParams.set('error', 'access_denied')
  assert.equal((await request(url.pathname + url.search)).status, 400)
  const failed = await signIn(denied.id)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.code, 'denied')

  const expiring = await start('linear')
  await control({ signIn: expiring.id, outcome: 'expire' })
  assert.equal((await signIn(expiring.id)).code, 'expired')
  await refused(pluginPaths.signInStatus('missing'), 404, 'unknown-sign-in')

  const post = (pluginId, body) => [
    pluginPaths.signIn(pluginId),
    'POST',
    { version: 1, ...body },
  ]
  const refuse = async (status, code, [path, method, body]) =>
    refused(path, status, code, method, body)
  await refuse(
    400,
    pluginErrorCodes.loopbackOnly,
    post('figma', { returnAddress }),
  )
  const local = await start('figma', {
    returnAddress: `http://127.0.0.1:43120${pluginPaths.callback}`,
  })
  assert.equal(local.status, 'redirect')
  assert.equal(local.method, 'cimd')
  assert.equal(
    (await start('canva')).status,
    pluginErrorCodes.needsClientMetadataDocument,
  )
  await refuse(
    400,
    pluginErrorCodes.invalidReturnAddress,
    post('linear', { returnAddress: `${origin}/elsewhere` }),
  )
  await refuse(
    400,
    pluginErrorCodes.invalidReturnAddress,
    post('linear', {
      returnAddress: `http://demo.kipster.invalid${pluginPaths.callback}`,
    }),
  )
  await refuse(
    400,
    pluginErrorCodes.returnAddressRefused,
    post('linear', {
      returnAddress: `https://kipster.example${pluginPaths.callback}`,
    }),
  )
  await refuse(409, 'plugin-unavailable', post('jira', { returnAddress }))
  await refuse(400, 'invalid-address', post('sentry', { returnAddress }))
  await refuse(
    400,
    'invalid-address',
    post('sentry', { returnAddress, address: 'acme.sentry.io' }),
  )
  await refuse(
    400,
    'invalid-address',
    post('linear', { returnAddress, address: 'https://linear.app' }),
  )
  const addressed = await start('sentry', {
    returnAddress,
    address: 'https://acme.sentry.io/settings',
  })
  assert.equal(addressed.serverUrl, 'https://acme.sentry.io')
  await control({ signIn: addressed.id, outcome: 'complete' })
  const sentry = await signIn(addressed.id)
  assert.equal(sentry.account.label, 'acme.sentry.io')
  assert.equal(sentry.account.serverUrl, 'https://acme.sentry.io')

  const longHost = `${'a'.repeat(55)}.sentry.io`
  const labels = []
  for (let i = 0; i < 2; i++) {
    const long = await start('sentry', {
      returnAddress,
      address: `https://${longHost}`,
    })
    await control({ signIn: long.id, outcome: 'complete' })
    labels.push((await signIn(long.id)).account.label)
  }
  assert.deepEqual(labels, [
    longHost.slice(0, 64),
    `${longHost.slice(0, 62)} 2`,
  ])
})

test('accounts rename with label rules, change the default and disconnect', async (t) => {
  const { json, refused, detail } = harness(t)
  const rename = (accountId, label) =>
    json(
      pluginPaths.account(accountId),
      protocol.pluginAccountResult,
      'PATCH',
      {
        version: 1,
        label,
      },
    )
  const renamed = await rename('acct-notion-home', 'Home')
  assert.equal(renamed.account.label, 'Home')
  assert.ok(renamed.account.updatedAt)
  assert.equal((await rename('acct-notion-home', 'HOME')).account.label, 'HOME')
  for (const label of ['', 'x'.repeat(65), 'work', 'WORK'])
    await refused(
      pluginPaths.account('acct-notion-home'),
      400,
      'invalid-label',
      'PATCH',
      {
        version: 1,
        label,
      },
    )
  assert.equal(
    (await rename('acct-notion-home', 'y'.repeat(64))).account.label.length,
    64,
  )
  await refused(
    pluginPaths.account('missing'),
    404,
    'unknown-account',
    'PATCH',
    {
      version: 1,
      label: 'Fine',
    },
  )

  const setDefault = (pluginId, account) =>
    json(
      pluginPaths.defaultAccount(pluginId),
      protocol.pluginDefaultAccount,
      'PUT',
      { version: 1, account },
    )
  assert.deepEqual(await setDefault('notion', 'acct-notion-home'), {
    version: 1,
    plugin: 'notion',
    defaultAccount: 'acct-notion-home',
  })
  assert.deepEqual(
    (await detail('notion')).accounts.map((a) => a.isDefault),
    [false, true],
  )
  await refused(
    pluginPaths.defaultAccount('linear'),
    404,
    'unknown-account',
    'PUT',
    {
      version: 1,
      account: 'acct-notion-home',
    },
  )
  const cleared = await json(
    pluginPaths.defaultAccount('notion'),
    protocol.pluginDefaultAccount,
    'DELETE',
  )
  assert.equal(cleared.defaultAccount, null)
  assert.equal((await setDefault('notion', null)).defaultAccount, null)
  await setDefault('notion', 'acct-notion-home')

  const removed = await json(
    pluginPaths.account('acct-notion-home'),
    protocol.pluginAccountRemoval,
    'DELETE',
  )
  assert.deepEqual(removed, { version: 1, removed: true, revoked: false })
  const notion = await detail('notion')
  assert.equal(notion.accountCount, 1)
  assert.equal(notion.accounts[0].isDefault, true)
  await refused(
    pluginPaths.account('acct-notion-home'),
    404,
    'unknown-account',
    'DELETE',
  )
  assert.equal(
    (
      await json(
        pluginPaths.account('acct-notion-work'),
        protocol.pluginAccountRemoval,
        'DELETE',
      )
    ).revoked,
    true,
  )
  assert.equal((await detail('notion')).accounts.length, 0)
})

test('the self-running demo completes pending sign-ins on its clock', async (t) => {
  const core = createFakeCore({ tickMs: 20 })
  t.after(() => core.dispose())
  const started = protocol.pluginSignInStart.parse(
    await (
      await core.handle(
        new Request(origin + pluginPaths.signIn('linear'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, returnAddress }),
        }),
      )
    ).json(),
  )
  let status
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    status = protocol.pluginSignInStatus.parse(
      await (
        await core.handle(
          new Request(origin + pluginPaths.signInStatus(started.id)),
        )
      ).json(),
    )
    if (status.status !== 'pending') break
  }
  assert.equal(status.status, 'completed')
})

test('the app returns sign-ins to Core on its own address, and never over plain HTTP to another computer', async () => {
  const { signInReturnAddress, pluginProblem, remoteHTTPMessage } =
    await import('../src/data/plugins.ts')
  assert.equal(
    signInReturnAddress('https://kipster.tail1234.ts.net'),
    'https://kipster.tail1234.ts.net/plugins/callback',
  )
  assert.equal(
    signInReturnAddress('http://127.0.0.1:43120'),
    'http://127.0.0.1:43120/plugins/callback',
  )
  assert.equal(
    signInReturnAddress('http://localhost:43120'),
    'http://localhost:43120/plugins/callback',
  )
  assert.equal(signInReturnAddress('http://192.168.1.20:43120'), null)
  assert.equal(signInReturnAddress('http://kipster.local:43120'), null)
  for (const code of ['invalid-return-address', 'return-address-refused'])
    assert.equal(pluginProblem(code), remoteHTTPMessage)
  assert.match(pluginProblem('loopback-only'), /computer running Kipster/)
  assert.match(pluginProblem('denied'), /denied/)
  assert.match(pluginProblem('expired'), /expired/)
  assert.match(
    pluginProblem('something-new', 'Detail'),
    /Sign-in failed: Detail/,
  )
})
