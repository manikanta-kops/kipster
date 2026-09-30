import { test, expect, DEMO_IDS as ids } from './demo.ts'
import { setupWork, patchWork } from './work-helpers.ts'
import {
  deriveThreadState,
  summarize,
} from '../src/features/status/live-state.ts'
import { emptyWork, type WorkRecords } from '../src/data/work.ts'

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

test('the summary shows the most important state and counts the rest', () => {
  expect(summarize([])).toEqual({ state: 'ready', others: 0 })
  expect(summarize(['writing', 'approval', 'queued', 'done'])).toEqual({
    state: 'approval',
    others: 2,
  })
  expect(summarize(['thinking', 'failed'])).toEqual({
    state: 'failed',
    others: 1,
  })
  expect(summarize(['thinking'], 'question')).toEqual({
    state: 'question',
    others: 1,
  })
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
