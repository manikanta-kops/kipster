import type { Page } from '@playwright/test'
import { test, expect, startDemo, demo, DEMO_IDS } from './demo.ts'

// Fake Core seeds Rowan's Berlin thread in Personal, which asked the admin kip, who answered,
// and the admin kip's own thread, which asked Rowan twice and still waits for the second answer.
const berlin = 'Research a 3-day Berlin trip in May, around the 14th.'
const plans = 'Turn every confirmed plan into one summary for me.'
const feedback = 'Berlin research so far: train on May 14'
const confirmed =
  'Which plans are confirmed? Send me the dates and status of each.'
// A thread's title is its first text, cut to 55 characters.
const confirmedTitle = confirmed.slice(0, 55).trim()

const pane = (page: Page) => page.locator('.thread-pane')
/** The open thread, once the pane it replaced has gone. */
async function shown(page: Page, title: string | RegExp) {
  await expect(
    page.getByRole('region', {
      name:
        typeof title === 'string'
          ? `Thread: ${title}`
          : new RegExp(`^Thread: ${title.source}`),
    }),
  ).toBeVisible()
  await expect(page.locator('.thread-pane')).toHaveCount(1)
}
const feed = (page: Page) => page.locator('.feed-message')
const card = (page: Page, text: string) => feed(page).filter({ hasText: text })
const island = (page: Page) =>
  page.locator('.toolbar .status-island .island-word')
const islandName = (page: Page) => page.locator('.toolbar .status-island h1')
const organization = (page: Page) =>
  page.getByRole('combobox', { name: 'Organization', exact: true })
const openAdmin = (page: Page) =>
  page.locator('.installation-agents button').first().click()
async function openRowan(page: Page) {
  await organization(page).selectOption(DEMO_IDS.personal)
  await page
    .locator('#workspace-sidebar')
    .getByRole('button', { name: 'Rowan', exact: true })
    .first()
    .click()
}
const openThread = (page: Page, title: string | RegExp) =>
  page
    .getByRole('button', {
      name:
        typeof title === 'string'
          ? `Open thread: ${title}`
          : new RegExp(`^Open thread: ${title.source}`),
    })
    .click()
async function threadOf(page: Page, text: string) {
  const state = await demo(page, '/inspect')
  return state.threads.find(
    (t: { messages: { parts: { text?: string }[] }[] }) =>
      t.messages[0]?.parts[0]?.text === text,
  ) as {
    summary: {
      threadId: string
      state: string
      links?: { waiting: boolean }[]
    }
  }
}

test.beforeEach(async ({ page }) => {
  await startDemo(page)
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
})

test('a linked thread names its sender in the feed, its pane chips and banner', async ({
  page,
}) => {
  await openAdmin(page)
  const linked = card(page, feedback)
  await expect(linked.locator('.message-meta strong')).toHaveText('Rowan')
  await expect(linked.locator('.kip-tag')).toHaveText('Kip message')
  await expect(linked.locator('.message-meta time')).toBeVisible()
  await expect(linked.locator('.kip-via')).toHaveText(
    `From “${berlin}” in Rowan’s chat`,
  )
  // The footer is the usual one: a finished thread shows only its replies.
  await expect(linked.locator('.reply-count')).toHaveText('1 reply')
  await expect(linked.locator('.reply-description')).toHaveCount(0)
  await expect(linked.locator('.work-status')).toHaveCount(0)
  // A person's own thread carries no kip labels.
  await expect(card(page, plans).locator('.kip-tag, .kip-via')).toHaveCount(0)

  await openThread(page, /Berlin research so far/)
  await expect(pane(page).locator('.kip-link-label')).toHaveText([
    `From Rowan · ${berlin}`,
  ])
  await expect(pane(page).locator('.kip-banner-text')).toHaveText(
    `Rowan started this thread from “${berlin}”. Kip’s answers go back there.`,
  )
  const incoming = pane(page).locator('.thread-reply').first()
  await expect(incoming.locator('.message-meta strong')).toHaveText('Rowan')
  await expect(incoming.locator('.kip-tag, .role-label')).toHaveCount(0)
  await expect(incoming.locator('.kip-via')).toHaveText(
    `Sent from “${berlin}” in Rowan’s chat`,
  )
  // Messages by the admin kip carry its role after the name, in the thread only.
  const reply = pane(page).locator('.thread-reply').nth(1)
  await expect(reply.locator('.message-meta strong')).toHaveText('Kip')
  await expect(reply.locator('.role-label')).toHaveText('admin kip')
  await expect(reply.locator('.kip-via')).toHaveCount(0)
  await expect(card(page, plans).locator('.role-label')).toHaveCount(0)
  // A long source title shrinks inside the header and leaves its buttons usable.
  // Read both edges in one frame while the pane animates into view.
  await expect
    .poll(() =>
      pane(page).evaluate((element) => {
        const chip = element.querySelector('.kip-link-chip')!
        const actions = element.querySelector('.header-actions')!
        return (
          chip.getBoundingClientRect().right -
          actions.getBoundingClientRect().left
        )
      }),
    )
    .toBeLessThanOrEqual(1)
  await pane(page).getByRole('button', { name: 'Close thread' }).click()
  await expect(pane(page)).toHaveCount(0)
})

