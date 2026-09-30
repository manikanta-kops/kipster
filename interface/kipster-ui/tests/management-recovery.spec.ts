import { test, expect } from './demo.ts'
import { setup, manage, save, read, create } from './management-helpers.ts'

test('late create acknowledgement cannot resurrect atomic enrollment completed in another tab', async ({
  page,
  context,
}) => {
  const endpoint = await setup(page)
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  const ids: string[] = []
  await page.route('**/v1/agents', async (route) => {
    ids.push(route.request().postDataJSON().operationId)
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response })
  })
  await create(page, 'agent', 'Cross-tab recovery agent')
  await save(page)
  await expect.poll(() => committed).toBe(true)
  const second = await context.newPage()
  await setup(second, endpoint.split('/').at(-1))
  await second.route('**/v1/agents', async (route) => {
    ids.push(route.request().postDataJSON().operationId)
    await route.continue()
  })
  await manage(second)
  await second.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(
    second.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  release()
  await expect(
    page.getByRole('region', { name: 'Request recovery' }),
  ).toHaveCount(0)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(1)
  const data = await read(page, endpoint)
  const agents = data.agents.filter(
    (a: { name: string }) => a.name === 'Cross-tab recovery agent',
  )
  expect(agents).toHaveLength(1)
  expect(
    data.memberships.filter(
      (m: { agentId: string }) => m.agentId === agents[0].id,
    ),
  ).toHaveLength(1)
})

for (const enroll of [false, true]) {
  test(`concurrent stale create cannot supersede an in-flight atomic ${enroll ? 'enrollment' : 'global identity'}`, async ({
    page,
    context,
  }) => {
    const endpoint = await setup(page)
    const second = await context.newPage()
    await setup(second, endpoint.split('/').at(-1))
    await create(page, 'agent', 'Keep this global identity')
    await create(second, 'agent', 'Competing identity')
    if (!enroll) await page.getByLabel('Add to Kipster').uncheck()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let committed = false
    await page.route('**/v1/agents', async (route) => {
      const response = await route.fetch()
      committed = true
      await held
      await route.fulfill({ response })
    })
    await save(page)
    await expect.poll(() => committed).toBe(true)
    let posts = 0
    second.on('request', (r) => {
      if (r.method() === 'POST') posts++
    })
    await save(second)
    await expect(
      second.getByText('This recovery step changed in another tab.', {
        exact: false,
      }),
    ).toBeVisible()
    expect(posts).toBe(0)
    release()
    await expect(
      page.getByRole('region', { name: 'Request recovery' }),
    ).toHaveCount(0)
    const data = await read(page, endpoint)
    const agents = data.agents.filter(
      (a: { name: string }) => a.name === 'Keep this global identity',
    )
    expect(agents).toHaveLength(1)
    expect(
      data.memberships.filter(
        (m: { agentId: string }) => m.agentId === agents[0].id,
      ),
    ).toHaveLength(enroll ? 1 : 0)
    expect(
      data.agents.some(
        (a: { name: string }) => a.name === 'Competing identity',
      ),
    ).toBe(false)
  })
}

for (const enroll of [false, true]) {
  test(`rejected atomic ${enroll ? 'enrollment' : 'global create'} retains input and cannot leave a partial identity`, async ({
    page,
  }) => {
    const endpoint = await setup(page)
    await page.route('**/v1/agents', (route) =>
      route.fulfill({
        status: 404,
        json: {
          version: 1,
          code: 'not-found',
          message: 'Organization unavailable.',
        },
      }),
    )
    await create(page, 'agent', 'Keep this global identity')
    if (!enroll) await page.getByLabel('Add to Kipster').uncheck()
    await save(page)
    await expect(
      page.getByText('Request rejected', { exact: true }),
    ).toBeVisible()
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
      'Keep this global identity',
    )
    await page.reload()
    await manage(page)
    await expect(
      page.getByText('Request rejected', { exact: true }),
    ).toBeVisible()
    const data = await read(page, endpoint)
    expect(
      data.agents.some(
        (a: { name: string }) => a.name === 'Keep this global identity',
      ),
    ).toBe(false)
    await page.getByRole('button', { name: 'Return to editing' }).click()
    await expect(
      page.getByRole('button', { name: 'Create organization', exact: true }),
    ).toBeEnabled()
  })
}
