import { test, expect, type Page } from '@playwright/test'
import { startDemo, demo, storageFault, DEMO_IDS } from './demo.ts'
const title = 'Shape a calmer workspace for the next release'
const scope = {
  installationId: DEMO_IDS.installation,
  callerId: DEMO_IDS.caller,
}
const context = { kind: 'organization', organizationId: DEMO_IDS.organization }
const input = (page: Page) =>
  page.getByRole('textbox', { name: 'Start a new thread' })
async function setup(page: Page, faults: Record<string, string> = {}) {
  const session = await startDemo(page, { faults })
  await expect(input(page)).toBeVisible()
  return session
}
async function core(page: Page, path: string, data?: unknown) {
  const session = new URL(page.url()).searchParams.get('testCore')!
  const response =
    data === undefined
      ? await page.request.get(`/__test-core/${session}${path}`)
      : await page.request.post(`/__test-core/${session}${path}`, { data })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
async function target(page: Page) {
  const { chatId } = await core(page, '/v1/direct-chats', {
    version: 1,
    context,
    agentId: DEMO_IDS.researcher,
  })
  return { context, chatId }
}
async function submit(
  page: Page,
  text: string,
  threadId?: string,
  submissionId = crypto.randomUUID(),
) {
  return core(page, '/v1/text/submissions', {
    version: 1,
    scope,
    submissionId,
    target: await target(page),
    mode: threadId ? 'reply' : 'root',
    ...(threadId ? { threadId } : {}),
    parts: [{ kind: 'text', text }],
  })
}
async function messages(page: Page, text: string) {
  const state = await demo(page, '/inspect')
  return state.threads
    .flatMap((t: { messages: { parts: { text?: string }[] }[] }) => t.messages)
    .filter((m: { parts: { text?: string }[] }) =>
      m.parts.some((p) => p.text === text),
    )
}
async function saved(page: Page, text: string) {
  await expect
    .poll(() =>
      page.evaluate(
        async (text) =>
          new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open('kipster-conversations')
            open.onerror = () => reject(open.error)
            open.onsuccess = () => {
              const db = open.result
              const tx = db.transaction('drafts')
              const get = tx.objectStore('drafts').getAll()
              get.onsuccess = () =>
                resolve(
                  get.result.some(
                    (draft: { text: string }) => draft.text === text,
                  ),
                )
              tx.oncomplete = () => db.close()
            }
          }),
        text,
      ),
    )
    .toBe(true)
}
async function open(page: Page) {
  await page
    .getByRole('button', { name: `Open thread: ${title}`, exact: true })
    .click()
  return page.getByRole('region', { name: `Thread: ${title}`, exact: true })
}

test('concurrent resolution and accepted ID reuse preserve original action and content', async ({
  page,
}) => {
  await setup(page)
  const targets = await Promise.all(
    Array.from({ length: 6 }, () => target(page)),
  )
  expect(new Set(targets.map((t) => t.chatId)).size).toBe(1)
  const id = crypto.randomUUID()
  const receipts = await Promise.all([
    submit(page, 'Original intended content', undefined, id),
    submit(page, 'Original intended content', undefined, id),
  ])
  expect(receipts[0].messageId).toBe(receipts[1].messageId)
  const changed = await submit(
    page,
    'Changed reuse must not be accepted',
    undefined,
    id,
  )
  expect(changed.alreadyAccepted).toBe(true)
  expect(changed.messageId).toBe(receipts[0].messageId)
  expect(await messages(page, 'Original intended content')).toHaveLength(1)
  expect(
    await messages(page, 'Changed reuse must not be accepted'),
  ).toHaveLength(0)
  await submit(page, 'Original intended content')
  expect(await messages(page, 'Original intended content')).toHaveLength(2)
})

test('root and reply drafts survive reload and remain isolated', async ({
  page,
}) => {
  await setup(page)
  await input(page).fill('Durable root draft')
  await saved(page, 'Durable root draft')
  const pane = await open(page)
  await pane
    .getByRole('textbox', { name: 'Reply in this thread' })
    .fill('Durable reply draft')
  await saved(page, 'Durable reply draft')
  await page.reload()
  await expect(input(page)).toHaveValue('Durable root draft')
  if (!(await pane.isVisible())) await open(page)
  await expect(
    pane.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toHaveValue('Durable reply draft')
  await pane.getByRole('button', { name: 'Close thread' }).click()
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.studio)
  await expect(input(page)).toHaveValue('')
})

