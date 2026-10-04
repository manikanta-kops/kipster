import { test, expect, demo } from './demo.ts'
import {
  managementDialog,
  setup,
  manage,
  close,
  save,
  read,
  create,
} from './management-helpers.ts'
import { DEMO_IDS as ids } from '../src/fake-core/admin.ts'

const refusal = {
  version: 1,
  code: 'invalid',
  message: 'Rejected test operation.',
}

test('organization create and partial edit survive read-after-write and reload', async ({
  page,
}) => {
  const endpoint = await setup(page)
  await create(page, 'organization', 'Quiet Lab')
  await page.getByLabel('Description').fill('A place to explore')
  await save(page)
  await expect(
    page.getByText('Organization saved.', { exact: true }),
  ).toBeVisible()
  const created = (await read(page, endpoint)).organizations.find(
    (o: { name: string }) => o.name === 'Quiet Lab',
  )
  await close(page)
  await page
    .getByRole('combobox', { name: 'Organization', exact: true })
    .selectOption(created.id)
  await manage(page)
  await page.getByRole('button', { name: 'Edit organization' }).click()
  await page.getByLabel('Description').fill('Updated purpose')
  const request = page.waitForRequest(
    (r) =>
      r.method() === 'PUT' &&
      r.url().endsWith('/v1/organizations/' + created.id),
  )
  await save(page)
  expect((await request).postDataJSON()).toEqual({
    version: 1,
    operationId: expect.any(String),
    description: 'Updated purpose',
  })
  await expect(
    page.getByText('Organization saved.', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await manage(page)
  await expect(page.getByText('Updated purpose', { exact: true })).toBeVisible()
  expect(
    (await read(page, endpoint)).organizations.find(
      (o: { id: string }) => o.id === created.id,
    ).name,
  ).toBe('Quiet Lab')
})

test('global catalog includes unassigned duplicate names and memberships deduplicate', async ({
  page,
}) => {
  const endpoint = await setup(page)
  const response = await page.request.post(endpoint + '/v1/agents', {
    data: { version: 1, operationId: crypto.randomUUID(), name: 'Atlas' },
  })
  const { agent } = await response.json()
  await manage(page, 'Kips')
  await expect(
    page.getByText('No organization memberships', { exact: true }).last(),
  ).toBeVisible()
  const row = page
    .locator('.management-row')
    .filter({ hasText: 'No organization memberships' })
    .filter({ hasText: 'Atlas' })
  await row.getByRole('button').click()
  await expect(
    page.getByText('Membership saved.', { exact: true }),
  ).toBeVisible()
  const data = await read(page, endpoint)
  expect(
    data.memberships.filter(
      (m: { agentId: string; organizationId: string }) =>
        m.agentId === agent.id && m.organizationId === ids.organization,
    ),
  ).toHaveLength(1)
  await close(page)
  await page
    .getByRole('button', { name: `Atlas (${agent.id})`, exact: true })
    .click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await expect(page.locator('.feed-message')).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole('button', { name: `Atlas (${agent.id})`, exact: true }),
  ).toHaveAttribute('aria-current', 'page')
})

test('create and enroll is atomic and rejected enrollment creates no global identity', async ({
  page,
}) => {
  const endpoint = await setup(page)
  await page.route('**/v1/agents', (route) =>
    route.fulfill({ status: 400, json: refusal }),
  )
  await create(page, 'agent', 'Juniper')
  await save(page)
  await expect(
    page.getByText('Request rejected', { exact: true }),
  ).toBeVisible()
  expect(
    (await read(page, endpoint)).agents.filter(
      (a: { name: string }) => a.name === 'Juniper',
    ),
  ).toHaveLength(0)
  await page.getByRole('button', { name: 'Return to editing' }).click()
  await page.unroute('**/v1/agents')
  await save(page)
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  await expect(page.getByText('Kip saved.', { exact: true })).toBeVisible()
  const state = await read(page, endpoint)
  const agents = state.agents.filter(
    (a: { name: string }) => a.name === 'Juniper',
  )
  expect(agents).toHaveLength(1)
  expect(
    state.memberships.filter(
      (m: { agentId: string }) => m.agentId === agents[0].id,
    ),
  ).toHaveLength(1)
  await page.reload()
  expect(
    (await read(page, endpoint)).agents.filter(
      (a: { name: string }) => a.name === 'Juniper',
    ),
  ).toHaveLength(1)
})

test('uncertain create survives reload and exact-ID retry never duplicates it', async ({
  page,
}) => {
  const endpoint = await setup(page)
  const bodies: unknown[] = []
  await page.route('**/v1/agents', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fetch()
    await route.abort()
  })
  await create(page, 'agent', 'Uncertain agent')
  await page.getByLabel('Add to Kipster').uncheck()
  await save(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Uncertain agent',
  )
  await page.reload()
  await manage(page)
  await page.unroute('**/v1/agents')
  await page.route('**/v1/agents', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.continue()
  })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(
    (await read(page, endpoint)).agents.filter(
      (a: { name: string }) => a.name === 'Uncertain agent',
    ),
  ).toHaveLength(1)
})

