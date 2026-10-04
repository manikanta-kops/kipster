import { test, expect, startDemo, demo, DEMO_IDS } from './demo.ts'
import type { Page } from '@playwright/test'
export const openInbox = (page: Page) =>
  page.getByRole('button', { name: /^Notifications, / }).click()
const note = (page: Page, text: string) =>
  page.locator('.note').filter({ hasText: text })
const question = (page: Page) =>
  note(page, 'Which direction would you like me to develop?')
const bell = (page: Page, label: string) =>
  page.getByRole('button', { name: `Notifications, ${label}`, exact: true })
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
export async function notificationSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Notifications', exact: true })
    .click()
}
export const driver = (page: Page) =>
  page.evaluate(() => (window as any).notificationTest)
/** A completed notification of the agent's seeded thread. */
async function seeded(page: Page, agentId: string) {
  const state = await demo(page, '/inspect')
  const thread = state.threads.find((t: any) => t.summary.agentId === agentId)
  return state.notifications.find(
    (n: any) => n.threadId === thread.summary.threadId,
  )
}
/** Publishes a new notification like one Core would send. */
const arrive = (page: Page, base: any, patch: Record<string, unknown>) =>
  demo(page, '/notification', {
    notification: {
      ...base,
      id: crypto.randomUUID(),
      read: false,
      revision: 1,
      createdAt: new Date().toISOString(),
      ...patch,
    },
  })
const readInCore = async (page: Page, id: string) =>
  (await demo(page, '/inspect')).notifications.find((n: any) => n.id === id)
    ?.read

test('the inbox says who did what, with Needs you before Updates', async ({
  page,
}) => {
  await startDemo(page)
  await expect(bell(page, '4 need you')).toBeVisible()
  await openInbox(page)
  const inbox = page.getByRole('dialog', { name: 'Notifications' })
  await expect(inbox).toContainText('4 need you')
  const needs = inbox.getByRole('region', { name: 'Needs you' })
  const updates = inbox.getByRole('region', { name: 'Updates' })
  await expect(needs.locator('.note')).toHaveCount(4)
  await expect(updates.locator('.note')).toHaveCount(4)
  await expect(needs.locator('.note').first()).toBeVisible()
  await expect(question(page)).toContainText('Atlas needs your answer')
  await expect(question(page)).toContainText(
    '“Choose the direction for the launch story” · Kipster',
  )
  await expect(
    note(page, 'Atlas needs your approval').getByRole('button', {
      name: 'Review',
      exact: true,
    }),
  ).toBeVisible()
  await expect(note(page, 'Atlas couldn’t finish')).toContainText(
    'The demo provider stopped before completing the work.',
  )
  await expect(note(page, 'Atlas’s work was interrupted')).toContainText(
    'The handoff stopped when the backend restarted.',
  )
  await expect(
    updates.locator('.note').filter({ hasText: 'Kip replied' }),
  ).toBeVisible()
  await expect(page.getByText(/finished “|asks: /)).toHaveCount(0)
})

test('opening a notification opens its thread and marks it read without answering', async ({
  page,
}) => {
  await startDemo(page)
  await openInbox(page)
  const id = await question(page).getAttribute('data-notification-id')
  await question(page)
    .getByRole('button', { name: 'Answer', exact: true })
    .click()
  await expect(page.locator('.interaction-card')).toBeVisible()
  await expect.poll(() => readInCore(page, id!)).toBe(true)
  expect((await demo(page, '/inspect')).answers).toHaveLength(0)
  await openInbox(page)
  await expect(
    page
      .getByRole('region', { name: 'Needs you' })
      .locator(`.note[data-notification-id="${id}"]`),
  ).toBeVisible()
  await expect(bell(page, '3 need you')).toHaveCount(0)
})

