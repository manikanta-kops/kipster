import { expect, test } from '@playwright/test'
import {
  TextClient,
  TextHttpError,
  parseAppPage,
  parseThreadPage,
  parseWireEvent,
  type Notice,
  type Summary,
  type TextDelegation,
  type TextInteraction,
  type TextWork,
} from '../src/data/text.js'
import {
  interactionState,
  mergeAppNotices,
  mergeNotice,
  outstanding,
  waitingNotices,
} from '../src/data/state.js'
import { chatGone, type Directory } from '../src/data/directory.js'
import {
  createCoreWorkClient,
  createNotificationClient,
  inboxItems,
  summaryTarget,
  threadWork,
} from '../src/data/core-work.js'
import {
  chatMarks,
  inboxSections,
  needsYou,
} from '../src/data/notifications.js'
import type { WorkOperation } from '../src/data/work.js'

const scope = { installationId: 'installation', callerId: 'caller' }
const createdAt = '2026-09-27T10:00:00.000Z'
const question: Notice = {
  id: 'notice',
  threadId: 'thread',
  runId: 'run',
  kind: 'interaction',
  interactionId: 'card',
  interactionState: 'pending',
  read: false,
  revision: 1,
  createdAt,
}
const summary: Summary = {
  threadId: 'thread',
  chatId: 'chat',
  contextKind: 'organization',
  contextId: 'org',
  agentId: 'scout',
  state: 'waiting',
  lastMessageId: 'message',
  revision: 1,
  createdAt,
}
const card: TextInteraction = {
  id: 'card',
  version: 1,
  runId: 'run',
  attemptId: 'attempt',
  kind: 'question',
  prompt: 'Blue or red?',
  options: [
    { id: 'blue', label: 'Blue' },
    { id: 'red', label: 'Red' },
  ],
  freeText: false,
  state: 'pending',
  revision: 1,
}
const run = (patch: Partial<TextWork>): TextWork => ({
  runId: 'run',
  attemptId: 'attempt',
  state: 'running',
  queueHold: false,
  cancelDelivery: 'none',
  revision: 1,
  queuePosition: 1,
  messageId: 'message',
  failure: null,
  ...patch,
})
const appEvent = (data: unknown, revision: number) => ({
  version: 1,
  type: 'notification',
  eventId: `event-${revision}`,
  cursor: `a:installation:${revision}`,
  occurredAt: createdAt,
  scope: { kind: 'application', ...scope },
  resourceId: 'notice',
  revision,
  data,
})
const page = (
  notifications: unknown[],
  next: {
    afterThreadId: string | null
    afterNotificationId: string | null
  } | null,
  cursor = 'a:installation:9',
) => ({
  version: 1,
  scope: { kind: 'application', ...scope },
  cursor,
  threads: [],
  notifications,
  next,
})
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
async function withFetch<T>(
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(String(input), init)) as typeof globalThis.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

test('notifications keep plain strings and skip unreadable entries', () => {
  const unusual = {
    ...question,
    createdAt: 'yesterday',
    interactionState: 'answered',
  }
  const completed = {
    ...question,
    kind: 'completed',
    interactionState: 'pending',
  }
  const parsed = parseAppPage(
    page([unusual, completed, { ...question, revision: undefined }], null),
  )
  expect(parsed.notifications).toEqual([unusual, completed])
  const missingInteraction = {
    ...question,
    interactionId: undefined,
    interactionState: undefined,
  }
  expect(
    parseAppPage(page([JSON.parse(JSON.stringify(missingInteraction))], null))
      .notifications,
  ).toHaveLength(1)
})

test('a notification event uses its record revision independently of its envelope', () => {
  const settled = { ...question, interactionState: 'settled', revision: 3 }
  expect(parseWireEvent(appEvent(settled, 2), scope, null).data).toEqual(
    settled,
  )
})

test('notifications merge by revision; reading never resolves the question', () => {
  const read = { ...question, read: true, revision: 2 }
  const settled = { ...read, interactionState: 'settled' as const, revision: 3 }
  // Device B receives A's read: still waiting for an answer.
  const onB = mergeNotice(question, read)
  expect(onB).toEqual(read)
  expect(outstanding(onB)).toBe(true)
  expect(waitingNotices({ notice: onB })).toHaveLength(1)
  // An answer from either device settles it; a late replay of an older revision changes nothing.
  expect(mergeNotice(onB, settled)).toEqual(settled)
  expect(mergeNotice(settled, read)).toEqual(settled)
  expect(mergeNotice(settled, question)).toEqual(settled)
  expect(outstanding(settled)).toBe(false)
  expect(waitingNotices({ notice: settled })).toHaveLength(0)
  // A read confirmed locally survives an older replay of the same notification.
  expect(mergeNotice({ ...question, read: true }, question).read).toBe(true)
})

