import { expect, test } from '@playwright/test'
import {
  agentLabel,
  applyDirectoryEvent,
  formerMemberChats,
  parseDirectory,
  parseDirectoryEvent,
  resolveSelection,
  workspaceView,
  type Directory,
  type DirectoryEvent,
} from '../src/data/directory.js'
import { mergeAppSummaries, upsertRevision } from '../src/data/state.js'
import {
  TextClient,
  TextHttpError,
  parseWireEvent,
  type Summary,
} from '../src/data/text.js'

const at = '2026-09-27T00:00:00.000Z'
const org = (id: string, revision = 1, lifecycle = 'active') => ({
  id,
  name: id,
  description: '',
  lifecycle,
  revision,
  createdAt: at,
})
const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  description: '',
  lifecycle: 'active',
  admin: false,
  revision: 1,
  createdAt: at,
  deletedAt: null,
  ...extra,
})
const membership = (id: string, organizationId: string, agentId: string) => ({
  id,
  organizationId,
  agentId,
  revision: 1,
  createdAt: at,
})
const group = (
  id: string,
  organizationId: string,
  position: number,
  appearances: [string, string][],
  revision = 1,
) => ({
  id,
  organizationId,
  name: id,
  position,
  revision,
  appearances: appearances.map(([membershipId, agentId]) => ({
    membershipId,
    agentId,
  })),
})
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  cursor: 'a:installation:3',
  organizations: [
    org('studio'),
    { ...org('harbor'), createdAt: '2026-09-27T01:00:00.000Z' },
  ],
  agents: [
    agent('admin', { admin: true }),
    agent('scout'),
    agent('atlas'),
    agent('dormant', { lifecycle: 'archived' }),
  ],
  memberships: [
    membership('m-admin', 'studio', 'admin'),
    membership('m-scout', 'studio', 'scout'),
    membership('m-atlas', 'studio', 'atlas'),
    membership('m-dormant', 'studio', 'dormant'),
    membership('m-scout-harbor', 'harbor', 'scout'),
  ],
  groups: [
    group('writing', 'studio', 1, [['m-atlas', 'atlas']]),
    group('research', 'studio', 0, [
      ['m-scout', 'scout'],
      ['m-atlas', 'atlas'],
    ]),
    group('finance', 'harbor', 0, [['m-scout-harbor', 'scout']]),
  ],
  ...overrides,
})
const summary = (
  threadId: string,
  contextKind: 'installation' | 'organization',
  contextId: string,
  agentId: string,
  revision = 1,
): Summary => ({
  threadId,
  chatId: `chat-${contextId}-${agentId}`,
  contextKind,
  contextId,
  agentId,
  state: 'completed',
  lastMessageId: `${threadId}-message`,
  revision,
  createdAt: at,
})
const apply = (directory: Directory, ...events: DirectoryEvent[]) =>
  events.reduce(
    (current, event, index) =>
      applyDirectoryEvent(current, event, `a:installation:${index + 10}`),
    directory,
  )
const scope = { installationId: 'installation', callerId: 'owner' }
const envelope = (
  type: string,
  data: unknown,
  resourceId: string,
  revision: number,
) => ({
  version: 1,
  eventId: `event-${resourceId}`,
  cursor: 'a:installation:4',
  occurredAt: at,
  scope: { kind: 'application', ...scope },
  resourceId,
  revision,
  type,
  data,
})