test('mark all read synchronizes across tabs, survives reload and keeps questions waiting', async ({
  page,
  context,
}) => {
  const session = await startDemo(page)
  const other = await context.newPage()
  await startDemo(other, { session })
  await openInbox(page)
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click()
  await expect(bell(other, '2 need you')).toBeVisible()
  await expect(page.locator('.note .udot')).toHaveCount(0)
  await expect(
    page.getByRole('region', { name: 'Needs you' }).locator('.note'),
  ).toHaveCount(2)
  await page.reload()
  await expect(bell(page, '2 need you')).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  const state = await demo(page, '/inspect')
  expect(state.notifications.every((n: any) => n.read)).toBe(true)
  expect(state.answers).toHaveLength(0)
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
  const state = await demo(page, '/inspect')
  const questionThread = state.threads.find((t: any) =>
    t.interactions.some((i: any) => i.kind === 'question'),
  )
  const notice = state.notifications.find(
    (n: any) =>
      n.threadId === questionThread.summary.threadId &&
      n.kind === 'interaction',
  )
  const run = questionThread.work.find((w: any) => w.state === 'waiting')
  expect(
    (
      await page.request.post(`/__test-core/${session}/v1/work/controls`, {
        data: {
          version: 1,
          operationId: crypto.randomUUID(),
          action: 'stop',
          context: state.chats.find(
            (c: any) => c.id === questionThread.summary.chatId,
          ).context,
          chatId: questionThread.summary.chatId,
          threadId: notice.threadId,
          runId: run.runId,
          attemptId: run.attemptId,
        },
      })
    ).ok(),
  ).toBe(true)
  await openInbox(page)
  const row = page.locator(`.note[data-notification-id="${notice.id}"]`)
  await expect(row).toContainText('Atlas asked a question')
  await expect(
    row.getByRole('button', { name: 'Answer', exact: true }),
  ).toHaveCount(0)
  await row.locator('.note-open').click()
  await expect(
    page.getByRole('button', { name: 'Send answer', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.interaction-card')).toContainText(/cancelled/i)
  await expect.poll(() => readInCore(page, notice.id)).toBe(true)
})

test('expired application cursor and offline return restore inbox without popup bursts', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await demo(page, '/retention', {})
  await expect(bell(page, '4 need you')).toBeVisible()
  await demo(page, '/connection', { offline: true })
  await failWork(page)
  await demo(page, '/connection', { offline: false })
  await page.reload()
  await expect(bell(page, '5 need you')).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  expect((await driver(page)).sends).toHaveLength(0)
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
    .locator(`.note[data-notification-id="${notice.id}"] .note-open`)
    .click()
  await expect(
    page.getByText(/unavailable|Deleted target/).first(),
  ).toBeVisible()
  await expect.poll(() => readInCore(page, notice.id)).toBe(true)
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
    await page.getByRole('button', { name: /^Instructions/ }).click()
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

test('background tabs send one system notification and permission is asked once', async ({
  page,
  context,
}) => {
  const session = await startDemo(page, { notification: 'background' })
  await expect.poll(async () => (await driver(page)).prompts).toBe(1)
  const other = await context.newPage()
  await startDemo(other, { session, notification: 'background' })
  await expect(
    other.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  const thread = await failWork(page)
  await expect
    .poll(
      async () =>
        (await driver(page)).sends.length + (await driver(other)).sends.length,
    )
    .toBe(1)
  const [sent] = [...(await driver(page)).sends, ...(await driver(other)).sends]
  expect(sent).toMatchObject({
    title: 'Atlas couldn’t finish',
    subtitle: 'Bring the research findings into focus',
    body: 'The demo provider stopped before completing the work.',
    threadId: thread.summary.threadId,
  })
  expect((await driver(other)).prompts).toBe(0)
  await page.reload()
  await expect(bell(page, '5 need you')).toBeVisible()
  expect((await driver(page)).sends).toHaveLength(0)
  expect((await driver(page)).prompts).toBe(0)
})

test('kinds and the master switch turned off are not sent as system notifications', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await notificationSettings(page)
  await page.getByRole('switch', { name: /^Failures/ }).uncheck()
  await page.getByRole('button', { name: 'Close settings' }).click()
  const mira = await seeded(page, DEMO_IDS.designer)
  await arrive(page, mira, { kind: 'failed', preview: 'Stopped.' })
  await arrive(page, mira, { preview: 'All done.' })
  await expect.poll(async () => (await driver(page)).sends.length).toBe(1)
  expect((await driver(page)).sends[0]).toMatchObject({
    title: 'Mira replied',
    body: 'All done.',
  })
  await notificationSettings(page)
  await page.getByRole('switch', { name: /^Allow notifications/ }).uncheck()
  await page.getByRole('button', { name: 'Close settings' }).click()
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([key]) => key.startsWith('kipster:desktop-notifications:'))
        .map(([, value]) => value),
    ),
  ).toEqual(['disabled'])
  await arrive(page, mira, { preview: 'Another reply.' })
  await expect(
    page.locator('.note').filter({ hasText: 'Another reply.' }),
  ).toHaveCount(0)
  await openInbox(page)
  await expect(note(page, 'Another reply.')).toBeVisible()
  await page.waitForTimeout(500)
  expect((await driver(page)).sends).toHaveLength(1)
})

test('the open thread is read on sight, including arrivals while you watch', async ({
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
  await expect
    .poll(
      async () =>
        (await demo(page, '/inspect')).notifications.find(
          (n: any) =>
            n.threadId === running.summary.threadId && n.kind === 'failed',
        )?.read,
    )
    .toBe(true)
  await expect(bell(page, '4 need you')).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  expect((await driver(page)).sends).toHaveLength(0)
})

test('banners are off by default and show for other threads when turned on', async ({
  page,
}) => {
  await startDemo(page, { notification: 'foreground' })
  const mira = await seeded(page, DEMO_IDS.designer)
  const rowan = await seeded(page, DEMO_IDS.engineer)
  await arrive(page, mira, { kind: 'failed', preview: 'First failure.' })
  await expect(bell(page, '5 need you')).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  await notificationSettings(page)
  await page.getByRole('switch', { name: /^In-app banners/ }).check()
  await page.getByRole('button', { name: 'Close settings' }).click()
  await arrive(page, rowan, { preview: 'Rowan’s plan is ready.' })
  const reply = page.locator('.banner').filter({ hasText: 'Rowan · Replied' })
  await expect(reply).toContainText('Rowan’s plan is ready.')
  for (const text of ['Second', 'Third', 'Fourth'])
    await arrive(page, mira, { kind: 'failed', preview: `${text} failure.` })
  await expect(page.locator('.banner')).toHaveCount(3)
  await expect(reply).toHaveCount(0)
  const failure = page.locator('.banner').filter({ hasText: 'Fourth failure.' })
  await expect(failure).toContainText('Mira · Couldn’t finish')
  await page.waitForTimeout(6500)
  await expect(page.locator('.banner')).toHaveCount(3)
  await failure.locator('.banner-open').click()
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  await expect
    .poll(async () =>
      (await demo(page, '/inspect')).notifications
        .filter((n: any) => n.threadId === mira.threadId)
        .every((n: any) => n.read),
    )
    .toBe(true)
})

test('reply banners hide on their own', async ({ page }) => {
  await startDemo(page, { notification: 'foreground' })
  await page.evaluate(() =>
    localStorage.setItem('kipster:notifications.banners', 'on'),
  )
  await arrive(page, await seeded(page, DEMO_IDS.engineer), {
    preview: 'Done for now.',
  })
  await expect(page.locator('.banner')).toContainText('Done for now.')
  await expect(page.locator('.banner')).toHaveCount(0, { timeout: 10000 })
})

test('clicking a system notification opens its thread and marks it read', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  const mira = await seeded(page, DEMO_IDS.designer)
  await page.evaluate(
    (threadId) => (window as any).notificationTest.open({ threadId }),
    mira.threadId,
  )
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Mira', exact: true }),
  ).toBeVisible()
  await expect.poll(() => readInCore(page, mira.id)).toBe(true)
})

