import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startDemo, demo, storageFault } from './demo.ts'

async function setup(page: Page, extra = '') {
  const session = await startDemo(page, {
    faults: extra.includes('draft=fail-read')
      ? { 'draft-read': 'fail' }
      : extra.includes('outbox=fail-read')
        ? { 'outbox-read': 'fail' }
        : {},
  })
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  return session
}

async function captureRecovery(page: Page, name: string) {
  if (!test.info().config.metadata.screenshots) return
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .every(
              (animation) =>
                animation.effect?.getTiming().iterations === Infinity ||
                animation.playState !== 'running',
            ) &&
          Array.from(
            document.querySelectorAll(
              '.conversation,.thread-pane,.composer-wrap,.feed,.thread-reply',
            ),
          ).every((element) => {
            const style = getComputedStyle(element)
            return style.transform === 'none' && Number(style.opacity) >= 0.999
          }),
      ),
    )
    .toBe(true)
  const directory = resolve('test-results/screenshots/conversation-recovery')
  await mkdir(directory, { recursive: true })
  await page.screenshot({
    path: resolve(directory, `${name}.png`),
    animations: 'disabled',
  })
}

test('transient initial draft read failure recovers through Retry saving', async ({
  page,
}) => {
  await setup(page, '&draft=fail-read')
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Retained while storage recovers')
  await expect(
    page.getByText('Draft is not saved on this device.'),
  ).toBeVisible()
  await storageFault(page, 'draft-read', 'allow')
  await page.getByRole('button', { name: 'Retry saving' }).click()
  await expect(
    page.getByText('Draft saved on this device', { exact: true }),
  ).toHaveClass(/sr-only/)
  await expect(
    page.getByText('Draft is not saved on this device.'),
  ).toHaveCount(0)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(
    page
      .locator('.feed')
      .getByText('Retained while storage recovers', { exact: true }),
  ).toBeVisible()
})