test('the directory parser keys readable records and tolerates new values', () => {
  const directory = parseDirectory({
    ...snapshot(),
    version: 2,
    extra: 'allowed',
  })
  expect(Object.keys(directory.organizations)).toEqual(['studio', 'harbor'])
  expect(directory.groups.research.appearances.map((a) => a.agentId)).toEqual([
    'scout',
    'atlas',
  ])
  for (const unusual of [
    snapshot({ version: 2 }),
    snapshot({ cursor: '' }),
    snapshot({ organizations: [org('studio'), org('studio')] }),
    snapshot({ organizations: [{ ...org('studio'), lifecycle: 'gone' }] }),
    snapshot({ agents: [agent('scout', { lifecycle: 'deleted' })] }),
    snapshot({ agents: [agent('scout', { deletedAt: at })] }),
    snapshot({ groups: [group('g', 'studio', -1, [])] }),
    snapshot({ organizations: [{ ...org('studio'), createdAt: 'yesterday' }] }),
  ])
    expect(() => parseDirectory(unusual)).not.toThrow()
  const partial = parseDirectory(
    snapshot({
      agents: [agent('scout'), agent('broken', { admin: 'no' })],
      memberships: [membership('m', 'studio', 'scout'), 1],
      groups: [
        group('good', 'studio', 0, []),
        { ...group('bad', 'studio', 1, []), appearances: {} },
      ],
    }),
  )
  expect(Object.keys(partial.agents)).toEqual(['scout'])
  expect(Object.keys(partial.memberships)).toEqual(['m'])
  expect(Object.keys(partial.groups)).toEqual(['good'])
  for (const broken of [
    null,
    [],
    snapshot({ agents: null }),
    snapshot({ cursor: 3 }),
  ])
    expect(() => parseDirectory(broken)).toThrow(TextHttpError)
  const deleted = parseDirectory(
    snapshot({
      agents: [agent('old', { lifecycle: 'deleted', deletedAt: at })],
    }),
  )
  expect(agentLabel(deleted, 'old')).toBe('old · deleted')
})

test('directory events read their data without matching envelope IDs or revisions', () => {
  for (const event of [
    envelope('agent-changed', agent('scout'), 'atlas', 1),
    envelope('agent-changed', agent('scout'), 'scout', 2),
    envelope('organization-removed', { id: 'studio' }, 'harbor', 2),
    envelope('group-removed', { id: 'g' }, 'g', 2),
  ])
    expect(parseWireEvent(event, scope, null).data).toEqual(event.data)
  expect(() =>
    parseWireEvent(
      envelope('membership-changed', { id: 'm' }, 'm', 1),
      scope,
      null,
    ),
  ).toThrow(TextHttpError)
  expect(
    parseWireEvent(envelope('operation-changed', {}, 'op', 1), scope, null)
      .type,
  ).toBe('unsupported')
  expect(
    parseDirectoryEvent('group-changed', group('g', 'o', 0, [])),
  ).toMatchObject({ type: 'group-changed' })
})

test('records merge by revision and removals always apply', () => {
  const start = parseDirectory(snapshot())
  const renamed = { ...group('research', 'studio', 0, []), name: 'Science' }
  const newer = apply(start, {
    type: 'group-changed',
    data: { ...renamed, revision: 3 },
  })
  expect(newer.groups.research.name).toBe('Science')
  expect(newer.cursor).toBe('a:installation:10')
  // An older record is ignored; an equal revision replays harmlessly.
  const stale = apply(newer, {
    type: 'group-changed',
    data: { ...renamed, name: 'Old', revision: 2 },
  })
  expect(stale.groups.research.name).toBe('Science')
  const same = apply(newer, {
    type: 'group-changed',
    data: { ...renamed, revision: 3 },
  })
  expect(same.groups.research).toEqual(newer.groups.research)
  const gone = apply(newer, {
    type: 'group-removed',
    data: { id: 'research', organizationId: 'studio' },
  })
  expect(gone.groups.research).toBeUndefined()
  expect(gone.groups.writing).toBeDefined()
  const agentRenamed = apply(start, {
    type: 'agent-changed',
    data: parseDirectory(
      snapshot({ agents: [{ ...agent('scout'), name: 'Scout', revision: 2 }] }),
    ).agents.scout,
  })
  expect(agentRenamed.agents.scout.name).toBe('Scout')
})

test('cascades: removed memberships leave groups; inactive or removed organizations drop their children', () => {
  const start = parseDirectory(snapshot())
  const removed = apply(start, {
    type: 'membership-removed',
    data: { id: 'm-atlas', organizationId: 'studio', agentId: 'atlas' },
  })
  expect(removed.memberships['m-atlas']).toBeUndefined()
  expect(removed.groups.research.appearances.map((a) => a.agentId)).toEqual([
    'scout',
  ])
  expect(removed.groups.writing.appearances).toEqual([])
  const deleting = apply(start, {
    type: 'organization-changed',
    data: parseDirectory(
      snapshot({ organizations: [org('studio', 2, 'deleting')] }),
    ).organizations.studio,
  })
  expect(deleting.organizations.studio.lifecycle).toBe('deleting')
  expect(
    Object.values(deleting.memberships).map((m) => m.organizationId),
  ).toEqual(['harbor'])
  expect(Object.keys(deleting.groups)).toEqual(['finance'])
  const dropped = apply(start, {
    type: 'organization-removed',
    data: { id: 'harbor' },
  })
  expect(dropped.organizations.harbor).toBeUndefined()
  expect(dropped.groups.finance).toBeUndefined()
  expect(dropped.memberships['m-scout-harbor']).toBeUndefined()
  // An older copy of an organization cannot bring it or its children back.
  const late = apply(deleting, {
    type: 'organization-changed',
    data: parseDirectory(snapshot()).organizations.studio,
  })
  expect(late.organizations.studio.lifecycle).toBe('deleting')
})

