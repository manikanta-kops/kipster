import { test, expect, type Locator, type Page } from '@playwright/test'
import { openRichDoc, startDemo } from './demo.ts'

async function selectionStyle(locator: Locator, value: 'none' | 'text') {
  await expect(locator).toHaveCSS('user-select', value)
  await expect(locator).toHaveCSS('-webkit-user-select', value)
}

// Drag actual glyphs, rather than installing a Range (which bypasses CSS).
async function dragText(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const points = await locator.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text: Node | null
    while ((text = walker.nextNode())) {
      if ((text.textContent?.trim().length ?? 0) < 4) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      const rect = range.getClientRects()[0]
      if (rect?.width > 10) {
        return {
          x: rect.x + 1,
          y: rect.y + rect.height / 2,
          end: rect.right - 1,
        }
      }
    }
    throw new Error('No visible text to drag')
  })
  await page.evaluate(() => getSelection()?.removeAllRanges())
  await page.mouse.move(points.x, points.y)
  await page.mouse.down()
  await page.mouse.move(points.end, points.y, { steps: 12 })
  await page.mouse.up()
  return page.evaluate(() => getSelection()?.toString() ?? '')
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await startDemo(page)
})

test('sidebar, filters, workspace switcher, top pill and empty state are chrome', async ({
  page,
}) => {
  const name = page
    .locator('.sidebar .agent-name')
    .filter({ hasText: 'Atlas' })
    .first()
  await selectionStyle(name, 'none')
  await selectionStyle(page.locator('.sidebar .agent-line').first(), 'none')
  const chips = page.locator('.sidebar .segments [role=tab]')
  await expect(chips).toHaveCount(3)
  for (const chip of await chips.all()) await selectionStyle(chip, 'none')
  await selectionStyle(
    page.getByRole('combobox', { name: 'Organization', exact: true }),
    'none',
  )
  await selectionStyle(
    page.getByRole('button', { name: 'Settings', exact: true }),
    'none',
  )
  await selectionStyle(page.locator('.toolbar .island-name'), 'none')
  expect(await dragText(page, name)).toBe('')
  await page.getByRole('button', { name: 'Mira', exact: true }).first().click()
  await selectionStyle(page.locator('.empty-state h2'), 'none')
  await selectionStyle(page.locator('.empty-state p').first(), 'none')
})

test('message paragraphs, lists, links, inline code, fenced code and tables stay selectable', async ({
  page,
}) => {
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await selectionStyle(input, 'text')
  await input.fill(
    'Copy this message text with `inline code` and [a link](https://example.com).\n\n- A copyable list item\n\n```ts\nconst selection = true\n```\n\n| Name | Value |\n| --- | --- |\n| Kip | Copyable |',
  )
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  // The feed previews three lines; the thread shows the whole message.
  await page
    .locator('.feed-message')
    .filter({ hasText: 'Copy this message text' })
    .locator('.message-text')
    .click()
  const message = page
    .locator('.thread-scroll .markdown')
    .filter({ hasText: 'const selection = true' })
    .last()
  await expect(message).toBeVisible()
  for (const selector of ['p', 'li', 'a', 'p code', 'pre', 'pre code', 'td'])
    await selectionStyle(message.locator(selector).first(), 'text')
  await expect(message.getByRole('cell', { name: 'Copyable' })).toBeVisible()
  expect(await dragText(page, message.locator('p').first())).toContain('Copy')
  expect(await dragText(page, message.locator('pre code'))).toContain(
    'selection',
  )
})

test('rich doc edit and revision text, code and rendered tables can be selected and copied', async ({
  page,
}) => {
  await openRichDoc(page, 'Rich docs: v1 plan')
  const doc = page.getByRole('region', { name: 'Rich doc: Rich docs: v1 plan' })
  const field = doc.locator('[data-block="scope-text"][data-field="text"]')
  await selectionStyle(field, 'text')
  await selectionStyle(doc.locator('.cm-pin').first(), 'none')
  await selectionStyle(doc.locator('table .doc-field').first(), 'text')
  await selectionStyle(doc.locator('.file-tile b').first(), 'text')
  const selected = await dragText(page, field)
  expect(selected.length).toBeGreaterThan(5)
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+c' : 'Control+c',
  )
  const note = doc.getByRole('textbox', { name: 'Note for Atlas' })
  await note.focus()
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+v' : 'Control+v',
  )
  await expect(note).toHaveValue(selected)
  await doc.getByRole('button', { name: /Revision 3/ }).click()
  await page
    .getByRole('menu', { name: 'Revisions' })
    .getByRole('menuitemradio', { name: /Rev 2/ })
    .click()
  await expect(doc.getByText('Read only.')).toBeVisible()
  await selectionStyle(field, 'text')
  await selectionStyle(doc.locator('.doc-code pre'), 'text')
  expect(await dragText(page, field)).not.toBe('')
})

test('retained send text and error details stay copyable while recovery actions remain chrome', async ({
  page,
}) => {
  await page.route('**/v1/text/submissions', (route) =>
    route.fulfill({
      status: 409,
      json: {
        version: 1,
        code: 'membership-removed',
        message: 'Diagnostic detail worth copying',
      },
    }),
  )
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Keep this rejected message to copy')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const body = page.locator('.recovery-body')
  await selectionStyle(body, 'text')
  await selectionStyle(page.locator('.rejection-reason'), 'text')
  await selectionStyle(
    page.getByRole('button', { name: 'Dismiss', exact: true }),
    'none',
  )
  expect(await dragText(page, body)).toContain('rejected')
})
