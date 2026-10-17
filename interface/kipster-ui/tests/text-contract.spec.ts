import * as protocol from '@kipster/core/protocol'
import { CoreSettingsClient } from '../src/data/core-settings.js'
import { expect, test } from '@playwright/test'
import {
  TextClient,
  TextHttpError,
  parseAppPage,
  parseThreadPage,
  parseWireEvent,
  parseMessage,
} from '../src/data/text.js'

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
const message = {
  id: 'message',
  threadId: 'thread',
  authorId: 'caller',
  position: 1,
  revision: 1,
  final: true,
  parts: [{ kind: 'text', text: 'Hello' }],
}
const work = {
  runId: 'run',
  attemptId: null,
  state: 'queued',
  queueHold: false,
  cancelDelivery: 'none',
  revision: 1,
  queuePosition: 1,
  messageId: 'message',
  failure: null,
}
const envelope = (type: string, data: unknown, resourceId: string) => ({
  version: 1,
  eventId: 'event',
  cursor: 'a:installation:1',
  occurredAt: '2026-09-23T00:00:00.000Z',
  scope: { kind: 'application', ...scope },
  resourceId,
  revision: 1,
  type,
  data,
})

test('pages skip malformed items and still require the lists used by the UI', () => {
  const app = {
    version: 2,
    scope: { kind: 'application', ...scope },
    cursor: 'cursor',
    threads: [summary, { ...summary, revision: '1' }, null],
    notifications: [],
    next: null,
  }
  expect(parseAppPage(app).threads).toEqual([summary])
  expect(() => parseAppPage({ ...app, threads: null })).toThrow(TextHttpError)
  expect(
    parseAppPage({ ...app, scope: { ...app.scope, installationId: 'other' } })
      .threads,
  ).toEqual([summary])
  const thread = {
    version: 2,
    scope: { kind: 'thread', ...scope, threadId: 'thread' },
    cursor: 'cursor',
    messages: [message, { ...message, parts: null }],
    work: [work, { ...work, queuePosition: null }],
    interactions: [],
    next: null,
  }
  expect(parseThreadPage(thread).messages).toEqual([message])
  expect(parseThreadPage(thread).work).toEqual([work])
  expect(() => parseThreadPage({ ...thread, interactions: undefined })).toThrow(
    TextHttpError,
  )
})

