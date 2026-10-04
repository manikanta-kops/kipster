import { test, expect, startDemo, demo, DEMO_IDS } from './demo.ts'

for (const width of [1440, 390]) {
  test(`workspace utilities live in settings at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await startDemo(page)
    if (width < 640)
      await page.getByRole('button', { name: 'Show sidebar' }).click()
    const sidebar = page.getByRole('complementary', { name: 'Workspace' })
    await expect(
      sidebar.getByRole('button', { name: 'Settings', exact: true }),
    ).toBeVisible()
    await expect(
      sidebar.getByRole('button', {
        name: /Manage workspace|Manage kips|Archive|Change connection/,
      }),
    ).toHaveCount(0)
    const organization = sidebar.getByRole('combobox', { name: 'Organization' })
    await expect(organization).toBeVisible()
    await expect(sidebar.locator('.profile-picker .avatar')).toHaveCount(0)
    await organization.selectOption(DEMO_IDS.studio)
    const name = await organization.locator('option:checked').textContent()
    await expect(sidebar.locator('.profile-context')).toHaveText(name!)
    await organization.selectOption({ label: 'Kipster' })
    await expect(
      page.getByRole('button', { name: 'Nothing is waiting for you' }),
    ).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Delete kip/ })).toHaveCount(
      0,
    )
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(
      settings.getByRole('combobox', { name: 'Organization' }),
    ).toHaveCount(0)
    await settings
      .getByRole('button', { name: 'Organization', exact: true })
      .click()
    await settings
      .getByRole('button', { name: 'Manage kips and groups…' })
      .click()
    await expect(
      page.getByRole('button', { name: 'Close management' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close management' }).click()
    await settings.getByRole('button', { name: 'Archive & deletion' }).click()
    await expect(
      settings.getByRole('heading', { name: 'Archive & deletion' }),
    ).toBeVisible()
    await expect(
      settings.getByRole('heading', { name: 'Archived kips' }),
    ).toBeVisible()
    await expect(
      settings.getByRole('button', { name: /^Notifications,/ }),
    ).toHaveCount(0)
    await page
      .getByRole('button', { name: 'Close settings', exact: true })
      .click()
    await sidebar.getByRole('button', { name: /^Notifications,/ }).click()
    await expect(
      page.getByRole('dialog', { name: 'Notifications', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close notifications' }).click()
    await expect(
      sidebar.getByRole('button', { name: /^Notifications,/ }),
    ).toBeFocused()
  })
}

test('waiting indicator disappears when the last pending request settles', async ({
  page,
}) => {
  await startDemo(page)
  const waiting = page.getByRole('button', { name: /^Waiting for you:/ })
  await expect(waiting).toBeVisible()
  const state = await demo(page, '/inspect')
  for (const notice of state.notifications.filter(
    (n: { interactionState?: string }) => n.interactionState === 'pending',
  )) {
    await demo(page, '/notification', {
      notification: {
        ...notice,
        interactionState: 'cancelled',
        revision: notice.revision + 1,
      },
    })
  }
  await expect(waiting).toHaveCount(0)
  await expect(page.locator('.waiting-pill')).toHaveCount(0)
})

test('each kip shows one mark: needs you, failed, working or an unread reply', async ({
  page,
}) => {
  await startDemo(page)
  const sidebar = page.getByRole('complementary', { name: 'Workspace' })
  const kip = (name: string) =>
    sidebar.getByRole('button', { name, exact: true }).first()
  await expect(kip('Atlas')).toHaveAttribute('data-mark', 'needs')
  await expect(kip('Atlas').locator('.corner-mark.needs')).toBeVisible()
  await expect(kip('Atlas')).toHaveAccessibleDescription('needs you')
  await expect(sidebar.locator('.kip-home')).toHaveAttribute(
    'data-mark',
    'unread',
  )
  await expect(sidebar.locator('.kip-home .unread-mark')).toBeVisible()
  await expect(sidebar.locator('.elsewhere-mark')).toHaveCount(0)
  async function start(name: string, text: string) {
    await kip(name).click()
    const composer = page.getByRole('textbox', { name: 'Start a new thread' })
    await composer.fill(text)
    await composer.press('Enter')
    await expect
      .poll(async () =>
        (await demo(page, '/inspect')).threads.find(
          (t: any) => t.messages[0]?.parts[0]?.text === text,
        ),
      )
      .toBeTruthy()
    return (await demo(page, '/inspect')).threads.find(
      (t: any) => t.messages[0]?.parts[0]?.text === text,
    ).summary.threadId
  }
  const rowan = await start('Rowan', 'Plan the release checklist')
  await demo(page, '/scenario', { threadId: rowan, scenario: 'failure' })
  await demo(page, '/advance', { threadId: rowan, steps: 1 })
  await expect(kip('Rowan')).toHaveAttribute('data-mark', 'working')
  const breathing = kip('Rowan').locator('.corner-mark.working')
  await expect(breathing).toHaveCSS('animation-name', /mark-breathe/)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(breathing).toHaveCSS('animation-name', 'none')
  await demo(page, '/advance', { threadId: rowan, steps: 2 })
  await expect(kip('Rowan')).toHaveAttribute('data-mark', 'failed')
  await expect(kip('Rowan').locator('.corner-mark.failed')).toBeVisible()
  const mira = await start('Mira', 'Sketch the welcome screen')
  await demo(page, '/scenario', { threadId: mira, scenario: 'complete' })
  await demo(page, '/advance', { threadId: mira, steps: 4 })
  await expect(kip('Mira')).toHaveAttribute('data-mark', 'unread')
  await expect(kip('Mira').locator('.unread-mark')).toBeVisible()
  await expect(kip('Mira').locator('.corner-mark')).toHaveCount(0)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(
    sidebar.locator('.stack-mark .corner-mark.needs').first(),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await sidebar
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.studio)
  await expect(sidebar.locator('.elsewhere-mark')).toBeVisible()
  await expect(
    sidebar.getByRole('combobox', { name: 'Organization' }),
  ).toHaveAccessibleDescription('Another organization needs you')
})

test('the bell counts what needs you and shows a quiet dot for unread replies', async ({
  page,
}) => {
  await startDemo(page)
  const bell = page.getByRole('button', { name: /^Notifications, / })
  await expect(bell).toHaveAccessibleName('Notifications, 4 need you')
  await expect(bell.locator('.unread-count')).toHaveText('4')
  const state = await demo(page, '/inspect')
  for (const notice of state.notifications) {
    await demo(page, '/notification', {
      notification: {
        ...notice,
        read: true,
        interactionState:
          notice.kind === 'interaction' ? 'settled' : notice.interactionState,
        revision: notice.revision + 1,
      },
    })
  }
  const reply = state.notifications.find((n: any) => n.kind === 'completed')
  await demo(page, '/notification', {
    notification: { ...reply, id: crypto.randomUUID(), read: false },
  })
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread')
  await expect(bell.locator('.unread-count')).toHaveCount(0)
  await expect(bell.locator('.unread-mark')).toBeVisible()
})
