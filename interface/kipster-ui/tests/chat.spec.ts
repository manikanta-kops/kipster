import { expect, test } from '@playwright/test'
import { startDemo } from './demo.ts'

test('thread reply stays in its thread and focus returns on close', async ({
  page,
}) => {
  await startDemo(page)
  const trigger = page.getByRole('button', {
    name: 'Open thread: Shape a calmer workspace for the next release',
    exact: true,
  })
  await page
    .locator('.feed .message-body')
    .getByText('Shape a calmer workspace for the next release', { exact: true })
    .click()
  const thread = page.getByRole('region', {
    name: 'Thread: Shape a calmer workspace for the next release',
    exact: true,
  })
  await expect(
    thread.getByRole('button', { name: 'Close thread' }),
  ).toBeFocused()
  const reply = thread.getByRole('textbox', { name: 'Reply in this thread' })
  await reply.fill('A local reply for this thread.')
  await expect(
    thread.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await reply.press('Enter')
  await expect(
    thread
      .locator('.thread-reply')
      .getByText('A local reply for this thread.', { exact: true }),
  ).toBeVisible()
  await expect(trigger).toContainText(/replies/)
  await expect(reply).toHaveValue('')
  await reply.press('Escape')
  await expect(thread).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await expect(
    page
      .locator('.feed')
      .getByText('A local reply for this thread.', { exact: true }),
  ).toHaveCount(0)
})

test('agent drafts survive navigation and whitespace cannot be sent', async ({
  page,
}) => {
  await startDemo(page)
  await page
    .getByRole('textbox', { name: 'Start a new thread' })
    .fill('Draft for Atlas')
  await page.getByRole('button', { name: 'Mira', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Mira', exact: true }),
  ).toBeVisible()
  const composer = page.getByRole('textbox', { name: 'Start a new thread' })
  await composer.fill('   ')
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled()
  await composer.fill('Hello Mira')
  await composer.press('Enter')
  await expect(
    page.locator('.feed').getByText('Hello Mira', { exact: true }),
  ).toBeVisible()
  const card = page.locator('.feed-message').filter({ hasText: 'Hello Mira' })
  await expect(card.locator('.reply-count')).toHaveCount(0)
  await expect(card.locator('.reply-participants')).toHaveCount(0)
  await card.click({ position: { x: 8, y: 8 } })
  await expect(
    page.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  await expect(
    card.getByRole('button', { name: 'Open thread: Hello Mira' }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page.getByRole('button', { name: 'Atlas', exact: true }).first().click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toHaveValue('Draft for Atlas')
  await expect(
    page.locator('.feed').getByText('Hello Mira', { exact: true }),
  ).toHaveCount(0)
})

test('theme survives reload and narrow thread layout stays within viewport', async ({
  page,
}) => {
  await startDemo(page)
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await page.reload()
  await expect(
    page.getByRole('button', { name: 'Switch to light mode' }),
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', {
      name: 'Open thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    .click()
  await expect(
    page.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeHidden()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'Close thread' }).click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
})

test('file-only messages upload original bytes and reference stable artifacts', async ({
  page,
}) => {
  await startDemo(page)
  await page.locator('input[type=file]').setInputFiles({
    name: 'scope.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Preview attachment'),
  })
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page.getByRole('region', { name: 'File: scope.txt', exact: true }),
  ).toContainText('scope.txt')
  await page.getByRole('button', { name: 'Prepare download scope.txt' }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download scope.txt' }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString()).toBe('Preview attachment')
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  await expect(page.locator('.pending-submission')).toHaveCount(0)
})

test('IME composition cannot submit and Shift+Enter retains a newline', async ({
  page,
}) => {
  await startDemo(page)
  await expect(
    page.getByRole('heading', { name: 'Atlas', exact: true }),
  ).toBeVisible()
  const composer = page.getByRole('textbox', { name: 'Start a new thread' })
  await composer.fill('Composing')
  await composer.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    bubbles: true,
  })
  await expect(composer).toHaveValue('Composing')
  await expect(
    page.locator('.feed').getByText('Composing', { exact: true }),
  ).toHaveCount(0)
  await composer.press('End')
  await composer.press('Shift+Enter')
  await expect(composer).toHaveValue('Composing\n')
})
