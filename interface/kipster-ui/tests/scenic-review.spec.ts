import { expect, test, startDemo } from './demo.ts'
for (const palette of ['Glacier', 'Obsidian']) {
  test(`${palette} appearance persists and System follows device changes`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await startDemo(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page
      .locator('.palette-card')
      .filter({
        has: page.getByRole('radio', {
          name: palette,
          exact: palette !== 'Obsidian',
        }),
      })
      .click()
    await expect(page.locator('html')).toHaveAttribute(
      'data-palette',
      palette.toLowerCase(),
    )
    if (palette === 'Obsidian') {
      await expect(
        page.getByRole('radio', { name: 'Light', exact: true }),
      ).toBeDisabled()
      await expect(page.locator('html')).toHaveAttribute(
        'data-surface',
        'outline',
      )
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    } else {
      for (const mode of ['Light', 'Dark']) {
        await page
          .locator('.mode-picker label')
          .filter({ has: page.getByRole('radio', { name: mode, exact: true }) })
          .click()
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          mode.toLowerCase(),
        )
      }
      await page
        .locator('.mode-picker label')
        .filter({
          has: page.getByRole('radio', { name: 'System', exact: true }),
        })
        .click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    }
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute(
      'data-palette',
      palette.toLowerCase(),
    )
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })
}

test('all five palettes can be selected', async ({ page }) => {
  await startDemo(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  for (const palette of [
    'Glacier',
    'Alpenglow',
    'Pine',
    'Graphite',
    'Obsidian',
  ]) {
    const radio = page.getByRole('radio', {
      name: palette,
      exact: palette !== 'Obsidian',
    })
    await page.locator('.palette-card').filter({ has: radio }).click()
    await expect(radio).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute(
      'data-palette',
      palette.toLowerCase(),
    )
  }
})
