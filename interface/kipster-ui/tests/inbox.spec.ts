import { test, expect, startDemo, demo, storageFault } from './demo.ts'
import type { Page } from '@playwright/test'
export const openInbox = (page: Page) =>
  page.getByRole('button', { name: /^Notifications, / }).click()
const question = (page: Page) =>
  page
    .locator('.inbox-item')
    .filter({ hasText: 'Which direction would you like me to develop?' })
export async function failWork(page: Page) {
  const state = await demo(page, '/inspect')
  const thread = state.threads.find((t: any) =>
    t.work.some((w: any) => w.state === 'running'),
  )
  await demo(page, '/scenario', {
    threadId: thread.summary.threadId,
    scenario: 'failure',
  })
  await demo(page, '/advance', { threadId: thread.summary.threadId, steps: 4 })
  return thread
}
export async function desktop(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop', exact: true }).click()
}
export const driver = (page: Page) =>
  page.evaluate(() => (window as any).notificationTest)

test('opening a notification marks it read without answering a question', async ({
  page,
}) => {
  await startDemo(page)
  await openInbox(page)
  await question(page)
    .getByRole('button', { name: 'Open original context' })
    .click()
  await expect(page.locator('.interaction-card')).toBeVisible()
  const before = await demo(page, '/inspect')
  expect(before.answers).toHaveLength(0)
  await openInbox(page)
  await expect(question(page)).toHaveClass(/\bread\b/)
  const after = await demo(page, '/inspect')
  expect(after.answers).toHaveLength(0)
  expect(
    after.threads
      .flatMap((t: any) => t.interactions)
      .filter((i: any) => i.state === 'pending'),
  ).toEqual(
    before.threads
      .flatMap((t: any) => t.interactions)
      .filter((i: any) => i.state === 'pending'),
  )
})
test('read state synchronizes across tabs and survives reload', async ({
  page,
  context,
}) => {
  const session = await startDemo(page)
  await openInbox(page)
  const other = await context.newPage()
  await startDemo(other, { session })
  await openInbox(other)
  await question(page)
    .getByRole('button', { name: 'Mark read', exact: true })
    .click()
  await expect(question(other)).toHaveClass(/\bread\b/)
  await page.reload()
  await openInbox(page)
  await expect(question(page)).toHaveClass(/\bread\b/)
  await expect(page.locator('.attention-toast')).toHaveCount(0)
})
test('stable meaningful event identities deduplicate and new attempts create distinct history', async ({
  page,
}) => {
  const session = await startDemo(page)
  await expect(
    page.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  const thread = await failWork(page)
  const id = thread.summary.threadId
  let state = await demo(page, '/inspect')
  const failure = state.notifications.find(
    (n: any) => n.threadId === id && n.kind === 'failed',
  )
  expect(failure).toBeTruthy()
  await demo(page, '/advance', { threadId: id, steps: 3 })
  state = await demo(page, '/inspect')
  expect(
    state.notifications.filter(
      (n: any) => n.threadId === id && n.kind === 'failed',
    ),
  ).toHaveLength(1)
  const read = await page.request.post(
    `/__test-core/${session}/v1/notifications/${failure.id}/read`,
    { data: { version: 1 } },
  )
  expect(read.ok()).toBe(true)
  const run = state.threads
    .find((t: any) => t.summary.threadId === id)
    .work.find((w: any) => w.state === 'failed')
  const retry = await page.request.post(
    `/__test-core/${session}/v1/work/controls`,
    {
      data: {
        version: 1,
        operationId: crypto.randomUUID(),
        action: 'retry',
        context: state.chats.find((c: any) => c.id === thread.summary.chatId)
          .context,
        chatId: thread.summary.chatId,
        threadId: id,
        runId: run.runId,
        attemptId: run.attemptId,
      },
    },
  )
  expect(retry.ok()).toBe(true)
  await demo(page, '/scenario', { threadId: id, scenario: 'failure' })
  await demo(page, '/advance', { threadId: id, steps: 5 })
  state = await demo(page, '/inspect')
  expect(
    state.notifications.filter(
      (n: any) => n.threadId === id && n.kind === 'failed',
    ),
  ).toHaveLength(2)
  expect(state.notifications.find((n: any) => n.id === failure.id).read).toBe(
    true,
  )
})
test('cancelled targets cannot restore obsolete interaction actions', async ({
  page,
}) => {
  const session = await startDemo(page)
  await openInbox(page)
  const state = await demo(page, '/inspect')
  const questionThread = state.threads.find((t: any) =>
    t.interactions.some((i: any) => i.kind === 'question'),
  )
  const notice = state.notifications.find(
    (n: any) =>
      n.threadId === questionThread.summary.threadId &&
      n.kind === 'interaction',
  )
  const thread = state.threads.find(
    (t: any) => t.summary.threadId === notice.threadId,
  )
  const run = thread.work.find((w: any) => w.state === 'waiting')
  expect(
    (
      await page.request.post(`/__test-core/${session}/v1/work/controls`, {
        data: {
          version: 1,
          operationId: crypto.randomUUID(),
          action: 'stop',
          context: state.chats.find((c: any) => c.id === thread.summary.chatId)
            .context,
          chatId: thread.summary.chatId,
          threadId: notice.threadId,
          runId: run.runId,
          attemptId: run.attemptId,
        },
      })
    ).ok(),
  ).toBe(true)
  await question(page)
    .getByRole('button', { name: 'Open original context' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Send answer', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.interaction-card')).toContainText(/cancelled/i)
  expect(
    (await demo(page, '/inspect')).notifications.find(
      (n: any) => n.id === notice.id,
    ).read,
  ).toBe(true)
})
test('expired application cursor and offline return restore inbox without popup bursts', async ({
  page,
}) => {
  await startDemo(page, { notification: 'foreground' })
  await openInbox(page)
  await page.getByRole('button', { name: 'Close notifications' }).click()
  await demo(page, '/retention', {})
  await expect(
    page.getByRole('button', { name: 'Notifications, 8 unread' }),
  ).toBeVisible()
  await expect(page.locator('.attention-toast')).toHaveCount(0)
  await demo(page, '/connection', { offline: true })
  await failWork(page)
  await demo(page, '/connection', { offline: false })
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  await expect(page.locator('.attention-toast')).toHaveCount(0)
})
test('unavailable original target reports failure after opening marks the notification read', async ({
  page,
}) => {
  const session = crypto.randomUUID()
  const state = await (
    await page.request.get(`/__test-core/${session}/__demo/inspect`)
  ).json()
  const thread = state.threads.find((t: any) =>
    t.interactions.some((i: any) => i.kind === 'question'),
  )
  const notice = state.notifications.find(
    (n: any) =>
      n.threadId === thread.summary.threadId && n.kind === 'interaction',
  )
  await page.route('**/v1/threads/*/snapshot**', (route) =>
    route.fulfill({
      status: 503,
      json: {
        version: 1,
        code: 'unavailable',
        message: 'Original target unavailable',
      },
    }),
  )
  await startDemo(page, { session })
  await openInbox(page)
  await page
    .locator(`.inbox-item[data-notification-id="${notice.id}"]`)
    .getByRole('button', { name: 'Open original context' })
    .click()
  await expect(
    page.getByText(/unavailable|Deleted target/).first(),
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        (await demo(page, '/inspect')).notifications.find(
          (n: any) => n.id === notice.id,
        ).read,
    )
    .toBe(true)
})
test('settings and inbox keyboard focus at desktop and phone widths with reduced motion', async ({
  page,
}) => {
  await startDemo(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    if (width === 390)
      await page.getByRole('button', { name: 'Show sidebar' }).click()
    const settings = page.getByRole('button', {
      name: 'Settings',
      exact: true,
    })
    await settings.focus()
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('dialog', { name: 'Settings', exact: true }),
    ).toBeVisible()
    await page
      .getByRole('button', { name: 'Organization', exact: true })
      .click()
    const instructions = page.getByRole('textbox', {
      name: 'Organization instructions',
      exact: true,
    })
    const long = 'Long instructions remain usable. '.repeat(80)
    await instructions.fill(long)
    const section = page.getByRole('region', {
      name: 'Organization instructions',
      exact: true,
    })
    await expect(
      section.getByRole('button', { name: 'Save instructions' }),
    ).toBeEnabled()
    await expect(
      section.getByRole('button', { name: 'Discard changes' }),
    ).toBeEnabled()
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    expect(
      await page
        .getByRole('dialog', { name: 'Settings', exact: true })
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true)
    await section.getByRole('button', { name: 'Discard changes' }).click()
    await expect(instructions).not.toHaveValue(long)
    await page.keyboard.press('Escape')
    await expect(settings).toBeFocused()
    await openInbox(page)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.keyboard.press('Escape')
    if (width === 390) await page.keyboard.press('Escape')
  }
})
test('same-browser background tabs claim one synthetic alert and startup never requests permission', async ({
  page,
  context,
}) => {
  const session = await startDemo(page, { notification: 'background' })
  await expect(
    page.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  expect((await driver(page)).prompts).toBe(0)
  expect((await driver(page)).sends).toHaveLength(0)
  await desktop(page)
  await page
    .getByRole('button', { name: 'Enable and test notifications' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Disable desktop alerts' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  const other = await context.newPage()
  await startDemo(other, { session, notification: 'background' })
  await expect(
    other.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  await failWork(page)
  await expect
    .poll(
      async () =>
        (await driver(page)).sends.length + (await driver(other)).sends.length,
    )
    .toBe(2)
  expect((await driver(page)).prompts + (await driver(other)).prompts).toBe(0)
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  expect((await driver(page)).sends).toHaveLength(0)
})
test('foreground attention suppressed at original thread and appears away from it', async ({
  page,
}) => {
  await startDemo(page, { notification: 'foreground' })
  const state = await demo(page, '/inspect')
  const running = state.threads.find((t: any) =>
    t.work.some((w: any) => w.state === 'running'),
  )
  await page
    .getByRole('button', {
      name: `Open thread: ${running.messages[0].parts[0].text}`,
      exact: true,
    })
    .press('Enter')
  await failWork(page)
  await expect(
    page.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  await expect(page.locator('.attention-toast')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close thread' }).click()
  const queued = state.threads.find((t: any) =>
    t.work.some((w: any) => w.state === 'queued'),
  )
  await demo(page, '/scenario', {
    threadId: queued.summary.threadId,
    scenario: 'failure',
  })
  await demo(page, '/advance', { threadId: queued.summary.threadId, steps: 5 })
  await expect(page.locator('.attention-toast')).toContainText(
    'couldn’t finish',
  )
  await page
    .locator('.attention-toast')
    .getByRole('button', { name: 'Open', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  const after = await demo(page, '/inspect')
  expect(
    after.notifications.find(
      (n: any) => n.threadId === queued.summary.threadId && n.kind === 'failed',
    ).read,
  ).toBe(true)
})
test('uncertain read update retries same identity and never dispatches an interaction response', async ({
  page,
}) => {
  await startDemo(page)
  const sent: any[] = []
  await page.route('**/v1/notifications/*/read', async (route) => {
    sent.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    })
    if (sent.length === 1) await route.abort('failed')
    else await route.continue()
  })
  await openInbox(page)
  await expect(page.locator('.inbox-item[data-kind="approval"]')).toBeVisible()
  await question(page)
    .getByRole('button', { name: 'Mark read', exact: true })
    .click()
  await expect(
    page.getByText('Read update uncertain.', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry original read update' }).click()
  await expect(question(page)).toHaveClass(/\bread\b/)
  expect(sent[1]).toEqual(sent[0])
  expect((await demo(page, '/inspect')).answers).toHaveLength(0)
})
test('permission denial uses synthetic driver only and never enables background alerts', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await desktop(page)
  await page.evaluate(() => {
    ;(window as any).notificationTest.permission = 'denied'
  })
  await page
    .getByRole('button', { name: 'Enable and test notifications' })
    .click()
  await expect(
    page.getByText(
      'Desktop notifications denied. Your persistent inbox remains available.',
    ),
  ).toBeVisible()
  expect((await driver(page)).prompts).toBe(1)
  expect((await driver(page)).sends).toHaveLength(0)
  await expect(
    page.getByRole('button', { name: 'Disable desktop alerts' }),
  ).toHaveCount(0)
})

test('duplicate and stale notification events cannot regress a confirmed read or repeat history', async ({
  page,
}) => {
  const session = await startDemo(page)
  await openInbox(page)
  const before = await demo(page, '/inspect')
  const original = before.notifications.find((n: any) => n.kind === 'failed')
  await demo(page, '/notification', { notification: original })
  await demo(page, '/notification', { notification: original })
  await expect(page.locator('.inbox-item')).toHaveCount(
    before.notifications.length,
  )
  expect(
    (
      await page.request.post(
        `/__test-core/${session}/v1/notifications/${original.id}/read`,
        { data: { version: 1 } },
      )
    ).ok(),
  ).toBe(true)
  await expect(page.locator('.inbox-item[data-kind="failure"]')).toHaveClass(
    /\bread\b/,
  )
  await demo(page, '/notification', { notification: original })
  await expect(page.locator('.inbox-item[data-kind="failure"]')).toHaveClass(
    /\bread\b/,
  )
  await expect(page.locator('.inbox-item')).toHaveCount(
    before.notifications.length,
  )
  await page.reload()
  await openInbox(page)
  await expect(page.locator('.inbox-item[data-kind="failure"]')).toHaveClass(
    /\bread\b/,
  )
})

test('gone original target removes stale inbox actions without marking read', async ({
  page,
}) => {
  const session = crypto.randomUUID()
  const state = await (
    await page.request.get(`/__test-core/${session}/__demo/inspect`)
  ).json()
  const thread = state.threads.find((t: any) =>
    t.interactions.some((i: any) => i.kind === 'question'),
  )
  const notice = state.notifications.find(
    (n: any) =>
      n.threadId === thread.summary.threadId && n.kind === 'interaction',
  )
  await page.route(
    `**/v1/threads/${thread.summary.threadId}/snapshot**`,
    (route) =>
      route.fulfill({
        status: 404,
        json: { version: 1, code: 'gone', message: 'Conversation removed' },
      }),
  )
  await startDemo(page, { session })
  await expect(
    page.getByRole('button', { name: 'Notifications, 7 unread' }),
  ).toBeVisible()
  await openInbox(page)
  await expect(question(page)).toHaveCount(0)
  await expect(page.locator('.inbox-item')).toHaveCount(7)
  const after = await demo(page, '/inspect')
  expect(after.notifications.find((n: any) => n.id === notice.id).read).toBe(
    false,
  )
  expect(after.answers).toHaveLength(0)
})

test('clear all marks notifications read and preserves pending requests after reload', async ({
  page,
}) => {
  await startDemo(page)
  const before = await demo(page, '/inspect')
  await openInbox(page)
  await expect(
    page.getByText(/Saved updates for you|Inbox history is separate/),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(page.locator('.inbox-item.unread')).toHaveCount(0)
  await expect(page.locator('.inbox-item')).toHaveCount(
    before.notifications.length,
  )
  await expect(
    page.getByRole('button', { name: 'Clear all', exact: true }),
  ).toBeDisabled()
  const after = await demo(page, '/inspect')
  expect(after.answers).toHaveLength(0)
  expect(after.threads.flatMap((t: any) => t.interactions)).toEqual(
    before.threads.flatMap((t: any) => t.interactions),
  )
  await page.reload()
  await openInbox(page)
  await expect(page.locator('.inbox-item.unread')).toHaveCount(0)
  await expect(page.locator('.inbox-item')).toHaveCount(
    before.notifications.length,
  )
})

test('clear all reports storage failures and can be retried', async ({
  page,
}) => {
  await startDemo(page, { faults: { 'control-reserve': 'fail' } })
  await openInbox(page)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(page.locator('.inbox-item.unread')).toHaveCount(8)
  await expect(page.locator('.inbox-item [role="alert"]')).toHaveCount(8)
  await storageFault(page, 'control-reserve', 'allow')
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(page.locator('.inbox-item.unread')).toHaveCount(0)
})
