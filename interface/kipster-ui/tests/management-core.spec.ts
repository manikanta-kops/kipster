import { manage, openManagement } from './management-helpers.ts'
import { expect, test } from '@playwright/test'
import {
  coreRequest,
  createCoreManagement,
  parseCoreResult,
} from '../src/data/management-core.js'
import {
  CommandError,
  type WorkspaceCommand,
  type WorkspaceOperation,
} from '../src/data/management.js'
import { parseDirectory, type Directory } from '../src/data/directory.js'

const at = '2026-09-27T00:00:00.000Z'
const organization = (id: string) => ({
  id,
  name: id,
  description: '',
  lifecycle: 'active',
  revision: 1,
  createdAt: at,
})
const agent = (id: string, name = id) => ({
  id,
  name,
  description: '',
  lifecycle: 'active',
  admin: false,
  revision: 1,
  createdAt: at,
  deletedAt: null,
})
const membership = (id: string, organizationId: string, agentId: string) => ({
  id,
  organizationId,
  agentId,
  revision: 1,
  createdAt: at,
})
const group = (
  id: string,
  position: number,
  appearances: { membershipId: string; agentId: string }[] = [],
) => ({
  id,
  organizationId: 'org',
  name: id,
  position,
  revision: 1,
  appearances,
})
const directory: Directory = parseDirectory({
  version: 1,
  cursor: 'c1',
  organizations: [organization('org')],
  agents: [agent('a'), agent('b')],
  memberships: [membership('ma', 'org', 'a'), membership('mb', 'org', 'b')],
  groups: [
    group('g2', 1),
    group('g1', 0, [
      { membershipId: 'ma', agentId: 'a' },
      { membershipId: 'mb', agentId: 'b' },
    ]),
  ],
})
const command = (operation: WorkspaceOperation): WorkspaceCommand => ({
  installationId: 'i',
  callerId: 'owner',
  commandId: crypto.randomUUID(),
  operation,
})
const fields = { name: 'Scout', description: 'Finds sources' }

test('operations map to the administration routes with the operation ID', () => {
  const cases: [WorkspaceOperation, string, string, Record<string, unknown>][] =
    [
      [
        { type: 'organization.create', fields },
        'POST',
        '/v1/organizations',
        { name: 'Scout', description: 'Finds sources' },
      ],
      [
        {
          type: 'organization.update',
          organizationId: 'org',
          fields: { name: 'New' },
        },
        'PUT',
        '/v1/organizations/org',
        { name: 'New' },
      ],
      [
        { type: 'agent.create', fields, organizationId: 'org' },
        'POST',
        '/v1/agents',
        { name: 'Scout', description: 'Finds sources', organizationId: 'org' },
      ],
      [
        { type: 'membership.add', organizationId: 'org', agentId: 'a' },
        'POST',
        '/v1/organizations/org/memberships',
        { agentId: 'a' },
      ],
      [
        {
          type: 'membership.remove',
          organizationId: 'org',
          membershipId: 'ma',
        },
        'DELETE',
        '/v1/memberships/ma',
        {},
      ],
      [
        { type: 'group.create', organizationId: 'org', name: 'Research' },
        'POST',
        '/v1/organizations/org/groups',
        { name: 'Research' },
      ],
      [
        {
          type: 'group.rename',
          organizationId: 'org',
          groupId: 'g1',
          name: 'Writing',
        },
        'PUT',
        '/v1/groups/g1',
        { name: 'Writing' },
      ],
      [
        { type: 'group.delete', organizationId: 'org', groupId: 'g1' },
        'DELETE',
        '/v1/groups/g1',
        {},
      ],
      [
        {
          type: 'group.move',
          organizationId: 'org',
          groupId: 'g2',
          direction: 'up',
        },
        'PUT',
        '/v1/organizations/org/groups/order',
        { groupIds: ['g2', 'g1'] },
      ],
      [
        {
          type: 'appearance.add',
          organizationId: 'org',
          groupId: 'g2',
          membershipId: 'ma',
        },
        'POST',
        '/v1/groups/g2/appearances',
        { membershipId: 'ma' },
      ],
      [
        {
          type: 'appearance.remove',
          organizationId: 'org',
          groupId: 'g1',
          membershipId: 'ma',
        },
        'DELETE',
        '/v1/groups/g1/appearances/ma',
        {},
      ],
      [
        {
          type: 'appearance.move',
          organizationId: 'org',
          groupId: 'g1',
          membershipId: 'ma',
          direction: 'down',
        },
        'PUT',
        '/v1/groups/g1/appearances/order',
        { membershipIds: ['mb', 'ma'] },
      ],
    ]
  for (const [operation, method, path, body] of cases)
    expect(coreRequest(operation, 'op', directory)).toEqual({
      method,
      path,
      body: { version: 1, operationId: 'op', ...body },
    })
  // A global agent carries no organization.
  expect(
    coreRequest({ type: 'agent.create', fields }, 'op', directory).body,
  ).not.toHaveProperty('organizationId')
  // A move at an end resends the current order, so a retry still reaches its recorded result.
  expect(
    coreRequest(
      {
        type: 'group.move',
        organizationId: 'org',
        groupId: 'g1',
        direction: 'up',
      },
      'op',
      directory,
    ).body.groupIds,
  ).toEqual(['g1', 'g2'])
  expect(() =>
    coreRequest(
      {
        type: 'organization.create',
        fields: { ...fields, instructions: 'Be brief' } as typeof fields,
      },
      'op',
      directory,
    ),
  ).toThrow(CommandError)
})