test('lost acknowledgement survives reload, receipt recovery never sends again', async ({
  page,
}) => {
  await setup(page)
  let writes = 0
  await page.route('**/v1/text/submissions', async (route) => {
    writes++
    await route.fetch()
    await route.abort()
  })
  await input(page).fill('Exactly one accepted action')
  await input(page).press('Enter')
  await expect(
    page
      .locator('.feed')
      .getByText('Exactly one accepted action', { exact: true }),
  ).toBeVisible()
  await input(page).fill('New text after send')
  await saved(page, 'New text after send')
  await page.reload()
  await expect(input(page)).toHaveValue('New text after send')
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0, { timeout: 15000 })
  expect(await messages(page, 'Exactly one accepted action')).toHaveLength(1)
  expect(writes).toBe(1)
})

test('missing receipt retains uncertainty and explicit retry reuses captured target and ID', async ({
  page,
}) => {
  await setup(page)
  let block = true
  const attempts: { submissionId: string; target: unknown }[] = []
  await page.route('**/v1/text/submissions', (route) => {
    attempts.push(route.request().postDataJSON())
    return block ? route.abort() : route.continue()
  })
  await input(page).fill('Original organization send')
  await input(page).press('Enter')
  await expect(
    page.getByText('Acceptance not yet confirmed', { exact: false }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByText('Acceptance not yet confirmed', { exact: false }),
  ).toBeVisible()
  expect(await messages(page, 'Original organization send')).toHaveLength(0)
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.studio)
  await expect(
    page.getByRole('region', {
      name: 'Saved drafts and sends from other conversations',
    }),
  ).toContainText('Original organization send')
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.organization)
  block = false
  await page
    .getByRole('button', { name: 'Check and retry original send' })
    .click()
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0, { timeout: 15000 })
  expect(attempts).toHaveLength(2)
  expect(attempts[1]).toEqual(attempts[0])
  expect(await messages(page, 'Original organization send')).toHaveLength(1)
})

test('late acknowledgement from one tab cannot resurrect settlement in another', async ({
  page,
  context,
}) => {
  const session = await setup(page)
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/v1/text/submissions', async (route) => {
    const response = await route.fetch()
    await held
    await route.fulfill({ response })
  })
  await input(page).fill('Shared receipt')
  await input(page).press('Enter')
  await expect(
    page.locator('.feed').getByText('Shared receipt', { exact: true }),
  ).toBeVisible()
  await input(page).fill('Keep newer draft')
  await saved(page, 'Keep newer draft')
  const other = await context.newPage()
  await startDemo(other, { session })
  await expect(input(other)).toHaveValue('Keep newer draft')
  await expect(
    other.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0)
  release()
  await expect(input(page)).toHaveValue('Keep newer draft')
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0, { timeout: 15000 })
  expect(await messages(page, 'Shared receipt')).toHaveLength(1)
})

