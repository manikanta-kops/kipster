import {
  test,
  expect,
  demo,
  startDemo,
  storageFault,
  DEMO_IDS as ids,
} from './demo.ts'
import {
  setupWork as setup,
  submit,
  openWork,
  inspectWork as inspect,
  threadState,
  patchWork,
} from './work-helpers.ts'
const recovery = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Work command recovery' })
const work = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Thread work', exact: true })
const answer = (page: import('@playwright/test').Page) =>
  page.locator('.interaction-card blockquote')

test('question stable choice and free text settle canonically and survive reload', async ({
  page,
}) => {
  const s = await setup(page)
  await page.getByRole('radio', { name: 'Keep it focused' }).check()
  await page
    .getByRole('textbox', { name: 'Your answer or additional detail' })
    .fill('Keep the first release small.')
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(answer(page)).toContainText(
    'Keep it focused — Keep the first release small.',
  )
  expect(
    (await inspect(page)).answers[0].interaction.response.answer.optionId,
  ).toBe('focused')
  await page.reload()
  await openWork(page)
  await expect(answer(page)).toContainText('Keep the first release small.')
  expect((await threadState(page, s.threadId)).interactions[0].state).toBe(
    'settled',
  )
})
test('question dismissal is not stop; approval comment is not approval', async ({
  page,
}) => {
  const q = await setup(page)
  await page.getByRole('button', { name: 'Dismiss question' }).click()
  await expect(answer(page)).toContainText('Dismissed without an answer')
  expect((await threadState(page, q.threadId)).work[0].state).toBe('running')
  await setup(page, 'approval')
  await page
    .getByRole('textbox', { name: 'Comment (optional)' })
    .fill('Only the recorded proposal.')
  expect((await inspect(page)).answers).toHaveLength(0)
  await page.getByRole('button', { name: 'Decline', exact: true }).click()
  await expect(answer(page)).toContainText(
    'Declined — Only the recorded proposal.',
  )
  expect((await inspect(page)).answers[0].interaction.proposalId).toBeTruthy()
})
test('stop waits for settlement, holds new replies, resume does not revive children', async ({
  page,
}) => {
  const s = await setup(page, 'delegation')
  await submit(page, s.endpoint, s.target, 'First accepted follow-up')
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect(work(page)).toContainText('Cancellation requested')
  await expect(
    page.getByRole('button', { name: 'Resume follow-ups', exact: true }),
  ).toHaveCount(0)
  await submit(page, s.endpoint, s.target, 'New held follow-up')
  await expect(
    page.getByRole('region', { name: 'Accepted follow-ups' }),
  ).toContainText('New held follow-up')
  await patchWork(page, s.threadId, {
    state: 'cancelled',
    cancelDelivery: 'confirmed-ended',
  })
  const stopped = await threadState(page, s.threadId)
  await page
    .getByRole('button', { name: 'Resume follow-ups', exact: true })
    .click()
  await expect(work(page)).not.toContainText('Follow-ups held')
  await demo(page, '/advance', { threadId: s.threadId })
  const current = await threadState(page, s.threadId)
  expect(current.work[0].state).toBe('cancelled')
  expect(current.work[1].state).toBe('running')
  expect(current.delegations[0].state).toBe('cancelled')
  await demo(page, '/work', {
    threadId: s.threadId,
    delegation: stopped.delegations[0],
  })
  expect((await threadState(page, s.threadId)).work[1].runId).toBe(
    current.work[1].runId,
  )
})
test('backend queue cancellation retains authored content and unsupported steering keeps selected item queued', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  await submit(page, s.endpoint, s.target, 'First queue item')
  await submit(page, s.endpoint, s.target, 'Second queue item')
  const queue = page.getByRole('region', { name: 'Accepted follow-ups' })
  await expect(queue.locator('li')).toHaveCount(2)
  await queue
    .locator('li')
    .filter({ hasText: 'Second queue item' })
    .getByRole('button', { name: 'Cancel queued item' })
    .click()
  await expect(queue.locator('li')).toHaveCount(1)
  await expect(
    page.locator('.thread-reply').filter({ hasText: 'Second queue item' }),
  ).toBeVisible()
  await expect(
    queue.getByRole('button', { name: 'Steer current attempt' }),
  ).toBeDisabled()
  const state = await threadState(page, s.threadId)
  expect(state.work.map((r: { state: string }) => r.state)).toEqual([
    'running',
    'queued',
    'cancelled',
  ])
})
test('unsupported and stale steering keep accepted message queued', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  await submit(page, s.endpoint, s.target, 'Leave this queued')
  const state = await threadState(page, s.threadId)
  const response = await page.request.post(s.endpoint + '/v1/work/controls', {
    data: {
      version: 1,
      operationId: crypto.randomUUID(),
      ...s.target,
      runId: state.work[1].runId,
      attemptId: 'obsolete-attempt',
      action: 'steer',
    },
  })
  expect((await response.json()).outcome).toBe('unsupported')
  await expect(
    page.getByRole('button', { name: 'Steer current attempt' }),
  ).toBeDisabled()
  expect((await threadState(page, s.threadId)).work[1].state).toBe('queued')
})
test('published done text does not hide later failure or complete work', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  const state = await threadState(page, s.threadId)
  await demo(page, '/message', {
    threadId: s.threadId,
    message: {
      id: crypto.randomUUID(),
      threadId: s.threadId,
      authorId: ids.researcher,
      position: state.messages.length + 1,
      revision: 1,
      final: true,
      parts: [{ kind: 'text', text: 'Done! The output is ready.' }],
    },
  })
  await expect(work(page)).toContainText('Working')
  await patchWork(page, s.threadId, {
    state: 'failed',
    queueHold: true,
    failure: 'Provider failed after output',
  })
  await expect(work(page)).toContainText('Failed')
  await expect(
    page.getByText('Done! The output is ready.', { exact: true }),
  ).toBeVisible()
})
test('saved child identity is retained by delegated interaction responses', async ({
  page,
}) => {
  const s = await setup(page)
  const state = await threadState(page, s.threadId)
  const childRunId = crypto.randomUUID()
  const childAttemptId = crypto.randomUUID()
  await demo(page, '/work', {
    threadId: s.threadId,
    work: {
      ...state.work[0],
      runId: childRunId,
      attemptId: childAttemptId,
      queuePosition: 2,
    },
    delegation: {
      id: crypto.randomUUID(),
      parentRunId: state.work[0].runId,
      childRunId,
      senderAgentId: ids.researcher,
      recipientAgentId: ids.engineer,
      originThreadId: s.threadId,
      depth: 1,
      ordinal: 1,
      request: 'Check the implementation',
      state: 'running',
      revision: 1,
    },
  })
  await demo(page, '/work', {
    threadId: s.threadId,
    interaction: {
      ...state.interactions[0],
      sourceAgentId: ids.engineer,
      runId: childRunId,
      attemptId: childAttemptId,
      revision: state.interactions[0].revision + 1,
    },
  })
  await expect(page.locator('.interaction-eyebrow')).toContainText('Rowan')
  const sent = page.waitForRequest((r) =>
    r.url().endsWith('/v1/work/interactions/answer'),
  )
  await page
    .getByRole('textbox', { name: 'Your answer or additional detail' })
    .fill('Ask about desktop only')
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  const body = (await sent).postDataJSON()
  expect(body.runId).toBe(childRunId)
  expect(body.attemptId).toBe(childAttemptId)
  await expect(answer(page)).toContainText('Ask about desktop only')
})
test('competing tabs display the actual first accepted answer', async ({
  page,
  browser,
}) => {
  const s = await setup(page)
  const context = await browser.newContext()
  const second = await context.newPage()
  await second.goto(s.url)
  await openWork(second)
  await second.getByRole('radio', { name: 'Explore alternatives' }).check()
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await second.route('**/v1/work/interactions/answer', async (route) => {
    await held
    await route.continue()
  })
  await second.getByRole('button', { name: 'Send answer', exact: true }).click()
  await page.getByRole('radio', { name: 'Keep it focused' }).check()
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(answer(page)).toContainText('Keep it focused')
  release()
  await expect(answer(second)).toContainText('Keep it focused')
  await expect.poll(async () => (await inspect(page)).answers.length).toBe(2)
  const receipts = (await inspect(page)).answers
  expect(receipts[1].interaction.response.operationId).toBe(
    receipts[0].interaction.response.operationId,
  )
  await context.close()
})
test('lost acknowledgement is read-reconciled after reload without another write', async ({
  page,
}) => {
  await setup(page, 'approval')
  let posts = 0
  await page.route('**/v1/work/interactions/answer', async (route) => {
    posts++
    await route.fetch()
    await route.abort()
  })
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(async () => (await inspect(page)).answers.length).toBe(1)
  await page.reload()
  await openWork(page)
  await expect(answer(page)).toContainText('Approved')
  await expect(recovery(page)).toBeHidden()
  expect(posts).toBe(1)
})
test('unknown receipt remains unresolved; explicit retry reuses immutable ID and payload', async ({
  page,
}) => {
  await setup(page, 'running')
  let first: unknown
  await page.route('**/v1/work/controls', (route) => {
    first = route.request().postDataJSON()
    return route.abort()
  })
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect.poll(() => first).toBeTruthy()
  await expect(recovery(page)).toContainText('Outcome unconfirmed')
  await page.reload()
  await openWork(page)
  await expect(recovery(page)).toBeVisible()
  expect((await inspect(page)).controls).toHaveLength(0)
  await page.unroute('**/v1/work/controls')
  const sent = page.waitForRequest((r) => r.url().endsWith('/v1/work/controls'))
  await page.getByRole('button', { name: 'Retry same command' }).click()
  expect((await sent).postDataJSON()).toEqual(first)
  await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
})
test('superseded card cannot authorize new work and disconnected thread stream does not block command', async ({
  page,
}) => {
  const s = await setup(page)
  const state = await threadState(page, s.threadId)
  await demo(page, '/work', {
    threadId: s.threadId,
    interaction: {
      ...state.interactions[0],
      state: 'superseded',
      revision: state.interactions[0].revision + 1,
    },
  })
  await expect(page.getByText('Superseded by a newer request')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Send answer', exact: true }),
  ).toBeHidden()
  await setup(page, 'approval')
  await page.route('**/v1/threads/*/events?*', (route) => route.abort())
  await page.reload()
  await openWork(page)
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(answer(page)).toContainText('Approved')
  await expect.poll(async () => (await inspect(page)).answers.length).toBe(1)
})
test('storage reservation failure preserves answer and prevents dispatch', async ({
  page,
}) => {
  await setup(page, 'question', { 'work-reserve': 'fail' })
  const input = page.getByRole('textbox', {
    name: 'Your answer or additional detail',
  })
  await input.fill('Preserve this exact answer')
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Your response could not be saved',
  )
  await expect(input).toHaveValue('Preserve this exact answer')
  expect((await inspect(page)).answers).toHaveLength(0)
})
test('failure holds existing and new replies; retry safely advances FIFO without Resume', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  await submit(page, s.endpoint, s.target, 'First held reply')
  await patchWork(page, s.threadId, {
    state: 'failed',
    queueHold: true,
    failure: 'Provider failed',
  })
  await submit(page, s.endpoint, s.target, 'Second held reply')
  await expect(
    page.getByRole('region', { name: 'Accepted follow-ups' }),
  ).toContainText('Held')
  const before = await threadState(page, s.threadId)
  await page.getByRole('button', { name: 'Retry work', exact: true }).click()
  await expect
    .poll(async () => (await threadState(page, s.threadId)).work[0].state)
    .toBe('queued')
  await demo(page, '/advance', { threadId: s.threadId })
  const retry = await threadState(page, s.threadId)
  expect(retry.work[0].attemptId).not.toBe(before.work[0].attemptId)
  expect(retry.work[0].runId).toBe(before.work[0].runId)
  await demo(page, '/advance', { threadId: s.threadId, steps: 4 })
  const after = await threadState(page, s.threadId)
  expect(after.work[0].state).toBe('completed')
  expect(after.work[1].state).toBe('running')
  expect(after.work[2].state).toBe('queued')
  expect(after.work[0].queueHold).toBe(false)
  await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
})
test('retry failure pauses again and later Stop supersedes retry continuation', async ({
  page,
}) => {
  const s = await setup(page, 'failure')
  await submit(page, s.endpoint, s.target, 'Held during retry')
  await page.getByRole('button', { name: 'Retry work', exact: true }).click()
  await expect
    .poll(async () => (await threadState(page, s.threadId)).work[0].state)
    .toBe('queued')
  await demo(page, '/advance', { threadId: s.threadId })
  await patchWork(page, s.threadId, {
    state: 'failed',
    queueHold: true,
    failure: 'Failed again',
  })
  await expect(
    page.getByRole('button', { name: 'Retry work', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Retry work', exact: true }).click()
  await expect
    .poll(async () => (await threadState(page, s.threadId)).work[0].state)
    .toBe('queued')
  await demo(page, '/advance', { threadId: s.threadId })
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect(work(page)).toContainText('Cancellation requested')
  await patchWork(page, s.threadId, {
    state: 'cancelled',
    cancelDelivery: 'confirmed-ended',
  })
  const state = await threadState(page, s.threadId)
  expect(state.work[0].queueHold).toBe(true)
  expect(state.work[1].state).toBe('queued')
  await expect(work(page)).toContainText('Stopped')
})
test('independent root work and background summaries survive organization navigation', async ({
  page,
}) => {
  const s = await setup(page, 'failure')
  const { threadId, ...target } = s.target
  void threadId
  await submit(page, s.endpoint, target, 'Independent new root')
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(ids.studio)
  await patchWork(page, s.threadId, { state: 'completed', queueHold: false })
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(ids.organization)
  await expect(
    page.getByRole('button', { name: 'Open thread: Independent new root' }),
  ).toBeVisible()
  await expect(
    page
      .locator('.feed-message')
      .filter({ hasText: 'Work acceptance scenario' }),
  ).toContainText('Completed')
})
test('expired cursor resnapshot restores work and pending interaction without replaying commands', async ({
  page,
}) => {
  const s = await setup(page, 'approval')
  let snapshots = 0
  page.on('request', (request) => {
    if (request.url().includes(`/v1/threads/${s.threadId}/snapshot`))
      snapshots++
  })
  await expect
    .poll(async () => {
      await demo(page, '/retention', { threadId: s.threadId })
      return snapshots
    })
    .toBeGreaterThan(0)
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toBeEnabled()
  expect((await inspect(page)).answers).toHaveLength(0)
})
test('overlapping streams and stale revisions neither duplicate output nor regress current work', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  const old = await threadState(page, s.threadId)
  await patchWork(page, s.threadId, {
    state: 'failed',
    queueHold: true,
    failure: 'Failed now',
  })
  await expect(work(page)).toContainText('Failed')
  await demo(page, '/work', { threadId: s.threadId, work: old.work[0] })
  await expect(work(page)).toContainText('Failed')
  expect((await threadState(page, s.threadId)).work[0].state).toBe('failed')
  const message = {
    ...old.messages[0],
    id: crypto.randomUUID(),
    position: 2,
    authorId: ids.researcher,
    final: true,
    parts: [{ kind: 'text', text: 'One canonical output' }],
  }
  await demo(page, '/message', { threadId: s.threadId, message })
  await demo(page, '/message', { threadId: s.threadId, message })
  await expect(
    page.locator('.thread-reply').filter({ hasText: 'One canonical output' }),
  ).toHaveCount(1)
})
test('accepted command ID returns original outcome even when later payload changes', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  const state = await threadState(page, s.threadId)
  const body = {
    version: 1,
    operationId: crypto.randomUUID(),
    ...s.target,
    runId: state.work[0].runId,
    attemptId: state.work[0].attemptId,
    action: 'stop',
  }
  const original = await (
    await page.request.post(s.endpoint + '/v1/work/controls', { data: body })
  ).json()
  const repeated = await (
    await page.request.post(s.endpoint + '/v1/work/controls', {
      data: { ...body, action: 'resume' },
    })
  ).json()
  expect(repeated).toEqual(original)
  expect((await threadState(page, s.threadId)).work[0].state).toBe(
    'cancellation-requested',
  )
})
test('old attempt outcomes cannot replace a newer retry or release its hold', async ({
  page,
}) => {
  const s = await setup(page, 'failure')
  await submit(page, s.endpoint, s.target, 'Keep exact queue hold')
  const old = await threadState(page, s.threadId)
  await page.getByRole('button', { name: 'Retry work', exact: true }).click()
  await expect
    .poll(async () => (await threadState(page, s.threadId)).work[0].state)
    .toBe('queued')
  await demo(page, '/advance', { threadId: s.threadId })
  for (const state of ['failed', 'completed'])
    await demo(page, '/work', {
      threadId: s.threadId,
      work: { ...old.work[0], state },
    })
  const current = await threadState(page, s.threadId)
  expect(current.work[0].attemptId).not.toBe(old.work[0].attemptId)
  expect(current.work[0].state).toBe('running')
  expect(current.work[0].queueHold).toBe(true)
  expect(current.work[1].state).toBe('queued')
})
test('application work summaries update while another organization is selected', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(ids.studio)
  await patchWork(page, s.threadId, {
    state: 'failed',
    queueHold: true,
    failure: 'Failed in background',
  })
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(ids.organization)
  await expect(
    page
      .locator('.feed-message')
      .filter({ hasText: 'Work acceptance scenario' }),
  ).toContainText('Failed')
})
test('a destination switch fences pending acknowledgement and keeps original recovery scoped', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/work/controls', async (route) => {
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect.poll(() => committed).toBe(true)
  await startDemo(page)
  release()
  await expect(
    page.getByRole('button', { name: 'Open thread', exact: true }),
  ).toHaveCount(0)
  await page.goto(s.url)
  await openWork(page)
  await expect(work(page)).toContainText('Cancellation requested')
  await expect(recovery(page)).toBeHidden()
  await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
})
test('failed journal observation can be restored without remount or unsafe dispatch', async ({
  page,
}) => {
  await setup(page, 'approval', { 'work-read': 'fail' })
  await expect(recovery(page)).toContainText(
    'Local work recovery is unavailable',
  )
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  expect((await inspect(page)).answers).toHaveLength(0)
  await storageFault(page, 'work-read', 'allow')
  await page
    .getByRole('button', { name: 'Retry loading work recovery' })
    .click()
  await expect(recovery(page)).toBeHidden()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(answer(page)).toContainText('Approved')
})
test('late command receipt cannot regress newer settlement or move the history scroll', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/work/controls', async (route) => {
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect.poll(() => committed).toBe(true)
  await patchWork(page, s.threadId, {
    state: 'cancelled',
    cancelDelivery: 'confirmed-ended',
  })
  await expect(work(page)).toContainText('Stopped')
  await page.locator('.thread-scroll').evaluate((e) => {
    e.scrollTop = 0
  })
  release()
  await expect(recovery(page)).toBeHidden()
  await expect(work(page)).toContainText('Stopped')
  expect(
    await page.locator('.thread-scroll').evaluate((e) => e.scrollTop),
  ).toBe(0)
})
test('same agent work remains distinct across organization contexts', async ({
  page,
}) => {
  const s = await setup(page)
  const context = { kind: 'organization', organizationId: ids.studio }
  const chat = await (
    await page.request.post(s.endpoint + '/v1/direct-chats', {
      data: { version: 1, context, agentId: ids.researcher },
    })
  ).json()
  const receipt = await submit(
    page,
    s.endpoint,
    { context, chatId: chat.chatId },
    'Studio independent work',
  )
  await demo(page, '/advance', { threadId: receipt.threadId, steps: 3 })
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(ids.studio)
  await openWork(page, 'Studio independent work')
  await page.getByRole('radio', { name: 'Explore alternatives' }).check()
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(answer(page)).toContainText('Explore alternatives')
  expect((await threadState(page, s.threadId)).interactions[0].state).toBe(
    'pending',
  )
})
for (const field of ['operationId', 'runId', 'threadId'])
  test(`control outcome remains readable with a different ${field}`, async ({
    page,
  }) => {
    await setup(page, 'running')
    let responses = 0
    await page.route('**/v1/work/controls', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      expect(response.ok(), JSON.stringify(body)).toBe(true)
      body[field] = crypto.randomUUID()
      responses++
      await route.fulfill({ response, json: body })
    })
    await page.getByRole('button', { name: 'Stop work', exact: true }).click()
    await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
    await expect.poll(() => responses).toBe(1)
    await expect(recovery(page)).toBeHidden()
    await expect(work(page)).toContainText('Cancellation requested')
  })