test('results read only the resource ID and acknowledgement flag', () => {
  const create: WorkspaceOperation = {
    type: 'agent.create',
    fields,
    organizationId: 'org',
  }
  const result = {
    version: 2,
    operationId: 'op',
    alreadyApplied: false,
    agent: { id: 'n' },
    membership: null,
  }
  expect(parseCoreResult(create, result)).toEqual({
    resourceId: 'n',
    alreadyApplied: false,
  })
  for (const broken of [
    null,
    { ...result, agent: { id: 4 } },
    { ...result, alreadyApplied: undefined },
  ]) {
    expect(() => parseCoreResult(create, broken)).toThrow(CommandError)
  }
  expect(
    parseCoreResult(
      { type: 'group.rename', organizationId: 'org', groupId: 'g1', name: 'x' },
      { ...result, group: group('g1', 0), alreadyApplied: true },
    ),
  ).toEqual({ resourceId: 'g1', alreadyApplied: true })
})

/** A Core stand-in that records each operation ID's first result, as Core does. */
function fakeCore() {
  const agents: string[] = []
  const recorded = new Map<string, unknown>()
  let loseNext = false
  let status: { code: number; body: unknown } | null = null
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (status)
      return new Response(JSON.stringify(status.body), { status: status.code })
    const body = JSON.parse(String(init?.body)) as {
      operationId: string
      name: string
      organizationId?: string
    }
    let result = recorded.get(body.operationId) as
      Record<string, unknown> | undefined
    if (result) result = { ...result, alreadyApplied: true }
    else {
      const id = crypto.randomUUID()
      agents.push(id)
      result = {
        version: 1,
        operationId: body.operationId,
        alreadyApplied: false,
        agent: agent(id, body.name),
        membership: body.organizationId
          ? membership(crypto.randomUUID(), body.organizationId, id)
          : null,
      }
      recorded.set(body.operationId, result)
    }
    if (loseNext) {
      loseNext = false
      throw new TypeError('Load failed')
    }
    return new Response(JSON.stringify(result), { status: 200 })
  }
  return {
    fetch,
    agents,
    loseNextAcknowledgement: () => (loseNext = true),
    respond: (code: number, body: unknown) => (status = { code, body }),
  }
}