test('a settled state from either stream closes the card', () => {
  expect(interactionState(card, {})).toBe('pending')
  const settled = {
    notice: { ...question, interactionState: 'settled' as const, revision: 3 },
  }
  expect(interactionState(card, settled)).toBe('settled')
  expect(interactionState({ ...card, state: 'cancelled' }, settled)).toBe(
    'cancelled',
  )
})

test('after replay expiry, paging restores outstanding notifications oldest first with current state', async () => {
  const older = { ...question, id: 'first', interactionId: 'first-card' }
  const newer = {
    ...question,
    id: 'second',
    interactionId: 'second-card',
    interactionState: 'cancelled',
    revision: 2,
    createdAt: '2026-09-27T10:05:00.000Z',
  }
  const completed = {
    id: 'third',
    threadId: 'thread',
    runId: 'run-3',
    kind: 'completed',
    read: true,
    revision: 2,
    createdAt: '2026-09-27T10:09:00.000Z',
  }
  const requests: string[] = []
  let changedOnce = false
  const restored = await withFetch(
    async (url) => {
      requests.push(url)
      const query = new URL(url).searchParams
      if (!query.has('afterNotificationId'))
        return json(
          200,
          page([older], { afterThreadId: null, afterNotificationId: 'first' }),
        )
      if (query.get('at') !== 'a:installation:9')
        throw new Error('wrong cursor')
      // The first attempt at the second page finds the snapshot changed.
      if (!changedOnce) {
        changedOnce = true
        return json(409, {
          version: 1,
          code: 'resync-required',
          message: 'Snapshot changed',
          requestId: 'r',
        })
      }
      if (query.get('afterNotificationId') === 'first')
        return json(
          200,
          page([newer], { afterThreadId: null, afterNotificationId: 'second' }),
        )
      return json(200, page([completed], null))
    },
    () =>
      new TextClient('http://core.test').appSnapshot(
        new AbortController().signal,
      ),
  )
  expect(restored.notifications.map((n) => n.id)).toEqual([
    'first',
    'second',
    'third',
  ])
  expect(requests.filter((r) => !r.includes('after'))).toHaveLength(2)
  // Held records from before the expiry: one stale, one for a chat that is gone since.
  const held = {
    second: { ...newer, interactionState: 'pending' as const, revision: 1 },
    gone: { ...question, id: 'gone' },
  } as Record<string, Notice>
  const merged = mergeAppNotices(held, restored.notifications)
  expect(Object.keys(merged).sort()).toEqual(['first', 'second', 'third'])
  expect(merged.second.interactionState).toBe('cancelled')
  expect(waitingNotices(merged).map((n) => n.id)).toEqual(['first'])
})

