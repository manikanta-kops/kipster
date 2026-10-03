import { expect, test, demo, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'

type Inspected = {
  summary: { threadId: string; turn: string; currentRevision: number }
  draft: {
    blocks: { id: string; type: string; [key: string]: unknown }[]
    comments: { quote: string; body: string }[]
    note: string
  } | null
  comments: { number: number; state: string; reply: string | null }[]
  runId: string | null
}
const inspect = async (page: Page) =>
  ((await demo(page, '/inspect')) as { documents: Inspected[] }).documents[0]
const pane = (page: Page) =>
  page.getByRole('region', { name: 'Rich doc: Rich docs: v1 plan' })

async function openDoc(page: Page) {
  await page
    .getByRole('button', { name: 'Rich docs: v1 plan, needs you' })
    .click()
  await expect(pane(page).locator('h1.doc-title')).toHaveText(
    'Rich docs: v1 plan',
  )
}
/** Puts the caret at the end of a text field. */
async function typeAtEnd(page: Page, blockId: string, text: string) {
  const field = pane(page).locator(
    `[data-block="${blockId}"][data-field="text"]`,
  )
  await field.click()
  await field.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(range)
  })
  await page.keyboard.type(text)
}
async function saved(page: Page) {
  await expect(pane(page).getByText('Draft saved')).toBeVisible()
}

test('a shared doc opens from its thread card, expands and closes', async ({
  page,
}) => {
  await startDemo(page)
  await page
    .getByRole('button', { name: /Open thread: Think through rich docs/ })
    .click()
  const cards = page.getByRole('button', {
    name: 'Open rich doc: Rich docs: v1 plan',
  })
  await expect(cards).toHaveCount(3)
  await expect(cards.last()).toContainText('3 questions for you')
  await cards.last().click()
  const doc = pane(page)
  await expect(doc.getByRole('button', { name: /Revision 3/ })).toBeVisible()
  await expect(doc.locator('.fresh-tag')).toHaveCount(3)
  await doc.getByRole('button', { name: 'Expand doc' }).click()
  await expect(page.locator('.app-shell')).toHaveClass(/thread-expanded/)
  await doc.getByRole('button', { name: 'Restore split view' }).click()
  await doc.getByRole('button', { name: 'Comment 1' }).click()
  await expect(page.getByRole('dialog', { name: 'Comment 1' })).toContainText(
    'Workspace kips won’t see root docs',
  )
  await page.keyboard.press('Escape')
  await doc.getByRole('button', { name: 'Close doc' }).click()
  await expect(doc).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^Thread:/ })).toBeVisible()
})

test('answers, checks and edits are saved as a draft', async ({ page }) => {
  await startDemo(page)
  await openDoc(page)
  const doc = pane(page)
  await doc.getByRole('radio', { name: /Full view/ }).click()
  await doc.getByRole('checkbox', { name: /Kip tools/ }).check()
  await doc
    .getByRole('slider', { name: 'How confident are you in this plan?' })
    .focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await typeAtEnd(page, 'scope-text', ' Shared docs stay read only.')
  await expect(doc.getByText('2 of 3 answered')).toBeVisible()
  await saved(page)
  await expect
    .poll(async () => {
      const blocks = (await inspect(page)).draft?.blocks ?? []
      const find = (id: string) => blocks.find((b) => b.id === id)!
      return [
        (find('open-in').answer as { optionIds: string[] } | null)?.optionIds,
        (find('scope').items as { text: string; done: boolean }[])[2].done,
        find('confidence').value,
        String(find('scope-text').text).endsWith('Shared docs stay read only.'),
      ]
    })
    .toEqual([['full'], true, 4, true])
  await page.reload()
  await openDoc(page)
  await expect(
    pane(page).getByRole('radio', { name: /Full view/ }),
  ).toHaveAttribute('aria-checked', 'true')
  await expect(pane(page).getByText('2 edits')).toBeVisible()
})