test('safe markdown and stream finalization retain identity and unknown content renders generically', async ({
  page,
}) => {
  await setup(page)
  const state = await demo(page, '/inspect')
  const thread = state.threads.find(
    (t: { messages: { parts: { text?: string }[] }[] }) =>
      t.messages[0].parts[0].text === title,
  )
  const pane = await open(page)
  const message = {
    id: crypto.randomUUID(),
    threadId: thread.summary.threadId,
    authorId: DEMO_IDS.researcher,
    position: thread.messages.length + 1,
    revision: 1,
    final: false,
    parts: [{ kind: 'text', text: 'Stream fragment' }],
  }
  await demo(page, '/message', { threadId: message.threadId, message })
  await expect(pane.getByText('Stream fragment', { exact: true })).toHaveCount(
    1,
  )
  const final = {
    ...message,
    revision: 2,
    final: true,
    parts: [
      {
        kind: 'text',
        text: '**Final output**\n\n- one\n- two\n\n```js\n<script>alert(1)</script>\n```\n\n[Safe](https://example.com) [Unsafe](javascript:alert(1))',
      },
      { kind: 'text', text: 'After previous part' },
    ],
  }
  await demo(page, '/message', { threadId: message.threadId, message: final })
  await expect(pane.getByText('Final output', { exact: true })).toHaveCount(1)
  await expect(pane.getByText('Stream fragment', { exact: true })).toHaveCount(
    0,
  )
  await expect(pane.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(pane.getByRole('link', { name: 'Safe' })).toHaveAttribute(
    'href',
    'https://example.com',
  )
  await demo(page, '/message', { threadId: message.threadId, message })
  await expect(pane.getByText('Final output', { exact: true })).toHaveCount(1)
  await page.route(
    `**/v1/threads/${message.threadId}/snapshot*`,
    async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      const received = body.messages.find(
        (m: { id: string }) => m.id === message.id,
      )
      received.parts = [
        { kind: 'future-widget' },
        { kind: 'text', text: 4 },
        { kind: 'text', text: 'Readable part' },
      ]
      await route.fulfill({ response, json: body })
    },
  )
  await page.reload()
  if (!(await pane.isVisible())) await open(page)
  await expect(
    pane.getByText('Unsupported content: future-widget', { exact: true }),
  ).toBeVisible()
  await expect(pane.getByText('Readable part', { exact: true })).toBeVisible()
})

test('complete root snapshots preserve all older roots and deterministic order beyond one hundred', async ({
  page,
}) => {
  test.setTimeout(60000)
  const session = crypto.randomUUID()
  const endpoint = `/__test-core/${session}`
  const resolved = await page.request.post(`${endpoint}/v1/direct-chats`, {
    data: { version: 1, context, agentId: DEMO_IDS.researcher },
  })
  expect(resolved.ok()).toBeTruthy()
  const { chatId } = await resolved.json()
  const roots = new Map<string, string>()
  for (let n = 0; n < 101; n++) {
    const text = `History root ${String(n).padStart(3, '0')}`
    const response = await page.request.post(
      `${endpoint}/v1/text/submissions`,
      {
        data: {
          version: 1,
          scope,
          submissionId: crypto.randomUUID(),
          target: { context, chatId },
          mode: 'root',
          parts: [
            {
              kind: 'text',
              text,
            },
          ],
        },
      },
    )
    expect(response.ok()).toBeTruthy()
    roots.set((await response.json()).threadId, text)
  }
  // Timestamps can tie. Higher IDs are older, and reversed pages exercise
  // chronological order and ID tie-breaks independently of response order.
  const ids = [...roots.keys()].sort()
  const older = ids.slice(50)
  const newer = ids.slice(0, 50)
  const olderIds = new Set(older)
  const expected = [...older, ...newer].map((id) => roots.get(id))
  await page.route('**/v1/app/snapshot**', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    for (const summary of body.threads) {
      if (roots.has(summary.threadId))
        summary.createdAt = olderIds.has(summary.threadId)
          ? '2026-09-23T00:00:00.000Z'
          : '2026-09-23T00:00:01.000Z'
    }
    body.threads.reverse()
    await route.fulfill({ response, json: body })
  })
  await startDemo(page, { session })
  await page.reload()
  await expect(page.getByText('History root 100', { exact: true })).toHaveCount(
    1,
    { timeout: 30000 },
  )
  await expect(
    page
      .locator('.feed-message .message-text')
      .filter({ hasText: /^History root \d{3}$/ }),
  ).toHaveCount(101, { timeout: 30000 })
  await expect(page.getByText('History root 000', { exact: true })).toHaveCount(
    1,
  )
  const history = (
    await page.locator('.feed-message .message-text').allTextContents()
  ).filter((t) => t.startsWith('History root'))
  expect(history).toHaveLength(101)
  expect(history).toEqual(expected)
  expect(new Set(history).size).toBe(history.length)
})

