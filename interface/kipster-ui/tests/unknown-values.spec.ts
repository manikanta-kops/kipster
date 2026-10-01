import { test, expect, startDemo, demo, DEMO_IDS as ids } from './demo.ts'
import { setupWork, patchWork, threadState } from './work-helpers.ts'
import {
  TextClient,
  isRefusal,
  parseAppPage,
  parseWireEvent,
  refusalMessage,
} from '../src/data/text.ts'
import { CoreSettingsClient } from '../src/data/core-settings.ts'
import { createCoreManagement } from '../src/data/management-core.ts'
import { CommandError } from '../src/data/management.ts'
import { deriveThreadState } from '../src/features/status/live-state.ts'
import { emptyWork } from '../src/data/work.ts'

const scope = { installationId: 'installation', callerId: 'caller' }
const summary = {
  threadId: 'thread',
  chatId: 'chat',
  contextKind: 'installation',
  contextId: 'installation',
  agentId: 'agent',
  state: 'queued',
  lastMessageId: 'message',
  revision: 1,
  createdAt: '2026-09-23T00:00:00.000Z',
}
const envelope = (type: string, data: unknown, cursor: string) => ({
  version: 1,
  eventId: cursor,
  cursor,
  occurredAt: '2026-09-23T00:00:00.000Z',
  scope: { kind: 'application', ...scope },
  resourceId: 'thread',
  revision: 1,
  type,
  data,
})
const stream = (frames: [string, unknown][]) => async () =>
  new Response(
    frames
      .map(
        ([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
      )
      .join(''),
  )

test('unknown stream control frames are skipped instead of stopping live updates', async () => {
  const original = globalThis.fetch
  const control = (code: string) =>
    [code, { version: 1, code }] as [string, unknown]
  globalThis.fetch = stream([
    control('future-control'),
    ['thread-summary', envelope('thread-summary', summary, 'a:1')],
  ])
  try {
    const applied: string[] = []
    await expect(
      new TextClient('http://127.0.0.1:12345').events(
        '/v1/app/events',
        scope,
        null,
        'cursor',
        new AbortController().signal,
        (event) => applied.push(`${event.type}@${event.cursor}`),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(applied).toEqual(['thread-summary@a:1'])

    globalThis.fetch = stream([
      control('gone'),
      control('future-control'),
      ['thread-summary', envelope('thread-summary', summary, 'a:2')],
    ])
    const settings: string[] = []
    await expect(
      new CoreSettingsClient('http://127.0.0.1:12345').events(
        scope,
        'cursor',
        new AbortController().signal,
        (event) => settings.push(`${event.kind}@${event.cursor}`),
      ),
    ).rejects.toMatchObject({ code: 'unavailable' })
    expect(settings).toEqual(['skipped@a:2'])
  } finally {
    globalThis.fetch = original
  }
})

test('threads in an unknown context kind are left out, not sent to the wrong context', () => {
  const future = { ...summary, threadId: 'future', contextKind: 'team' }
  const page = parseAppPage({
    version: 1,
    scope: { kind: 'application', ...scope },
    cursor: 'cursor',
    threads: [summary, future],
    notifications: [],
    next: null,
  })
  expect(page.threads).toEqual([summary])
  expect(
    parseWireEvent(envelope('thread-summary', future, 'a:1'), scope, null),
  ).toMatchObject({ type: 'unsupported', data: null })
})

test('an unknown work state is shown as Unknown, never as Ready', async ({
  page,
}) => {
  const work = emptyWork()
  work.workflows.push({
    id: 'run',
    revision: 1,
    target: {
      ...scope,
      chatId: 'chat',
      context: { kind: 'installation', installationId: 'installation' },
      threadId: 'thread',
    },
    runId: 'run',
    attemptId: 'attempt',
    state: 'future-state',
    held: false,
    reason: '',
    actions: [],
  })
  expect(deriveThreadState(work, 'thread', false)).toBe('unknown')

  const s = await setupWork(page, 'running', undefined, ids.designer)
  const header = page.locator('.pane-header .status-island')
  await expect(header).toContainText('Thinking')
  await patchWork(page, s.threadId, { state: 'future-state' })
  await expect(header).toContainText('Unknown')
  await expect(header).not.toContainText('Ready')
  await expect(page.getByRole('region', { name: 'Thread work' })).toBeVisible()
})

test('unknown interaction states and kinds render a neutral result', async ({
  page,
}) => {
  const s = await setupWork(page, 'question')
  const card = page.locator('.interaction-card')
  await expect(card.getByRole('radio').first()).toBeVisible()
  const interaction = (await threadState(page, s.threadId)).interactions[0]
  const patch = (fields: object, revision: number) =>
    demo(page, '/work', {
      threadId: s.threadId,
      interaction: { ...interaction, ...fields, revision },
    })
  await patch({ state: 'future-state' }, interaction.revision + 1)
  await expect(card.getByRole('status')).toHaveText('Status: future-state')
  await expect(card.getByRole('radio')).toHaveCount(0)

  await patch({ state: 'pending', kind: 'poll' }, interaction.revision + 2)
  await expect(card.getByRole('status')).toHaveText(
    'This version of Kipster can’t answer this request.',
  )
  await expect(card.getByRole('radio')).toHaveCount(0)
})

test('an unknown operation state keeps progress checking without an error', async ({
  page,
}) => {
  const session = crypto.randomUUID()
  const endpoint = `https://${session}.demo.kipster.invalid`
  const operationId = crypto.randomUUID()
  await page.addInitScript(
    ({ key, operationId }) =>
      localStorage.setItem(
        key,
        JSON.stringify([
          {
            operationId,
            action: 'archive',
            id: 'agent',
            name: 'Ari',
            copy: false,
            state: 'pending',
            detail: 'Waiting for Core.',
          },
        ]),
      ),
    {
      key: `kipster-lifecycle:${JSON.stringify([endpoint, ids.installation, ids.caller])}`,
      operationId,
    },
  )
  let reads = 0
  await page.route('**/__test-core/*/v1/operations/*', (route) => {
    reads++
    return route.fulfill({
      json: {
        version: 1,
        operationId,
        state: 'migrating',
        step: 'Moving files',
      },
    })
  })
  await startDemo(page, { session })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Archive & deletion' }).click()
  const progress = page.getByRole('region', { name: 'Operation progress' })
  await expect(progress).toContainText('Ari · archive · migrating')
  await expect(progress).toContainText('Moving files')
  await expect.poll(() => reads).toBeGreaterThan(1)
  await expect(
    page.getByRole('dialog', { name: 'Archive & deletion' }).getByRole('alert'),
  ).toHaveCount(0)
})

test('error codes: known refusals are rejections, unknown codes keep Core’s words', async () => {
  expect(isRefusal('constructor')).toBe(false)
  expect(refusalMessage('constructor')).toBe('This request was refused.')
  const original = globalThis.fetch
  const directory = {
    cursor: 'cursor',
    organizations: {},
    agents: {},
    memberships: {},
    groups: {},
  }
  const failure = async (status: number, body: object) => {
    globalThis.fetch = async () => Response.json(body, { status })
    return createCoreManagement('http://core', () => directory as never)
      .execute(
        {
          installationId: 'installation',
          callerId: 'caller',
          commandId: crypto.randomUUID(),
          operation: { type: 'group.create', organizationId: 'org', name: 'x' },
        } as never,
        new AbortController().signal,
      )
      .then(
        () => {
          throw new Error('Expected a failure.')
        },
        (error: CommandError) => error,
      )
  }
  try {
    const archived = await failure(409, {
      code: 'agent-archived',
      message: 'Agent is archived',
    })
    expect([archived.outcome, archived.code]).toEqual([
      'rejected',
      'agent-archived',
    ])
    expect(archived.message).toBe(refusalMessage('agent-archived'))
    const future = await failure(422, {
      code: 'quota-exceeded',
      message: 'This workspace has reached its group limit.',
    })
    expect([future.outcome, future.code]).toEqual(['unknown', 'quota-exceeded'])
    expect(future.message).toContain(
      'This workspace has reached its group limit.',
    )
  } finally {
    globalThis.fetch = original
  }
})
