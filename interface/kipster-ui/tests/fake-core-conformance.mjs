import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as protocol from '@kipster/core/protocol'
import { createFakeCore } from '../src/fake-core/index.ts'

const origin = 'https://demo.kipster.invalid'
async function replay(response, endCursor) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let pending = ''
  try {
    while (events.at(-1)?.cursor !== endCursor) {
      const { value, done } = await reader.read()
      assert.equal(
        done,
        false,
        'stream ended before its current snapshot cursor',
      )
      pending += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const line = frame.split('\n').find((line) => line.startsWith('data: '))
        if (!line) continue
        const event = protocol.textEvent.parse(JSON.parse(line.slice(6)))
        assert.ok(frame.includes(`id: ${event.cursor}`))
        assert.ok(frame.includes(`event: ${event.type}`))
        events.push(event)
      }
    }
  } finally {
    await reader.cancel()
  }
  assert.equal(
    new Set(events.map((event) => event.eventId)).size,
    events.length,
  )
  return events
}
function harness(t) {
  const core = createFakeCore({ autoAdvance: false, testControls: true })
  t.after(() => core.dispose())
  const request = (path, method = 'GET', body) =>
    core.handle(
      new Request(origin + path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    )
  const json = async (path, schema, method = 'GET', body) => {
    const response = await request(path, method, body)
    const value = await response.json()
    assert.ok(
      response.ok,
      `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
    )
    return schema ? schema.parse(value) : value
  }
  return { core, request, json }
}
const op = (fields = {}) => ({
  version: 1,
  operationId: randomUUID(),
  ...fields,
})
const query = (values) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ).toString()
async function target(json) {
  const bootstrap = await json('/v1/bootstrap')
  assert.equal(bootstrap.version, 1)
  for (const key of [
    'installationId',
    'callerId',
    'organizationId',
    'rootAgentId',
  ])
    assert.match(bootstrap[key], /^[0-9a-f-]{36}$/)
  assert.equal(typeof bootstrap.capabilities.voiceRecording, 'boolean')
  const directory = await json('/v1/directory', protocol.directorySnapshot)
  const membership = directory.memberships.find(
    (item) => item.organizationId === bootstrap.organizationId,
  )
  const context = {
    kind: 'organization',
    organizationId: bootstrap.organizationId,
  }
  const chat = await json(
    '/v1/direct-chats',
    protocol.directChatResult,
    'POST',
    { version: 1, context, agentId: membership.agentId },
  )
  return {
    bootstrap,
    directory,
    agentId: membership.agentId,
    context,
    chatId: chat.chatId,
  }
}

test('bootstrap, directory and seeded snapshots conform to public schemas', async (t) => {
  const { json } = harness(t)
  const { directory, bootstrap } = await target(json)
  assert.ok(directory.organizations.length >= 2)
  assert.ok(directory.groups.length >= 2)
  assert.ok(
    directory.agents.some(
      (agent) => agent.id === bootstrap.rootAgentId && agent.admin,
    ),
  )
  const appearances = directory.groups.flatMap((group) =>
    group.appearances.map((appearance) => appearance.agentId),
  )
  assert.ok(
    new Set(appearances).size < appearances.length,
    'an agent appears in two groups',
  )
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  const states = new Set()
  const kinds = new Set()
  let files = 0
  let voices = 0
  let delegations = 0
  for (const thread of app.threads) {
    const snapshot = await json(
      `/v1/threads/${thread.threadId}/snapshot`,
      protocol.threadSnapshot,
    )
    for (const work of snapshot.work) states.add(work.state)
    for (const interaction of snapshot.interactions) kinds.add(interaction.kind)
    delegations += snapshot.delegations.length
    for (const message of snapshot.messages)
      for (const part of message.parts) {
        if (part.kind === 'file') files++
        if (part.kind === 'file' && part.purpose === 'voice_note') voices++
      }
  }
  for (const state of [
    'queued',
    'preparing',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
    'recovery-needed',
    'cancellation-requested',
  ])
    assert.ok(states.has(state), state)
  assert.ok(kinds.has('question') && kinds.has('approval'))
  assert.ok(files && voices && delegations && app.notifications.length)
})

test('submissions and receipts are idempotent and scoped; history has no invented route', async (t) => {
  const { json, request } = harness(t)
  const { bootstrap, context, chatId, agentId } = await target(json)
  const again = await json(
    '/v1/direct-chats',
    protocol.directChatResult,
    'POST',
    { version: 1, context, agentId },
  )
  assert.equal(again.chatId, chatId)
  const submission = {
    version: 1,
    submissionId: randomUUID(),
    scope: {
      installationId: bootstrap.installationId,
      callerId: bootstrap.callerId,
    },
    target: { context, chatId },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Explore a new idea' }],
  }
  const first = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    submission,
  )
  const repeat = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    {
      ...submission,
      parts: [
        {
          kind: 'text',
          text: 'Changed text must not overwrite accepted content',
        },
      ],
    },
  )
  assert.equal(first.threadId, repeat.threadId)
  assert.equal(repeat.alreadyAccepted, true)
  const receipt = await json(
    `/v1/text/receipts/${submission.submissionId}`,
    protocol.acceptedReceipt,
  )
  assert.equal(receipt.messageId, first.messageId)
  const thread = await json(
    `/v1/threads/${first.threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  assert.equal(thread.messages.length, 1)
  assert.deepEqual(thread.messages[0].parts, submission.parts)
  const rejected = await request('/v1/text/submissions', 'POST', {
    ...submission,
    submissionId: randomUUID(),
    scope: { ...submission.scope, callerId: randomUUID() },
  })
  assert.equal(rejected.status, 403)
  protocol.stableError.parse(await rejected.json())
  assert.equal(
    (await request(`/v1/threads/${first.threadId}/history`)).status,
    404,
  )
})

test('paged snapshots share a cursor and require resync after mutations', async (t) => {
  const { json, request } = harness(t)
  const first = await json('/v1/app/snapshot?limit=2', protocol.appSnapshot)
  assert.ok(first.next)
  const expected = await json(
    `/v1/app/snapshot?at=${encodeURIComponent(first.cursor)}`,
    protocol.appSnapshot,
  )
  const threads = [...first.threads]
  const notifications = [...first.notifications]
  let page = first
  while (page.next) {
    page = await json(
      `/v1/app/snapshot?${query({ at: first.cursor, limit: 2, ...page.next })}`,
      protocol.appSnapshot,
    )
    assert.equal(page.cursor, first.cursor)
    threads.push(...page.threads)
    notifications.push(...page.notifications)
  }
  assert.deepEqual(threads, expected.threads)
  assert.deepEqual(notifications, expected.notifications)
  await json(
    '/v1/organizations',
    protocol.organizationResult,
    'POST',
    op({ name: 'Later organization' }),
  )
  const stale = await request(
    `/v1/app/snapshot?${query({ at: first.cursor, limit: 2, ...first.next })}`,
  )
  assert.equal(stale.status, 409)
  assert.equal(
    protocol.stableError.parse(await stale.json()).code,
    'resync-required',
  )
  const threadId =
    expected.threads.find((item) => item.state === 'completed')?.threadId ??
    expected.threads[0].threadId
  const full = await json(
    `/v1/threads/${threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  let part = await json(
    `/v1/threads/${threadId}/snapshot?limit=1`,
    protocol.threadSnapshot,
  )
  const messages = [...part.messages]
  const work = [...part.work]
  while (part.next) {
    part = await json(
      `/v1/threads/${threadId}/snapshot?${query({ at: part.cursor, limit: 1, ...part.next })}`,
      protocol.threadSnapshot,
    )
    messages.push(...part.messages)
    work.push(...part.work)
  }
  assert.deepEqual(messages, full.messages)
  assert.deepEqual(work, full.work)
})

test('settings, effective inheritance, adapters, learning and identity files conform', async (t) => {
  const { json, request } = harness(t)
  const { bootstrap, agentId } = await target(json)
  const organizationId = bootstrap.organizationId
  await json('/v1/settings', protocol.settingsSnapshot)
  const adapters = await json(
    '/v1/execution-adapters',
    protocol.executionAdapters,
  )
  await json(
    '/v1/execution-adapters/refresh',
    protocol.executionAdapters,
    'POST',
    { version: 1 },
  )
  const adapter = adapters.adapters.find((item) => item.available)
  const settings = {
    adapterId: { set: adapter.id },
    modelId: { set: adapter.models[0].id },
  }
  const write = op({ settings })
  await json(
    `/v1/organizations/${organizationId}/settings`,
    protocol.settingsResult,
    'PUT',
    write,
  )
  assert.equal(
    (
      await json(
        `/v1/organizations/${organizationId}/settings`,
        protocol.settingsResult,
        'PUT',
        write,
      )
    ).alreadyApplied,
    true,
  )
  await json(
    `/v1/agents/${agentId}/settings`,
    protocol.settingsResult,
    'PUT',
    op({ settings: { adapterId: { clear: true }, modelId: { clear: true } } }),
  )
  const effective = await json(
    `/v1/agents/${agentId}/effective-settings?organizationId=${organizationId}`,
    protocol.effectiveSettings,
  )
  assert.equal(effective.settings.modelId, adapter.models[0].id)
  assert.equal(effective.sources.modelId, 'organization')
  await json(
    `/v1/agents/${bootstrap.rootAgentId}/effective-settings`,
    protocol.effectiveSettings,
  )
  await json(
    `/v1/organizations/${organizationId}/instructions`,
    protocol.organizationInstructions,
  )
  const instructions = await json(
    `/v1/organizations/${organizationId}/instructions`,
    protocol.organizationInstructions,
    'PUT',
    { version: 1, content: 'Preserve the shared context.' },
  )
  assert.equal(instructions.content, 'Preserve the shared context.')
  await json('/v1/settings/learning', protocol.learningSettings)
  await json('/v1/settings/learning', protocol.learningSettings, 'PUT', {
    version: 1,
    enabled: false,
    sleepTime: '02:30',
  })
  await json(
    `/v1/agents/${agentId}/learning`,
    protocol.agentLearningResult,
    'PUT',
    { version: 1, enabled: true, sleepTime: null },
  )
  for (const file of ['AGENTS.md', 'soul.md', 'identity.md']) {
    const path = `/v1/agents/${agentId}/identity/${file}`
    const current = await json(path, protocol.identityFile)
    const changed = await json(path, protocol.identityFile, 'PUT', {
      version: 1,
      content: 'A considered edit',
      expectedSha256: current.sha256,
    })
    assert.notEqual(changed.sha256, current.sha256)
    assert.equal(
      (
        await request(path, 'PUT', {
          version: 1,
          content: 'Stale edit',
          expectedSha256: current.sha256,
        })
      ).status,
      409,
    )
    const backups = await json(`${path}/backups`, protocol.identityBackups)
    assert.ok(backups.backups.length)
    const backup = await json(
      `${path}/backups/${backups.backups[0].id}`,
      protocol.identityFile,
    )
    const restored = await json(
      `${path}/backups/${backups.backups[0].id}/restore`,
      protocol.identityFile,
      'POST',
      { version: 1, expectedSha256: changed.sha256 },
    )
    assert.equal(restored.content, backup.content)
  }
})

test('administration, grouping and lifecycle return public results and stable operations', async (t) => {
  const { json, request } = harness(t)
  const organizationRequest = op({
    name: 'Protocol laboratory',
    description: 'A test organization',
  })
  const { organization } = await json(
    '/v1/organizations',
    protocol.organizationResult,
    'POST',
    organizationRequest,
  )
  assert.equal(
    (
      await json(
        '/v1/organizations',
        protocol.organizationResult,
        'POST',
        organizationRequest,
      )
    ).alreadyApplied,
    true,
  )
  await json(
    `/v1/organizations/${organization.id}`,
    protocol.organizationResult,
    'PUT',
    op({ name: 'Laboratory' }),
  )
  const created = await json(
    '/v1/agents',
    protocol.agentCreateResult,
    'POST',
    op({ name: 'Researcher' }),
  )
  const agentId = created.agent.id
  await json(
    `/v1/agents/${agentId}`,
    protocol.agentResult,
    'PUT',
    op({ description: 'Studies protocol behavior' }),
  )
  const { membership } = await json(
    `/v1/organizations/${organization.id}/memberships`,
    protocol.membershipResult,
    'POST',
    op({ agentId }),
  )
  const { group } = await json(
    `/v1/organizations/${organization.id}/groups`,
    protocol.groupResult,
    'POST',
    op({ name: 'Research' }),
  )
  await json(
    `/v1/groups/${group.id}`,
    protocol.groupResult,
    'PUT',
    op({ name: 'Discovery' }),
  )
  await json(
    `/v1/organizations/${organization.id}/groups/order`,
    protocol.groupOrderResult,
    'PUT',
    op({ groupIds: [group.id] }),
  )
  await json(
    `/v1/groups/${group.id}/appearances`,
    protocol.groupResult,
    'POST',
    op({ membershipId: membership.id }),
  )
  await json(
    `/v1/groups/${group.id}/appearances/order`,
    protocol.groupResult,
    'PUT',
    op({ membershipIds: [membership.id] }),
  )
  await json(
    `/v1/groups/${group.id}/appearances/${membership.id}`,
    protocol.groupResult,
    'DELETE',
    op(),
  )
  await json(
    `/v1/groups/${group.id}`,
    protocol.groupRemovalResult,
    'DELETE',
    op(),
  )
  await json(
    `/v1/memberships/${membership.id}`,
    protocol.membershipRemovalResult,
    'DELETE',
    op(),
  )
  const archive = op()
  const archived = await json(
    `/v1/agents/${agentId}/archive`,
    protocol.agentResult,
    'POST',
    archive,
  )
  assert.equal(archived.agent.lifecycle, 'archived')
  await json(`/v1/operations/${archive.operationId}`, protocol.operationStatus)
  assert.equal(
    (
      await json(
        `/v1/agents/${agentId}/restore`,
        protocol.agentResult,
        'POST',
        op(),
      )
    ).agent.lifecycle,
    'active',
  )
  await json(
    `/v1/agents/${agentId}/archive`,
    protocol.agentResult,
    'POST',
    op(),
  )
  const deletion = op({ copyFilesToOrganizations: true })
  await json(`/v1/agents/${agentId}`, protocol.agentResult, 'DELETE', deletion)
  let status
  for (let i = 0; i < 5; i++)
    status = await json(
      `/v1/operations/${deletion.operationId}`,
      protocol.operationStatus,
    )
  assert.equal(status.state, 'succeeded')
  const removal = op()
  await json(
    `/v1/organizations/${organization.id}`,
    protocol.organizationResult,
    'DELETE',
    removal,
  )
  for (let i = 0; i < 5; i++)
    status = await json(
      `/v1/operations/${removal.operationId}`,
      protocol.operationStatus,
    )
  assert.equal(status.state, 'succeeded')
  const bootstrap = await json('/v1/bootstrap')
  const protectedAgent = await request(
    `/v1/agents/${bootstrap.rootAgentId}/archive`,
    'POST',
    op(),
  )
  assert.ok(!protectedAgent.ok)
  protocol.stableError.parse(await protectedAgent.json())
})

test('media preserves bytes, receipts, metadata and target binding', async (t) => {
  const { core, json, request } = harness(t)
  const { bootstrap, context, chatId } = await target(json)
  const capabilities = await json('/conversations/media/capabilities')
  assert.equal(capabilities.maxUploadBytes, 25 * 1024 * 1024)
  const bytes = new TextEncoder().encode('A small original file.\n')
  const mediaTarget = {
    installationId: bootstrap.installationId,
    callerId: bootstrap.callerId,
    context,
    chatId,
  }
  const intent = {
    uploadId: randomUUID(),
    target: mediaTarget,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    purpose: 'attachment',
  }
  const upload = () =>
    core.handle(
      new Request(
        `${origin}/conversations/media/uploads/${intent.uploadId}?intent=${encodeURIComponent(JSON.stringify(intent))}`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
          },
          body: bytes,
        },
      ),
    )
  const response = await upload()
  assert.equal(response.status, 200)
  const accepted = await response.json()
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(accepted.intent, intent)
  const artifact = accepted.artifact
  for (const field of ['id', 'name', 'mimeType', 'sha256'])
    assert.equal(typeof artifact[field], 'string')
  assert.equal(artifact.size, bytes.length)
  assert.equal(artifact.availability, 'registered')
  assert.equal(typeof artifact.revision, 'number')
  assert.deepEqual(artifact.ownership, {
    kind: 'organization',
    id: bootstrap.organizationId,
  })
  assert.deepEqual(artifact.provenance, {
    kind: 'upload',
    authorId: bootstrap.callerId,
  })
  assert.equal((await (await upload()).json()).artifact.id, artifact.id)
  const suffix = `?target=${encodeURIComponent(JSON.stringify(mediaTarget))}`
  const receipt = await json(
    `/conversations/media/uploads/${intent.uploadId}${suffix}`,
  )
  assert.deepEqual(receipt, accepted)
  const found = await json(
    `/conversations/media/artifacts/${artifact.id}${suffix}`,
  )
  assert.deepEqual(found, artifact)
  const content = await request(
    `/conversations/media/artifacts/${artifact.id}/content${suffix}`,
  )
  assert.equal(content.headers.get('content-type'), 'application/octet-stream')
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(content.headers.get('content-security-policy'), 'sandbox')
  assert.deepEqual(new Uint8Array(await content.arrayBuffer()), bytes)
  const wrong = `?target=${encodeURIComponent(JSON.stringify({ ...mediaTarget, callerId: randomUUID() }))}`
  assert.equal(
    (await request(`/conversations/media/artifacts/${artifact.id}${wrong}`))
      .status,
    403,
  )
})

test('interaction answers bind to exact attempts, persist receipts, and do not follow notification reads', async (t) => {
  const { json, request } = harness(t)
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  for (const kind of ['question', 'approval']) {
    let selected
    for (const thread of app.threads) {
      const snapshot = await json(
        `/v1/threads/${thread.threadId}/snapshot`,
        protocol.threadSnapshot,
      )
      const interaction = snapshot.interactions.find(
        (item) => item.kind === kind && item.state === 'pending',
      )
      if (interaction) {
        selected = { thread, interaction }
        break
      }
    }
    assert.ok(selected, kind)
    const { interaction, thread } = selected
    const notification = app.notifications.find(
      (item) => item.interactionId === interaction.id,
    )
    if (notification) {
      const read = await json(
        `/v1/notifications/${notification.id}/read`,
        undefined,
        'POST',
        { version: 1 },
      )
      assert.deepEqual(read, {
        version: 1,
        status: 'read',
        notificationId: notification.id,
      })
      const snapshot = await json(
        `/v1/threads/${thread.threadId}/snapshot`,
        protocol.threadSnapshot,
      )
      assert.equal(
        snapshot.interactions.find((item) => item.id === interaction.id).state,
        'pending',
      )
    }
    const answer = op({
      interactionId: interaction.id,
      threadId: thread.threadId,
      runId: interaction.runId,
      attemptId: interaction.attemptId,
      ...(interaction.proposalId ? { proposalId: interaction.proposalId } : {}),
      answer:
        kind === 'approval'
          ? { kind: 'approve' }
          : { kind: 'text', text: 'Use the first option.' },
    })
    const stale = await request('/v1/work/interactions/answer', 'POST', {
      ...answer,
      operationId: randomUUID(),
      attemptId: randomUUID(),
    })
    const staleBody = await stale.json()
    assert.ok(!stale.ok || staleBody.outcome === 'rejected')
    const accepted = await json(
      '/v1/work/interactions/answer',
      protocol.interactionResponseReceipt,
      'POST',
      answer,
    )
    assert.equal(accepted.outcome, 'accepted')
    assert.equal(accepted.interaction.state, 'settled')
    const receipt = await json(
      '/v1/work/interactions/receipt',
      protocol.interactionResponseReceipt,
      'POST',
      answer,
    )
    assert.deepEqual(receipt, accepted)
    const repeat = await json(
      '/v1/work/interactions/answer',
      protocol.interactionResponseReceipt,
      'POST',
      answer,
    )
    assert.deepEqual(repeat, accepted)
  }
})

test('queued work progresses through writing and a durable question, with valid SSE replay', async (t) => {
  const { json, request } = harness(t)
  const { bootstrap, context, chatId } = await target(json)
  const receipt = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    {
      version: 1,
      submissionId: randomUUID(),
      scope: {
        installationId: bootstrap.installationId,
        callerId: bootstrap.callerId,
      },
      target: { context, chatId },
      mode: 'root',
      parts: [{ kind: 'text', text: 'Create a thoughtful plan.' }],
    },
  )
  const path = `/v1/threads/${receipt.threadId}`
  const first = await json(`${path}/snapshot`, protocol.threadSnapshot)
  assert.equal(first.work[0].state, 'queued')
  await json('/__demo/advance', undefined, 'POST', {
    threadId: receipt.threadId,
    steps: 1,
  })
  assert.equal(
    (await json(`${path}/snapshot`, protocol.threadSnapshot)).work[0].state,
    'running',
  )
  await json('/__demo/advance', undefined, 'POST', {
    threadId: receipt.threadId,
    steps: 1,
  })
  const writing = await json(`${path}/snapshot`, protocol.threadSnapshot)
  assert.ok(writing.messages.some((item) => !item.final))
  await json('/__demo/advance', undefined, 'POST', {
    threadId: receipt.threadId,
    steps: 1,
  })
  const waiting = await json(`${path}/snapshot`, protocol.threadSnapshot)
  assert.equal(waiting.work[0].state, 'waiting')
  assert.ok(waiting.interactions.some((item) => item.state === 'pending'))
  const stream = await request(
    `${path}/events?after=${encodeURIComponent(first.cursor)}`,
  )
  const events = await replay(stream, waiting.cursor)
  assert.ok(events.every((event) => event.scope.threadId === receipt.threadId))
  assert.ok(
    events.some((event) => event.type === 'message-draft' && !event.data.final),
  )
  assert.ok(
    events.some((event) => event.type === 'message-final' && event.data.final),
  )
  assert.ok(
    events.some(
      (event) =>
        event.type === 'work-changed' && event.data.state === 'running',
    ),
  )
  assert.ok(
    events.some(
      (event) =>
        event.type === 'work-changed' && event.data.state === 'waiting',
    ),
  )
  assert.ok(
    events.some(
      (event) =>
        event.type === 'interaction-changed' && event.data.state === 'pending',
    ),
  )
  const interaction = waiting.interactions[0]
  await json(
    '/v1/work/interactions/answer',
    protocol.interactionResponseReceipt,
    'POST',
    op({
      interactionId: interaction.id,
      runId: interaction.runId,
      attemptId: interaction.attemptId,
      threadId: receipt.threadId,
      answer: { kind: 'choice', optionId: interaction.options[0].id },
    }),
  )
  await json('/__demo/advance', undefined, 'POST', {
    threadId: receipt.threadId,
  })
  const done = await json(`${path}/snapshot`, protocol.threadSnapshot)
  assert.equal(done.work[0].state, 'completed')
  const continuation = await replay(
    await request(`${path}/events?after=${encodeURIComponent(waiting.cursor)}`),
    done.cursor,
  )
  assert.ok(
    continuation.some(
      (event) =>
        event.type === 'interaction-changed' && event.data.state === 'settled',
    ),
  )
  assert.ok(
    continuation.some(
      (event) =>
        event.type === 'work-changed' && event.data.state === 'completed',
    ),
  )
  const invalid = await request(`${path}/events?after=not-a-cursor`)
  assert.equal(invalid.status, 400)
  assert.equal(protocol.stableError.parse(await invalid.json()).code, 'invalid')
})

test('controls retain idempotent receipts and held follow-ups', async (t) => {
  const { json } = harness(t)
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  const summary = app.threads.find((item) => item.state === 'failed')
  assert.ok(summary)
  const path = `/v1/threads/${summary.threadId}/snapshot`
  const thread = await json(path, protocol.threadSnapshot)
  assert.ok(thread.work.some((work) => work.queueHold))
  const run = thread.work.find((work) => work.state === 'failed')
  const command = op({
    context: { kind: summary.contextKind, organizationId: summary.contextId },
    chatId: summary.chatId,
    threadId: summary.threadId,
    runId: run.runId,
    attemptId: run.attemptId,
    action: 'retry',
  })
  const accepted = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    command,
  )
  assert.equal(accepted.outcome, 'accepted')
  assert.deepEqual(
    await json(
      '/v1/work/controls/receipt',
      protocol.controlReceipt,
      'POST',
      command,
    ),
    accepted,
  )
  assert.deepEqual(
    await json('/v1/work/controls', protocol.controlReceipt, 'POST', command),
    accepted,
  )
})

test('test controls are opt-in and protocol errors use the public envelope', async (t) => {
  const core = createFakeCore({ autoAdvance: false })
  t.after(() => core.dispose())
  const denied = await core.handle(new Request(`${origin}/__demo/inspect`))
  assert.equal(denied.status, 404)
  protocol.stableError.parse(await denied.json())
  const { request } = harness(t)
  for (const path of [
    '/missing',
    '/v1/app/snapshot?limit=-1',
    '/v1/app/snapshot?afterThreadId=invalid',
  ]) {
    const response = await request(path)
    assert.ok(!response.ok)
    protocol.stableError.parse(await response.json())
  }
})

test('application events replay directory mutations and reject thread cursors', async (t) => {
  const { json, request } = harness(t)
  const before = await json('/v1/app/snapshot', protocol.appSnapshot)
  const created = await json(
    '/v1/organizations',
    protocol.organizationResult,
    'POST',
    op({ name: 'Replay organization' }),
  )
  const response = await request(
    `/v1/app/events?after=${encodeURIComponent(before.cursor)}`,
  )
  const after = await json('/v1/app/snapshot', protocol.appSnapshot)
  const events = await replay(response, after.cursor)
  assert.ok(
    events.some(
      (event) =>
        event.type === 'organization-changed' &&
        event.data.id === created.organization.id,
    ),
  )
  assert.ok(events.every((event) => event.scope.kind === 'application'))
  const thread = await json(
    `/v1/threads/${before.threads[0].threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  const wrongScope = await request(
    `/v1/app/events?after=${encodeURIComponent(thread.cursor)}`,
  )
  assert.equal(wrongScope.status, 400)
  protocol.stableError.parse(await wrongScope.json())
})

test('Stop holds ordinary follow-ups, Resume releases them and queued cancellation keeps history', async (t) => {
  const { json } = harness(t)
  const { bootstrap, context, chatId } = await target(json)
  const base = {
    version: 1,
    scope: {
      installationId: bootstrap.installationId,
      callerId: bootstrap.callerId,
    },
    target: { context, chatId },
    parts: [{ kind: 'text', text: 'Work item' }],
  }
  const first = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    { ...base, submissionId: randomUUID(), mode: 'root' },
  )
  const followup = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    {
      ...base,
      submissionId: randomUUID(),
      mode: 'reply',
      threadId: first.threadId,
    },
  )
  const command = (runId, action) =>
    op({ context, chatId, threadId: first.threadId, runId, action })
  const unknown = await json(
    '/v1/work/controls/receipt',
    protocol.controlReceipt,
    'POST',
    command(first.runId, 'stop'),
  )
  assert.equal(unknown.status, 'unknown')
  const steer = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    command(first.runId, 'steer'),
  )
  assert.equal(steer.outcome, 'unsupported')
  const stopped = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    command(first.runId, 'stop'),
  )
  assert.equal(stopped.outcome, 'accepted')
  const path = `/v1/threads/${first.threadId}/snapshot`
  const held = await json(path, protocol.threadSnapshot)
  assert.equal(
    held.work.find((work) => work.runId === first.runId).queueHold,
    true,
  )
  assert.equal(
    held.work.find((work) => work.runId === followup.runId).state,
    'queued',
  )
  const resumed = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    command(first.runId, 'resume'),
  )
  assert.equal(resumed.outcome, 'accepted')
  assert.equal(
    (await json(path, protocol.threadSnapshot)).work.find(
      (work) => work.runId === first.runId,
    ).queueHold,
    false,
  )
  const cancelled = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    command(followup.runId, 'cancel-queued'),
  )
  assert.equal(cancelled.outcome, 'accepted')
  const snapshot = await json(path, protocol.threadSnapshot)
  assert.equal(
    snapshot.work.find((work) => work.runId === followup.runId).state,
    'cancelled',
  )
  assert.ok(
    snapshot.messages.some((message) => message.id === followup.messageId),
  )
})