test('delayed restoration cannot replace fresh typing and slow writes keep the latest edit', async ({
  page,
}) => {
  const session = await setup(page)
  await input(page).fill('Older saved value')
  await saved(page, 'Older saved value')
  await startDemo(page, { session, faults: { 'draft-read': 'hold' } })
  await input(page).fill('Typed while restoring')
  await storageFault(page, 'draft-read', 'allow')
  await expect(input(page)).toHaveValue('Typed while restoring')
  await saved(page, 'Typed while restoring')
  await storageFault(page, 'draft-write', 'hold')
  await input(page).fill('First slow edit')
  await input(page).fill('Newest slow edit')
  await storageFault(page, 'draft-write', 'allow')
  await saved(page, 'Newest slow edit')
  await startDemo(page, { session })
  await expect(input(page)).toHaveValue('Newest slow edit')
})

test('cross-tab draft conflict preserves editor text and conditionally resolves', async ({
  page,
  context,
}) => {
  const session = await setup(page)
  await input(page).fill('Shared baseline')
  await saved(page, 'Shared baseline')
  const other = await context.newPage()
  await startDemo(other, { session })
  await expect(input(other)).toHaveValue('Shared baseline')
  await storageFault(other, 'draft-write', 'hold')
  await input(other).fill('Keep this local editor')
  await input(page).fill('Saved from first tab')
  await saved(page, 'Saved from first tab')
  await storageFault(other, 'draft-write', 'allow')
  await expect(
    other.getByText(
      'This draft changed in another tab. Your text is preserved.',
    ),
  ).toBeVisible()
  await expect(input(other)).toHaveValue('Keep this local editor')
  await other.getByRole('button', { name: 'Keep my text' }).click()
  await saved(other, 'Keep this local editor')
  await expect(input(page)).toHaveValue('Keep this local editor')
})

test('draft failure and reservation failure preserve text and prevent dispatch', async ({
  page,
}) => {
  await setup(page, { 'draft-write': 'fail' })
  let writes = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/text/submissions')) writes++
  })
  await input(page).fill('Keep when storage fails')
  await expect(
    page.getByText('Draft is not saved on this device.'),
  ).toBeVisible()
  await input(page).press('Enter')
  await expect(input(page)).toHaveValue('Keep when storage fails')
  expect(writes).toBe(0)
  await storageFault(page, 'draft-write', 'allow')
  await page.getByRole('button', { name: 'Retry saving' }).click()
  await saved(page, 'Keep when storage fails')
  await storageFault(page, 'draft-reserve', 'fail')
  await input(page).press('Enter')
  await expect(
    page.getByRole('alert').filter({ hasText: 'draft-reserve unavailable' }),
  ).toBeVisible()
  await expect(input(page)).toHaveValue('Keep when storage fails')
  expect(writes).toBe(0)
})

test('newly enrolled agent resolves a usable empty chat through atomic management', async ({
  page,
}) => {
  await setup(page)
  await core(page, '/v1/agents', {
    version: 1,
    operationId: crypto.randomUUID(),
    name: 'New chat partner',
    description: 'Newly enrolled',
    organizationId: DEMO_IDS.organization,
  })
  await page
    .getByRole('button', { name: 'New chat partner', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'New chat partner', exact: true }),
  ).toBeVisible()
  await expect(input(page)).toBeEnabled()
  await input(page).fill('Hello new partner')
  await input(page).press('Enter')
  await expect(
    page.locator('.feed').getByText('Hello new partner', { exact: true }),
  ).toBeVisible()
  expect(await messages(page, 'Hello new partner')).toHaveLength(1)
})

test('snapshot cursor replays a concurrent event without a gap and background scope survives navigation', async ({
  page,
}) => {
  await setup(page)
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  let captured = false,
    first = true
  await page.route('**/v1/app/snapshot**', async (route) => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch()
    captured = true
    await held
    return route.fulfill({ response })
  })
  await page.reload()
  await expect.poll(() => captured).toBe(true)
  await submit(page, 'Between snapshot and subscription')
  release()
  await expect(
    page
      .locator('.feed')
      .getByText('Between snapshot and subscription', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.studio)
  await submit(page, 'Background organization update')
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.organization)
  await expect(
    page
      .locator('.feed')
      .getByText('Background organization update', { exact: true }),
  ).toBeVisible()
})

