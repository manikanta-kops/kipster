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
        name: /Manage workspace|Archive|Change connection/,
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
    await settings.getByRole('button', { name: 'Manage workspace' }).click()
    await expect(
      page.getByRole('button', { name: 'Close management' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close management' }).click()
    await settings.getByRole('button', { name: 'Archive & deletion' }).click()
    await expect(
      page.getByRole('dialog', { name: 'Archive & deletion' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close archive & deletion' }).click()
    await expect(
      settings.getByRole('button', { name: /^Notifications/ }),
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