test('a lost acknowledgement resolves to the recorded result with no duplicate agent', async () => {
  const core = fakeCore()
  const original = globalThis.fetch
  globalThis.fetch = core.fetch as typeof fetch
  try {
    const management = createCoreManagement('http://core', () => directory)
    const create = command({
      type: 'agent.create',
      fields,
      organizationId: 'org',
    })
    const signal = new AbortController().signal
    core.loseNextAcknowledgement()
    const lost = await management.execute(create, signal).catch((e) => e)
    expect(lost).toBeInstanceOf(CommandError)
    expect((lost as CommandError).outcome).toBe('unknown')
    expect(core.agents).toHaveLength(1)
    const retried = await management.execute(create, signal)
    expect(retried).toMatchObject({
      commandId: create.commandId,
      status: 'acknowledged',
      resourceId: core.agents[0],
      alreadyApplied: true,
    })
    expect(core.agents).toHaveLength(1)
    // A new request is a new operation.
    const next = await management.execute(
      command({ type: 'agent.create', fields }),
      signal,
    )
    expect(next.alreadyApplied).toBe(false)
    expect(core.agents).toHaveLength(2)
  } finally {
    globalThis.fetch = original
  }
})

test('refusals are rejections; server failures and unreadable replies stay unknown', async () => {
  const core = fakeCore()
  const original = globalThis.fetch
  globalThis.fetch = core.fetch as typeof fetch
  const outcome = async (code: number, body: unknown) => {
    core.respond(code, body)
    const error = await createCoreManagement('http://core', () => directory)
      .execute(
        command({ type: 'group.create', organizationId: 'org', name: 'x' }),
        new AbortController().signal,
      )
      .then(
        () => {
          throw new Error('Expected a failure.')
        },
        (e: CommandError) => e,
      )
    return [error.outcome, error.code]
  }
  try {
    expect(await outcome(409, { code: 'conflict', message: 'x' })).toEqual([
      'rejected',
      'conflict',
    ])
    expect(await outcome(404, { code: 'not-found', message: 'x' })).toEqual([
      'rejected',
      'not-found',
    ])
    expect(await outcome(400, { code: 'invalid', message: 'x' })).toEqual([
      'rejected',
      'invalid',
    ])
    expect(await outcome(500, { code: 'unavailable', message: 'x' })).toEqual([
      'unknown',
      'unavailable',
    ])
    expect(await outcome(200, { version: 1 })).toEqual([
      'unknown',
      'invalid-result',
    ])
  } finally {
    globalThis.fetch = original
  }
})

test('configured Core: a lost acknowledgement is retried from the journal after reload', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires a disposable Core and PostgreSQL',
  )
  const core = process.env.KIPSTER_TEST_CORE_URL!
  const name = `Lost ack ${crypto.randomUUID().slice(0, 8)}`
  const count = async () =>
    (
      (await (await page.request.get(`${core}/v1/directory`)).json()) as {
        agents: { name: string }[]
      }
    ).agents.filter((a) => a.name === name).length
  let lose = true
  await page.route(`${core}/v1/agents`, async (route) => {
    if (!lose) return route.continue()
    lose = false
    await route.fetch() // Core applies the request; the browser never sees the reply.
    await route.abort('connectionreset')
  })
  await page.goto('/')
  await manage(page, 'Kips')
  await page
    .getByRole('button', { name: 'Create new kip', exact: true })
    .click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const recovery = page.getByRole('region', { name: 'Request recovery' })
  await expect(recovery.getByText('Outcome unresolved')).toBeVisible()
  expect(await count()).toBe(1)
  await page.reload()
  await openManagement(page)
  await recovery.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByText('Kip was already saved by the earlier request.'),
  ).toBeVisible()
  await expect(recovery).toHaveCount(0)
  expect(await count()).toBe(1)
})