for (const field of ['id', 'runId', 'attemptId', 'proposalId'])
  test(`answer outcome remains readable with a different ${field}`, async ({
    page,
  }) => {
    await setup(page, 'approval')
    let responses = 0
    await page.route('**/v1/work/interactions/answer', async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      if (body.interaction) body.interaction[field] = crypto.randomUUID()
      responses++
      await route.fulfill({ response, json: body })
    })
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    await expect.poll(async () => (await inspect(page)).answers.length).toBe(1)
    await expect.poll(() => responses).toBe(1)
    await expect(recovery(page)).toBeHidden()
    await expect(answer(page).first()).toContainText('Approved')
  })
for (const outcome of ['unknown', 'accepted', 'rejected'])
  test(`pending explicit retries coalesce after automatic receipt is ${outcome}`, async ({
    page,
  }) => {
    await setup(page, 'running')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let lookup = false
    await page.route('**/v1/work/controls/receipt', async (route) => {
      lookup = true
      await held
      await route.continue()
    })
    await page.route('**/v1/work/controls', async (route) => {
      if (outcome !== 'unknown')
        await route.fetch(
          outcome === 'rejected'
            ? {
                postData: {
                  ...route.request().postDataJSON(),
                  attemptId: 'obsolete-attempt',
                },
              }
            : {},
        )
      await route.abort()
    })
    await page.getByRole('button', { name: 'Stop work', exact: true }).click()
    await expect.poll(() => lookup).toBe(true)
    await page.unroute('**/v1/work/controls')
    await page
      .getByRole('button', { name: 'Retry same command', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Retry same command', exact: true })
      .click()
    release()
    if (outcome === 'rejected')
      await expect(recovery(page)).toContainText('Not accepted')
    else await expect(recovery(page)).toBeHidden()
    await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
  })
test('reordered protocol context keys reach the same workflow', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  const state = await threadState(page, s.threadId)
  const response = await page.request.post(s.endpoint + '/v1/work/controls', {
    data: {
      action: 'stop',
      attemptId: state.work[0].attemptId,
      runId: state.work[0].runId,
      threadId: s.threadId,
      chatId: s.target.chatId,
      context: { organizationId: ids.organization, kind: 'organization' },
      operationId: crypto.randomUUID(),
      version: 1,
    },
  })
  expect((await response.json()).outcome).toBe('accepted')
  await expect(work(page)).toContainText('Cancellation requested')
})
test('destination change abandons explicit retry waiting on an automatic receipt read', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let lookup = false
  await page.route('**/v1/work/controls/receipt', async (route) => {
    lookup = true
    await held
    await route.continue().catch(() => {})
  })
  await page.route('**/v1/work/controls', (route) => route.abort())
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect.poll(() => lookup).toBe(true)
  await page.unroute('**/v1/work/controls')
  await page
    .getByRole('button', { name: 'Retry same command', exact: true })
    .click()
  await startDemo(page)
  release()
  await page.unroute('**/v1/work/controls/receipt')
  await page.goto(s.url)
  await openWork(page)
  await expect(recovery(page)).toContainText('Outcome unconfirmed')
  expect((await inspect(page)).controls).toHaveLength(0)
})

