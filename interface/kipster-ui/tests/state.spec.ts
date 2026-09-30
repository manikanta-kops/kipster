import { expect, test } from '@playwright/test'
import {
  mergeAppNotices,
  mergeAppSummaries,
  mergeNotice,
  mergeRevisions,
  threadTitle,
} from '../src/data/state.js'
import type { Notice, Summary, TextMessage } from '../src/data/text.js'

test('a late selected snapshot cannot replace a newer streamed revision', () => {
  const base: TextMessage = {
    id: 'message',
    threadId: 'thread',
    authorId: 'agent',
    position: 1,
    revision: 1,
    final: false,
    parts: [{ kind: 'text', text: 'draft' }],
  }
  const streamed = {
    ...base,
    revision: 2,
    final: true,
    parts: [{ kind: 'text' as const, text: 'final' }],
  }
  const afterStream = mergeRevisions({}, [streamed], (message) => message.id)
  expect(
    mergeRevisions(afterStream, [base], (message) => message.id).message,
  ).toEqual(streamed)
})

test('a file-only first message gives its thread a settled title', () => {
  const first: TextMessage = {
    id: 'message',
    threadId: 'thread',
    authorId: 'caller',
    position: 1,
    revision: 1,
    final: true,
    parts: [{ kind: 'file', artifactId: 'artifact', purpose: 'attachment' }],
  }
  expect(threadTitle(undefined)).toBe('Loading thread')
  expect(threadTitle(first)).toBe('File attachment')
  expect(
    threadTitle({ ...first, parts: [{ kind: 'text', text: 'Named thread' }] }),
  ).toBe('Named thread')
})

test('a late application snapshot preserves newer summary and confirmed read', () => {
  const base: Summary = {
    threadId: 'thread',
    chatId: 'chat',
    contextKind: 'installation',
    contextId: 'installation',
    agentId: 'agent',
    state: 'running',
    lastMessageId: 'message',
    revision: 1,
    createdAt: '2026-09-23T00:00:00.000Z',
  }
  const newer = { ...base, state: 'completed', revision: 2 }
  expect(mergeAppSummaries({ thread: newer }, [base]).thread).toEqual(newer)
  const unread: Notice = {
    id: 'notice',
    threadId: 'thread',
    runId: 'run',
    kind: 'completed',
    read: false,
    revision: 1,
    createdAt: '2026-09-23T00:00:00.000Z',
  }
  const read = { ...unread, read: true, revision: 2 }
  expect(mergeAppNotices({ notice: read }, [unread]).notice).toEqual(read)
  expect(mergeNotice(read, unread)).toEqual(read)
})
