import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import * as protocol from '@kipster/core/protocol'
import { createFakeCore } from '../src/fake-core/index.ts'

const origin = 'https://demo.kipster.invalid'
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
  return { request, json }
}
/** Application events after `cursor`, until one matches `done`. */
async function eventsUntil(request, cursor, done) {
  const response = await request(
    `/v1/app/events?after=${encodeURIComponent(cursor)}`,
  )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let pending = ''
  try {
    while (!events.some(done)) {
      const { value, done: ended } = await reader.read()
      assert.equal(ended, false)
      pending += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const line = pending
          .slice(0, boundary)
          .split('\n')
          .find((l) => l.startsWith('data: '))
        pending = pending.slice(boundary + 2)
        if (line)
          events.push(protocol.textEvent.parse(JSON.parse(line.slice(6))))
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}
async function seeded(t) {
  const h = harness(t)
  const { documents } = await h.json('/v1/documents', protocol.documentList)
  assert.equal(documents.length, 1)
  const id = documents[0].id
  const path = `/v1/documents/${id}`
  const detail = () => h.json(path, protocol.documentDetail)
  return { ...h, id, path, detail, summary: documents[0] }
}
const write = (detail, change = {}) => ({
  version: 1,
  baseRevision: detail.current.number,
  expectedDraftVersion: detail.draft?.draftVersion ?? 0,
  title: detail.current.title,
  blocks: detail.current.blocks,
  comments: [],
  note: '',
  ...change,
})
const answer = (blocks) =>
  blocks.map((b) =>
    b.id === 'open-in'
      ? { ...b, answer: { optionIds: ['full'], other: '' } }
      : b,
  )

test('bootstrap advertises docs and the seeded doc reads as the contract', async (t) => {
  const { json, detail, summary, path } = await seeded(t)
  const bootstrap = await json('/v1/bootstrap')
  assert.equal(bootstrap.capabilities.documents, true)
  assert.equal(summary.turn, 'user')
  assert.equal(summary.currentRevision, 3)
  assert.equal(summary.pendingQuestions, 3)
  const doc = await detail()
  assert.deepEqual(
    doc.revisions.map((r) => [r.number, r.authorKind]),
    [
      [1, 'agent'],
      [2, 'user'],
      [3, 'agent'],
    ],
  )
  assert.deepEqual(doc.current.changes.added, ['blocks-table', 'why-turns'])
  assert.equal(doc.comments[0].state, 'resolved')
  const first = await json(
    `${path}/revisions/1`,
    protocol.documentRevisionResult,
  )
  assert.equal(
    first.revision.blocks.some((b) => b.id === 'blocks-table'),
    false,
  )
})

test('draft saves are version-checked and validated', async (t) => {
  const { request, json, detail, path } = await seeded(t)
  const doc = await detail()
  const saved = await json(
    `${path}/draft`,
    protocol.documentDraftResult,
    'PUT',
    write(doc, { blocks: answer(doc.current.blocks), note: 'Hi' }),
  )
  assert.equal(saved.draftVersion, 1)
  const stale = await request(`${path}/draft`, 'PUT', write(doc))
  assert.equal(stale.status, 409)
  assert.equal((await stale.json()).code, 'conflict')
  const oldBase = await request(
    `${path}/draft`,
    'PUT',
    write(doc, { baseRevision: 2, expectedDraftVersion: 1 }),
  )
  assert.equal(oldBase.status, 409)
  const twice = doc.current.blocks[0]
  const duplicate = await request(
    `${path}/draft`,
    'PUT',
    write(doc, { expectedDraftVersion: 1, blocks: [twice, twice] }),
  )
  assert.equal(duplicate.status, 400)
  const unknownBlock = { id: 'later', type: 'embed', url: 'https://x.test' }
  const kept = await json(
    `${path}/draft`,
    protocol.documentDraftResult,
    'PUT',
    write(doc, {
      expectedDraftVersion: 1,
      blocks: [...doc.current.blocks, unknownBlock],
    }),
  )
  assert.equal(kept.draftVersion, 2)
  // Unknown block types round-trip with all their fields.
  const after = await json(path)
  assert.deepEqual(after.draft.blocks.at(-1), unknownBlock)
  assert.equal(after.document.hasDraft, true)
  await json(`${path}/draft`, null, 'DELETE')
  assert.equal((await detail()).draft, null)
})

test('submit posts to the thread, locks the doc and the kip publishes a revision', async (t) => {
  const { request, json, detail, path, id } = await seeded(t)
  const doc = await detail()
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  const draft = await json(
    `${path}/draft`,
    protocol.documentDraftResult,
    'PUT',
    write(doc, {
      blocks: answer(doc.current.blocks),
      note: 'Mostly layout.',
      comments: [
        {
          id: 'c1',
          blockId: 'flow-title',
          field: 'text',
          quote: 'How a doc moves',
          start: 0,
          end: 15,
          body: 'Shorter?',
        },
      ],
    }),
  )
  const submit = {
    version: 1,
    operationId: randomUUID(),
    draftVersion: draft.draftVersion,
  }
  const result = await json(
    `${path}/submit`,
    protocol.documentSubmitResult,
    'POST',
    submit,
  )
  assert.equal(result.document.turn, 'agent')
  assert.deepEqual(
    await json(`${path}/submit`, null, 'POST', submit),
    JSON.parse(JSON.stringify(result)),
  )
  const locked = await detail()
  assert.equal(locked.current.number, 4)
  assert.equal(locked.current.authorKind, 'user')
  assert.deepEqual(
    locked.comments.map((c) => [c.number, c.state, c.submittedInRevision]),
    [
      [1, 'resolved', 2],
      [2, 'open', 4],
    ],
  )
  assert.equal(
    (await request(`${path}/draft`, 'PUT', write(locked))).status,
    409,
  )
  const threadId = locked.document.threadId
  const thread = await json(
    `/v1/threads/${threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  const posted = thread.messages.find((m) => m.id === result.messageId)
  assert.deepEqual(posted.parts, [
    { kind: 'text', text: 'Mostly layout.' },
    { kind: 'document', documentId: id, revision: 4 },
  ])
  assert.equal(thread.work.at(-1).runId, result.runId)

  await json('/__demo/advance', null, 'POST', { threadId, steps: 3 })
  const revised = await detail()
  assert.equal(revised.document.turn, 'user')
  assert.equal(revised.current.number, 5)
  assert.equal(revised.current.authorKind, 'agent')
  assert.ok(revised.current.changes.added.includes('decided-open-in'))
  assert.deepEqual(
    revised.comments.map((c) => [c.state, c.resolvedInRevision]),
    [
      ['resolved', 3],
      ['resolved', 5],
    ],
  )
  const after = await json(
    `/v1/threads/${threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  assert.deepEqual(after.messages.at(-1).parts.at(-1), {
    kind: 'document',
    documentId: id,
    revision: 5,
  })
  const events = await eventsUntil(
    request,
    app.cursor,
    (e) => e.type === 'document-changed' && e.data.currentRevision === 5,
  )
  assert.ok(
    events.some(
      (e) => e.type === 'document-changed' && e.data.turn === 'agent',
    ),
  )
})

test('take back stops the run and keeps later kip steps out', async (t) => {
  const { request, json, detail, path } = await seeded(t)
  const doc = await detail()
  const { draftVersion } = await json(
    `${path}/draft`,
    protocol.documentDraftResult,
    'PUT',
    write(doc),
  )
  const result = await json(
    `${path}/submit`,
    protocol.documentSubmitResult,
    'POST',
    {
      version: 1,
      operationId: randomUUID(),
      draftVersion,
    },
  )
  const threadId = result.document.threadId
  await json('/__demo/advance', null, 'POST', { threadId, steps: 2 })
  await json(`${path}/take-back`, null, 'POST', { version: 1 })
  assert.equal(
    (await request(`${path}/take-back`, 'POST', { version: 1 })).status,
    409,
  )
  await json('/__demo/advance', null, 'POST', { threadId, steps: 3 })
  const back = await detail()
  assert.equal(back.document.turn, 'user')
  assert.equal(back.current.number, 4)
  const thread = await json(
    `/v1/threads/${threadId}/snapshot`,
    protocol.threadSnapshot,
  )
  assert.equal(
    thread.work.find((w) => w.runId === result.runId).state,
    'cancelled',
  )
  assert.ok(thread.messages.every((m) => m.final))
})

test('doc artifacts are served only when the doc references them', async (t) => {
  const { request, json, detail, path } = await seeded(t)
  const doc = await detail()
  const image = doc.current.blocks.find((b) => b.type === 'image')
  const metadata = await json(`${path}/artifacts/${image.artifactId}`)
  assert.equal(metadata.mimeType, 'image/svg+xml')
  const content = await request(`${path}/artifacts/${image.artifactId}/content`)
  assert.equal(content.headers.get('content-type'), 'application/octet-stream')
  const bytes = new Uint8Array(await content.arrayBuffer())
  assert.equal(bytes.length, metadata.size)
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    metadata.sha256,
  )
  const inspect = await json('/__demo/inspect')
  const other = inspect.threads
    .flatMap((thread) => thread.messages)
    .flatMap((message) => message.parts)
    .find((part) => part.kind === 'file')
  assert.equal(
    (await request(`${path}/artifacts/${other.artifactId}`)).status,
    404,
  )
  const missing = await request(
    `${path}/draft`,
    'PUT',
    write(doc, {
      blocks: [
        { id: 'img', type: 'image', artifactId: randomUUID(), caption: '' },
      ],
    }),
  )
  assert.equal(missing.status, 400)
})

test('deleting a doc removes it and emits document-removed', async (t) => {
  const { request, json, path, id } = await seeded(t)
  const app = await json('/v1/app/snapshot', protocol.appSnapshot)
  await json(path, null, 'DELETE')
  assert.equal((await request(path)).status, 404)
  assert.deepEqual(
    (await json('/v1/documents', protocol.documentList)).documents,
    [],
  )
  const events = await eventsUntil(
    request,
    app.cursor,
    (e) => e.type === 'document-removed',
  )
  assert.deepEqual(events.at(-1).data, { id })
})
