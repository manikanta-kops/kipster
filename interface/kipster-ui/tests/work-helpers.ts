import { expect, startDemo, demo, DEMO_IDS as ids } from './demo.ts'
import type { Page } from '@playwright/test'
export type WorkScenario =
  'question' | 'approval' | 'delegation' | 'failure' | 'running'
export async function setupWork(
  page: Page,
  scenario: WorkScenario = 'question',
  faults?: Record<string, string>,
  agentId = ids.researcher,
  organizationId = ids.organization,
) {
  const session = await startDemo(page, { faults })
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  const endpoint = `/__test-core/${session}`
  const context = { kind: 'organization', organizationId }
  const chat = await (
    await page.request.post(endpoint + '/v1/direct-chats', {
      data: { version: 1, context, agentId },
    })
  ).json()
  const target = { context, chatId: chat.chatId }
  const receipt = await submit(
    page,
    endpoint,
    target,
    'Work acceptance scenario',
  )
  await demo(page, '/scenario', {
    threadId: receipt.threadId,
    scenario: scenario === 'running' ? 'complete' : scenario,
  })
  await demo(page, '/advance', {
    threadId: receipt.threadId,
    steps: scenario === 'running' ? 1 : 3,
  })
  if (agentId === ids.designer)
    await page
      .getByRole('region', { name: 'Research', exact: true })
      .getByRole('button', { name: 'Mira', exact: true })
      .click()
  await openWork(page)
  return {
    endpoint,
    session,
    target: { ...target, threadId: receipt.threadId },
    threadId: receipt.threadId,
    url: page.url(),
  }
}
export async function submit(
  page: Page,
  endpoint: string,
  target: object,
  text: string,
) {
  const { threadId, ...destination } = target as Record<string, unknown>
  const response = await page.request.post(endpoint + '/v1/text/submissions', {
    data: {
      version: 1,
      submissionId: crypto.randomUUID(),
      scope: { installationId: ids.installation, callerId: ids.caller },
      target: destination,
      ...(threadId ? { threadId } : {}),
      mode: 'threadId' in target ? 'reply' : 'root',
      parts: [{ kind: 'text', text }],
    },
  })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}
export async function openWork(page: Page, title = 'Work acceptance scenario') {
  await page
    .getByRole('button', { name: 'Open thread: ' + title, exact: true })
    .press('Enter')
  const controls = page.getByRole('region', {
    name: 'Thread work',
    exact: true,
  })
  // AnimatePresence briefly retains the previous thread during destination changes.
  await expect(controls).toHaveCount(1)
  await expect(controls).toBeVisible()
}
export const inspectWork = (page: Page) => demo(page, '/inspect')
export const threadState = async (page: Page, threadId: string) =>
  (await inspectWork(page)).threads.find(
    (t: { summary: { threadId: string } }) => t.summary.threadId === threadId,
  )
export async function patchWork(
  page: Page,
  threadId: string,
  patch: object,
  index = 0,
) {
  const thread = await threadState(page, threadId)
  await demo(page, '/work', {
    threadId,
    work: {
      ...thread.work[index],
      ...patch,
      revision: thread.work[index].revision + 1,
    },
  })
}