test('incomplete Markdown preserves literal content without stripping suffix characters', async ({
  page,
}) => {
  await setup(page)
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('**incomplete')
  await input.press('Enter')
  await expect(
    page.getByRole('button', {
      name: 'Open thread: **incomplete',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.locator('.message-text').filter({ hasText: 'incom' }).last(),
  ).toHaveText('**incomplete')
})

for (const layout of ['expanded', 'narrow'] as const) {
  for (const outcome of ['uncertain', 'rejected'] as const) {
    test(`${layout} thread exposes ${outcome} reply recovery and original target`, async ({
      page,
    }) => {
      await setup(page)
      if (layout === 'narrow')
        await page.setViewportSize({ width: 390, height: 844 })
      await page
        .getByRole('button', {
          name: 'Open thread: Shape a calmer workspace for the next release',
          exact: true,
        })
        .click()
      if (layout === 'expanded')
        await page.getByRole('button', { name: 'Expand thread' }).click()
      const pane = page.getByRole('region', {
        name: 'Thread: Shape a calmer workspace for the next release',
        exact: true,
      })
      let blocked = true
      if (outcome === 'uncertain')
        await page.route('**/v1/text/submissions', (route) =>
          blocked ? route.abort() : route.continue(),
        )
      else
        await page.route('**/v1/text/submissions', (route) =>
          route.fulfill({
            status: 409,
            json: {
              version: 1,
              code: 'membership-removed',
              message:
                'This kip is no longer a member of the organization, so it can’t take new messages.',
            },
          }),
        )
      const text = `Keep ${layout} ${outcome} reply`
      const input = pane.getByRole('textbox', { name: 'Reply in this thread' })
      await input.fill(text)
      await input.press('Enter')
      await expect(input).toHaveValue('')
      await expect(pane.getByText(text, { exact: true }).first()).toBeVisible()
      await expect(
        pane.getByText(
          'In thread: Shape a calmer workspace for the next release',
          { exact: true },
        ),
      ).toBeVisible()
      if (outcome === 'uncertain') {
        await expect(
          pane.getByText('Reply · Acceptance not yet confirmed', {
            exact: true,
          }),
        ).toBeVisible()
        const retry = pane.getByRole('button', {
          name: 'Check and retry original send',
        })
        await expect(retry).toBeInViewport()
        await captureRecovery(page, `${layout}-${outcome}`)
        blocked = false
        await retry.click()
        await expect(
          pane.locator(
            '.submission-recovery:not(details) > .pending-submission',
          ),
        ).toHaveCount(0)
        await expect(
          pane.getByText(text, { exact: true }).first(),
        ).toBeVisible()
        const inspected = await demo(page, '/inspect')
        expect(
          inspected.threads
            .flatMap(
              (t: { messages: { parts: { text?: string }[] }[] }) => t.messages,
            )
            .filter((m: { parts: { text?: string }[] }) =>
              m.parts.some((p) => p.text === text),
            ),
        ).toHaveLength(1)
      } else {
        await expect(
          pane.getByText('Reply · Not accepted', { exact: true }),
        ).toBeVisible()
        await expect(
          pane.getByText(
            'This kip is no longer a member of the organization, so it can’t take new messages.',
            { exact: true },
          ),
        ).toBeVisible()
        await expect(
          pane.getByRole('button', { name: 'Dismiss', exact: true }),
        ).toBeInViewport()
        await expect(
          pane.getByRole('button', { name: 'Check and retry original send' }),
        ).toHaveCount(0)
        await captureRecovery(page, `${layout}-${outcome}`)
      }
    })
  }
  test(`${layout} thread exposes live disconnection and reconnect`, async ({
    page,
  }) => {
    await setup(page)
    await page.route('**/v1/threads/*/events?**', (route) => route.abort())
    if (layout === 'narrow')
      await page.setViewportSize({ width: 390, height: 844 })
    await page
      .getByRole('button', {
        name: 'Open thread: Shape a calmer workspace for the next release',
        exact: true,
      })
      .click()
    if (layout === 'expanded')
      await page.getByRole('button', { name: 'Expand thread' }).click()
    const pane = page.getByRole('region', {
      name: 'Thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    await expect(
      pane.getByText('Thread updates interrupted. Reconnecting…', {
        exact: false,
      }),
    ).toBeVisible()
    await page.unroute('**/v1/threads/*/events?**')
    await expect(
      pane.getByText('Thread updates interrupted. Reconnecting…'),
    ).toHaveCount(0, { timeout: 15000 })
  })
}

test('draft read retry retains text and restores subsequent cross-tab observation', async ({
  page,
  context,
}) => {
  const endpoint = await setup(page, '&draft=fail-read')
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Typed before failed read recovery')
  await storageFault(page, 'draft-read', 'allow')
  await page.getByRole('button', { name: 'Retry saving' }).click()
  await expect(
    page.getByText('Draft saved on this device', { exact: true }),
  ).toHaveClass(/sr-only/)
  const other = await context.newPage()
  await startDemo(other, { session: endpoint })
  const second = other.getByRole('textbox', { name: 'Start a new thread' })
  await expect(second).toHaveValue('Typed before failed read recovery')
  await second.fill('A later saved edit from another tab')
  await expect(
    other.getByText('Draft saved on this device', { exact: true }),
  ).toHaveClass(/sr-only/)
  await expect(input).toHaveValue('A later saved edit from another tab')
  await expect(page.getByText(/Saved drafts on this device/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByText(/Saved drafts on this device/)).toHaveCount(0)
})

test('streamed incomplete inline delimiters remain literal until canonical finalization', async ({
  page,
}) => {
  await setup(page)
  const snapshot = await demo(page, '/inspect')
  const thread = snapshot.threads.find(
    (item: { messages: { parts: { text?: string }[] }[] }) =>
      item.messages[0].parts[0].text ===
      'Shape a calmer workspace for the next release',
  )
  await page
    .getByRole('button', {
      name: 'Open thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    .click()
  const pane = page.getByRole('region', {
    name: 'Thread: Shape a calmer workspace for the next release',
    exact: true,
  })
  const id = crypto.randomUUID()
  const pieces = [
    '*',
    '**',
    '**incomplete',
    '`',
    '`unfinished',
    'Before **partial',
    '```ts\nconst unfinished = 1',
    '**complete** and `complete`',
  ]
  for (const [index, text] of pieces.entries()) {
    await demo(page, '/message', {
      threadId: thread.summary.threadId,
      message: {
        id,
        threadId: thread.summary.threadId,
        authorId: thread.summary.agentId,
        position: thread.messages.length + 1,
        revision: index + 1,
        final: index === pieces.length - 1,
        parts: [{ kind: 'text', text }],
      },
    })
    const body = pane.locator('.thread-reply .message-text').last()
    await expect(body).toHaveText(
      index === pieces.length - 1 ? 'complete and complete' : text,
    )
  }
  await expect(pane.locator('.message-state')).toHaveCount(0)
})

for (const layout of ['expanded', 'narrow'] as const) {
  test(`${layout} thread keeps local outbox failure accessible`, async ({
    page,
  }) => {
    await setup(page, '&outbox=fail-read')
    if (layout === 'narrow')
      await page.setViewportSize({ width: 390, height: 844 })
    await page
      .getByRole('button', {
        name: 'Open thread: Shape a calmer workspace for the next release',
        exact: true,
      })
      .click()
    if (layout === 'expanded')
      await page.getByRole('button', { name: 'Expand thread' }).click()
    const pane = page.getByRole('region', {
      name: 'Thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    await expect(pane.getByRole('alert')).toContainText(
      'Local send history is unavailable.',
    )
    await expect(pane.getByRole('alert')).toBeVisible()
  })
}

test('closing a thread preserves its recovery on the feed and reopening moves it back', async ({
  page,
}) => {
  await setup(page)
  await page.route('**/v1/text/submissions', (route) => route.abort())
  await page
    .getByRole('button', {
      name: 'Open thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    .click()
  const pane = page.getByRole('region', {
    name: 'Thread: Shape a calmer workspace for the next release',
    exact: true,
  })
  await pane
    .getByRole('textbox', { name: 'Reply in this thread' })
    .fill('Recovery belongs to the original thread')
  await pane
    .getByRole('textbox', { name: 'Reply in this thread' })
    .press('Enter')
  await expect(
    pane.getByText('Reply · Acceptance not yet confirmed', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.conversation .pending-submission')).toHaveCount(0)
  await pane.getByRole('button', { name: 'Close thread' }).click()
  await expect(page.locator('.conversation .pending-submission')).toHaveCount(1)
  await page.getByRole('button', { name: 'Open original thread' }).click()
  await expect(
    pane.getByText('Recovery belongs to the original thread', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.conversation .pending-submission')).toHaveCount(0)
})