test('former-member chats are derived from summaries without a membership', () => {
  const start = parseDirectory(
    snapshot({
      agents: [
        ...snapshot().agents,
        agent('gone', { lifecycle: 'deleted', deletedAt: at }),
      ],
    }),
  )
  const summaries = Object.fromEntries(
    [
      summary('t1', 'organization', 'studio', 'atlas'),
      summary('t2', 'organization', 'studio', 'atlas'),
      summary('t3', 'organization', 'studio', 'scout'),
      summary('t4', 'installation', 'installation', 'admin'),
      summary('t5', 'organization', 'harbor', 'atlas'),
      summary('t6', 'organization', 'harbor', 'dormant'),
      summary('t7', 'organization', 'harbor', 'gone'),
      summary('t8', 'organization', 'harbor', 'admin'),
      summary('t9', 'organization', 'closed', 'atlas'),
    ].map((s) => [s.threadId, s]),
  )
  // Atlas never joined Harbor Labs; archived agents and the admin stay out; the deleted
  // agent keeps its chat under its last name; unknown organizations are ignored.
  expect(formerMemberChats(start, summaries)).toEqual([
    { organizationId: 'harbor', agentId: 'atlas', chatId: 'chat-harbor-atlas' },
    { organizationId: 'harbor', agentId: 'gone', chatId: 'chat-harbor-gone' },
  ])
  const removed = apply(start, {
    type: 'membership-removed',
    data: { id: 'm-atlas', organizationId: 'studio', agentId: 'atlas' },
  })
  expect(
    formerMemberChats(removed, summaries).map((f) => f.organizationId),
  ).toEqual(['studio', 'harbor', 'harbor'])
  const readded = apply(removed, {
    type: 'membership-changed',
    data: { ...membership('m-atlas-2', 'studio', 'atlas') },
  })
  expect(
    formerMemberChats(readded, summaries).map((f) => f.organizationId),
  ).toEqual(['harbor', 'harbor'])
  const closing = apply(removed, {
    type: 'organization-changed',
    data: parseDirectory(
      snapshot({ organizations: [org('studio', 2, 'deleting')] }),
    ).organizations.studio,
  })
  expect(
    formerMemberChats(closing, summaries).map((f) => f.organizationId),
  ).toEqual(['harbor', 'harbor'])
})

test('following from the older directory cursor converges with a fresh directory and app state', () => {
  // The directory is read first (cursor 3). Then Atlas is removed (4), Pixel joins (5) and the
  // app snapshot is read (cursor 5, holding the newer summary). The stream replays from 3.
  const directory = parseDirectory(snapshot())
  const oldSummary = summary('t1', 'organization', 'studio', 'atlas', 1)
  const newSummary = { ...oldSummary, state: 'running', revision: 2 }
  const events: DirectoryEvent[] = [
    {
      type: 'membership-removed',
      data: { id: 'm-atlas', organizationId: 'studio', agentId: 'atlas' },
    },
    {
      type: 'group-changed',
      data: parseDirectory(
        snapshot({
          groups: [group('research', 'studio', 0, [['m-scout', 'scout']], 2)],
        }),
      ).groups.research,
    },
    {
      type: 'membership-changed',
      data: { ...membership('m-pixel', 'studio', 'pixel') },
    },
  ]
  let summaries = mergeAppSummaries({}, [newSummary])
  let merged = directory
  for (const event of events) merged = apply(merged, event)
  // Replayed summary changes already in the newer app snapshot change nothing.
  summaries = upsertRevision(summaries, 't1', oldSummary)
  expect(summaries.t1.state).toBe('running')
  const fresh = parseDirectory(
    snapshot({
      memberships: snapshot().memberships.filter(
        (m) => (m as { id: string }).id !== 'm-atlas',
      ),
      groups: [
        group('writing', 'studio', 1, []),
        group('research', 'studio', 0, [['m-scout', 'scout']], 2),
        group('finance', 'harbor', 0, [['m-scout-harbor', 'scout']]),
      ],
    }),
  )
  fresh.memberships['m-pixel'] = membership('m-pixel', 'studio', 'pixel')
  const comparable = (d: Directory) => ({ ...d, cursor: '' })
  expect(comparable(merged)).toEqual(comparable(fresh))
  expect(formerMemberChats(merged, summaries)).toEqual([
    { organizationId: 'studio', agentId: 'atlas', chatId: 'chat-studio-atlas' },
  ])
  // Replaying the same events again is idempotent.
  let again = merged
  for (const event of events) again = apply(again, event)
  expect(comparable(again)).toEqual(comparable(merged))
})