test('the shared stream reader keeps large frames, skips foreign scopes and advances past unknown kinds', async () => {
  const originalFetch = globalThis.fetch
  const future = {
    ...envelope('future-kind', { text: 'x'.repeat(500_001) }, 'future'),
    version: 2,
  }
  const foreign = {
    ...future,
    cursor: 'a:installation:0',
    scope: { ...future.scope, callerId: 'other' },
  }
  const next = {
    ...envelope('thread-summary', summary, 'thread'),
    cursor: 'a:installation:2',
  }
  const bytes = new TextEncoder().encode(
    [foreign, future, next]
      .map(
        (event) =>
          `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join(''),
  )
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          const split = bytes.indexOf(13) + 1
          controller.enqueue(bytes.slice(0, split))
          controller.enqueue(bytes.slice(split))
          controller.close()
        },
      }),
    )
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
    expect(applied).toEqual([
      'unsupported@a:installation:0',
      'unsupported@a:installation:1',
      'thread-summary@a:installation:2',
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
    expect(settings).toEqual([
      'skipped@a:installation:0',
      'skipped@a:installation:1',
      'skipped@a:installation:2',
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pagination stops when the next cursor does not change', async () => {
  const originalFetch = globalThis.fetch
  let reads = 0
  globalThis.fetch = async () => {
    if (++reads > 2) throw new Error('Pagination repeated its cursor')
    return Response.json({
      version: 2,
      scope: { kind: 'application', ...scope },
      cursor: 'snapshot',
      threads: [summary],
      notifications: [],
      next: { afterThreadId: 'thread', afterNotificationId: null },
    })
  }
  try {
    const result = await new TextClient('http://127.0.0.1:12345').appSnapshot(
      new AbortController().signal,
    )
    expect(reads).toBe(2)
    expect(result.threads[0]).toEqual(summary)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('events use their data and skip unknown kinds and unrelated scopes', () => {
  const event = {
    ...envelope('thread-summary', summary, 'other'),
    version: 2,
    revision: -7,
    occurredAt: 'whenever',
  }
  expect(parseWireEvent(event, scope, null).data).toEqual(summary)
  for (const other of [
    { ...event, type: 'future-kind' },
    { ...event, type: '' },
    { ...event, scope: { ...event.scope, installationId: 'other' } },
    { ...event, scope: { ...event.scope, callerId: 'someone' } },
    { ...event, scope: { ...event.scope, kind: 'future-scope' } },
  ])
    expect(parseWireEvent(other, scope, null)).toMatchObject({
      type: 'unsupported',
      data: null,
    })
  expect(() =>
    parseWireEvent({ ...event, data: { ...summary, state: {} } }, scope, null),
  ).toThrow(TextHttpError)
})

test('voice preparation is parsed as derived status beside the original part', () => {
  const voice = {
    ...message,
    parts: [{ kind: 'file', artifactId: 'audio', purpose: 'voice_note' }],
    preparation: [
      {
        id: 'message:0',
        artifactId: 'audio',
        partIndex: 0,
        revision: 2,
        status: 'unavailable',
        provider: 'spokenly-cli',
        error: 'timeout',
      },
    ],
  }
  expect(
    parseThreadPage({
      version: 1,
      scope: { kind: 'thread', ...scope, threadId: 'thread' },
      cursor: 't:thread:1',
      messages: [voice],
      work: [],
      interactions: [],
      next: null,
    }).messages[0].preparation?.[0].status,
  ).toBe('unavailable')
  expect(
    parseMessage({
      ...voice,
      preparation: [{ ...voice.preparation[0], status: 'future-status' }],
    }).preparation?.[0].status,
  ).toBe('future-status')
})

test('kip messaging summaries and message parts parse through Core’s schemas and the client keeps them', () => {
  const linked = {
    ...summary,
    startedBy: 'agent-a',
    linkedFrom: {
      threadId: 'source',
      chatId: 'source-chat',
      agentId: 'agent-a',
      title: 'Berlin research',
    },
  }
  const source = {
    ...summary,
    threadId: 'source',
    startedBy: 'caller',
    links: [
      { agentId: 'agent-b', threadId: 'thread', chatId: 'chat', waiting: true },
    ],
  }
  const sent = {
    ...message,
    authorId: 'agent-a',
    parts: [
      { kind: 'text', text: 'Which plans are confirmed?' },
      {
        kind: 'kip-message',
        recipientId: 'agent-b',
        threadId: 'thread',
        chatId: 'chat',
      },
    ],
  }
  const answer = {
    ...message,
    id: 'answer',
    authorId: 'agent-b',
    position: 2,
    parts: [
      { kind: 'text', text: 'Berlin and Lisbon.' },
      {
        kind: 'kip-answer',
        agentId: 'agent-b',
        threadId: 'thread',
        chatId: 'chat',
      },
    ],
  }
  for (const value of [linked, source])
    expect(protocol.appThreadSummary.parse(value)).toEqual(value)
  for (const value of [sent, answer])
    expect(
      protocol.threadMessage.parse({
        ...value,
        createdAt: '2026-09-23T00:00:00.000Z',
      }).parts,
    ).toEqual(value.parts)
  const app = parseAppPage({
    version: 1,
    scope: { kind: 'application', ...scope },
    cursor: 'cursor',
    threads: [linked, source],
    notifications: [],
    next: null,
  })
  expect(app.threads).toEqual([linked, source])
  const page = parseThreadPage({
    version: 1,
    scope: { kind: 'thread', ...scope, threadId: 'source' },
    cursor: 't:source:2',
    messages: [sent, answer],
    work: [],
    interactions: [],
    next: null,
  })
  expect(page.messages.map((m) => m.parts)).toEqual([sent.parts, answer.parts])
  // From protocol 3 a thread snapshot may omit Core's deprecated list.
  const snapshot = {
    version: 1,
    scope: { kind: 'thread', ...scope, threadId: 'source' },
    cursor: 't:source:2',
    messages: [{ ...sent, createdAt: '2026-09-23T00:00:00.000Z' }],
    work: [],
    interactions: [],
    next: null,
  }
  expect(protocol.threadSnapshot.parse(snapshot)).toEqual(snapshot)
  // A marker missing its thread is dropped; the message keeps its text.
  expect(
    parseMessage({
      ...answer,
      parts: [answer.parts[0], { kind: 'kip-answer', agentId: 'agent-b' }],
    }).parts,
  ).toEqual([answer.parts[0]])
})

test('voice preparation tolerates unusual values without imposing Core rules', () => {
  const voice = {
    ...message,
    parts: [{ kind: 'file', artifactId: 'audio', purpose: 'voice_note' }],
    preparation: [
      {
        id: 'preparation',
        artifactId: 'audio',
        partIndex: 0,
        revision: 0,
        status: 'succeeded',
        provider: 'spokenly-cli',
        transcript: 'Original voice',
      },
    ],
  }
  expect(parseMessage(voice).preparation?.[0].provider).toBe('spokenly-cli')
  for (const patch of [
    { provider: '' },
    { provider: '   ' },
    { revision: -1 },
    { revision: 0.5 },
    { partIndex: -1 },
    { partIndex: 1 },
    { partIndex: 0.5 },
    { artifactId: 'other' },
  ])
    expect(
      parseMessage({
        ...voice,
        preparation: [{ ...voice.preparation[0], ...patch }],
      }).preparation?.[0],
    ).toMatchObject(patch)
  for (const part of [
    { kind: 'text', text: 'Not voice' },
    { kind: 'file', artifactId: 'audio', purpose: 'attachment' },
  ])
    expect(parseMessage({ ...voice, parts: [part] }).parts).toEqual([part])
})