test('all seed event families validate and expired cursors explicitly resynchronize', async (t) => {
  const { json, request } = harness(t)
  const bootstrap = await json('/v1/bootstrap')
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  const kinds = new Set()
  const application = await replay(
    await request(`/v1/app/events?after=a:${bootstrap.installationId}:0`),
    app.cursor,
  )
  for (const event of application) kinds.add(event.type)
  for (const summary of app.threads) {
    const path = `/v1/threads/${summary.threadId}`
    const snapshot = await json(`${path}/snapshot`, protocol.threadSnapshot)
    const events = await replay(
      await request(`${path}/events?after=t:${summary.threadId}:0`),
      snapshot.cursor,
    )
    for (const event of events) kinds.add(event.type)
  }
  for (const type of [
    'thread-summary',
    'notification',
    'message-draft',
    'message-final',
    'work-changed',
    'interaction-changed',
    'delegation-changed',
  ])
    assert.ok(kinds.has(type), type)
  await json(
    '/v1/organizations',
    protocol.organizationResult,
    'POST',
    op({ name: 'Retention trigger' }),
  )
  await json('/__demo/retention', undefined, 'POST', {})
  const expired = await request(
    `/v1/app/events?after=${encodeURIComponent(app.cursor)}`,
  )
  assert.equal(expired.status, 409)
  assert.equal(
    protocol.stableError.parse(await expired.json()).code,
    'resync-required',
  )
  await json('/v1/app/snapshot', protocol.appSnapshot)
  await json('/__demo/connection', undefined, 'POST', { offline: true })
  const offline = await request('/v1/bootstrap')
  assert.equal(offline.status, 503)
  assert.equal(
    protocol.stableError.parse(await offline.json()).code,
    'unavailable',
  )
  await json('/__demo/connection', undefined, 'POST', { offline: false })
  await json('/v1/app/snapshot', protocol.appSnapshot)
})