test('a source thread shows its sent cards, the answer and that it waits', async ({
  page,
}) => {
  await openAdmin(page)
  await expect(page.locator('.kip-home .kip-wait')).toHaveText(
    'Waiting for Rowan',
  )
  await expect(island(page)).toHaveText('Waiting for Rowan', {
    timeout: 10_000,
  })
  await expect(card(page, plans).locator('.work-status')).toHaveText(
    'Waiting for Rowan',
  )
  await openThread(page, plans)
  await expect(pane(page).locator('.kip-link-label')).toHaveText([
    'Linked: Rowan’s thread',
  ])
  await expect(pane(page).locator('.kip-banner')).toHaveCount(0)
  const sent = pane(page).locator('.kip-sent')
  await expect(sent).toHaveCount(2)
  await expect(sent.locator('.kip-sent-top')).toHaveText([
    'Sent to Rowan',
    'Sent to Rowan',
  ])
  await expect(sent.first()).toContainText(confirmed)
  await expect(sent.first().locator('.kip-sent-foot')).toContainText(
    'Rowan’s answer comes back here',
  )
  await expect(
    sent.first().getByRole('button', { name: 'Open in Rowan’s chat' }),
  ).toBeVisible()
  // A sent card stands under the message before it, without a name of its own.
  const cardReply = pane(page)
    .locator('.thread-reply')
    .filter({ has: page.locator('.kip-sent') })
    .first()
  await expect(cardReply.locator('.message-meta, .avatar')).toHaveCount(0)
  await expect(cardReply.locator('.message-body > .sr-only')).toContainText(
    'Kip',
  )
  const answer = pane(page)
    .locator('.thread-reply')
    .filter({ hasText: 'Only the Berlin trip' })
  await expect(answer.locator('.message-meta strong')).toHaveText('Rowan')
  await expect(answer.locator('.kip-via')).toHaveText(
    'Answer from Rowan’s thread',
  )
  await expect(pane(page).locator('.kip-waiting')).toHaveText(
    'Waiting for Rowan. Kip’s turn has ended; the answer will wake it.',
  )
})