test('the workspace snapshot reads the directory first and follows from its cursor', async () => {
  const originalFetch = globalThis.fetch
  const requested: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    requested.push(path)
    const body =
      path === '/v1/directory'
        ? snapshot({ cursor: 'a:installation:3' })
        : {
            version: 1,
            scope: { kind: 'application', ...scope },
            cursor: 'a:installation:5',
            threads: [summary('t1', 'organization', 'studio', 'atlas')],
            notifications: [],
            next: null,
          }
    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const client = new TextClient('http://127.0.0.1:12345')
    const result = await client.workspaceSnapshot(new AbortController().signal)
    expect(requested).toEqual(['/v1/directory', '/v1/app/snapshot'])
    expect(result.cursor).toBe('a:installation:3')
    expect(result.threads).toHaveLength(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('navigation lists active, non-admin members by group order and resolves selections', () => {
  const directory = parseDirectory(snapshot())
  const view = workspaceView(directory, 'installation', 'owner', () => 'iris')
  expect(view.organizations.map((o) => o.id)).toEqual(['studio', 'harbor'])
  expect(view.agentRoles).toEqual([{ agentId: 'admin', role: 'root-admin' }])
  expect(view.memberships.map((m) => m.actorId)).toEqual([
    'atlas',
    'scout',
    'scout',
  ])
  expect(
    view.groups.filter((g) => g.organizationId === 'studio').map((g) => g.id),
  ).toEqual(['research', 'writing'])
  // Atlas appears in two groups through one membership, so both open one chat.
  expect(
    view.groupAssignments.filter((a) => a.membershipId === 'm-atlas'),
  ).toEqual([
    { groupId: 'research', membershipId: 'm-atlas' },
    { groupId: 'writing', membershipId: 'm-atlas' },
  ])
  const base = {
    organizationId: null,
    agentId: null,
    target: 'organization' as const,
    collapsed: false,
    segment: 'all',
  }
  expect(resolveSelection(view, [], base)).toMatchObject({
    organizationId: 'studio',
    agentId: 'atlas',
    target: 'organization',
  })
  expect(
    resolveSelection(view, [], {
      ...base,
      organizationId: 'harbor',
      agentId: 'atlas',
      segment: 'research',
    }),
  ).toMatchObject({
    organizationId: 'harbor',
    agentId: 'scout',
    segment: 'all',
  })
  const former = [{ organizationId: 'harbor', agentId: 'atlas' }]
  expect(
    resolveSelection(view, former, {
      ...base,
      organizationId: 'harbor',
      agentId: 'atlas',
    }),
  ).toMatchObject({ agentId: 'atlas', target: 'organization' })
  expect(
    resolveSelection(view, [], {
      ...base,
      organizationId: 'gone',
      target: 'installation',
      agentId: 'admin',
    }),
  ).toMatchObject({
    organizationId: 'studio',
    agentId: 'admin',
    target: 'installation',
  })
  const empty = workspaceView(
    parseDirectory(snapshot({ memberships: [], groups: [] })),
    'installation',
    'owner',
    () => 'iris',
  )
  expect(resolveSelection(empty, [], base)).toMatchObject({
    agentId: 'admin',
    target: 'installation',
  })
})