test('expired replay cursor takes a fresh snapshot and reconnect never dispatches work', async ({
  page,
}) => {
  await setup(page)
  let writes = 0,
    snapshots = 0
  page.on('request', (r) => {
    if (r.url().includes('/v1/app/snapshot')) snapshots++
    if (r.url().endsWith('/v1/text/submissions')) writes++
  })
  await demo(page, '/retention', {})
  await expect.poll(() => snapshots).toBeGreaterThan(0)
  await expect(
    page.getByRole('button', { name: `Open thread: ${title}`, exact: true }),
  ).toBeVisible()
  expect(writes).toBe(0)
  await submit(page, 'After cursor reset')
  await expect(
    page.locator('.feed').getByText('After cursor reset', { exact: true }),
  ).toBeVisible()
  expect(await messages(page, 'After cursor reset')).toHaveLength(1)
})

test('thread switch fences a late snapshot and replaces the detailed subscription', async ({
  page,
}) => {
  await setup(page)
  const { threads } = await demo(page, '/inspect')
  const first = threads.find(
    (t: { messages: { parts: { text?: string }[] }[] }) =>
      t.messages[0].parts[0].text === title,
  )
  const alternate = threads.find(
    (t: { summary: { chatId: string; threadId: string } }) =>
      t.summary.chatId === first.summary.chatId &&
      t.summary.threadId !== first.summary.threadId,
  )
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  let captured = false
  await page.route(
    `**/v1/threads/${first.summary.threadId}/snapshot**`,
    async (route) => {
      const response = await route.fetch()
      captured = true
      await held
      await route.fulfill({ response }).catch(() => {})
    },
  )
  await open(page)
  await expect.poll(() => captured).toBe(true)
  const alternateTitle = alternate.messages[0].parts[0].text
  await page
    .getByRole('button', {
      name: `Open thread: ${alternateTitle}`,
      exact: true,
    })
    .press('Enter')
  release()
  await expect(
    page.getByRole('region', { name: `Thread: ${title}`, exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('region', {
      name: `Thread: ${alternateTitle}`,
      exact: true,
    }),
  ).toBeVisible()
})

test('intentional identical sends get new identities and independent roots', async ({
  page,
}) => {
  await setup(page)
  const ids: string[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/text/submissions'))
      ids.push(r.postDataJSON().submissionId)
  })
  for (let n = 0; n < 2; n++) {
    await input(page).fill('Intentional duplicate')
    await input(page).press('Enter')
    await expect(input(page)).toHaveValue('')
    await expect(
      page.locator('.feed').getByText('Intentional duplicate', { exact: true }),
    ).toHaveCount(n + 1)
  }
  expect(new Set(ids).size).toBe(2)
  const received = await messages(page, 'Intentional duplicate')
  expect(
    new Set(received.map((m: { threadId: string }) => m.threadId)).size,
  ).toBe(2)
})

test('authoritative rejection is retained distinctly and never retried as uncertain', async ({
  page,
}) => {
  await setup(page)
  let writes = 0
  await page.route('**/v1/text/submissions', (route) => {
    writes++
    return route.fulfill({
      status: 409,
      json: {
        version: 1,
        code: 'membership-removed',
        message: 'A participant no longer belongs to this organization.',
      },
    })
  })
  await input(page).fill('Rejected membership send')
  await input(page).press('Enter')
  await expect(
    page.getByText('New thread · Not accepted', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByText('New thread · Not accepted', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Check and retry original send' }),
  ).toHaveCount(0)
  expect(writes).toBe(1)
  expect(await messages(page, 'Rejected membership send')).toHaveLength(0)
})

test('connection changes isolate drafts and pending sends with identical installation IDs', async ({
  page,
}) => {
  const session = await setup(page)
  await page.route('**/v1/text/submissions', (route) => route.abort())
  await input(page).fill('Uncertain original destination')
  await input(page).press('Enter')
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(1)
  await expect(input(page)).toHaveValue('')
  await input(page).fill('Original destination draft')
  await saved(page, 'Original destination draft')
  await startDemo(page)
  await expect(input(page)).toHaveValue('')
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0, { timeout: 15000 })
  await startDemo(page, { session })
  await expect(input(page)).toHaveValue('Original destination draft')
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(1)
  expect(await messages(page, 'Uncertain original destination')).toHaveLength(0)
})

test('new root content does not move a reader away from older messages', async ({
  page,
}) => {
  await setup(page)
  for (let n = 0; n < 8; n++)
    await submit(
      page,
      `Reading history ${n}\n\n${'A paragraph to read. '.repeat(12)}`,
    )
  await page.reload()
  await expect(
    page.locator('.feed').getByText('Reading history 7', { exact: false }),
  ).toBeVisible()
  await expect(
    page.locator('.feed').getByText('Loading thread…', { exact: true }),
  ).toHaveCount(0)
  const scroll = page.locator('.conversation-scroll')
  await scroll.evaluate((el) => {
    el.scrollTop = 180
    el.dispatchEvent(new Event('scroll'))
  })
  const before = await scroll.evaluate((el) => el.scrollTop)
  await submit(page, 'New while reading old')
  await expect(
    page.getByRole('button', { name: 'Back to latest messages' }),
  ).toBeVisible()
  expect(
    Math.abs((await scroll.evaluate((el) => el.scrollTop)) - before),
  ).toBeLessThan(10)
  await expect(
    page.getByRole('button', { name: 'Back to latest messages' }),
  ).toHaveCSS('border-radius', '999px')
  await expect(
    page.getByRole('button', { name: 'Back to latest messages' }),
  ).toHaveCSS('display', 'flex')
  await page.getByRole('button', { name: 'Back to latest messages' }).click()
  await expect(
    page.getByText('New while reading old', { exact: true }),
  ).toBeInViewport()
})

test('snapshot history failure renders unavailable and recovers without duplicate roots', async ({
  page,
}) => {
  let fail = true
  await page.route('**/v1/app/snapshot**', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: {
            version: 1,
            code: 'unavailable',
            message: 'History temporarily unavailable',
          },
        })
      : route.continue(),
  )
  await startDemo(page)
  await expect(
    page.getByText('Live connection interrupted. Reconnecting…', {
      exact: false,
    }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Try again', exact: true })
    .first()
    .click()
  fail = false
  await expect(
    page.getByRole('button', { name: `Open thread: ${title}`, exact: true }),
  ).toHaveCount(1)
})

test('caller scope cannot dispatch into another callers chat or consume its saved journal', async ({
  page,
}) => {
  await setup(page)
  await input(page).fill('Original human draft')
  await saved(page, 'Original human draft')
  const session = new URL(page.url()).searchParams.get('testCore')
  const response = await page.request.post(
    `/__test-core/${session}/v1/text/submissions`,
    {
      data: {
        version: 1,
        submissionId: crypto.randomUUID(),
        scope: { ...scope, callerId: crypto.randomUUID() },
        target: await target(page),
        mode: 'root',
        parts: [{ kind: 'text', text: 'Unauthorized send' }],
      },
    },
  )
  expect(response.status()).toBe(403)
  expect(await messages(page, 'Unauthorized send')).toHaveLength(0)
  await page.reload()
  await expect(input(page)).toHaveValue('Original human draft')
})

test('thread snapshot windows retain ordered replies beyond one hundred without duplicate roots', async ({
  page,
}) => {
  await setup(page)
  const { threads } = await demo(page, '/inspect')
  const thread = threads.find(
    (t: { messages: { parts: { text?: string }[] }[] }) =>
      t.messages[0].parts[0].text === title,
  )
  for (let n = 0; n < 105; n++)
    await submit(
      page,
      `Older reply ${String(n).padStart(3, '0')}`,
      thread.summary.threadId,
    )
  await page.reload()
  const pane = await open(page)
  await expect(
    pane.locator('.thread-reply').getByText('Older reply 104', { exact: true }),
  ).toHaveCount(1)
  await expect(
    pane.locator('.thread-reply').getByText('Older reply 000', { exact: true }),
  ).toHaveCount(0)
  await pane
    .getByRole('button', { name: 'Older messages', exact: true })
    .click()
  await expect(
    pane.locator('.thread-reply').getByText('Older reply 000', { exact: true }),
  ).toHaveCount(1)
  const texts = (
    await pane.locator('.thread-reply .message-text').allTextContents()
  ).filter((t) => t.startsWith('Older reply'))
  expect(texts).toEqual([...texts].sort())
  expect(new Set(texts).size).toBe(texts.length)
  await pane
    .getByRole('button', { name: 'Latest messages', exact: true })
    .click()
  await expect(
    pane.locator('.thread-reply').getByText('Older reply 104', { exact: true }),
  ).toBeInViewport()
  await submit(page, 'Reply arriving after Latest', thread.summary.threadId)
  await expect(
    pane
      .locator('.thread-reply')
      .getByText('Reply arriving after Latest', { exact: true }),
  ).toBeInViewport()
  await expect(
    pane.getByRole('button', { name: 'Back to latest messages' }),
  ).toHaveCount(0)
  await pane
    .getByRole('button', { name: 'Older messages', exact: true })
    .click()
  await expect(
    pane.getByRole('button', { name: 'Older messages', exact: true }),
  ).toBeInViewport()
  await pane
    .locator('.thread-reply')
    .getByText('Older reply 000', { exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    pane.locator('.thread-reply').getByText('Older reply 000', { exact: true }),
  ).toBeInViewport()
  const scroll = pane.locator('.thread-scroll')
  const readingPosition = await scroll.evaluate((el) => el.scrollTop)
  await submit(
    page,
    'Reply arriving while reading older',
    thread.summary.threadId,
  )
  await expect(
    pane.getByRole('button', { name: 'Back to latest messages' }),
  ).toBeVisible()
  expect(
    Math.abs((await scroll.evaluate((el) => el.scrollTop)) - readingPosition),
  ).toBeLessThan(10)
  await expect(
    pane.getByRole('button', { name: 'Back to latest messages' }),
  ).toHaveCSS('border-radius', '999px')
  await expect(
    pane.getByRole('button', { name: 'Back to latest messages' }),
  ).toHaveCSS('display', 'flex')
  await pane.getByRole('button', { name: 'Back to latest messages' }).click()
  await expect(
    pane
      .locator('.thread-reply')
      .getByText('Reply arriving while reading older', { exact: true }),
  ).toBeInViewport()
})

test('a version 2 response with an unknown interaction kind still displays the thread', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/v1/app/snapshot*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.version = 2
    body.notifications[0].kind = 'digest'
    await route.fulfill({ response, json: body })
  })
  await page.route('**/v1/threads/*/snapshot*', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.version = 2
    for (const work of body.work) work.state = 'paused'
    body.interactions.push({
      version: 2,
      id: 'future-interaction',
      runId: 'future-run',
      attemptId: 'future-attempt',
      kind: 'future-card',
      prompt: 'A newer interaction',
      options: [],
      freeText: false,
      state: 'pending',
      revision: 1,
    })
    await route.fulfill({ json: body })
  })
  await setup(page)
  await page.getByRole('button', { name: /^Notifications, / }).click()
  await expect(page.locator('.note[data-kind="digest"]')).toContainText(
    'has an update',
  )
  await page.keyboard.press('Escape')
  const pane = await open(page)
  await expect(
    pane.getByRole('heading', { name: 'A newer interaction' }),
  ).toBeVisible()
  await expect(pane.getByText('future-card', { exact: false })).toBeVisible()
  await expect(
    pane.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeVisible()
  await expect(pane.locator('.work-block-word')).toContainText('paused')
  await expect(page.getByText(/Backend.*incompatible/)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('malformed stream response refuses invalid content and reconnect re-snapshots', async ({
  page,
}) => {
  let first = true,
    snapshots = 0
  page.on('request', (r) => {
    if (r.url().includes('/v1/app/snapshot')) snapshots++
  })
  await page.route('**/v1/app/events?**', (route) => {
    if (first) {
      first = false
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"broken":\n\n',
      })
    }
    return route.continue()
  })
  await setup(page)
  await expect(page.getByText(/Backend.*incompatible/)).toBeVisible()
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect.poll(() => snapshots).toBeGreaterThanOrEqual(2)
  await submit(page, 'Recovered after malformed event')
  await expect(
    page
      .locator('.feed')
      .getByText('Recovered after malformed event', { exact: true }),
  ).toBeVisible()
})
