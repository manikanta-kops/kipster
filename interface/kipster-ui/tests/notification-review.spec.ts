import { test, expect, startDemo, demo, storageFault } from './demo.ts'

test('read reservation failure remains visible and does not silently swallow the action', async ({
  page,
}) => {
  await startDemo(page, { faults: { 'control-reserve': 'fail' } })
  let writes = 0
  page.on('request', (r) => {
    if (/\/v1\/notifications\/.*\/read$/.test(r.url())) writes++
  })
  await page.getByRole('button', { name: /^Notifications,/ }).click()
  const item = page
    .locator('.inbox-item')
    .filter({ hasText: 'Which direction would you like me to develop?' })
  await item.getByRole('button', { name: 'Mark read', exact: true }).click()
  await expect(item.getByRole('alert')).toBeVisible()
  expect(writes).toBe(0)
  await item
    .getByRole('button', { name: 'Retry Mark read', exact: true })
    .click()
  await expect(item.getByRole('alert')).toBeVisible()
  expect(writes).toBe(0)
  await storageFault(page, 'control-reserve', 'allow')
  await item
    .getByRole('button', { name: 'Retry Mark read', exact: true })
    .click()
  await expect(item).toHaveClass(/\bread\b/)
  expect(writes).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: /^Notifications,/ }).click()
  await expect(
    page
      .locator('.inbox-item')
      .filter({ hasText: 'Which direction would you like me to develop?' }),
  ).toHaveClass(/\bread\b/)
})

test('failed disable preference write cannot claim that background alerts are disabled', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop', exact: true }).click()
  await page
    .getByRole('button', { name: 'Enable and test notifications' })
    .click()
  await expect(
    page.getByRole('button', { name: 'Disable desktop alerts' }),
  ).toBeVisible()
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Object.assign(window, {
      restorePreferenceWrite: () => {
        Storage.prototype.setItem = original
      },
    })
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith('kipster:desktop-notifications:') &&
        value === 'disabled'
      )
        throw new DOMException('Storage unavailable', 'QuotaExceededError')
      return original.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Disable desktop alerts' }).click()
  const actual = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('kipster:desktop-notifications:'))
      .map((k) => localStorage.getItem(k)),
  )
  expect(actual).toEqual(['enabled'])
  await expect(
    page.getByText('Background desktop alerts disabled.', { exact: true }),
  ).toHaveCount(0)
  await expect(page.getByText(/could not be saved/)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Disable desktop alerts' }),
  ).toBeVisible()
  await page.evaluate(() => (window as any).restorePreferenceWrite())
  await page.getByRole('button', { name: 'Disable desktop alerts' }).click()
  await expect(
    page.getByText('Background desktop alerts disabled.', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Enable and test notifications' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Disable desktop alerts' }),
  ).toHaveCount(0)
})

test('ineligible background tab cannot consume live foreground attention', async ({
  page,
  context,
}) => {
  const session = await startDemo(page, { notification: 'background' })
  await expect(
    page.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  const foreground = await context.newPage()
  await foreground.addInitScript(() => {
    const gate = { hold: false, release: () => {} }
    Object.assign(window, { reviewAttentionGate: gate })
    const original = window.fetch
    window.fetch = async (...args) => {
      const response = await original(...args)
      const url = String(args[0])
      if (!url.includes('/v1/app/events') || !response.body) return response
      return new Response(
        response.body.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              if (gate.hold)
                await new Promise<void>((resolve) => (gate.release = resolve))
              controller.enqueue(chunk)
            },
          }),
        ),
        { status: response.status, headers: response.headers },
      )
    }
  })
  await startDemo(foreground, { session, notification: 'foreground' })
  await expect(
    foreground.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  await foreground.evaluate(() => {
    ;(window as any).reviewAttentionGate.hold = true
  })
  const state = await demo(page, '/inspect')
  const thread = state.threads.find((t: any) =>
    t.work.some((w: any) => w.state === 'running'),
  )
  await demo(page, '/scenario', {
    threadId: thread.summary.threadId,
    scenario: 'failure',
  })
  await demo(page, '/advance', { threadId: thread.summary.threadId, steps: 4 })
  await expect(
    page.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).notificationTest.attentionChecks),
    )
    .toBeGreaterThan(0)
  expect(
    await page.evaluate(() => (window as any).notificationTest.sends),
  ).toHaveLength(0)
  await foreground.evaluate(() => {
    const gate = (window as any).reviewAttentionGate
    gate.hold = false
    gate.release()
  })
  await expect(foreground.locator('.attention-toast')).toContainText(
    'couldn’t finish',
  )
  await foreground.reload()
  await expect(
    foreground.getByRole('button', { name: 'Notifications, 9 unread' }),
  ).toBeVisible()
  await expect(foreground.locator('.attention-toast')).toHaveCount(0)
})