test('a gone thread ends its stream and refusals keep the message as not accepted', async () => {
  const client = new TextClient('http://core.test')
  const signal = new AbortController().signal
  const gone = await withFetch(
    async () =>
      json(410, {
        version: 1,
        code: 'gone',
        message: 'Thread is gone',
        requestId: 'r',
      }),
    () =>
      client
        .events(
          '/v1/threads/thread/events',
          scope,
          'thread',
          't:1',
          signal,
          () => {},
        )
        .catch((error: unknown) => error),
  )
  expect(gone).toMatchObject({ code: 'gone' })
  const frame = await withFetch(
    async () =>
      new Response('event: gone\ndata: {"version":1,"code":"gone"}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    () =>
      client
        .events(
          '/v1/threads/thread/events',
          scope,
          'thread',
          't:1',
          signal,
          () => {},
        )
        .catch((error: unknown) => error),
  )
  expect(frame).toMatchObject({
    code: 'gone',
    message: 'This conversation is no longer available.',
  })
  for (const [status, code] of [
    [410, 'organization-deleted'],
    [403, 'membership-removed'],
    [403, 'agent-archived'],
    [410, 'gone'],
  ] as const) {
    const receipt = await withFetch(
      async () =>
        json(status, { version: 1, code, message: 'internal', requestId: 'r' }),
      () =>
        client.submit(
          {
            submissionId: 'submission',
            target: {
              ...scope,
              context: { kind: 'organization', organizationId: 'org' },
              chatId: 'chat',
            },
            parts: [{ type: 'text', text: 'Hello' }],
          },
          signal,
        ),
    )
    expect(receipt).toMatchObject({ status: 'rejected', code })
    expect(receipt.status === 'rejected' && receipt.message).not.toContain(
      'internal',
    )
  }
  // A server failure is not a refusal: the send stays uncertain.
  await expect(
    withFetch(
      async () =>
        json(503, {
          version: 1,
          code: 'unavailable',
          message: 'x',
          requestId: 'r',
        }),
      () =>
        client.submit(
          {
            submissionId: 'submission',
            target: {
              ...scope,
              context: { kind: 'organization', organizationId: 'org' },
              chatId: 'chat',
            },
            parts: [{ type: 'text', text: 'Hello' }],
          },
          signal,
        ),
    ),
  ).rejects.toThrow(TextHttpError)
})

test('chats of an agent being deleted, or of an organization leaving active, are gone', () => {
  const agent = (lifecycle: string) => ({
    id: 'scout',
    name: 'Scout',
    description: '',
    lifecycle,
    admin: false,
    revision: 1,
    createdAt,
    deletedAt: lifecycle === 'deleted' ? createdAt : null,
  })
  const directory = (agentLifecycle: string, orgLifecycle?: string) =>
    ({
      cursor: 'c',
      agents: { scout: agent(agentLifecycle) },
      organizations: orgLifecycle
        ? {
            org: {
              id: 'org',
              name: 'Org',
              description: '',
              lifecycle: orgLifecycle,
              revision: 1,
              createdAt,
            },
          }
        : {},
      memberships: {},
      groups: {},
    }) as Directory
  expect(chatGone(directory('active', 'active'), summary)).toBe(false)
  // Archived agents and former members keep readable chats.
  expect(chatGone(directory('archived', 'active'), summary)).toBe(false)
  expect(chatGone(directory('deleting', 'active'), summary)).toBe(true)
  expect(chatGone(directory('deleted', 'active'), summary)).toBe(true)
  expect(chatGone(directory('active', 'deleting'), summary)).toBe(true)
  expect(chatGone(directory('active'), summary)).toBe(true)
  const installation = { ...summary, contextKind: 'installation' as const }
  expect(chatGone(directory('active'), installation)).toBe(false)
})

test('thread work projects current work, held follow-ups and a delegated child question', () => {
  const target = summaryTarget(scope, summary)
  const delegation: TextDelegation = {
    id: 'delegation',
    parentRunId: 'run',
    childRunId: 'child',
    senderAgentId: 'scout',
    recipientAgentId: 'ledger',
    originThreadId: 'thread',
    depth: 1,
    ordinal: 1,
    request: 'Check the figures',
    state: 'waiting',
    revision: 2,
  }
  const work = threadWork({
    target,
    agentId: 'scout',
    works: [
      run({
        runId: 'later',
        state: 'queued',
        queuePosition: 3,
        messageId: 'm3',
        attemptId: null,
      }),
      run({ state: 'failed', queueHold: true, failure: 'Provider failed' }),
      run({
        runId: 'cancelled',
        state: 'cancelled',
        queuePosition: 2,
        attemptId: null,
      }),
    ],
    interactions: [{ ...card, runId: 'child', sourceAgentId: 'ledger' }],
    delegations: [delegation],
    messages: {
      m3: {
        id: 'm3',
        threadId: 'thread',
        authorId: 'caller',
        position: 3,
        revision: 1,
        final: true,
        parts: [{ kind: 'text', text: 'And the totals?' }],
      },
    },
    notices: {},
  })
  const [flow] = work.workflows
  expect(flow).toMatchObject({
    runId: 'run',
    state: 'failed',
    held: true,
    reason: 'Provider failed',
  })
  expect(flow.actions.map((a) => a.action).sort()).toEqual(['resume', 'retry'])
  expect(work.queue).toMatchObject([
    { id: 'later', text: 'And the totals?', state: 'held' },
  ])
  expect(work.queue[0].actions).toEqual([
    { action: 'cancel-queued', allowed: true, reason: '' },
    expect.objectContaining({ action: 'steer', allowed: false }),
  ])
  // The child's question shows on the parent thread, naming the child agent.
  expect(work.interactions[0]).toMatchObject({
    sourceAgentId: 'ledger',
    delegationId: 'delegation',
    state: 'pending',
    target,
  })
  expect(work.delegations[0]).toMatchObject({
    fromAgentId: 'scout',
    toAgentId: 'ledger',
  })
  // Running work can be stopped; a question on the app stream already settled closes the card.
  const running = threadWork({
    target,
    agentId: 'scout',
    works: [
      run({ state: 'completed' }),
      run({ runId: 'next', state: 'waiting', queuePosition: 2 }),
    ],
    interactions: [card],
    delegations: [],
    messages: {},
    notices: {
      notice: { ...question, interactionState: 'settled', revision: 3 },
    },
  })
  expect(running.workflows[0]).toMatchObject({
    runId: 'next',
    actions: [{ action: 'stop' }],
  })
  expect(running.interactions[0]).toMatchObject({
    sourceAgentId: 'scout',
    state: 'settled',
  })
})

test('work commands use Core routes; refusals and gone threads are final', async () => {
  const target = summaryTarget(scope, summary)
  const bodies: { url: string; body: Record<string, unknown> }[] = []
  const applied: string[] = []
  const goneThreads: string[] = []
  const client = createCoreWorkClient('http://core.test', {
    interaction: (_thread, x) => applied.push(`${x.id}:${x.state}`),
    gone: (thread) => goneThreads.push(thread),
  })
  const signal = new AbortController().signal
  const stop: WorkOperation = {
    operationId: 'op-stop',
    target,
    action: 'cancel-queued',
    runId: 'run',
    attemptId: 'attempt',
    queueId: 'later',
  }
  const answer: WorkOperation = {
    operationId: 'op-answer',
    target,
    action: 'respond',
    runId: 'child',
    attemptId: 'attempt',
    interactionId: 'card',
    interactionVersion: 1,
    answer: { kind: 'choice', optionId: 'blue', text: '' },
  }
  const replies: Response[] = [
    json(200, {
      version: 1,
      operationId: 'op-stop',
      outcome: 'rejected',
      reason: 'Work is not queued',
      runId: 'later',
      threadId: 'thread',
      state: 'running',
    }),
    json(200, { version: 1, operationId: 'op-stop', status: 'unknown' }),
    json(200, {
      version: 1,
      operationId: 'op-answer',
      outcome: 'accepted',
      interaction: { ...card, runId: 'child', state: 'settled', revision: 2 },
    }),
    json(410, {
      version: 1,
      code: 'gone',
      message: 'Thread is gone',
      requestId: 'r',
    }),
    json(503, {
      version: 1,
      code: 'unavailable',
      message: 'down',
      requestId: 'r',
    }),
  ]
  await withFetch(
    async (url, init) => {
      bodies.push({ url, body: JSON.parse(String(init?.body)) })
      return replies.shift()!
    },
    async () => {
      expect(await client.command(stop, signal)).toMatchObject({
        status: 'rejected',
        message: 'Work is not queued',
      })
      expect(await client.receipt(stop, signal)).toEqual({
        operationId: 'op-stop',
        status: 'unknown',
      })
      expect(await client.command(answer, signal)).toMatchObject({
        status: 'accepted',
      })
      expect(await client.command(answer, signal)).toMatchObject({
        status: 'rejected',
        message: 'This conversation is no longer available.',
      })
      await expect(client.command(stop, signal)).rejects.toThrow()
    },
  )
  expect(bodies[0]).toEqual({
    url: 'http://core.test/v1/work/controls',
    body: {
      version: 1,
      operationId: 'op-stop',
      context: { kind: 'organization', organizationId: 'org' },
      chatId: 'chat',
      threadId: 'thread',
      runId: 'later',
      attemptId: null,
      action: 'cancel-queued',
    },
  })
  expect(bodies[1].url).toBe('http://core.test/v1/work/controls/receipt')
  expect(bodies[2]).toEqual({
    url: 'http://core.test/v1/work/interactions/answer',
    body: {
      version: 1,
      operationId: 'op-answer',
      interactionId: 'card',
      threadId: 'thread',
      runId: 'child',
      attemptId: 'attempt',
      answer: { kind: 'choice', optionId: 'blue' },
    },
  })
  expect(applied).toEqual(['card:settled'])
  expect(goneThreads).toEqual(['thread'])
})

test('notification actions batch IDs, skip refusals and fall back to single reads', async () => {
  const posts: { url: string; body: unknown }[] = []
  const ids = Array.from({ length: 201 }, (_, i) => `n${i}`)
  const signal = new AbortController().signal
  await withFetch(
    async (url, init) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return url.endsWith('/n1/read')
        ? json(404, { version: 1, code: 'gone', message: 'Gone' })
        : json(200, { version: 1, status: 'read', notificationIds: [] })
    },
    async () => {
      const batch = createNotificationClient('http://core.test', true)
      await batch.read(ids, signal)
      await batch.clear(['n0'], signal)
      const single = createNotificationClient('http://core.test', false)
      expect(single.canClear).toBe(false)
      await single.read(['n0', 'n1', 'n2'], signal)
      await single.clear(['n0'], signal)
    },
  )
  expect(posts.map((p) => p.url)).toEqual([
    'http://core.test/v1/notifications/read',
    'http://core.test/v1/notifications/read',
    'http://core.test/v1/notifications/clear',
    'http://core.test/v1/notifications/n0/read',
    'http://core.test/v1/notifications/n1/read',
    'http://core.test/v1/notifications/n2/read',
  ])
  expect(posts[0].body).toEqual({
    version: 1,
    notificationIds: ids.slice(0, 200),
  })
  expect(posts[1].body).toEqual({ version: 1, notificationIds: ['n200'] })
  await expect(
    withFetch(
      async () => json(503, { version: 1, code: 'unavailable', message: '' }),
      () =>
        createNotificationClient('http://core.test', true).read(ids, signal),
    ),
  ).rejects.toThrow()
})

