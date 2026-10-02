import type { Page } from '@playwright/test'
import { test, expect, startDemo, demo, DEMO_IDS as ids } from './demo.ts'
import { setupWork, patchWork } from './work-helpers.ts'
import {
  deriveThreadState,
  summarize,
} from '../src/features/status/live-state.ts'
import { emptyWork, type WorkRecords } from '../src/data/work.ts'
import {
  actionItems,
  type InboxNotification,
} from '../src/data/notifications.ts'

const scope = {
  installationId: 'preview-installation',
  callerId: 'human-owner',
}
const target = {
  ...scope,
  chatId: 'chat',
  context: { kind: 'organization' as const, organizationId: 'studio' },
  threadId: 'thread',
}
const resource = { id: 'r', revision: 1, target }

function withFlow(state: WorkRecords['workflows'][number]['state']) {
  const work = emptyWork()
  work.workflows.push({
    ...resource,
    runId: 'run',
    attemptId: 'attempt',
    state,
    held: false,
    reason: '',
    actions: [],
  })
  return work
}

test('thread states derive from the work model', () => {
  expect(deriveThreadState(emptyWork(), 'thread', false)).toBe('ready')
  expect(deriveThreadState(withFlow('running'), 'thread', false)).toBe(
    'thinking',
  )
  expect(deriveThreadState(withFlow('running'), 'thread', true)).toBe('writing')
  expect(deriveThreadState(withFlow('failed'), 'thread', false)).toBe('failed')
  expect(deriveThreadState(withFlow('completed'), 'thread', false)).toBe('done')
  expect(
    deriveThreadState(withFlow('cancellation-requested'), 'thread', false),
  ).toBe('stopping')
  expect(deriveThreadState(withFlow('recovery-needed'), 'thread', false)).toBe(
    'recovery',
  )

  const approval = withFlow('waiting')
  approval.interactions.push({
    ...resource,
    version: 1,
    kind: 'approval',
    runId: 'run',
    attemptId: 'attempt',
    sourceAgentId: 'ari',
    prompt: 'Deploy?',
    options: [],
    freeText: false,
    state: 'pending',
    continuation: 'waiting',
    reason: '',
  })
  expect(deriveThreadState(approval, 'thread', false)).toBe('approval')

  const delegated = withFlow('running')
  delegated.delegations.push({
    ...resource,
    runId: 'run',
    attemptId: 'attempt',
    fromAgentId: 'ari',
    toAgentId: 'niko',
    childRunId: 'child',
    state: 'running',
    createdAt: '2026-01-01T00:00:00Z',
  })
  expect(deriveThreadState(delegated, 'thread', false)).toBe('delegating')
})

test('the summary shows the most important state', () => {
  expect(summarize([])).toEqual({ state: 'ready', several: false })
  expect(summarize(['writing', 'approval', 'queued', 'done'])).toEqual({
    state: 'approval',
    several: false,
  })
  expect(summarize(['thinking', 'failed'])).toEqual({
    state: 'failed',
    several: false,
  })
  expect(summarize(['thinking'], 'question')).toEqual({
    state: 'question',
    several: false,
  })
  expect(summarize(['done', 'thinking'])).toEqual({
    state: 'thinking',
    several: false,
  })
  expect(summarize(['writing', 'thinking', 'done'])).toEqual({
    state: 'writing',
    several: true,
  })
})

