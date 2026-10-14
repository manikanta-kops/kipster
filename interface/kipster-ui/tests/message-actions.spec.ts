import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { startDemo, demo, switchTheme } from './demo.ts'

const title = 'Shape a calmer workspace for the next release'
const sentAt = '2026-03-04T09:58:00.000Z'
const finishedAt = '2026-03-04T10:07:00.000Z'
const markdown = [
  '## Release plan\n\nShip the **calmer** workspace first.',
  '```ts\nconst calm = true\n```',
]

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

type Thread = {
  summary: { threadId: string; agentId: string }
  messages: { parts: { text?: string }[] }[]
}

/** Opens the seeded thread and adds a kip reply and a person's reply with known times. */
async function setup(page: Page) {
  await startDemo(page)
  const snapshot = await demo(page, '/inspect')
  const thread = snapshot.threads.find(
    (item: Thread) => item.messages[0].parts[0].text === title,
  ) as Thread
  await page
    .getByRole('button', { name: `Open thread: ${title}`, exact: true })
    .click()
  const pane = page.getByRole('region', {
    name: `Thread: ${title}`,
    exact: true,
  })
  let position = thread.messages.length
  const add = async (message: Record<string, unknown>) =>
    demo(page, '/message', {
      threadId: thread.summary.threadId,
      message: {
        id: crypto.randomUUID(),
        threadId: thread.summary.threadId,
        position: ++position,
        revision: 1,
        final: true,
        ...message,
      },
    })
  await add({
    authorId: snapshot.ids.caller,
    createdAt: sentAt,
    finishedAt,
    parts: [{ kind: 'text', text: 'A person asks for the plan.' }],
  })
  await add({
    authorId: thread.summary.agentId,
    createdAt: sentAt,
    finishedAt,
    parts: markdown.map((text) => ({ kind: 'text', text })),
  })
  const person = pane
    .locator('.thread-reply')
    .filter({ hasText: 'A person asks for the plan.' })
  const kip = pane
    .locator('.thread-reply')
    .filter({ hasText: 'Ship the calmer workspace first.' })
  await expect(person).toBeVisible()
  await expect(kip).toBeVisible()
  return { pane, person, kip, add, thread, snapshot }
}

const formatted = (page: Page, timestamp: string) =>
  page.evaluate(
    (timestamp) =>
      new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(timestamp)),
    timestamp,
  )

async function away(page: Page) {
  await page.mouse.move(1, 1)
}

test('hover shows copy and the finish time for a kip and the send time for a person', async ({
  page,
}) => {
  const { kip, person } = await setup(page)
  await away(page)
  for (const [message, timestamp] of [
    [kip, finishedAt],
    [person, sentAt],
  ] as [Locator, string][]) {
    const actions = message.locator('.message-actions')
    const body = message.locator('.message-content')
    await expect(actions).toHaveCSS('opacity', '0')
    await expect(actions).toHaveCSS('pointer-events', 'none')
    // Layout height, which entrance transforms do not affect.
    const height = () => body.evaluate((node: HTMLElement) => node.offsetHeight)
    const hidden = await height()
    await body.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await expect(actions).toHaveCSS('pointer-events', 'auto')
    await expect(
      actions.getByRole('button', { name: 'Copy message', exact: true }),
    ).toBeVisible()
    const time = actions.locator('time')
    await expect(time).toHaveAttribute('datetime', timestamp)
    await expect(time).toHaveText(await formatted(page, timestamp))
    expect(await height()).toBe(hidden)
    await away(page)
    await expect(actions).toHaveCSS('opacity', '0')
  }
})

test('copy writes the message Markdown and briefly shows a check', async ({
  page,
}) => {
  const { kip } = await setup(page)
  await kip.locator('.message-content').hover()
  const button = kip.getByRole('button', { name: 'Copy message', exact: true })
  const icon = await button.innerHTML()
  await button.click()
  await expect(kip.locator('.message-actions [aria-live]')).toHaveText('Copied')
  expect(await button.innerHTML()).not.toBe(icon)
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    markdown.join('\n\n'),
  )
  await expect.poll(() => button.innerHTML(), { timeout: 4000 }).toBe(icon)
  await expect(kip.locator('.message-actions [aria-live]')).toHaveText('')
})