test('the Dock badge counts what needs you and can be turned off', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await expect.poll(async () => (await driver(page)).badges.at(-1)).toBe(4)
  await openInbox(page)
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click()
  await expect.poll(async () => (await driver(page)).badges.at(-1)).toBe(2)
  await page.keyboard.press('Escape')
  await notificationSettings(page)
  await page.getByRole('switch', { name: /^Dock badge/ }).uncheck()
  await expect.poll(async () => (await driver(page)).badges.at(-1)).toBe(0)
})

test('clear all removes everything except unanswered questions', async ({
  page,
}) => {
  await startDemo(page)
  await openInbox(page)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(page.locator('.note')).toHaveCount(2)
  await expect(
    page.getByRole('region', { name: 'Needs you' }).locator('.note'),
  ).toHaveCount(2)
  await expect(page.locator('.note .clear-x')).toHaveCount(0)
  const state = await demo(page, '/inspect')
  expect(state.notifications).toHaveLength(2)
  expect(
    state.notifications.every(
      (n: any) => n.read && n.interactionState === 'pending',
    ),
  ).toBe(true)
  expect(state.answers).toHaveLength(0)
  await page.reload()
  await expect(bell(page, '2 need you')).toBeVisible()
  await openInbox(page)
  await expect(page.locator('.note')).toHaveCount(2)
})