test('actions list each waiting thread once, answers before failures', () => {
  const item = (
    id: string,
    threadId: string,
    kind: string,
    createdAt: string,
    extra: Partial<InboxNotification> = {},
  ): InboxNotification => ({
    id,
    revision: 1,
    target: { ...target, threadId },
    agentId: 'ari',
    agent: 'Ari',
    kind,
    title: '',
    body: '',
    thread: '',
    context: '',
    pending: kind === 'question' || kind === 'approval',
    createdAt,
    read: false,
    ...extra,
  })
  const items = [
    item('f-old', 'a', 'failure', '2026-01-01T01:00:00Z'),
    item('q-new', 'b', 'question', '2026-01-01T03:00:00Z'),
    item('f-new', 'c', 'failure', '2026-01-01T04:00:00Z'),
    item('q-old', 'd', 'approval', '2026-01-01T02:00:00Z'),
    item('q-again', 'd', 'question', '2026-01-01T05:00:00Z'),
    item('seen', 'e', 'failure', '2026-01-01T06:00:00Z', { read: true }),
    item('reply', 'f', 'completion', '2026-01-01T07:00:00Z'),
  ]
  expect(actionItems(items).map((n) => n.id)).toEqual([
    'q-old',
    'q-new',
    'f-new',
    'f-old',
  ])
})

test('the title island follows the agent and the open thread', async ({
  page,
}) => {
  const s = await setupWork(page, 'running', undefined, ids.designer)
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page
    .getByRole('region', { name: 'Research', exact: true })
    .getByRole('button', { name: 'Mira', exact: true })
    .click()
  const island = page.locator('.toolbar .status-island')
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Thinking')
  await page
    .getByRole('button', {
      name: 'Open thread: Work acceptance scenario',
      exact: true,
    })
    .press('Enter')
  const header = page.locator('.pane-header .status-island')
  await expect(header).toHaveClass(/active/)
  await expect(header.getByRole('heading', { level: 2 })).toHaveText(
    'Work acceptance scenario',
  )
  await expect(header).toContainText('Thinking')
  await patchWork(page, s.threadId, { state: 'completed', queueHold: false })
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Done')
  await expect(island).not.toHaveClass(/active/, { timeout: 8000 })
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Ready')
})

const islandOf = (page: Page) => page.locator('.toolbar .status-island')

test('the island lists the threads that need you and opens the one picked', async ({
  page,
}) => {
  await startDemo(page)
  const island = islandOf(page)
  const trigger = island.getByRole('button', { name: '4 threads need you' })
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  const menu = page.getByRole('dialog', { name: 'Atlas needs you' })
  await expect(menu).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  // Questions and approvals come first, then failures.
  await expect(menu.locator('.action-label')).toHaveText([
    /^Needs your/,
    /^Needs your/,
    /^(Couldn’t finish|Was interrupted)$/,
    /^(Couldn’t finish|Was interrupted)$/,
  ])

  await expect(menu.getByRole('button').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await menu.getByRole('button').filter({ hasText: 'Couldn’t finish' }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.thread-pane')).toBeVisible()
  await expect
    .poll(
      async () =>
        (await demo(page, '/inspect')).notifications.find(
          (n: { kind: string }) => n.kind === 'failed',
        ).read,
    )
    .toBe(true)
  await page.getByRole('button', { name: 'Close thread' }).click()
  await expect(
    island.getByRole('button', { name: '3 threads need you' }),
  ).toBeVisible()
})

test('one thread needing you opens directly, and a read failure leaves the island', async ({
  page,
}) => {
  const s = await setupWork(page, 'running', undefined, ids.designer)
  await page.getByRole('button', { name: 'Close thread' }).click()
  const island = islandOf(page)
  const open = island.getByRole('button', {
    name: 'Open Work acceptance scenario',
  })
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Thinking')
  await open.click()
  await expect(page.locator('.pane-header h2')).toHaveText(
    'Work acceptance scenario',
  )
  await page.getByRole('button', { name: 'Close thread' }).click()

  await demo(page, '/scenario', { threadId: s.threadId, scenario: 'failure' })
  await demo(page, '/advance', { threadId: s.threadId, steps: 4 })
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Failed')
  await open.click()
  await expect(page.locator('.pane-header h2')).toHaveText(
    'Work acceptance scenario',
  )
  await page.getByRole('button', { name: 'Close thread' }).click()
  await expect(island.locator('[aria-live]')).toHaveText('Mira, Ready')
  await expect(island.locator('.island-action')).toHaveCount(0)
})
