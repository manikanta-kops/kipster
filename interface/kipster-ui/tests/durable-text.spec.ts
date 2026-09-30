import { expect, test } from '@playwright/test'

test('configured Core stores browser threads and replies across reload', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.goto('/')
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  const root = `Browser root ${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(root)
  await page.getByRole('button', { name: 'Send message' }).first().click()
  const feed = page.locator('.feed-message').filter({ hasText: root })
  await expect(feed).toBeVisible()
  await feed.getByRole('button', { name: /^Open thread:/ }).press('Enter')
  await expect(page.getByText(`Fixture reply: ${root}`)).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Reply in this thread' })
    .fill('First follow-up')
  await page.getByRole('button', { name: 'Send message' }).last().click()
  await expect(page.getByText('Fixture reply: First follow-up')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Thread' })).toBeVisible()
  await expect(page.getByText('Fixture reply: First follow-up')).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  const second = `Independent root ${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(second)
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await expect(
    page.locator('.feed-message').filter({ hasText: second }),
  ).toBeVisible()
  await expect(
    page.locator('.feed-message').filter({ hasText: root }),
  ).toBeVisible()
  const feedText = await page.locator('.feed-message').allTextContents()
  expect(feedText.findIndex((text) => text.includes(root))).toBeLessThan(
    feedText.findIndex((text) => text.includes(second)),
  )
})

test('lost HTTP acknowledgement reconciles one saved submission', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.goto('/')
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  const root = `Lost acknowledgement ${crypto.randomUUID()}`
  let intercepted = 0
  await page.route('**/v1/text/submissions', async (route) => {
    intercepted++
    if (intercepted === 1) {
      await route.fetch()
      await route.abort('failed')
    } else await route.continue()
  })
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(root)
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await expect(
    page.locator('.feed-message').filter({ hasText: root }),
  ).toHaveCount(1)
  await page.reload()
  await expect(
    page.locator('.feed-message').filter({ hasText: root }),
  ).toHaveCount(1)
  await expect(page.getByText('Acceptance not yet confirmed')).toHaveCount(0)
  expect(intercepted).toBe(1)
})

test('oversized live reply resynchronizes to complete saved text', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires the isolated large-reply fixture',
  )
  await page.goto('/')
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  await page
    .getByRole('textbox', { name: 'Start a new thread' })
    .fill('__large_reply__')
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  const feed = page
    .locator('.feed-message')
    .filter({ hasText: '__large_reply__' })
    .last()
  await feed.getByRole('button', { name: /^Open thread:/ }).press('Enter')
  await expect
    .poll(
      async () =>
        (await page.locator('.thread-pane .message-body').last().textContent())
          ?.length ?? 0,
      { timeout: 20000 },
    )
    .toBeGreaterThan(300000)
  await page.reload()
  await expect(page.getByRole('region', { name: 'Thread' })).toBeVisible()
  await expect
    .poll(
      async () =>
        (await page.locator('.thread-pane .message-body').last().textContent())
          ?.length ?? 0,
      { timeout: 20000 },
    )
    .toBeGreaterThan(300000)
})

test('a quiet saved root recovers after one failed hydration read', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.goto('/')
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  let failed = false
  await page.route('**/v1/threads/*/snapshot*', async (route) => {
    if (!failed) {
      failed = true
      await route.abort('failed')
    } else await route.continue()
  })
  const root = `Hydration retry ${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(root)
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await expect(
    page.locator('.feed-message').filter({ hasText: root }),
  ).toBeVisible({ timeout: 15000 })
  expect(failed).toBe(true)
})

test('local outbox failure is visible and prevents an unsafe send', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.addInitScript(() => {
    for (const key of ['openCursor', 'getAll'] as const) {
      const original = IDBObjectStore.prototype[key]
      Object.defineProperty(IDBObjectStore.prototype, key, {
        value: function (this: IDBObjectStore, ...args: unknown[]) {
          if (this.name === 'outbox')
            throw new DOMException('Storage unavailable', 'UnknownError')
          return Reflect.apply(original, this, args)
        },
      })
      const originalIndex = IDBIndex.prototype[key]
      Object.defineProperty(IDBIndex.prototype, key, {
        value: function (this: IDBIndex, ...args: unknown[]) {
          if (this.objectStore.name === 'outbox')
            throw new DOMException('Storage unavailable', 'UnknownError')
          return Reflect.apply(originalIndex, this, args)
        },
      })
    }
  })
  await page.goto('/')
  await expect(
    page.getByText(
      'Local send history is unavailable. Messages cannot be sent safely.',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeDisabled()
  await expect(
    page.getByRole('button', { name: 'Send message' }).first(),
  ).toBeDisabled()
})

test('saved thread selection is isolated from a replacement installation at the same URL', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.goto('/')
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  const root = `Selection scope ${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(root)
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await page
    .locator('.feed-message')
    .filter({ hasText: root })
    .getByRole('button', { name: /^Open thread:/ })
    .press('Enter')
  await expect(page.getByRole('region', { name: 'Thread' })).toBeVisible()
  const installationId = crypto.randomUUID()
  const callerId = crypto.randomUUID()
  const rootAgentId = crypto.randomUUID()
  const chatId = crypto.randomUUID()
  await page.route('**/v1/bootstrap', (route) =>
    route.fulfill({
      json: {
        version: 1,
        installationId,
        callerId,
        rootAgentId,
        organizationId: crypto.randomUUID(),
      },
    }),
  )
  await page.route('**/v1/direct-chats', (route) =>
    route.fulfill({ json: { version: 1, chatId } }),
  )
  await page.route('**/v1/app/snapshot*', (route) =>
    route.fulfill({
      json: {
        version: 1,
        scope: { kind: 'application', installationId, callerId },
        cursor: 'replacement',
        threads: [],
        notifications: [],
        next: null,
      },
    }),
  )
  await page.route('**/v1/app/events*', (route) =>
    route.fulfill({ status: 503, json: { code: 'unavailable' } }),
  )
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'A little space to think.' }),
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Thread' })).toHaveCount(0)
})