test('a block added with slash and a comment on selected text', async ({
  page,
}) => {
  await startDemo(page)
  await openDoc(page)
  const doc = pane(page)
  await typeAtEnd(page, 'scope-text', '')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const menu = page.getByRole('menu', { name: 'Insert a block' })
  await expect(menu).toBeVisible()
  await page.keyboard.type('check')
  await expect(menu.getByRole('menuitem')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Write the release notes')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Tell the team')

  await doc.locator('[data-block="flow-title"]').click({ clickCount: 3 })
  await page
    .getByRole('toolbar', { name: 'Text tools' })
    .getByRole('button', { name: 'Comment' })
    .click()
  await page.keyboard.type('Can this section be shorter?')
  await page.keyboard.press('Enter')
  await expect(doc.getByRole('button', { name: 'Comment 2' })).toBeVisible()
  await expect(doc.getByText('1 comment', { exact: true })).toBeVisible()
  await saved(page)
  await expect
    .poll(async () => {
      const draft = (await inspect(page)).draft
      const added = draft?.blocks.find(
        (b) => b.type === 'checklist' && b.id !== 'scope',
      )
      return {
        items: (added?.items as { text: string }[] | undefined)?.map(
          (i) => i.text,
        ),
        comments: draft?.comments.map((c) => [c.quote, c.body]),
      }
    })
    .toEqual({
      items: ['Write the release notes', 'Tell the team'],
      comments: [['How a doc moves', 'Can this section be shorter?']],
    })
  await doc.getByRole('button', { name: 'Comment 2' }).click()
  await page
    .getByRole('dialog', { name: 'Comment 2' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await expect(doc.getByText('0 comments')).toBeVisible()
})

test('submit locks the doc until the kip publishes a revision', async ({
  page,
}) => {
  await startDemo(page)
  await openDoc(page)
  const doc = pane(page)
  await doc.getByRole('radio', { name: /Side by side/ }).click()
  await doc.locator('[data-block="flow-title"]').click({ clickCount: 3 })
  await page
    .getByRole('toolbar', { name: 'Text tools' })
    .getByRole('button', { name: 'Comment' })
    .click()
  await page.keyboard.type('Shorter, please.')
  await page.keyboard.press('Enter')
  await doc
    .getByRole('textbox', { name: 'Note for Atlas' })
    .fill('Mostly the layout question.')
  await doc.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(doc.getByText('Atlas is revising')).toBeVisible()
  await expect(doc.getByRole('radio', { name: /Full view/ })).toBeDisabled()
  await expect(
    doc.getByRole('button', { name: 'Submit', exact: true }),
  ).toHaveCount(0)
  const sent = await inspect(page)
  expect(sent.summary).toMatchObject({ turn: 'agent', currentRevision: 4 })
  expect(sent.comments.map((c) => [c.number, c.state])).toEqual([
    [1, 'resolved'],
    [2, 'open'],
  ])

  await demo(page, '/advance', { threadId: sent.summary.threadId, steps: 3 })
  await expect(doc.getByText('Atlas published revision 5.')).toBeVisible()
  await expect(doc.getByText('Atlas is revising')).toHaveCount(0)
  await expect(doc.getByRole('button', { name: /Revision 5/ })).toBeVisible()
  await expect(
    doc.getByText(/Decided: Side by side with the chat/),
  ).toBeVisible()
  await doc.getByRole('button', { name: 'Comment 2' }).click()
  await expect(page.getByRole('dialog', { name: 'Comment 2' })).toContainText(
    'Resolved',
  )
  await page.keyboard.press('Escape')
  await doc.getByRole('button', { name: /Revision 5/ }).click()
  await page
    .getByRole('menu', { name: 'Revisions' })
    .getByRole('menuitemradio', { name: /Rev 4 · You/ })
    .click()
  await expect(doc.getByText('Read only.')).toBeVisible()
  await doc.getByRole('button', { name: 'Back to latest' }).click()
  await expect(
    doc.getByRole('button', { name: 'Submit', exact: true }),
  ).toBeVisible()
})

test('take back stops the kip and returns the doc', async ({ page }) => {
  await startDemo(page)
  await openDoc(page)
  const doc = pane(page)
  await doc.getByRole('radio', { name: /Full view/ }).click()
  await doc.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(doc.getByText('Atlas is revising')).toBeVisible()
  const { summary } = await inspect(page)
  await demo(page, '/advance', { threadId: summary.threadId, steps: 2 })
  await doc.getByRole('button', { name: 'Take back' }).click()
  await expect(doc.getByText('You took the doc back.')).toBeVisible()
  await expect(
    doc.getByRole('button', { name: 'Submit', exact: true }),
  ).toBeVisible()
  const after = await inspect(page)
  expect(after.summary).toMatchObject({ turn: 'user', currentRevision: 4 })
  expect(after.runId).toBeNull()
  await demo(page, '/advance', { threadId: summary.threadId, steps: 3 })
  expect((await inspect(page)).summary.currentRevision).toBe(4)
})

test('Obsidian draws the doc on outline surfaces', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await startDemo(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page
    .locator('.palette-card')
    .filter({ has: page.getByRole('radio', { name: 'Obsidian' }) })
    .click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-surface', 'outline')
  await openDoc(page)
  const card = pane(page).locator('.doc-card.ask').first()
  await expect(card).toBeVisible()
  const background = await card.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  )
  expect(background).not.toMatch(/rgba\(.*, 0\)$/)
  await expect(
    pane(page).getByRole('button', { name: 'Submit', exact: true }),
  ).toBeVisible()
})
