import { expect, test, type Page } from '@playwright/test'

// The fixture kip in real-core-suite.mjs writes a "Trip plan" doc when a message
// asks it to "write a rich doc", and revises the doc when the user submits it.
const pane = (page: Page) =>
  page.getByRole('region', { name: /^Rich doc: Trip plan/ })

/** Puts the caret at the end of a text field. */
async function caretAtEnd(page: Page, text: string) {
  const field = pane(page)
    .locator('.doc-field[data-field="text"]')
    .filter({ hasText: text })
  await field.click()
  await field.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
}

test('a kip writes a rich doc, the user submits it and the kip revises it', async ({
  page,
}) => {
  test.skip(
    !process.env.KIPSTER_TEST_CORE_URL,
    'Requires an isolated real Core/PostgreSQL fixture',
  )
  await page.goto('/')
  await page
    .getByRole('navigation', { name: 'Kips' })
    .getByRole('button', { name: /^Root/ })
    .click()
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  const ask = `Please write a rich doc ${crypto.randomUUID()}`
  await page.getByRole('textbox', { name: 'Start a new thread' }).fill(ask)
  await page
    .getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await page
    .locator('.feed-message')
    .filter({ hasText: ask })
    .getByRole('button', { name: /^Open thread:/ })
    .press('Enter')
  const thread = page.getByRole('region', { name: 'Thread' })
  await expect(thread.getByText('Fixture wrote a rich doc.')).toBeVisible()
  const card = thread.getByRole('button', { name: 'Open rich doc: Trip plan' })
  await expect(card).toContainText('2 questions for you')
  await card.click()

  const doc = pane(page)
  await expect(
    doc.getByRole('button', { name: 'Revision 1, show revisions' }),
  ).toBeVisible()
  await doc.getByRole('radio', { name: /Oslo/ }).click()
  await doc.getByRole('checkbox', { name: 'Done: Book flights' }).check()
  const slider = doc.getByRole('slider', {
    name: 'How flexible are the dates?',
  })
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(slider).toHaveAttribute('aria-valuetext', '4')
  await caretAtEnd(page, 'We fly out in May.')
  await page.keyboard.type(' Two weeks.')
  for (let i = 0; i < 'weeks.'.length; i++)
    await page.keyboard.press('Shift+ArrowLeft')
  await page
    .getByRole('toolbar', { name: 'Text tools' })
    .getByRole('button', { name: 'Comment' })
    .click()
  await page.keyboard.type('Be specific')
  await page.keyboard.press('Enter')
  await expect(doc.getByRole('button', { name: 'Comment 1' })).toBeVisible()
  await expect(doc.getByText('2 of 2 answered')).toBeVisible()
  await expect(doc.getByText('Draft saved')).toBeVisible()
  await doc.getByRole('textbox', { name: 'Note for Root' }).fill('Oslo it is.')
  await doc.getByRole('button', { name: 'Submit', exact: true }).click()

  await expect(doc.getByText('Root is revising')).toBeVisible()
  await expect(
    doc.getByRole('button', { name: 'Submit', exact: true }),
  ).toHaveCount(0)
  await expect(doc.getByRole('radio', { name: /Oslo/ })).toBeDisabled()
  expect((await page.request.get('/__test-documents/release')).ok()).toBe(true)

  await expect(doc.getByText('Root is revising')).toHaveCount(0)
  await expect(doc.getByText('Root published revision 3.')).toBeVisible()
  await expect(
    doc.getByRole('button', { name: 'Revision 3, show revisions' }),
  ).toBeVisible()
  await expect(doc.getByText('Trip plan, revised')).toBeVisible()
  await expect(
    doc.getByText('The kip added this after your submission.'),
  ).toBeVisible()
  await expect(doc.getByText('We fly out in May. Two weeks.')).toBeVisible()
  await expect(doc.getByRole('radio', { name: /Oslo/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(slider).toHaveAttribute('aria-valuetext', '4')
  await expect(
    doc.getByRole('checkbox', { name: 'Done: Book flights' }),
  ).toBeChecked()
  await doc.getByRole('button', { name: 'Comment 1' }).click()
  const comment = page.getByRole('dialog', { name: 'Comment 1' })
  await expect(comment).toContainText('Resolved')
  await expect(comment).toContainText('Addressed: Be specific')
  await page.keyboard.press('Escape')
  await expect(
    doc.getByRole('button', { name: 'Submit', exact: true }),
  ).toBeVisible()

  // The doc's thread holds the submission and the kip's reply.
  await doc.getByRole('button', { name: 'Close doc' }).click()
  await expect(thread.getByText('Oslo it is.')).toBeVisible()
  await expect(thread.getByText('Fixture revised the doc.')).toBeVisible()
  await expect(thread.getByText('Rich doc · Rev 2')).toBeVisible()
})