test('media targets bind a thread to its chat', async (t) => {
  const { json, request } = harness(t)
  const { bootstrap, context, chatId } = await target(json)
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  const other = app.threads.find((thread) => thread.chatId !== chatId)
  assert.ok(other)
  const mediaTarget = {
    installationId: bootstrap.installationId,
    callerId: bootstrap.callerId,
    context,
    chatId,
    threadId: other.threadId,
  }
  const response = await request(
    `/conversations/media/uploads/${randomUUID()}?target=${encodeURIComponent(JSON.stringify(mediaTarget))}`,
  )
  assert.equal(response.status, 403)
  assert.equal(
    protocol.stableError.parse(await response.json()).code,
    'forbidden',
  )
})

test('membership removal preserves accepted work and receipts while refusing new work', async (t) => {
  const { json, request } = harness(t)
  const bootstrap = await json('/v1/bootstrap')
  const { organization } = await json(
    '/v1/organizations',
    protocol.organizationResult,
    'POST',
    op({ name: 'Membership laboratory' }),
  )
  const { agent, membership } = await json(
    '/v1/agents',
    protocol.agentCreateResult,
    'POST',
    op({ name: 'Member', organizationId: organization.id }),
  )
  const context = { kind: 'organization', organizationId: organization.id }
  const direct = { version: 1, context, agentId: agent.id }
  const { chatId } = await json(
    '/v1/direct-chats',
    protocol.directChatResult,
    'POST',
    direct,
  )
  const submission = {
    version: 1,
    submissionId: randomUUID(),
    scope: {
      installationId: bootstrap.installationId,
      callerId: bootstrap.callerId,
    },
    target: { context, chatId },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Keep accepted work available' }],
  }
  const accepted = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    submission,
  )
  await json('/__demo/scenario', undefined, 'POST', {
    threadId: accepted.threadId,
    scenario: 'failure',
  })
  await json('/__demo/advance', undefined, 'POST', {
    threadId: accepted.threadId,
    steps: 3,
  })
  await json(
    `/v1/memberships/${membership.id}`,
    protocol.membershipRemovalResult,
    'DELETE',
    op(),
  )
  const path = `/v1/threads/${accepted.threadId}/snapshot`
  const snapshot = await json(path, protocol.threadSnapshot)
  assert.equal(snapshot.work[0].state, 'failed')
  const repeat = await json(
    '/v1/text/submissions',
    protocol.acceptedReceipt,
    'POST',
    submission,
  )
  assert.equal(repeat.alreadyAccepted, true)
  assert.equal(repeat.messageId, accepted.messageId)
  for (const [path, body] of [
    ['/v1/direct-chats', direct],
    ['/v1/text/submissions', { ...submission, submissionId: randomUUID() }],
  ]) {
    const response = await request(path, 'POST', body)
    assert.equal(response.status, 403)
    assert.equal(
      protocol.stableError.parse(await response.json()).code,
      'membership-removed',
    )
  }
  const retry = await json(
    '/v1/work/controls',
    protocol.controlReceipt,
    'POST',
    op({
      context,
      chatId,
      threadId: accepted.threadId,
      runId: accepted.runId,
      attemptId: snapshot.work[0].attemptId,
      action: 'retry',
    }),
  )
  assert.equal(retry.outcome, 'accepted')
  await json('/__demo/advance', undefined, 'POST', {
    threadId: accepted.threadId,
    steps: 4,
  })
  assert.equal(
    (await json(path, protocol.threadSnapshot)).work[0].state,
    'completed',
  )
})