test('inbox entries say who did what, with the excerpt and where', () => {
  const done = {
    id: 'done',
    threadId: 'thread',
    runId: 'run',
    kind: 'completed',
    read: false,
    revision: 1,
    createdAt,
  }
  const items = inboxItems({
    scope,
    notices: [
      { ...question, read: true, revision: 2 },
      { ...done, preview: 'Here is the summary.' },
      { ...done, id: 'failed', kind: 'failed', preview: 'Provider stopped.' },
      { ...done, id: 'interrupted', kind: 'recovery-needed' },
      { ...done, id: 'future', kind: 'digest' },
    ],
    summaries: { thread: summary },
    interactions: { thread: { card: { ...card, sourceAgentId: 'ledger' } } },
    firstMessage: () => ({
      id: 'message',
      threadId: 'thread',
      authorId: 'caller',
      position: 1,
      revision: 1,
      final: true,
      parts: [{ kind: 'text', text: 'Quarterly review' }],
    }),
    agentName: (id) => ({ scout: 'Scout', ledger: 'Ledger' })[id] ?? id,
    organizationName: () => 'Harbor Labs',
  })
  expect(items.map((n) => [n.title, n.body])).toEqual([
    ['Ledger needs your answer', 'Blue or red?'],
    ['Scout replied', 'Here is the summary.'],
    ['Scout couldn’t finish', 'Provider stopped.'],
    ['Scout’s work was interrupted', ''],
    ['Scout has an update', ''],
  ])
  expect(items[0]).toMatchObject({
    kind: 'question',
    agentId: 'ledger',
    thread: 'Quarterly review',
    context: 'Harbor Labs',
    pending: true,
    read: true,
    target: { chatId: 'chat', threadId: 'thread' },
  })
  expect(items.filter(needsYou).map((n) => n.id)).toEqual([
    'notice',
    'failed',
    'interrupted',
  ])
  const sections = inboxSections(items)
  expect(sections.needs).toHaveLength(3)
  expect(sections.updates).toHaveLength(1)
  expect(sections.updates[0].ids.sort()).toEqual(['done', 'future'])
  const marks = chatMarks(items, [], () => 'chat')
  expect(marks).toEqual({ chat: 'needs' })
  expect(
    chatMarks(
      items.filter((n) => !n.pending && n.kind !== 'failure'),
      ['thread'],
      () => 'chat',
    ),
  ).toEqual({ chat: 'failed' })
  expect(
    chatMarks(
      items.filter((n) => n.kind === 'completion'),
      ['thread'],
      () => 'chat',
    ),
  ).toEqual({ chat: 'working' })
  expect(
    chatMarks(
      items.filter((n) => n.kind === 'completion'),
      [],
      () => 'chat',
    ),
  ).toEqual({ chat: 'unread' })
})