test('a streaming message shows no actions', async ({ page }) => {
  const { pane, add, thread } = await setup(page)
  await add({
    authorId: thread.summary.agentId,
    createdAt: sentAt,
    final: false,
    parts: [{ kind: 'text', text: 'Still writing this reply' }],
  })
  const draft = pane
    .locator('.thread-reply')
    .filter({ hasText: 'Still writing this reply' })
  await draft.locator('.message-content').hover()
  await expect(draft.locator('.message-actions')).toHaveCount(0)
  await expect(draft.getByRole('button', { name: 'Copy message' })).toHaveCount(
    0,
  )
})

test('keyboard focus on the copy button shows the row', async ({ page }) => {
  const { kip } = await setup(page)
  await away(page)
  const actions = kip.locator('.message-actions')
  const button = actions.getByRole('button', { name: 'Copy message' })
  await expect(actions).toHaveCSS('opacity', '0')
  await page.getByRole('textbox', { name: 'Reply in this thread' }).focus()
  for (let step = 0; step < 40; step++) {
    if (await button.evaluate((node) => node === document.activeElement)) break
    await page.keyboard.press('Shift+Tab')
  }
  await expect(button).toBeFocused()
  await expect(actions).toHaveCSS('opacity', '1')
})

test('the row is not selectable while the message text is', async ({
  page,
}) => {
  const { kip } = await setup(page)
  const time = kip.locator('.message-actions time')
  await expect(time).toHaveCSS('user-select', 'none')
  expect(
    await kip
      .locator('.message-text')
      .first()
      .evaluate((node) => getComputedStyle(node).userSelect),
  ).not.toBe('none')
  const selected = await kip.locator('.message-body').evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    return selection.toString()
  })
  expect(selected).toContain('Ship the calmer workspace first.')
  expect(selected).not.toContain(await time.innerText())
})

test('without Core message times only copy shows, and an empty row is omitted', async ({
  page,
}) => {
  const { pane, add, snapshot, thread } = await setup(page)
  await add({
    authorId: snapshot.ids.caller,
    parts: [{ kind: 'text', text: 'Sent to an older Core' }],
  })
  const older = pane
    .locator('.thread-reply')
    .filter({ hasText: 'Sent to an older Core' })
  await older.locator('.message-content').hover()
  await expect(
    older.getByRole('button', { name: 'Copy message', exact: true }),
  ).toBeVisible()
  await expect(older.locator('.message-actions time')).toHaveCount(0)
  await add({
    authorId: thread.summary.agentId,
    parts: [{ kind: 'unsupported-kind' }],
  })
  const unknown = pane
    .locator('.thread-reply')
    .filter({ has: page.locator('.unsupported-part') })
    .last()
  await expect(unknown).toBeVisible()
  // The fake Core stamps finishedAt on final messages, so this one has a time but nothing to copy.
  await expect(
    unknown.getByRole('button', { name: 'Copy message' }),
  ).toHaveCount(0)
})

test('feed root shows the row on hover', async ({ page }) => {
  await startDemo(page)
  await away(page)
  const card = page.locator('.feed-message').filter({ hasText: title })
  const actions = card.locator('.message-actions')
  await expect(actions).toHaveCSS('opacity', '0')
  await card.hover()
  await expect(actions).toHaveCSS('opacity', '1')
  await expect(
    actions.getByRole('button', { name: 'Copy message', exact: true }),
  ).toBeVisible()
})

test('captures hover row screenshots in light and dark themes', async ({
  page,
}) => {
  const dir = process.env.MESSAGE_ACTIONS_SHOTS
  test.skip(!dir, 'Set MESSAGE_ACTIONS_SHOTS to capture screenshots')
  await mkdir(resolve(dir!), { recursive: true })
  const { kip, person } = await setup(page)
  for (const theme of ['light', 'dark'] as const) {
    await switchTheme(page, theme)
    for (const [name, message] of [
      ['kip', kip],
      ['person', person],
    ] as const) {
      await message.locator('.message-content').hover()
      await expect(message.locator('.message-actions')).toHaveCSS(
        'opacity',
        '1',
      )
      await message.screenshot({
        path: resolve(dir!, `message-actions-${name}-${theme}.png`),
      })
    }
  }
})