test('late cross-tab acknowledgement cannot resurrect settled journal evidence', async ({
  page,
  context,
}) => {
  const s = await setup(page, 'approval')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/work/interactions/answer', async (route) => {
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(() => committed).toBe(true)
  const second = await context.newPage()
  await second.goto(s.url)
  await openWork(second)
  await expect(answer(second)).toContainText('Approved')
  await expect(recovery(second)).toBeHidden()
  release()
  await expect(recovery(page)).toBeHidden()
  await expect.poll(async () => (await inspect(page)).answers.length).toBe(1)
})

test('unknown control never dispatches new work and recovery follows owning layout', async ({
  page,
}) => {
  const s = await setup(page, 'running')
  await submit(page, s.endpoint, s.target, 'Preserve this exact queued message')
  await page.route('**/v1/work/controls', (route) => route.abort())
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect(recovery(page)).toBeVisible()
  await page.getByRole('button', { name: 'Expand thread' }).click()
  await expect(
    page.getByRole('button', { name: 'Retry same command' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close thread' }).click()
  await page.getByRole('button', { name: 'Open thread', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Retry same command' }),
  ).toBeVisible()
  const state = await threadState(page, s.threadId)
  expect(state.work.map((r: { state: string }) => r.state)).toEqual([
    'running',
    'queued',
  ])
  expect((await inspect(page)).controls).toHaveLength(0)
})

test('caller change fences old command acknowledgement and restores original scoped evidence', async ({
  page,
}) => {
  await setup(page, 'running')
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  let committed = false
  await page.route('**/v1/work/controls', async (route) => {
    const response = await route.fetch()
    committed = true
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect.poll(() => committed).toBe(true)
  await demo(page, '/identity', { callerId: crypto.randomUUID() })
  await page.reload()
  release()
  await expect(
    page.getByRole('button', { name: 'Open thread', exact: true }),
  ).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { kipsterTest?: { ready?: boolean } })
            .kipsterTest?.ready,
        ),
      ),
    )
    .toBe(true)
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await demo(page, '/identity', { callerId: ids.caller })
  await page.reload()
  await openWork(page)
  await expect(work(page)).toContainText('Cancellation requested')
  await expect(recovery(page)).toBeHidden({ timeout: 15000 })
  await expect.poll(async () => (await inspect(page)).controls.length).toBe(1)
})

test('reordered receipt keys still settle accepted work', async ({ page }) => {
  await setup(page)
  for (const path of ['answer', 'receipt'])
    await page.route('**/v1/work/interactions/' + path, async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      const reordered = Object.fromEntries(Object.entries(body).reverse())
      if (body.interaction)
        reordered.interaction = Object.fromEntries(
          Object.entries(body.interaction).reverse(),
        )
      await route.fulfill({ response, json: reordered })
    })
  await page.getByRole('radio', { name: 'Keep it focused' }).check()
  await page.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(answer(page)).toContainText('Keep it focused')
  await expect(recovery(page)).toBeHidden()
  await expect.poll(async () => (await inspect(page)).answers.length).toBe(1)
})

test('Stop cancels the exact approval and recovery-needed work never offers a new answer', async ({
  page,
}) => {
  const s = await setup(page, 'approval')
  await page.getByRole('button', { name: 'Stop work', exact: true }).click()
  await expect(page.getByText('Question or approval cancelled')).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0)
  expect((await threadState(page, s.threadId)).interactions[0].state).toBe(
    'cancelled',
  )
  await patchWork(page, s.threadId, {
    state: 'recovery-needed',
    queueHold: true,
    failure: 'Provider continuation needs recovery',
  })
  await expect(work(page)).toContainText('Recovery needed')
  await expect(
    page.getByRole('button', { name: 'Approve', exact: true }),
  ).toHaveCount(0)
  expect((await inspect(page)).answers).toHaveLength(0)
})
