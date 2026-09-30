import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeMedia } from '../src/fake-core/media.ts'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const target = {
  installationId: id(1),
  callerId: id(2),
  chatId: id(3),
  context: { kind: 'organization', organizationId: id(4) },
}
const origin = 'https://demo.kipster.invalid/conversations/media'
const media = () =>
  createFakeMedia({
    installationId: target.installationId,
    callerId: target.callerId,
  })
const sha = async (bytes) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')

test('media upload checks integrity, replays receipts, retains scope and serves safe full downloads', async () => {
  const service = media(),
    bytes = new TextEncoder().encode('hello world')
  const intent = {
    uploadId: id(5),
    target,
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: bytes.length,
    sha256: await sha(bytes),
    purpose: 'attachment',
  }
  const put = (i) =>
    new Request(
      `${origin}/uploads/${i.uploadId}?intent=${encodeURIComponent(JSON.stringify(i))}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
        body: bytes,
      },
    )
  const accepted = await (await service.handle(put(intent))).json()
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(accepted.intent, intent)
  assert.deepEqual(await (await service.handle(put(intent))).json(), accepted)
  await assert.rejects(
    service.handle(put({ ...intent, name: 'different.txt' })),
    /Upload intent conflict/,
  )
  const q = new URLSearchParams({ target: JSON.stringify(target) })
  assert.deepEqual(
    await (
      await service.handle(new Request(`${origin}/uploads/${id(5)}?${q}`))
    ).json(),
    accepted,
  )
  assert.deepEqual(
    await (
      await service.handle(new Request(`${origin}/uploads/${id(6)}?${q}`))
    ).json(),
    { status: 'unknown', uploadId: id(6) },
  )
  const response = await service.handle(
    new Request(`${origin}/artifacts/${accepted.artifact.id}/content?${q}`, {
      headers: { range: 'bytes=0-2' },
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-security-policy'), 'sandbox')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(await response.text(), 'hello world')
  service.validateParts(target, [
    { kind: 'file', artifactId: accepted.artifact.id },
  ])
  assert.throws(
    () =>
      service.validateParts(
        { ...target, context: { kind: 'organization', organizationId: id(8) } },
        [{ kind: 'file', artifactId: accepted.artifact.id }],
      ),
    /access denied/,
  )
  await assert.rejects(
    service.handle(put({ ...intent, uploadId: id(9), sha256: '0'.repeat(64) })),
    /integrity/,
  )
  assert.deepEqual(
    await (
      await service.handle(new Request(`${origin}/uploads/${id(9)}?${q}`))
    ).json(),
    { status: 'unknown', uploadId: id(9) },
  )
})

test('generated files stay associated with their chat and thread', async () => {
  const service = media()
  const file = await service.addArtifact({
    id: id(10),
    target: { ...target, threadId: id(11) },
    name: 'result.txt',
    mimeType: 'text/plain',
    bytes: new TextEncoder().encode('result'),
    ownership: { kind: 'agent', id: id(12) },
    provenance: { kind: 'generated', authorId: id(12) },
  })
  const request = (t) =>
    new Request(
      `${origin}/artifacts/${file.id}?${new URLSearchParams({ target: JSON.stringify(t) })}`,
    )
  assert.deepEqual(await (await service.handle(request(target))).json(), file)
  await assert.rejects(
    service.handle(request({ ...target, threadId: id(13) })),
    /access denied/,
  )
  assert.throws(
    () =>
      service.validateParts(target, [{ kind: 'file', artifactId: file.id }]),
    /access denied/,
  )
})

test('agent deletion copies referenced files once into each organization and removes personal originals', async () => {
  const service = media()
  const bytes = new TextEncoder().encode('shared work')
  const file = await service.addArtifact({
    id: id(20),
    name: 'shared.txt',
    mimeType: 'text/plain',
    bytes,
    target,
    ownership: { kind: 'agent', id: id(21) },
    provenance: { kind: 'generated', authorId: id(21) },
  })
  const result = service.deleteOwner(
    'agent',
    id(21),
    [
      { artifactId: file.id, organizationId: id(4) },
      { artifactId: file.id, organizationId: id(4) },
      { artifactId: file.id, organizationId: id(22) },
    ],
    true,
  )
  assert.deepEqual(result.removed, [file.id])
  assert.equal(result.replacements.length, 2)
  for (const replacement of result.replacements) {
    assert.notEqual(replacement.replacementId, file.id)
    const q = new URLSearchParams({
      target: JSON.stringify({
        ...target,
        context: {
          kind: 'organization',
          organizationId: replacement.organizationId,
        },
      }),
    })
    const copy = await (
      await service.handle(
        new Request(`${origin}/artifacts/${replacement.replacementId}?${q}`),
      )
    ).json()
    assert.equal(copy.sourceId, file.id)
    assert.equal(copy.sha256, file.sha256)
    assert.deepEqual(copy.provenance, { kind: 'published', authorId: id(21) })
    assert.deepEqual(copy.ownership, {
      kind: 'organization',
      id: replacement.organizationId,
    })
  }
  assert.deepEqual(service.deleteOwner('agent', id(21), [], true), {
    removed: [],
    replacements: [],
  })
  await assert.rejects(
    service.handle(
      new Request(
        `${origin}/artifacts/${file.id}?${new URLSearchParams({ target: JSON.stringify(target) })}`,
      ),
    ),
    /not found/,
  )
  const removedOrg = service.deleteOwner('organization', id(4), [], false)
  assert.equal(removedOrg.removed.length, 1)
  await assert.rejects(
    service.addArtifact({
      id: id(23),
      name: 'late.txt',
      mimeType: 'text/plain',
      bytes,
      target,
    }),
    /access denied/,
  )
})

test('reset fences pending publication and deletion without copying removes original bytes', async () => {
  const service = media(),
    bytes = new TextEncoder().encode('pending')
  const pending = service.addArtifact({
    id: id(30),
    name: 'pending.txt',
    mimeType: 'text/plain',
    bytes,
    target,
  })
  service.reset()
  await assert.rejects(pending, /claim expired/)
  const file = await service.addArtifact({
    id: id(31),
    name: 'private.txt',
    mimeType: 'text/plain',
    bytes,
    target,
    ownership: { kind: 'agent', id: id(32) },
  })
  assert.deepEqual(
    service.deleteOwner(
      'agent',
      id(32),
      [{ artifactId: file.id, organizationId: id(4) }],
      false,
    ),
    { removed: [file.id], replacements: [] },
  )
  assert.throws(
    () =>
      service.validateParts(target, [{ kind: 'file', artifactId: file.id }]),
    /not found/,
  )
})