test('a workspace kip that waits says so in the sidebar, the island and the thread', async ({
  page,
}) => {
  await openRowan(page)
  const source = (await threadOf(page, berlin)).summary
  const row = page
    .locator('#workspace-sidebar .agent-button')
    .filter({ hasText: 'Rowan' })
  await expect(row.locator('.agent-line')).toHaveText(
    'Engineering and delivery',
  )
  const state = await demo(page, '/inspect')
  const kipThread = state.threads.find(
    (t: { summary: { linkedFrom?: { threadId: string } } }) =>
      t.summary.linkedFrom?.threadId === source.threadId,
  ).summary
  await demo(page, '/summary', {
    threadId: source.threadId,
    links: [
      {
        agentId: DEMO_IDS.rootAgent,
        threadId: kipThread.threadId,
        chatId: kipThread.chatId,
        waiting: true,
      },
    ],
  })
  await expect(row.locator('.agent-line')).toHaveText('Waiting for Kip')
  // Rowan is busy in another thread of this chat, so the island shows that work.
  await expect(island(page)).toHaveText('Thinking')
  await expect(card(page, berlin).locator('.work-status')).toHaveText(
    'Waiting for Kip',
  )
  await openThread(page, berlin)
  await expect(pane(page).locator('.kip-waiting')).toHaveText(
    'Waiting for Kip. Rowan’s turn has ended; the answer will wake it.',
  )
  const answer = pane(page)
    .locator('.thread-reply')
    .filter({ hasText: 'Drop the hotel' })
  await expect(answer.locator('.role-label')).toHaveText('admin kip')
  await expect(answer.locator('.kip-via')).toHaveText(
    'Answer from Kip’s thread',
  )
})

test('every kip link opens the other thread, switching workspace or chat', async ({
  page,
}) => {
  await expect(organization(page)).toHaveValue(DEMO_IDS.organization)
  await openAdmin(page)
  await openThread(page, plans)
  // Sent card → Rowan's linked thread in the Personal workspace.
  await pane(page)
    .getByRole('button', { name: 'Open in Rowan’s chat' })
    .first()
    .click()
  await expect(organization(page)).toHaveValue(DEMO_IDS.personal)
  await expect(islandName(page)).toHaveText('Rowan')
  await shown(page, confirmedTitle)
  await expect(pane(page).locator('.kip-banner-text')).toHaveText(
    `Kip started this thread from “${plans}”. Rowan’s answers go back there.`,
  )
  const incoming = pane(page).locator('.thread-reply').first()
  await expect(incoming.locator('.role-label')).toHaveText('admin kip')
  await expect(incoming.locator('.kip-via')).toHaveText(
    `Sent from “${plans}” in Kip’s chat`,
  )
  await expect(card(page, confirmed).locator('.kip-tag')).toHaveText(
    'Kip message',
  )
  await expect(card(page, confirmed).locator('.work-status')).toHaveText(
    'Working',
  )
  // From chip → the admin kip's installation chat.
  await pane(page)
    .getByRole('button', { name: `From Kip · ${plans}` })
    .click()
  await shown(page, plans)
  await expect(page.locator('.kip-home')).toHaveAttribute(
    'aria-current',
    'page',
  )
  // Linked chip → Rowan's thread again, then the feed line back to the source.
  await pane(page)
    .getByRole('button', { name: 'Linked: Rowan’s thread' })
    .click()
  await shown(page, confirmedTitle)
  await card(page, confirmed)
    .getByRole('button', { name: `From “${plans}” in Kip’s chat` })
    .click()
  await shown(page, plans)
  // Answer → Rowan's linked thread.
  await pane(page)
    .getByRole('button', { name: 'Answer from Rowan’s thread' })
    .click()
  await shown(page, confirmedTitle)
  // Rowan's Berlin thread: its sent card and answer open the admin kip's linked thread.
  await openThread(page, berlin)
  await pane(page).getByRole('button', { name: 'Open in Kip’s chat' }).click()
  await shown(page, /Berlin research so far/)
  await expect(page.locator('.kip-home')).toHaveAttribute(
    'aria-current',
    'page',
  )
  await pane(page)
    .getByRole('button', { name: `Sent from “${berlin}” in Rowan’s chat` })
    .click()
  await shown(page, berlin)
  await expect(islandName(page)).toHaveText('Rowan')
  await pane(page)
    .getByRole('button', { name: 'Answer from Kip’s thread' })
    .click()
  await shown(page, /Berlin research so far/)
  // A workspace switch the other way: from Personal back to Kipster's admin view.
  await organization(page).selectOption(DEMO_IDS.organization)
  await card(page, feedback)
    .getByRole('button', { name: `From “${berlin}” in Rowan’s chat` })
    .click()
  await expect(organization(page)).toHaveValue(DEMO_IDS.personal)
  await shown(page, berlin)
})