test('records left by a deleted agent parse: null run links, removed files and removed threads', () => {
  const delegation = {
    id: 'delegation',
    parentRunId: null,
    childRunId: null,
    senderAgentId: 'scout',
    recipientAgentId: 'ledger',
    originThreadId: 'thread',
    depth: 1,
    ordinal: 1,
    request: 'Check the figures',
    state: 'completed',
    revision: 2,
  }
  const message = {
    id: 'message',
    threadId: 'thread',
    authorId: 'caller',
    position: 1,
    revision: 3,
    final: true,
    parts: [
      { kind: 'text', text: 'See attached' },
      { kind: 'removed', artifactId: 'file' },
    ],
  }
  const threadPage = {
    version: 1,
    scope: { kind: 'thread', ...scope, threadId: 'thread' },
    cursor: 't:thread:4',
    messages: [message],
    work: [],
    interactions: [],
    delegations: [delegation],
    next: null,
  }
  const parsed = parseThreadPage(threadPage)
  expect(parsed.delegations[0]).toMatchObject({
    parentRunId: null,
    childRunId: null,
  })
  expect(parsed.messages[0].parts[1]).toEqual({
    kind: 'removed',
    artifactId: 'file',
  })
  expect(
    threadWork({
      target: summaryTarget(scope, summary),
      agentId: 'scout',
      works: [],
      interactions: [],
      delegations: parsed.delegations,
      messages: {},
      notices: {},
    }).delegations[0],
  ).toMatchObject({
    fromAgentId: 'scout',
    toAgentId: 'ledger',
    state: 'completed',
  })
  expect(
    parseThreadPage({
      ...threadPage,
      delegations: [{ ...delegation, childRunId: '' }],
    }).delegations[0].childRunId,
  ).toBe('')
  expect(
    parseThreadPage({
      ...threadPage,
      messages: [{ ...message, parts: [{ kind: 'removed' }] }],
    }).messages[0].parts,
  ).toEqual([])
  const removed = {
    ...appEvent({ threadId: 'thread', chatId: 'chat' }, 5),
    type: 'thread-removed',
    resourceId: 'thread',
  }
  expect(parseWireEvent(removed, scope, null)).toMatchObject({
    type: 'thread-removed',
    data: { threadId: 'thread', chatId: 'chat' },
  })
  expect(
    parseWireEvent({ ...removed, resourceId: 'other' }, scope, null).data,
  ).toEqual(removed.data)
  expect(
    parseWireEvent({ ...removed, data: { threadId: 'thread' } }, scope, null)
      .data,
  ).toEqual({ threadId: 'thread' })
})

