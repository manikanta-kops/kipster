import { test, expect, startDemo, demo } from './demo.ts'

test('ineligible background tab cannot consume live foreground attention', async ({
  page,
  context,
}) => {
  const session = await startDemo(page, { notification: 'background' })
  await expect(
    page.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  // Both tabs share these: banners on, system notifications for failures off.
  await page.evaluate(() => {
    localStorage.setItem('kipster:notifications.banners', 'on')
    localStorage.setItem('kipster:notifications.failures', 'off')
  })
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
    page.getByRole('button', { name: 'Notifications, 5 need you' }),
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
  await expect(foreground.locator('.banner')).toContainText(
    'Atlas · Couldn’t finish',
  )
  await foreground.reload()
  await expect(
    foreground.getByRole('button', { name: 'Notifications, 5 need you' }),
  ).toBeVisible()
  await expect(foreground.locator('.banner')).toHaveCount(0)
})