test('an Updates row groups its thread and clears it in one go', async ({
  page,
}) => {
  await startDemo(page)
  const mira = await seeded(page, DEMO_IDS.designer)
  await arrive(page, mira, { preview: 'A second pass is ready.' })
  await openInbox(page)
  const updates = page.getByRole('region', { name: 'Updates' })
  await expect(updates.locator('.note')).toHaveCount(4)
  const row = updates.locator('.note').filter({ hasText: 'Mira replied' })
  await expect(row).toContainText('A second pass is ready.')
  await expect(row).toContainText('Design studio · 2 updates')
  await row.hover()
  await row.getByRole('button', { name: 'Clear: Mira replied' }).click()
  await expect(row).toHaveCount(0)
  await expect
    .poll(async () =>
      (await demo(page, '/inspect')).notifications.some(
        (n: any) => n.threadId === mira.threadId,
      ),
    )
    .toBe(false)
  await expect(page.getByText('You’re all caught up')).toHaveCount(0)
})

test('without batch actions, Clear is hidden and reads go one by one', async ({
  page,
}) => {
  await page.route('**/v1/bootstrap', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    delete body.capabilities.notificationActions
    await route.fulfill({ response, json: body })
  })
  const single: string[] = []
  const batch: string[] = []
  page.on('request', (r) => {
    if (/\/v1\/notifications\/[^/]+\/read$/.test(r.url())) single.push(r.url())
    if (/\/v1\/notifications\/(read|clear)$/.test(r.url())) batch.push(r.url())
  })
  await startDemo(page)
  await openInbox(page)
  await expect(
    page.getByRole('button', { name: 'Mark all read', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Clear all', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.note .clear-x')).toHaveCount(0)
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click()
  await expect
    .poll(async () =>
      (await demo(page, '/inspect')).notifications.every((n: any) => n.read),
    )
    .toBe(true)
  expect(single).toHaveLength(8)
  expect(batch).toHaveLength(0)
})

test('a failed read is sent again and never answers a question', async ({
  page,
}) => {
  await startDemo(page)
  let attempts = 0
  await page.route('**/v1/notifications/read', async (route) => {
    attempts++
    if (attempts === 1) await route.abort('failed')
    else await route.continue()
  })
  await openInbox(page)
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click()
  await expect
    .poll(async () =>
      (await demo(page, '/inspect')).notifications.every((n: any) => n.read),
    )
    .toBe(true)
  expect(attempts).toBe(2)
  expect((await demo(page, '/inspect')).answers).toHaveLength(0)
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
  await expect(page.locator('.note')).toHaveCount(before.notifications.length)
  expect(
    (
      await page.request.post(
        `/__test-core/${session}/v1/notifications/${original.id}/read`,
        { data: { version: 1 } },
      )
    ).ok(),
  ).toBe(true)
  const failure = page
    .getByRole('region', { name: 'Updates' })
    .locator('.note[data-kind="failure"]')
  await expect(failure).toHaveClass(/\bread\b/)
  await demo(page, '/notification', { notification: original })
  await expect(failure).toHaveClass(/\bread\b/)
  await expect(page.locator('.note')).toHaveCount(before.notifications.length)
  await page.reload()
  await openInbox(page)
  await expect(failure).toHaveClass(/\bread\b/)
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
  await expect(bell(page, '3 need you')).toBeVisible()
  await openInbox(page)
  await expect(question(page)).toHaveCount(0)
  await expect(page.locator('.note')).toHaveCount(7)
  const after = await demo(page, '/inspect')
  expect(after.notifications.find((n: any) => n.id === notice.id).read).toBe(
    false,
  )
  expect(after.answers).toHaveLength(0)
})