test('answer recovery uses the exact Core receipt route and immutable bindings', async () => {
  const operation: WorkOperation = {
    operationId: 'answer-retry',
    target: summaryTarget(scope, summary),
    action: 'respond',
    runId: 'run',
    attemptId: 'attempt',
    interactionId: 'card',
    interactionVersion: 1,
    proposalId: 'bound-proposal',
    answer: { kind: 'approve' },
  }
  const client = createCoreWorkClient('http://core.test', {
    interaction: () => {},
    gone: () => {},
  })
  await withFetch(
    async (url, init) => {
      expect(url).toBe('http://core.test/v1/work/interactions/receipt')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        operationId: 'answer-retry',
        interactionId: 'card',
        runId: 'run',
        attemptId: 'attempt',
        proposalId: 'bound-proposal',
      })
      return json(200, {
        version: 1,
        operationId: 'answer-retry',
        status: 'unknown',
      })
    },
    async () => {
      expect(
        await client.receipt(operation, new AbortController().signal),
      ).toMatchObject({ status: 'unknown' })
    },
  )
})

test('notification removal reads the data ID rather than the envelope ID', () => {
  const event = {
    version: 1,
    eventId: 'removed-event',
    cursor: 'cursor',
    occurredAt: createdAt,
    scope: { kind: 'application', ...scope },
    type: 'notification-removed',
    resourceId: 'notice',
    revision: 3,
    data: { id: 'notice', threadId: 'thread' },
  }
  expect(parseWireEvent(event, scope, null)).toMatchObject({
    type: 'notification-removed',
    data: { id: 'notice', threadId: 'thread' },
  })
  expect(
    parseWireEvent(
      { ...event, data: { id: 'other', threadId: 'thread' } },
      scope,
      null,
    ).data,
  ).toEqual({ id: 'other', threadId: 'thread' })
})
