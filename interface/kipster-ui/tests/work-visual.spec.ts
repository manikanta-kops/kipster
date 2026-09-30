import { test, expect } from './demo.ts'
import { setupWork } from './work-helpers.ts'
test('work cards support keyboard focus, reduced motion in split and narrow layouts', async ({
  page,
}) => {
  await setupWork(page)
  await expect(page.locator('.interaction-card')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('radio', { name: 'Keep it focused' }).focus()
  await page.keyboard.press('Space')
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('textbox', { name: 'Your answer or additional detail' }),
  ).toBeFocused()
  await page.keyboard.type('Small beta first')
  await page.keyboard.press('Tab')
  await expect(
    page.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    page.getByText('Recorded response', { exact: true }),
  ).toBeFocused()
  await expect(page.locator('.interaction-card blockquote')).toContainText(
    'Small beta first',
  )
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page
    .getByRole('button', {
      name: 'Open thread: Work acceptance scenario',
      exact: true,
    })
    .press('Enter')
  await page.route('**/v1/work/controls', (route) => route.abort())
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Retry same command' }),
  ).toBeInViewport()
})
