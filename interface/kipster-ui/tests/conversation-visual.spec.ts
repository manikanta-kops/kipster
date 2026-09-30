import { test, expect } from '@playwright/test'
import { startDemo, switchTheme } from './demo.ts'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

test('conversation layouts retain focus, fit narrow screens, and honor reduced motion', async ({
  page,
}) => {
  const directory = resolve('test-results/screenshots/conversations')
  const capture = async (name: string) => {
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
              return (
                style.transform === 'none' && Number(style.opacity) >= 0.999
              )
            }),
        ),
      )
      .toBe(true)
    if (test.info().config.metadata.screenshots) {
      await mkdir(directory, { recursive: true })
      await page.screenshot({
        path: resolve(directory, `${name}.png`),
        animations: 'disabled',
      })
    }
  }
  const usableThread = async () => {
    await expect(page.locator('.status-island')).toHaveCount(2)
    await expect(
      page.getByRole('textbox', { name: 'Reply in this thread' }),
    ).toBeInViewport()
    await expect
      .poll(() =>
        page.locator('.thread-pane').evaluate((pane) => {
          const bounds = pane.getBoundingClientRect()
          return [
            ...pane.querySelectorAll('.thread-scroll, .composer-wrap'),
          ].every((child) => {
            const rect = child.getBoundingClientRect()
            return (
              rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
            )
          })
        }),
      )
      .toBe(true)
  }
  await startDemo(page)
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await capture('01-light-feed')
  await page.emulateMedia({ colorScheme: 'dark' })
  await capture('02-dark-feed')
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  const trigger = page.getByRole('button', {
    name: 'Open thread: Shape a calmer workspace for the next release',
    exact: true,
  })
  await trigger.click()
  await expect(page.getByRole('button', { name: 'Close thread' })).toBeFocused()
  await capture('03-dark-split')
  await usableThread()
  await page.emulateMedia({ colorScheme: 'light' })
  await capture('04-light-split')
  await page.getByRole('button', { name: 'Expand thread' }).click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeHidden()
  await capture('05-light-expanded')
  await usableThread()
  await page.getByRole('button', { name: 'Restore split view' }).click()
  await usableThread()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(
    page.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await capture('06-dark-narrow-thread')
  await usableThread()
  await page
    .getByRole('textbox', { name: 'Reply in this thread' })
    .press('Escape')
  await expect(trigger).toBeFocused()
  await switchTheme(page, 'light')
  await capture('07-light-narrow-feed')
})
