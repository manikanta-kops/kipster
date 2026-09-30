import { test, expect } from '@playwright/test'
import { setupMedia, syntheticMicrophone } from './media-helpers.ts'

test('compact voice and document tiles share a row and retain controls', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await syntheticMicrophone(page)
  await setupMedia(page)
  await page.setViewportSize({ width: 1280, height: 820 })
  await page
    .getByRole('button', { name: 'Record voice note', exact: true })
    .click()
  await expect(page.getByText('Recording 0:01')).toBeVisible()
  await page.getByRole('button', { name: 'Stop recording' }).click()
  const voice = page.locator('.pending-media.voice')
  await expect(voice.locator('.voice-play')).toBeVisible()
  await expect(voice.locator('.voice-wave')).toBeVisible()
  await expect(voice.locator('audio')).toHaveCount(1)
  await expect(voice.locator('audio')).not.toBeVisible()
  await page.locator('input[type=file]').setInputFiles({
    name: 'Amulya - The Practical Blanks.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 example'),
  })
  const pdf = page.locator('.pending-media:not(.voice)')
  await expect(pdf).toContainText('Uploaded')
  const a = (await voice.boundingBox())!
  const b = (await pdf.boundingBox())!
  expect(Math.abs(a.y - b.y)).toBeLessThan(2)
  expect(a.height).toBeLessThanOrEqual(72)
  expect(b.x).toBeGreaterThan(a.x)
  await page.screenshot({ path: 'test-results/compact-attachments.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    voice.getByRole('button', { name: 'Re-record voice note' }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await pdf
    .getByRole('button', { name: 'Remove Amulya - The Practical Blanks.pdf' })
    .click()
  await expect(pdf).toHaveCount(0)
})