test('lifecycle operations expose waiting and completion through polling', async (t) => {
  const { json } = harness(t)
  const { agent } = await json(
    '/v1/agents',
    protocol.agentCreateResult,
    'POST',
    op({ name: 'Cleanup demonstration' }),
  )
  await json(
    `/v1/agents/${agent.id}/archive`,
    protocol.agentResult,
    'POST',
    op(),
  )
  const deletion = op()
  await json(`/v1/agents/${agent.id}`, protocol.agentResult, 'DELETE', deletion)
  await json('/__demo/operation', undefined, 'POST', {
    operationId: deletion.operationId,
    waiting: true,
  })
  const waiting = await json(
    `/v1/operations/${deletion.operationId}`,
    protocol.operationStatus,
  )
  assert.equal(waiting.state, 'waiting')
  assert.ok(waiting.waitingFor)
  assert.equal(
    (
      await json(
        `/v1/operations/${deletion.operationId}`,
        protocol.operationStatus,
      )
    ).state,
    'waiting',
  )
  await json('/__demo/operation', undefined, 'POST', {
    operationId: deletion.operationId,
    waiting: false,
  })
  const states = []
  for (let index = 0; index < 5; index++)
    states.push(
      (
        await json(
          `/v1/operations/${deletion.operationId}`,
          protocol.operationStatus,
        )
      ).state,
    )
  assert.equal(states.at(-1), 'succeeded')
  assert.ok(
    states.every((state) =>
      ['pending', 'running', 'waiting', 'succeeded'].includes(state),
    ),
  )
})

