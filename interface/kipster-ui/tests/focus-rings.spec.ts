import { test, expect, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'

const outlined = (page: Page) =>
  page
    .locator('.feed-message')
    .evaluateAll(
      (cards) =>
        cards.filter((card) => getComputedStyle(card).outlineStyle !== 'none')
          .length,
    )

test('a click leaves no focus ring; the keyboard brings it back', async ({
  page,
}) => {
  await startDemo(page)
  await page.locator('.reply-link').first().click()
  await page.getByRole('button', { name: 'Close thread' }).click()
  // Closing returns focus to the card's link; a mouse user sees no ring.
  await expect(page.locator('.feed-message .reply-link').first()).toBeFocused()
  expect(await outlined(page)).toBe(0)
  await expect(page.locator(':root')).toHaveAttribute('data-input', 'pointer')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(page.locator(':root')).toHaveAttribute('data-input', 'keyboard')
  expect(await outlined(page)).toBe(1)
})