test('the waiting line gives way to the thread’s own turn', async ({
  page,
}) => {
  await openAdmin(page)
  await openThread(page, plans)
  const waiting = pane(page).locator('.kip-waiting')
  await expect(waiting).toBeVisible()
  // A reply starts the admin kip's own turn: the working state shows instead.
  await pane(page)
    .getByRole('textbox', { name: 'Reply in this thread' })
    .fill('Leave the Q4 launch out for now.')
  await pane(page)
    .getByRole('button', { name: 'Send message', exact: true })
    .click()
  await expect(
    pane(page).getByText('Leave the Q4 launch out for now.'),
  ).toBeVisible()
  await expect(waiting).toHaveCount(0)
  await expect(card(page, plans)).not.toContainText('Waiting for Rowan')
  await expect(page.locator('.kip-home .kip-wait')).toHaveCount(0)
})

test('an answer lands under the recipient’s name and the woken kip ends silently', async ({
  page,
}) => {
  await openAdmin(page)
  await openThread(page, plans)
  const replies = pane(page).locator('.thread-reply')
  await expect(replies).toHaveCount(4)
  // Rowan finishes; the answer lands here under Rowan's name and the wait ends.
  await demo(page, '/advance', {
    threadId: (await threadOf(page, confirmed)).summary.threadId,
    steps: 3,
  })
  await expect(replies).toHaveCount(5)
  await expect(replies.last().locator('.message-meta strong')).toHaveText(
    'Rowan',
  )
  await expect(replies.last().locator('.kip-via')).toHaveText(
    'Answer from Rowan’s thread',
  )
  await expect(pane(page).locator('.kip-waiting')).toHaveCount(0)
  await expect(page.locator('.kip-home .kip-wait')).toHaveCount(0)
  // The answer woke the admin kip; with nothing to add, its turn ends without a message.
  const source = (await threadOf(page, plans)).summary.threadId
  await demo(page, '/advance', { threadId: source, steps: 2 })
  await expect
    .poll(async () => (await threadOf(page, plans)).summary.state)
    .toBe('completed')
  expect(
    (await threadOf(page, plans)).summary.links?.map((l) => l.waiting),
  ).toEqual([false])
  await expect(card(page, plans).locator('.work-status')).toHaveCount(0)
  await expect(replies).toHaveCount(5)
})

test('the filter capsule opens on click, filters the feed and clears', async ({
  page,
}) => {
  await openAdmin(page)
  await expect(feed(page)).toHaveCount(3)
  const trigger = page.getByRole('button', { name: 'Filter threads' })
  const menu = page.getByRole('menu', { name: 'Show threads' })
  await expect(menu).toBeHidden()
  // Hovering does nothing; a click opens the menu.
  await trigger.hover()
  await expect(menu).toBeHidden()
  await trigger.click()
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  const item = (name: string) =>
    menu.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })
  await expect(item('All threads')).toHaveAttribute('aria-checked', 'true')
  await expect(item('All threads').locator('.filter-count')).toHaveText('3')
  await expect(item('Started by you').locator('.filter-count')).toHaveText('2')
  await expect(item('From other kips').locator('.filter-count')).toHaveText('1')
  await expect(item('From other kips').locator('.avatar')).toHaveText('R')

  await item('From other kips').click()
  await expect(feed(page)).toHaveCount(1)
  await expect(card(page, feedback)).toBeVisible()
  await expect(menu).toBeHidden()
  // A second click closes the menu, and so does a click outside it.
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(menu).toBeVisible()
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(menu).toBeHidden()
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(menu).toBeVisible()
  await page.mouse.click(700, 700)
  await expect(menu).toBeHidden()
  const capsule = page.locator('.thread-filter .capsule')
  await expect(capsule).toContainText('From other kips')

  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await item('Started by you').click()
  await expect(feed(page)).toHaveCount(2)
  await expect(card(page, plans)).toBeVisible()
  await expect(card(page, feedback)).toHaveCount(0)

  await page.getByRole('button', { name: 'Show all threads' }).click()
  await expect(feed(page)).toHaveCount(3)
  await expect(capsule).not.toContainText('Started by you')

  // Rowan's chat has one thread from the admin kip.
  await openRowan(page)
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(item('All threads').locator('.filter-count')).toHaveText('3')
  await expect(item('From other kips').locator('.filter-count')).toHaveText('1')
  await expect(item('From other kips').locator('.avatar.kip')).toHaveCount(1)
  // The choice holds in every chat; Atlas's chat has no thread from another kip.
  await item('From other kips').click()
  await expect(feed(page)).toHaveCount(1)
  await organization(page).selectOption(DEMO_IDS.organization)
  await page
    .locator('#workspace-sidebar')
    .getByRole('button', { name: 'Atlas', exact: true })
    .first()
    .click()
  await expect(page.locator('.feed-filter-empty')).toHaveText(
    'No kip has messaged Atlas yet.',
  )
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(item('From other kips')).toHaveAttribute('aria-checked', 'true')
  await expect(item('From other kips').locator('.filter-count')).toHaveText('0')
})