test('unavailable retry remains unresolved and prevents a new create', async ({
  page,
}) => {
  await setup(page)
  await page.route('**/v1/organizations', (route) => route.abort())
  await create(page, 'organization', 'Unknown org')
  await save(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled()
  await page.reload()
  await manage(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Create organization', exact: true }),
  ).toBeDisabled()
})

test('rejected edit keeps input and pending command retains its original organization', async ({
  page,
}) => {
  const endpoint = await setup(page)
  await manage(page)
  await page.getByRole('button', { name: 'Edit organization' }).click()
  const name = page.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue('Kipster')
  await name.selectText()
  await name.pressSequentially('Captured target')
  await expect(name).toHaveValue('Captured target')
  await page.route('**/v1/organizations/*', (route) =>
    route.fulfill({ status: 400, json: refusal }),
  )
  await save(page)
  await expect(
    page.getByText('Request rejected', { exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Captured target',
  )
  await page.getByRole('button', { name: 'Return to editing' }).click()
  await page.unroute('**/v1/organizations/*')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/v1/organizations/*', async (route) => {
    await held
    await route.continue()
  })
  await save(page)
  await expect(
    page.getByText('Waiting for acknowledgement…', { exact: true }),
  ).toBeVisible()
  await close(page)
  await page
    .getByRole('combobox', { name: 'Organization', exact: true })
    .selectOption(ids.studio)
  release()
  await expect
    .poll(
      async () =>
        (await read(page, endpoint)).organizations.find(
          (o: { id: string }) => o.id === ids.organization,
        ).name,
    )
    .toBe('Captured target')
  await expect(
    page.getByRole('combobox', { name: 'Organization', exact: true }),
  ).toHaveValue(ids.studio)
  expect(
    (await read(page, endpoint)).organizations.find(
      (o: { id: string }) => o.id === ids.studio,
    ).name,
  ).toBe('Design studio')
})

test('membership removal preserves global identity, other membership and contributions', async ({
  page,
}) => {
  const endpoint = await setup(page)
  await manage(page, 'Kips')
  await page
    .getByRole('button', { name: 'Remove membership', exact: true })
    .first()
    .click()
  await expect(
    page.getByText('Work that was already accepted may still finish.', {
      exact: false,
    }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Confirm remove membership' }).click()
  await expect(
    page.getByText('Remove membership saved.', { exact: true }),
  ).toBeVisible()
  const data = await read(page, endpoint)
  expect(data.agents.some((a: { id: string }) => a.id === ids.researcher)).toBe(
    true,
  )
  expect(
    data.memberships.some(
      (m: { agentId: string; organizationId: string }) =>
        m.agentId === ids.researcher && m.organizationId === ids.studio,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'Add Atlas', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Add Atlas', exact: true }),
  ).toBeDisabled()
  await close(page)
  await page
    .getByRole('region', { name: 'Ungrouped', exact: true })
    .getByRole('button', { name: 'Atlas', exact: true })
    .click()
  await expect(page.locator('.feed-message').first()).toBeVisible()
})

test('visual groups create rename order appearances and delete only grouping', async ({
  page,
}) => {
  const endpoint = await setup(page)
  const before = await read(page, endpoint)
  const membership = (agentId: string) =>
    before.memberships.find(
      (m: { agentId: string; organizationId: string }) =>
        m.agentId === agentId && m.organizationId === ids.organization,
    ).id
  await manage(page, 'Groups')
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('Favorites')
  await save(page)
  for (const agent of [ids.researcher, ids.designer]) {
    await page
      .getByRole('combobox', { name: 'Add kip to Favorites' })
      .selectOption(membership(agent))
    await expect(
      page.getByText('Appearance saved.', { exact: true }),
    ).toBeVisible()
  }
  await page.getByRole('button', { name: 'Move Mira up in Favorites' }).click()
  await expect(
    page.getByRole('button', { name: 'Move Mira up in Favorites' }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Move Favorites up', exact: true })
    .click()
  await expect(
    page.getByText('Group order saved.', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('region', { name: 'Manage Favorites' })
    .getByRole('button', { name: 'Rename', exact: true })
    .click()
  await page.getByLabel('Group name').fill('Priority')
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(
    page.getByRole('region', { name: 'Manage Priority' }),
  ).toBeVisible()
  await page.reload()
  await manage(page, 'Groups')
  await page
    .getByRole('region', { name: 'Manage Priority' })
    .getByRole('button', { name: 'Remove from group' })
    .first()
    .click()
  await expect(
    page.getByText('Appearance removal saved.', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('region', { name: 'Manage Delivery' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click()
  await page.getByRole('button', { name: 'Confirm delete group' }).click()
  await expect(
    page.getByRole('region', { name: 'Manage Delivery' }),
  ).toHaveCount(0)
  expect(
    (await read(page, endpoint)).memberships.some(
      (m: { agentId: string }) => m.agentId === ids.engineer,
    ),
  ).toBe(true)
  await close(page)
  await expect(
    page
      .getByRole('region', { name: 'Ungrouped', exact: true })
      .getByRole('button', { name: 'Rowan', exact: true }),
  ).toBeVisible()
})

test('management dialog traps focus, Escape returns it, narrow dark and reduced motion fit', async ({
  page,
}, info) => {
  await setup(page)
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await manage(page, 'Kips')
  await page.getByRole('button', { name: 'Create new kip' }).click()
  await expect(page.getByLabel('Name', { exact: true })).toBeFocused()
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('dialog')),
    ).toBe(true)
  }
  expect(
    await managementDialog(page).evaluate(
      (el) => el.scrollWidth <= el.clientWidth,
    ),
  ).toBe(true)
  await page.screenshot({ path: info.outputPath('management-narrow-dark.png') })
  await page.keyboard.press('Escape')
  await expect(managementDialog(page)).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /^Manage kips and groups…/ }),
  ).toBeFocused()
})

test('journal write failure prevents dispatch and keeps input while navigation works', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === 'kipster-management')
        throw new Error('Storage full')
      return put.apply(this, args)
    }
  })
  const endpoint = await setup(page)
  let posts = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/v1/organizations'))
      posts++
  })
  await create(page, 'organization', 'Retained input')
  await save(page)
  await expect(
    page.getByText('Could not save recovery information.', { exact: false }),
  ).toBeVisible()
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
    'Retained input',
  )
  expect(posts).toBe(0)
  expect(
    (await read(page, endpoint)).organizations.some(
      (o: { name: string }) => o.name === 'Retained input',
    ),
  ).toBe(false)
  await close(page)
  await page
    .getByRole('combobox', { name: 'Organization', exact: true })
    .selectOption(ids.studio)
  await expect(
    page.getByRole('combobox', { name: 'Organization', exact: true }),
  ).toHaveValue(ids.studio)
})

test('late acknowledgement fetches current state and cannot regress another client save', async ({
  page,
}) => {
  const endpoint = await setup(page)
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/organizations/*', async (route) => {
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response })
  })
  await manage(page)
  await page.getByRole('button', { name: 'Edit organization' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Earlier save')
  await save(page)
  await expect.poll(() => committed).toBe(true)
  await expect(
    page.getByRole('button', { name: 'Saving…', exact: true }),
  ).toBeDisabled()
  const response = await page.request.put(
    endpoint + '/v1/organizations/' + ids.organization,
    {
      data: {
        version: 1,
        operationId: crypto.randomUUID(),
        name: 'Latest save',
      },
    },
  )
  expect(response.ok()).toBe(true)
  release()
  await expect(
    page.getByRole('heading', { name: 'Latest save', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Earlier save', exact: true }),
  ).toHaveCount(0)
})

test('connection switch isolates pending writes and journal is recoverable on return', async ({
  page,
}) => {
  const endpoint = await setup(page)
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/organizations', async (route) => {
    await route.fetch()
    committed = true
    await held
    await route.abort().catch(() => {})
  })
  await create(page, 'organization', 'Connection A only')
  await save(page)
  await expect.poll(() => committed).toBe(true)
  const otherEndpoint = await setup(page)
  release()
  await manage(page)
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  expect(
    (await read(page, otherEndpoint)).organizations.some(
      (o: { name: string }) => o.name === 'Connection A only',
    ),
  ).toBe(false)
  await page.unroute('**/v1/organizations')
  await setup(page, endpoint.split('/').at(-1))
  await manage(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  expect(
    (await read(page, endpoint)).organizations.filter(
      (o: { name: string }) => o.name === 'Connection A only',
    ),
  ).toHaveLength(1)
})

test('caller change hides old recovery and returning caller recovers the original request', async ({
  page,
}) => {
  const endpoint = await setup(page)
  await page.route('**/v1/organizations', async (route) => {
    await route.fetch()
    await route.abort()
  })
  await create(page, 'organization', 'Owner request')
  await save(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await demo(page, '/identity', { callerId: crypto.randomUUID() })
  await page.reload()
  await manage(page)
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  await demo(page, '/identity', { callerId: ids.caller })
  await page.unroute('**/v1/organizations')
  await page.reload()
  await manage(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  expect(
    (await read(page, endpoint)).organizations.filter(
      (o: { name: string }) => o.name === 'Owner request',
    ),
  ).toHaveLength(1)
})

test('failed ordering preserves canonical order and retries only after definite rejection', async ({
  page,
}) => {
  const endpoint = await setup(page)
  const order = async () =>
    (await read(page, endpoint)).groups
      .filter(
        (g: { organizationId: string }) =>
          g.organizationId === ids.organization,
      )
      .sort(
        (a: { position: number }, b: { position: number }) =>
          a.position - b.position,
      )
      .map((g: { name: string }) => g.name)
  await page.route('**/v1/organizations/*/groups/order', (route) =>
    route.fulfill({ status: 400, json: refusal }),
  )
  await manage(page, 'Groups')
  await page
    .getByRole('button', { name: 'Move Research down', exact: true })
    .click()
  await expect(
    page.getByText('Request rejected', { exact: true }),
  ).toBeVisible()
  expect(await order()).toEqual(['Research', 'Delivery'])
  await page.getByRole('button', { name: 'Return to editing' }).click()
  await page.unroute('**/v1/organizations/*/groups/order')
  await page
    .getByRole('button', { name: 'Move Research down', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Move Research down', exact: true }),
  ).toBeDisabled()
  await expect.poll(order).toEqual(['Delivery', 'Research'])
  await expect(
    page.getByRole('button', { name: 'Move Research up', exact: true }),
  ).toBeEnabled()
})

test('global discovery searches current directory identities and empty search remains usable', async ({
  page,
}, info) => {
  await setup(page)
  await manage(page, 'Kips')
  await expect(
    page.getByRole('button', { name: 'Add Rowan', exact: true }),
  ).toBeVisible()
  await page.getByLabel('Find a global kip').fill('No such identity')
  await expect(page.getByText('No kips match this search.')).toBeVisible()
  await page.screenshot({ path: info.outputPath('catalog-empty-light.png') })
  await page.getByLabel('Find a global kip').fill(ids.engineer)
  await expect(
    page.getByRole('button', { name: 'Add Rowan', exact: true }),
  ).toBeVisible()
})

test('another tab cannot overwrite an unresolved create journal', async ({
  page,
  context,
}) => {
  const endpoint = await setup(page)
  const other = await context.newPage()
  await setup(other, endpoint.split('/').at(-1))
  await create(page, 'organization', 'First request')
  await create(other, 'organization', 'Second request')
  await page.route('**/v1/organizations', async (route) => {
    await route.fetch()
    await route.abort()
  })
  await save(page)
  await expect(
    page.getByText('Outcome unresolved', { exact: true }),
  ).toBeVisible()
  let posts = 0
  other.on('request', (req) => {
    if (req.method() === 'POST') posts++
  })
  await save(other)
  await expect(
    other.getByText('This recovery step changed in another tab.', {
      exact: false,
    }),
  ).toBeVisible()
  expect(posts).toBe(0)
  await other.reload()
  await manage(other)
  await other.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    other.getByText('Organization was already saved by the earlier request.', {
      exact: true,
    }),
  ).toBeVisible()
  const data = await read(other, endpoint)
  expect(
    data.organizations.filter(
      (o: { name: string }) => o.name === 'First request',
    ),
  ).toHaveLength(1)
  expect(
    data.organizations.some(
      (o: { name: string }) => o.name === 'Second request',
    ),
  ).toBe(false)
})

test('root admin stays an installation shortcut separate from organization conversations', async ({
  page,
}) => {
  await setup(page)
  const composer = page.getByRole('textbox', { name: 'Start a new thread' })
  await composer.fill('Organization conversation')
  await composer.press('Enter')
  await expect(
    page
      .locator('.feed')
      .getByText('Organization conversation', { exact: true }),
  ).toBeVisible()
  await manage(page, 'Kips')
  await expect(
    page.getByRole('button', { name: 'Add Kip', exact: true }),
  ).toHaveCount(0)
  await close(page)
  await page
    .locator('.installation-agents')
    .getByRole('button', { name: 'Kip', exact: true })
    .click()
  await expect(
    page
      .locator('.feed')
      .getByText('Organization conversation', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: 'Kip', exact: true }),
  ).toBeVisible()
  await expect(composer).toBeVisible()
})