test('the fake handler serves only its exact demo origin', async (t) => {
  const { core } = harness(t)
  for (const origin of [
    'https://example.com',
    'http://demo.kipster.invalid',
    'https://demo.kipster.invalid.example.com',
    'https://demo.kipster.invalid:444',
  ]) {
    const response = await core.handle(new Request(`${origin}/v1/bootstrap`))
    assert.equal(response.status, 404)
    assert.equal(
      protocol.stableError.parse(await response.json()).code,
      'not-found',
    )
  }
})

test('agent deletion preserves or removes shared file references and never revives cancelled delegation', async (t) => {
  for (const copyFilesToOrganizations of [true, false]) {
    await t.test(`copy files: ${copyFilesToOrganizations}`, async (t) => {
      const { json, request } = harness(t)
      const bootstrap = await json('/v1/bootstrap')
      const inspect = await json('/__demo/inspect')
      const agentId = inspect.ids.engineer
      const app = await json('/v1/app/snapshot', protocol.appSnapshot)
      let selected
      let delegated
      for (const summary of app.threads.filter(
        (summary) => summary.agentId !== agentId,
      )) {
        const snapshot = await json(
          `/v1/threads/${summary.threadId}/snapshot`,
          protocol.threadSnapshot,
        )
        if (
          snapshot.delegations.some(
            (delegation) =>
              delegation.recipientAgentId === agentId &&
              delegation.state === 'running',
          )
        )
          delegated = summary
        const target = {
          installationId: bootstrap.installationId,
          callerId: bootstrap.callerId,
          context:
            summary.contextKind === 'organization'
              ? { kind: 'organization', organizationId: summary.contextId }
              : { kind: 'installation', installationId: summary.contextId },
          chatId: summary.chatId,
          threadId: summary.threadId,
        }
        const suffix = `?target=${encodeURIComponent(JSON.stringify(target))}`
        for (const message of snapshot.messages)
          for (const part of message.parts.filter(
            (part) => part.kind === 'file',
          )) {
            const artifact = await json(
              `/conversations/media/artifacts/${part.artifactId}${suffix}`,
            )
            if (
              artifact.ownership.kind === 'agent' &&
              artifact.ownership.id === agentId
            )
              selected = { summary, message, part, artifact, suffix }
          }
      }
      assert.ok(
        selected,
        'a generated personal file is shared in a surviving thread',
      )
      assert.ok(delegated, 'the agent has an active delegated child')
      const original = await request(
        `/conversations/media/artifacts/${selected.artifact.id}/content${selected.suffix}`,
      )
      const bytes = new Uint8Array(await original.arrayBuffer())
      await json(
        `/v1/agents/${agentId}/archive`,
        protocol.agentResult,
        'POST',
        op(),
      )
      const delegatedSnapshot = await json(
        `/v1/threads/${delegated.threadId}/snapshot`,
        protocol.threadSnapshot,
      )
      assert.ok(
        delegatedSnapshot.delegations
          .filter((item) => item.recipientAgentId === agentId)
          .every((item) => item.state === 'cancelled'),
      )
      const deletion = op({ copyFilesToOrganizations })
      await json(
        `/v1/agents/${agentId}`,
        protocol.agentResult,
        'DELETE',
        deletion,
      )
      let status
      for (let index = 0; index < 5; index++)
        status = await json(
          `/v1/operations/${deletion.operationId}`,
          protocol.operationStatus,
        )
      assert.equal(status.state, 'succeeded')
      const retained = await json(
        `/v1/threads/${selected.summary.threadId}/snapshot`,
        protocol.threadSnapshot,
      )
      const message = retained.messages.find(
        (message) => message.id === selected.message.id,
      )
      assert.ok(message)
      if (copyFilesToOrganizations) {
        const replacement = message.parts.find((part) => part.kind === 'file')
        assert.ok(replacement)
        assert.notEqual(replacement.artifactId, selected.artifact.id)
        const metadata = await json(
          `/conversations/media/artifacts/${replacement.artifactId}${selected.suffix}`,
        )
        assert.deepEqual(metadata.ownership, {
          kind: 'organization',
          id: selected.summary.contextId,
        })
        assert.equal(metadata.sourceId, selected.artifact.id)
        const download = await request(
          `/conversations/media/artifacts/${replacement.artifactId}/content${selected.suffix}`,
        )
        assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes)
      } else {
        assert.ok(
          message.parts.some(
            (part) =>
              part.kind === 'removed' &&
              part.artifactId === selected.artifact.id,
          ),
        )
      }
      const missing = await request(
        `/conversations/media/artifacts/${selected.artifact.id}${selected.suffix}`,
      )
      assert.equal(missing.status, 404)
      protocol.stableError.parse(await missing.json())
      await json('/__demo/advance', undefined, 'POST', {
        threadId: delegated.threadId,
        steps: 5,
      })
      const after = await json(
        `/v1/threads/${delegated.threadId}/snapshot`,
        protocol.threadSnapshot,
      )
      assert.ok(
        after.delegations
          .filter((item) => item.recipientAgentId === agentId)
          .every((item) => item.state === 'cancelled'),
      )
    })
  }
})

test('test notification replay uses valid protocol records without regressing canonical reads', async (t) => {
  const { json, request } = harness(t)
  const before = await json('/v1/app/snapshot', protocol.appSnapshot)
  const initial = await json('/__demo/inspect')
  const notice = initial.notifications[0]
  await json('/__demo/notification', undefined, 'POST', {
    notification: notice,
  })
  await json(`/v1/notifications/${notice.id}/read`, undefined, 'POST', {
    version: 1,
  })
  await json('/__demo/notification', undefined, 'POST', {
    notification: notice,
  })
  const snapshot = await json('/v1/app/snapshot', protocol.appSnapshot)
  assert.equal(
    snapshot.notifications.filter((n) => n.id === notice.id).length,
    1,
  )
  assert.equal(
    snapshot.notifications.find((n) => n.id === notice.id).read,
    true,
  )
  await replay(
    await request(`/v1/app/events?after=${encodeURIComponent(before.cursor)}`),
    snapshot.cursor,
  )
})