test('routine runs have their own filter, and Core keeps the choice', async ({
  page,
}) => {
  await openAdmin(page)
  await expect(feed(page)).toHaveCount(3)
  const run = (await threadOf(page, plans)).summary
  await demo(page, '/summary', {
    threadId: run.threadId,
    routine: { id: crypto.randomUUID(), name: 'Weekly plans' },
  })
  const menu = page.getByRole('menu', { name: 'Show threads' })
  const item = (name: string) =>
    menu.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })
  await page.getByRole('button', { name: /^Filter threads/ }).click()
  await expect(item('All threads').locator('.filter-count')).toHaveText('3')
  // A routine run counts only under Routines, though the person started it.
  await expect(item('Started by you').locator('.filter-count')).toHaveText('1')
  await expect(item('Routines').locator('.filter-count')).toHaveText('1')
  await item('Routines').click()
  await expect(feed(page)).toHaveCount(1)
  await expect(card(page, plans)).toBeVisible()
  await page.reload()
  await openAdmin(page)
  await expect(feed(page)).toHaveCount(1)
  await expect(page.locator('.thread-filter .capsule')).toContainText(
    'Routines',
  )
  // Atlas has run no routine.
  await organization(page).selectOption(DEMO_IDS.organization)
  await page
    .locator('#workspace-sidebar')
    .getByRole('button', { name: 'Atlas', exact: true })
    .first()
    .click()
  await expect(page.locator('.feed-filter-empty')).toHaveText(
    'Atlas hasn’t run a routine yet.',
  )
})

test('the filter menu works from the keyboard and is kept', async ({
  page,
}) => {
  await openAdmin(page)
  await openThread(page, plans)
  const trigger = page.getByRole('button', { name: /^Filter threads/ })
  const menu = page.getByRole('menu', { name: 'Show threads' })
  // Keyboard focus alone leaves the menu closed; Escape closes it and keeps focus.
  await page
    .getByRole('button', { name: /^Switch to (dark|light) mode$/ })
    .focus()
  await page.keyboard.press('Shift+Tab')
  await expect(trigger).toBeFocused()
  await expect(menu).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  // Arrow keys move into and through the menu; Enter chooses and returns focus.
  await page.keyboard.press('ArrowDown')
  await expect(menu).toBeVisible()
  await expect(
    menu.getByRole('menuitemradio', { name: /^All threads/ }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(
    menu.getByRole('menuitemradio', { name: /^From other kips/ }),
  ).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute(
    'aria-label',
    'Filter threads: From other kips',
  )
  await expect(feed(page)).toHaveCount(1)
  // Escape from inside the menu closes it and returns focus to the button.
  await page.keyboard.press('ArrowDown')
  await expect(
    menu.getByRole('menuitemradio', { name: /^From other kips/ }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  // Escape in the menu leaves the open thread alone.
  await shown(page, plans)
  await expect(feed(page)).toHaveCount(1)
  // Core keeps the choice: a reload shows the same threads.
  await page.reload()
  await openAdmin(page)
  await expect(feed(page)).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Filter threads: From other kips' }),
  ).toBeVisible()
})
