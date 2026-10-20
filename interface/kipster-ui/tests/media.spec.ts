import { test, expect, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { demo, startDemo, storageFault, DEMO_IDS } from './demo.ts'
import {
  setupMedia,
  submitMedia,
  uploadMedia,
  attach,
  send,
  mediaMessages,
  syntheticMicrophone,
  microphoneState,
} from './media-helpers.ts'

test('binary integrity, duplicate names, immutable upload receipt and ordered mixed parts', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const a = await uploadMedia(
    page,
    endpoint,
    target,
    Buffer.from([0, 255, 1, 2]),
    'attachment',
    'duplicate.bin',
  )
  const b = await uploadMedia(
    page,
    endpoint,
    target,
    Buffer.from([9, 8, 7]),
    'attachment',
    'duplicate.bin',
  )
  expect(a.receipt.artifact.id).not.toBe(b.receipt.artifact.id)
  const reused = await page.request.put(a.url, {
    data: a.bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  expect((await reused.json()).artifact.id).toBe(a.receipt.artifact.id)
  const changed = await page.request.put(
    a.url.replace(
      encodeURIComponent(JSON.stringify(a.intent)),
      encodeURIComponent(
        JSON.stringify({
          ...a.intent,
          sha256: b.intent.sha256,
          size: b.bytes.length,
        }),
      ),
    ),
    { data: b.bytes, headers: { 'Content-Type': 'application/octet-stream' } },
  )
  expect(changed.status()).toBe(409)
  const downloaded = await page.request.get(
    `${endpoint}/conversations/media/artifacts/${a.receipt.artifact.id}/content?target=${encodeURIComponent(JSON.stringify(target))}`,
  )
  expect(await downloaded.body()).toEqual(a.bytes)
  const parts = [
    { kind: 'file', artifactId: a.receipt.artifact.id, purpose: 'attachment' },
    { kind: 'text', text: 'Caption between originals' },
    { kind: 'file', artifactId: b.receipt.artifact.id, purpose: 'attachment' },
  ]
  const receipt = await submitMedia(page, target, parts)
  const message = (await mediaMessages(page)).find(
    (m: { id: string }) => m.id === receipt.messageId,
  )
  expect(message.parts).toEqual(parts)
})

test('actual bytes survive reload and file-only dispatch consumes the saved association', async ({
  page,
}) => {
  await setupMedia(page)
  await attach(page, 'recovered original')
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await send(page)
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  const messages = await mediaMessages(page)
  expect(messages).toHaveLength(1)
  expect(messages[0].parts[0].kind).toBe('file')
  const ready = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download sample.txt' }).click()
  const stream = await (await ready).createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  expect(Buffer.concat(chunks).toString()).toBe('recovered original')
})

for (const behavior of ['fail', 'lost-ack', 'slow'])
  test(`upload ${behavior}: no duplicate finalization after reload and explicit retry`, async ({
    page,
  }) => {
    await setupMedia(page)
    let writes = 0,
      release = () => {}
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/conversations/media/uploads/**', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      writes++
      if (behavior === 'fail') return route.abort()
      const response = await route.fetch()
      if (behavior === 'slow') await held
      return behavior === 'lost-ack'
        ? route.abort()
        : route.fulfill({ response }).catch(() => {})
    })
    await attach(page)
    if (behavior === 'fail') {
      await expect(page.getByText(/Upload outcome unconfirmed/)).toBeVisible()
      await page.reload()
      await expect(page.getByText(/Upload outcome unconfirmed/)).toBeVisible()
      expect(writes).toBe(1)
      await page.unroute('**/conversations/media/uploads/**')
      await page.getByRole('button', { name: 'Retry upload' }).click()
    } else {
      await expect.poll(() => writes).toBe(1)
      release()
      await page.reload()
    }
    await expect(page.getByText(/Uploaded/)).toBeVisible()
    await send(page)
    await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
    expect(writes).toBe(1)
  })

test('remove during slow finalization never reattaches and preserves receipt evidence', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  let uploadId = ''
  await page.route('**/conversations/media/uploads/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    uploadId = new URL(route.request().url()).pathname.split('/').at(-1)!
    const response = await route.fetch()
    await held
    await route.fulfill({ response }).catch(() => {})
  })
  await attach(page)
  await expect.poll(() => uploadId).not.toBe('')
  await page.getByRole('button', { name: 'Remove sample.txt' }).click()
  release()
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  const receipt = await page.request.get(
    `${endpoint}/conversations/media/uploads/${uploadId}?target=${encodeURIComponent(JSON.stringify(target))}`,
  )
  expect((await receipt.json()).status).toBe('accepted')
  expect(await mediaMessages(page)).toHaveLength(0)
})

test('late upload stays with original organization and newer typed draft', async ({
  page,
}) => {
  await setupMedia(page)
  let accepted = false
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/conversations/media/uploads/**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    const response = await route.fetch()
    accepted = true
    await held
    await route.fulfill({ response })
  })
  await attach(page)
  await expect.poll(() => accepted).toBe(true)
  await page
    .getByRole('textbox', { name: 'Start a new thread' })
    .fill('Newer caption')
  await page.getByRole('button', { name: 'Mira', exact: true }).click()
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  release()
  await page.getByRole('button', { name: 'Atlas', exact: true }).first().click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toHaveValue('Newer caption')
  await expect(page.getByText(/Uploaded/)).toBeVisible()
})

test('two tabs settle a shared attachment and only one outbox reservation consumes it', async ({
  page,
  context,
}) => {
  const { session } = await setupMedia(page)
  await attach(page)
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  const other = await context.newPage()
  await startDemo(other, { session })
  await expect(other.getByText(/Uploaded/)).toBeVisible()
  await Promise.all([
    page
      .getByRole('button', { name: 'Send message', exact: true })
      .dispatchEvent('click'),
    other
      .getByRole('button', { name: 'Send message', exact: true })
      .dispatchEvent('click'),
  ])
  await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
})

for (const outcome of ['succeeded', 'no-speech', 'unavailable'])
  test(`voice preparation ${outcome} keeps original identity and derived provenance`, async ({
    page,
  }) => {
    const { endpoint, target } = await setupMedia(page)
    const audio = await uploadMedia(
      page,
      endpoint,
      target,
      Buffer.from('voice'),
      'voice_note',
      'voice.webm',
      'audio/webm',
    )
    const receipt = await submitMedia(page, target, [
      {
        kind: 'file',
        artifactId: audio.receipt.artifact.id,
        purpose: 'voice_note',
      },
    ])
    const message = (await mediaMessages(page)).find(
      (m: { id: string }) => m.id === receipt.messageId,
    )
    await demo(page, '/message', {
      threadId: receipt.threadId,
      message: {
        ...message,
        revision: message.revision + 1,
        preparation: [
          {
            id: crypto.randomUUID(),
            artifactId: audio.receipt.artifact.id,
            partIndex: 0,
            revision: 1,
            status: outcome,
            provider: 'transcribe-cpp',
            ...(outcome === 'succeeded'
              ? { transcript: 'Derived transcript' }
              : { error: 'No transcript available' }),
          },
        ],
      },
    })
    await page.reload()
    const card = page
      .getByRole('region', { name: 'Voice preparation' })
      .filter({ hasText: 'transcribe-cpp' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Derived from voice note 1')
    if (outcome === 'succeeded') {
      await expect(
        card.getByText('Derived transcript', { exact: true }),
      ).not.toBeVisible()
      await card.locator('summary').click()
      await expect(
        card.getByText('Derived transcript', { exact: true }),
      ).toBeVisible()
      await expect(page.getByText(/Simulated preparation/)).toHaveCount(0)
    }

    const updated = (await mediaMessages(page)).find(
      (m: { id: string }) => m.id === receipt.messageId,
    )
    expect(updated.parts).toEqual(message.parts)
    expect(updated.preparation[0].status).toBe(outcome)
    const later = await submitMedia(
      page,
      target,
      [{ kind: 'text', text: 'Later FIFO reply' }],
      receipt.threadId,
    )
    const state = async () =>
      (await demo(page, '/inspect')).threads.find(
        (t: { summary: { threadId: string } }) =>
          t.summary.threadId === receipt.threadId,
      )
    const before = await state()
    await demo(page, '/advance', { threadId: receipt.threadId, steps: 1 })
    const after = await state()
    expect(
      after.work.find((w: { runId: string }) => w.runId === receipt.runId)
        .state,
    ).toBe('running')
    expect(
      after.work.find((w: { runId: string }) => w.runId === later.runId).state,
    ).toBe('queued')
    expect(
      after.work.map((w: { runId: string; queuePosition: number }) => [
        w.runId,
        w.queuePosition,
      ]),
    ).toEqual(
      before.work.map((w: { runId: string; queuePosition: number }) => [
        w.runId,
        w.queuePosition,
      ]),
    )
    await demo(page, '/message', {
      threadId: receipt.threadId,
      message: updated,
    })
    expect((await state()).work).toHaveLength(before.work.length)
    if (outcome === 'succeeded') {
      const current = after.messages.find(
        (m: { id: string }) => m.id === receipt.messageId,
      )
      await demo(page, '/message', {
        threadId: receipt.threadId,
        message: {
          ...current,
          revision: current.revision + 1,
          preparation: [
            {
              ...current.preparation[0],
              revision: current.preparation[0].revision + 1,
              provider: 'demo:transcription',
            },
          ],
        },
      })
      await page.reload()
      const alternate = page
        .getByRole('region', { name: 'Voice preparation' })
        .filter({ hasText: 'demo:transcription' })
      await expect(alternate).toBeVisible()
      await expect(alternate).toContainText('Derived from voice note 1')
      await expect(page.getByText(/Simulated preparation/)).toHaveCount(0)
    }
  })

test('ordinary audio never requests voice preparation; active HTML and SVG never execute', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const audio = await uploadMedia(
    page,
    endpoint,
    target,
    Buffer.from('audio'),
    'attachment',
    'ordinary.mp3',
    'audio/mpeg',
  )
  const receipt = await submitMedia(page, target, [
    {
      kind: 'file',
      artifactId: audio.receipt.artifact.id,
      purpose: 'attachment',
    },
  ])
  expect(
    (await mediaMessages(page)).find(
      (m: { id: string }) => m.id === receipt.messageId,
    ).preparation,
  ).toBeUndefined()
  for (const [name, mimeType, text] of [
    [
      'active.svg',
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="window.mediaExecuted=true"/>',
    ],
    ['active.html', 'text/html', '<script>window.mediaExecuted=true</script>'],
  ]) {
    await attach(page, text, name, mimeType)
    await send(page)
    const card = page.getByRole('region', {
      name: `File: ${name}`,
      exact: true,
    })
    await expect(
      card.getByRole('link', { name: `Download ${name}` }),
    ).toBeVisible()
  }
  // SVG renders only as an image; HTML shows as escaped source text.
  await expect(
    page.getByRole('region', { name: 'File: active.svg' }).locator('img'),
  ).toHaveJSProperty('complete', true)
  await expect(
    page.getByRole('region', { name: 'Text preview of active.html' }),
  ).toHaveText('<script>window.mediaExecuted=true</script>')
  await expect(page.locator('.feed svg[onload], .feed script')).toHaveCount(0)
  expect(await page.evaluate(() => 'mediaExecuted' in window)).toBe(false)
  await expect(page.locator('iframe,object,embed')).toHaveCount(0)
})

test('missing content and integrity errors leave message readable with retry', async ({
  page,
}) => {
  await setupMedia(page)
  await attach(page, 'actual bytes', 'sample.zip', 'application/zip')
  await send(page, 'Keep this caption')
  await page.route('**/conversations/media/artifacts/*/content?**', (route) =>
    route.fulfill({
      status: 404,
      json: {
        version: 1,
        code: 'not-found',
        message: 'File content is missing or unavailable.',
      },
    }),
  )
  await page
    .getByRole('button', { name: 'Prepare download sample.zip' })
    .click()
  await expect(
    page.getByRole('region', { name: 'File: sample.zip' }),
  ).toContainText(/missing|unavailable/)
  await expect(
    page
      .getByRole('region', { name: 'File: sample.zip' })
      .getByRole('button', { name: 'Retry file' }),
  ).toBeVisible()
  await expect(
    page.locator('.feed').getByText('Keep this caption', { exact: true }),
  ).toBeVisible()
  await page.unroute('**/conversations/media/artifacts/*/content?**')
  await page
    .getByRole('region', { name: 'File: sample.zip' })
    .getByRole('button', { name: 'Retry file' })
    .click()
  await expect(
    page.getByRole('link', { name: 'Download sample.zip' }),
  ).toBeVisible()
})
for (const mode of ['denied', 'unavailable', 'unsupported'])
  test(`recording ${mode} is explicit without creating an attachment`, async ({
    page,
  }) => {
    await syntheticMicrophone(page, mode)
    await setupMedia(page)
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    await expect(page.locator('.voice-control [role=alert]')).toBeVisible()
    await expect(page.locator('.attachment-list')).toHaveCount(0)
    expect((await microphoneState(page)).created).toBe(0)
  })

for (const action of ['cancel', 'navigate', 'late-cancel', 'late-navigate'])
  test(`recording ${action} releases synthetic tracks and cannot attach late bytes`, async ({
    page,
  }) => {
    await syntheticMicrophone(
      page,
      action.startsWith('late') ? 'late' : 'normal',
    )
    await setupMedia(page)
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    if (!action.startsWith('late'))
      await expect(
        page.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible()
    if (action.includes('navigate'))
      await page.getByRole('button', { name: 'Mira', exact: true }).click()
    else await page.getByRole('button', { name: 'Cancel recording' }).click()
    await expect.poll(async () => (await microphoneState(page)).stopped).toBe(1)
    await expect
      .poll(async () => {
        const { contexts, closed } = await microphoneState(page)
        return contexts - closed
      })
      .toBe(0)
    await expect(page.locator('.attachment-list')).toHaveCount(0)
  })

test('recording can be removed and recorded again without retaining old streams', async ({
  page,
}) => {
  await syntheticMicrophone(page)
  await setupMedia(page)
  for (let count = 1; count <= 2; count++) {
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    await expect(page.getByText('Recording 0:01')).toBeVisible()
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await expect(page.getByText(/Uploaded/)).toBeVisible()
    await page.getByRole('button', { name: /Remove Voice note/ }).click()
    expect((await microphoneState(page)).stopped).toBe(count)
    expect((await microphoneState(page)).closed).toBe(count)
  }
  await expect(page.locator('.attachment-list')).toHaveCount(0)
})

test('synthetic recording requests permission on action, stops tracks, reviews original and sends voice intent plus caption', async ({
  page,
}) => {
  await syntheticMicrophone(page)
  await setupMedia(page)
  expect((await microphoneState(page)).requested).toBe(0)
  await page
    .getByRole('button', { name: 'Record voice note', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Stop recording' }),
  ).toBeFocused()
  await expect(page.getByText('Recording 0:01')).toBeVisible()
  await page.requestGC()
  const uploaded = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && request.url().includes('/media/uploads/'),
  )
  await page.getByRole('button', { name: 'Stop recording' }).click()
  const upload = await uploaded
  const intent = JSON.parse(new URL(upload.url()).searchParams.get('intent')!)
  expect(intent.name).toBe('Voice note.wav')
  expect(intent.mimeType).toBe('audio/wav')
  const samples = assertWav(upload.postDataBuffer()!)
  // A 440 Hz source has 220 rising zero crossings in 8,000 samples at 16 kHz.
  expect(samples.length).toBeGreaterThanOrEqual(8000)
  const tail = samples.slice(-8000)
  const crossings = tail.filter(
    (sample, i) => i > 0 && sample >= 0 && tail[i - 1] < 0,
  ).length
  expect(crossings).toBeGreaterThanOrEqual(210)
  expect(crossings).toBeLessThanOrEqual(230)
  await expect(page.locator('.pending-media .voice-play')).toBeVisible()
  expect((await microphoneState(page)).stopped).toBe(1)
  expect((await microphoneState(page)).closed).toBe(1)
  expect((await microphoneState(page)).constraints).toEqual({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  })
  await send(page, 'Typed caption stays typed')
  await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
  const [message] = await mediaMessages(page)
  expect(message.parts[0]).toEqual({
    kind: 'text',
    text: 'Typed caption stays typed',
  })
  expect(message.parts[1].purpose).toBe('voice_note')
  await demo(page, '/advance', { threadId: message.threadId, steps: 1 })
  await expect(
    page
      .getByRole('article')
      .filter({
        has: page.getByText('Typed caption stays typed', { exact: true }),
      })
      .getByRole('region', { name: 'Voice preparation' })
      .filter({ hasText: 'demo-transcription' }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page
      .locator('.feed')
      .getByText('Typed caption stays typed', { exact: true }),
  ).toBeVisible()
  await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
})

test('quota failure blocks upload and dispatch until original bytes are saved', async ({
  page,
}) => {
  await setupMedia(page, { 'media-add': 'fail' })
  let writes = 0
  page.on('request', (r) => {
    if (r.method() === 'PUT') writes++
  })
  await attach(page, 'quota original')
  await expect(page.getByText(/File bytes are not saved/)).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeDisabled()
  expect(writes).toBe(0)
  await storageFault(page, 'media-add', 'allow')
  await storageFault(page, 'media-commit', 'hold')
  await page.getByRole('button', { name: 'Retry attachment storage' }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, 'kipsterTest').calls['media-commit'] || 0,
      ),
    )
    .toBe(1)
  await expect(page.locator('.pending-media')).toHaveCount(1)
  await storageFault(page, 'media-commit', 'allow')
  await expect(page.locator('.pending-media')).toHaveCount(1)
  await page.getByRole('button', { name: 'Retry upload' }).click()
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await send(page)
  expect(writes).toBe(1)
  await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
})

for (const phase of ['before commit', 'after commit'])
  test(`removing an attachment during quota recovery ${phase} removes its committed copy too`, async ({
    page,
  }) => {
    await setupMedia(page, { 'media-add': 'fail' })
    await attach(page, 'remove original')
    await expect(page.getByText(/File bytes are not saved/)).toBeVisible()
    await storageFault(
      page,
      'media-add',
      phase === 'before commit' ? 'hold' : 'allow',
    )
    if (phase === 'after commit')
      await storageFault(page, 'media-commit', 'hold')
    await page.getByRole('button', { name: 'Retry attachment storage' }).click()
    if (phase === 'after commit')
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, 'kipsterTest').calls['media-commit'] || 0,
          ),
        )
        .toBe(1)
    await page.getByRole('button', { name: 'Remove sample.txt' }).click()
    await storageFault(page, 'media-add', 'allow')
    await storageFault(page, 'media-commit', 'allow')
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<boolean>((resolve) => {
              const req = indexedDB.open('kipster-conversations')
              req.onsuccess = () => {
                const tx = req.result.transaction('media')
                const rows = tx.objectStore('media').getAll()
                rows.onsuccess = () =>
                  resolve(
                    rows.result.some(
                      (row: { association: string }) =>
                        row.association === 'removed',
                    ),
                  )
                tx.oncomplete = () => req.result.close()
              }
            }),
        ),
      )
      .toBe(true)
    await expect(page.locator('.pending-media')).toHaveCount(0)
    await page.reload()
    await expect(
      page.getByRole('textbox', { name: 'Start a new thread' }),
    ).toBeVisible()
    await expect(page.locator('.pending-media')).toHaveCount(0)
    expect(await mediaMessages(page)).toHaveLength(0)
  })

test('destination and organization switches cannot leak pending attachments', async ({
  page,
}) => {
  const { session } = await setupMedia(page)
  await attach(page)
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.studio)
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  await page
    .getByRole('combobox', { name: 'Organization' })
    .selectOption(DEMO_IDS.organization)
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await startDemo(page)
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await expect(page.locator('.attachment-list')).toHaveCount(0)
  await startDemo(page, { session })
  await expect(page.getByText(/Uploaded/)).toBeVisible()
})

for (const otherTab of [false, true])
  test(`${otherTab ? 'another tab terminal upload receipt supersedes' : 'explicit upload retry waits behind'} a receipt lookup without duplicate writes`, async ({
    page,
    context,
  }) => {
    const { session } = await setupMedia(page)
    let writes = 0,
      release = () => {}
    const held = new Promise<void>((r) => (release = r))
    let pendingURL = ''
    let pendingBytes: Buffer | null = null
    let holdReads = false
    let heldReads = 0
    await page.route('**/conversations/media/uploads/**', async (route) => {
      if (route.request().method() === 'PUT') {
        writes++
        pendingURL = route.request().url()
        pendingBytes = route.request().postDataBuffer()
        return route.abort()
      }
      if (holdReads) {
        heldReads++
        await held
      }
      return route.continue()
    })
    await attach(page)
    await expect.poll(() => writes).toBe(1)
    await expect(page.getByText(/Upload outcome unconfirmed/)).toBeVisible()
    const accepted = await page.request.put(pendingURL, {
      data: pendingBytes!,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    expect(accepted.ok()).toBeTruthy()
    holdReads = true
    // Reload recovers from the authoritative upload receipt and must never dispatch another PUT.
    const reload = page.reload()
    await reload
    await expect.poll(() => heldReads).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Retry upload' }).click()
    expect(writes).toBe(1)
    if (otherTab) {
      const other = await context.newPage()
      await startDemo(other, { session })
      await expect(other.getByText(/Uploaded/)).toBeVisible()
    }
    release()
    await expect(page.getByText(/Uploaded/)).toBeVisible()
    expect(writes).toBe(1)
  })

test('generated agent file and organization-owned file use the same projection and independent bytes', async ({
  page,
}) => {
  const { endpoint } = await setupMedia(page)
  const state = await demo(page, '/inspect')
  const thread = state.threads.find(
    (t: { messages: { parts: { text?: string }[] }[] }) =>
      t.messages[0].parts[0].text ===
      'Shape a calmer workspace for the next release',
  )
  await page
    .getByRole('button', {
      name: 'Open thread: Shape a calmer workspace for the next release',
      exact: true,
    })
    .click()
  const artifacts = thread.messages
    .flatMap((m: { parts: { kind: string; artifactId?: string }[] }) => m.parts)
    .filter((p: { kind: string }) => p.kind === 'file')
  expect(artifacts.length).toBeGreaterThanOrEqual(2)
  const targets = {
    installationId: DEMO_IDS.installation,
    callerId: DEMO_IDS.caller,
    context: { kind: 'organization', organizationId: DEMO_IDS.organization },
    chatId: thread.summary.chatId,
    threadId: thread.summary.threadId,
  }
  const rows = []
  const contents: Buffer[] = []
  for (const part of artifacts) {
    const response = await page.request.get(
      `${endpoint}/conversations/media/artifacts/${part.artifactId}?target=${encodeURIComponent(JSON.stringify(targets))}`,
    )
    expect(response.ok()).toBeTruthy()
    rows.push(await response.json())
    const content = await page.request.get(
      `${endpoint}/conversations/media/artifacts/${part.artifactId}/content?target=${encodeURIComponent(JSON.stringify(targets))}`,
    )
    expect(content.ok()).toBeTruthy()
    contents.push(await content.body())
  }
  expect(contents[0].equals(contents[1])).toBe(false)
  expect(contents[0].toString()).toContain('A calmer workspace')
  expect(contents[1].toString()).toContain('<svg')
  expect(new Set(rows.map((r) => r.artifact?.id ?? r.id)).size).toBe(
    rows.length,
  )
  await expect(
    page.getByRole('region', { name: 'File: workspace-plan.md' }),
  ).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'File: palette.svg' }),
  ).toBeVisible()
})

test('corrupt binary upload is rejected and corrupt download is never exposed as ready', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const uploadId = crypto.randomUUID(),
    bytes = Buffer.from('valid')
  const intent = {
    uploadId,
    target,
    name: 'bad.txt',
    mimeType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update('other').digest('hex'),
    purpose: 'attachment',
  }
  const response = await page.request.put(
    `${endpoint}/conversations/media/uploads/${uploadId}?intent=${encodeURIComponent(JSON.stringify(intent))}`,
    { data: bytes, headers: { 'Content-Type': 'application/octet-stream' } },
  )
  expect(response.ok()).toBe(false)
  await attach(page, 'actual bytes', 'sample.zip', 'application/zip')
  await send(page)
  await page.route('**/conversations/media/artifacts/*/content?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'corrupt bytes',
    }),
  )
  await page
    .getByRole('button', { name: 'Prepare download sample.zip' })
    .click()
  await expect(
    page.getByRole('region', { name: 'File: sample.zip' }),
  ).toContainText(/integrity|match|verified/i)
  await expect(
    page.getByRole('link', { name: 'Download sample.zip' }),
  ).toHaveCount(0)
})

test('caller scope cannot read old artifact bytes or consume old draft', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const audio = await uploadMedia(page, endpoint, target)
  const response = await page.request.get(
    `${endpoint}/conversations/media/artifacts/${audio.receipt.artifact.id}/content?target=${encodeURIComponent(JSON.stringify({ ...target, callerId: crypto.randomUUID() }))}`,
  )
  expect(response.ok()).toBe(false)
  await attach(page, 'Original caller bytes')
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/Uploaded/)).toBeVisible()
})

test('object URLs are released when their draft owner leaves the UI', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const made: string[] = [],
      released: string[] = []
    const create = URL.createObjectURL.bind(URL),
      revoke = URL.revokeObjectURL.bind(URL)
    URL.createObjectURL = (value) => {
      const url = create(value)
      made.push(url)
      return url
    }
    URL.revokeObjectURL = (url) => {
      released.push(url)
      revoke(url)
    }
    Object.assign(window, { objectURLs: { made, released } })
  })
  await setupMedia(page)
  await attach(page, 'image', 'test.png', 'image/png')
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  const urls = await page.evaluate(
    () => Reflect.get(window, 'objectURLs').made as string[],
  )
  expect(urls.length).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Mira', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'objectURLs').released.length),
    )
    .toBeGreaterThan(0)
})

test('media message lost acknowledgement recovers read-only across reload and reordered target keys', async ({
  page,
}) => {
  await setupMedia(page)
  let writes = 0
  await page.route('**/v1/text/submissions', async (route) => {
    writes++
    await route.fetch()
    await route.abort()
  })
  await attach(page)
  await send(page, 'Caption once')
  await expect(
    page.locator('.feed').getByText('Caption once', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  await expect(
    page.locator('.submission-recovery:not(details) > .pending-submission'),
  ).toHaveCount(0)
  expect(writes).toBe(1)
  await expect.poll(async () => (await mediaMessages(page)).length).toBe(1)
})

test('offline capability read still saves original bytes and reload never starts a write', async ({
  page,
}) => {
  await page.route('**/conversations/media/capabilities**', (route) =>
    route.abort(),
  )
  await setupMedia(page)
  let writes = 0
  page.on('request', (r) => {
    if (r.method() === 'PUT') writes++
  })
  await attach(page, 'Offline original')
  await expect(page.locator('.pending-media')).toHaveCount(1)
  await expect(page.getByText(/Upload outcome unconfirmed/)).toBeVisible()
  await page.reload()
  await expect(page.locator('.pending-media')).toHaveCount(1)
  expect(writes).toBe(0)
  await page.unroute('**/conversations/media/capabilities**')
  await page.getByRole('button', { name: 'Retry upload' }).click()
  await expect(page.getByText(/Uploaded/)).toBeVisible()
  expect(writes).toBe(1)
})

test('root voice preparation blocks replies and Stop wins over late transcript', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const audio = await uploadMedia(
    page,
    endpoint,
    target,
    Buffer.from('voice'),
    'voice_note',
    'voice.webm',
    'audio/webm',
  )
  const root = await submitMedia(page, target, [
    {
      kind: 'file',
      artifactId: audio.receipt.artifact.id,
      purpose: 'voice_note',
    },
  ])
  const reply = await submitMedia(
    page,
    target,
    [{ kind: 'text', text: 'Held behind preparation' }],
    root.threadId,
  )
  const thread = async () =>
    (await demo(page, '/inspect')).threads.find(
      (t: { summary: { threadId: string } }) =>
        t.summary.threadId === root.threadId,
    )
  let current = await thread()
  expect(
    current.work.find((w: { runId: string }) => w.runId === reply.runId).state,
  ).toBe('queued')
  const response = await page.request.post(`${endpoint}/v1/work/controls`, {
    data: {
      version: 1,
      operationId: crypto.randomUUID(),
      context: target.context,
      chatId: target.chatId,
      threadId: root.threadId,
      runId: root.runId,
      action: 'stop',
    },
  })
  expect((await response.json()).outcome).toBe('accepted')
  const message = current.messages.find(
    (m: { id: string }) => m.id === root.messageId,
  )
  await demo(page, '/message', {
    threadId: root.threadId,
    message: {
      ...message,
      revision: message.revision + 1,
      preparation: message.preparation.map((p: object) => ({
        ...p,
        revision: 2,
        status: 'succeeded',
        transcript: 'Late transcript',
      })),
    },
  })
  await demo(page, '/advance', { threadId: root.threadId, steps: 3 })
  current = await thread()
  expect(
    current.work.find((w: { runId: string }) => w.runId === root.runId).state,
  ).toBe('cancelled')
  expect(
    current.work.find((w: { runId: string }) => w.runId === reply.runId).state,
  ).toBe('queued')
  expect(current.work).toHaveLength(2)
})

test('cancelled preparing follow-up cannot revive after late transcription', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const root = await submitMedia(page, target, [
    { kind: 'text', text: 'Independent active root' },
  ])
  await demo(page, '/advance', { threadId: root.threadId, steps: 1 })
  const audio = await uploadMedia(
    page,
    endpoint,
    { ...target, threadId: root.threadId },
    Buffer.from('voice'),
    'voice_note',
    'voice.webm',
    'audio/webm',
  )
  const reply = await submitMedia(
    page,
    target,
    [
      {
        kind: 'file',
        artifactId: audio.receipt.artifact.id,
        purpose: 'voice_note',
      },
    ],
    root.threadId,
  )
  const response = await page.request.post(`${endpoint}/v1/work/controls`, {
    data: {
      version: 1,
      operationId: crypto.randomUUID(),
      context: target.context,
      chatId: target.chatId,
      threadId: root.threadId,
      runId: reply.runId,
      action: 'cancel-queued',
    },
  })
  expect((await response.json()).outcome).toBe('accepted')
  const state = await demo(page, '/inspect')
  const thread = state.threads.find(
    (t: { summary: { threadId: string } }) =>
      t.summary.threadId === root.threadId,
  )
  const message = thread.messages.find(
    (m: { id: string }) => m.id === reply.messageId,
  )
  await demo(page, '/message', {
    threadId: root.threadId,
    message: {
      ...message,
      revision: message.revision + 1,
      preparation: message.preparation.map((p: object) => ({
        ...p,
        revision: 2,
        status: 'succeeded',
        transcript: 'Late transcript',
      })),
    },
  })
  const after = (await demo(page, '/inspect')).threads.find(
    (t: { summary: { threadId: string } }) =>
      t.summary.threadId === root.threadId,
  )
  expect(after.work).toHaveLength(thread.work.length)
  expect(
    after.work.find((w: { runId: string }) => w.runId === reply.runId).state,
  ).toBe('cancelled')
})

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, 'fixtures/media', name))
type Expected = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'generic'
// name, MIME type, bytes, preview when the browser supports the format
const previewSets: [string, string, Buffer, Expected][][] = [
  [
    ['song.mp3', 'audio/mpeg', fixture('tone.mp3'), 'audio'],
    ['memo.m4a', 'audio/mp4', fixture('tone.m4a'), 'audio'],
    ['dot.png', 'image/png', fixture('dot.png'), 'image'],
    [
      'diagram.svg',
      'image/svg+xml',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="window.mediaExecuted=true"><rect width="40" height="20" fill="#4cc0a8"/></svg>',
      ),
      'image',
    ],
    ['clip.mp4', 'video/mp4', fixture('clip.mp4'), 'video'],
    ['clip.mov', 'video/quicktime', fixture('clip.mov'), 'video'],
  ],
  [
    ['report.pdf', 'application/pdf', fixture('report.pdf'), 'pdf'],
    [
      'notes.md',
      'text/markdown',
      Buffer.from('# Release notes\n\n<b>not bold</b> and **not bold**\n'),
      'text',
    ],
    ['table.csv', 'text/csv', Buffer.from('name,size\nkip,1\n'), 'text'],
    // A generic MIME type falls back to the extension.
    [
      'data.json',
      'application/octet-stream',
      Buffer.from('{"kip": true}\n'),
      'text',
    ],
    ['readme.txt', 'text/plain', Buffer.from('Plain words.\n'), 'text'],
    [
      'bundle.zip',
      'application/zip',
      Buffer.from('PK\x03\x04 archive'),
      'generic',
    ],
  ],
]
async function supported(page: Page, mimeType: string, kind: Expected) {
  if (kind === 'pdf')
    return page.evaluate(() => navigator.pdfViewerEnabled === true)
  if (kind !== 'audio' && kind !== 'video') return true
  return page.evaluate(
    ([kind, type]) =>
      (document.createElement(kind) as HTMLMediaElement).canPlayType(type) !==
      '',
    [kind, mimeType],
  )
}
async function expectPreview(
  page: Page,
  scope: Locator,
  [name, mimeType, bytes, preferred]: [string, string, Buffer, Expected],
) {
  const card = scope.getByRole('region', { name: `File: ${name}`, exact: true })
  const kind = (await supported(page, mimeType, preferred))
    ? preferred
    : 'generic'
  await expect(card).toBeVisible()
  await expect(card.locator('.artifact-name small')).toContainText(mimeType)
  const previews = card.locator(
    'img, audio, video, iframe, [aria-label^="Text preview"]',
  )
  if (kind === 'generic') {
    await expect(
      card.getByRole('button', { name: `Prepare download ${name}` }),
    ).toBeVisible()
    await expect(previews).toHaveCount(0)
    return kind
  }
  await expect(
    card.getByRole('link', { name: `Download ${name}` }),
  ).toBeVisible()
  await expect(previews).toHaveCount(1)
  if (kind === 'image') {
    const image = card.getByRole('img', { name })
    await expect(image).toBeVisible()
    await expect
      .poll(() => image.evaluate((e: HTMLImageElement) => e.naturalWidth))
      .toBeGreaterThan(0)
  } else if (kind === 'audio' || kind === 'video') {
    const player = card.locator(kind)
    await expect(player).toHaveAttribute('preload', 'metadata')
    await expect(player).toHaveAccessibleName(`Play ${name}`)
    // Metadata loads only for bytes the browser can really decode.
    await expect
      .poll(() => player.evaluate((e: HTMLMediaElement) => e.readyState))
      .toBeGreaterThan(0)
  } else if (kind === 'pdf') {
    await expect(card.locator('iframe')).toHaveAttribute(
      'title',
      `PDF preview of ${name}`,
    )
    await expect(card.locator('iframe')).toBeVisible()
  } else {
    const text = card.getByRole('region', { name: `Text preview of ${name}` })
    await expect(text).toHaveText(bytes.toString().replace(/\n$/, ''))
    await expect(text.locator('b, h1, strong')).toHaveCount(0)
  }
  return kind
}

test('common file types preview inline in the chat and its thread, and every file downloads', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const upload = (set: (typeof previewSets)[number]) =>
    Promise.all(
      set.map(async ([name, mimeType, bytes]) => {
        const { receipt } = await uploadMedia(
          page,
          endpoint,
          target,
          bytes,
          'attachment',
          name,
          mimeType,
        )
        return {
          kind: 'file',
          artifactId: receipt.artifact.id,
          purpose: 'attachment',
        }
      }),
    )
  const first = await submitMedia(page, target, [
    { kind: 'text', text: 'Preview set one' },
    ...(await upload(previewSets[0])),
  ])
  await submitMedia(page, target, [
    { kind: 'text', text: 'Preview set two' },
    ...(await upload(previewSets[1])),
  ])
  const feed = page.locator('.feed')
  const kinds: Record<string, string> = {}
  for (const file of previewSets.flat())
    kinds[file[0]] = await expectPreview(page, feed, file)
  test.info().annotations.push({
    type: 'preview kinds',
    description: JSON.stringify(kinds),
  })

  // A previewed file downloads straight away; others prepare first.
  for (const [name, , bytes] of [previewSets[0][2], previewSets[1][5]]) {
    const card = feed.getByRole('region', {
      name: `File: ${name}`,
      exact: true,
    })
    const prepare = card.getByRole('button', {
      name: `Prepare download ${name}`,
    })
    if (await prepare.isVisible()) await prepare.click()
    const ready = page.waitForEvent('download')
    await card.getByRole('link', { name: `Download ${name}` }).click()
    const download = await ready
    expect(download.suggestedFilename()).toBe(name)
    const chunks = []
    for await (const chunk of (await download.createReadStream())!)
      chunks.push(chunk)
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
  }

  const threadId = (await mediaMessages(page)).find(
    (m: { id: string }) => m.id === first.messageId,
  ).threadId
  await submitMedia(
    page,
    target,
    [
      { kind: 'text', text: 'Second set in the thread' },
      ...(await upload(previewSets[1])),
    ],
    threadId,
  )
  await page
    .getByRole('button', { name: 'Open thread: Preview set one', exact: true })
    .click()
  const thread = page.locator('.thread-pane')
  for (const file of previewSets.flat())
    expect(await expectPreview(page, thread, file)).toBe(kinds[file[0]])
  expect(await page.evaluate(() => 'mediaExecuted' in window)).toBe(false)
})

test('a large text file previews only a bounded, truncated start', async ({
  page,
}) => {
  const { endpoint, target } = await setupMedia(page)
  const line = 'Kipster large log line with steady width.\n'
  const bytes = Buffer.from(
    line.repeat(Math.ceil((20 * 1024 * 1024) / line.length)),
  )
  const { receipt } = await uploadMedia(
    page,
    endpoint,
    target,
    bytes,
    'attachment',
    'huge.log',
    'text/plain',
  )
  await submitMedia(page, target, [
    { kind: 'file', artifactId: receipt.artifact.id, purpose: 'attachment' },
  ])
  const card = page.getByRole('region', { name: 'File: huge.log', exact: true })
  const text = card.getByRole('region', { name: 'Text preview of huge.log' })
  await expect(text).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText('20.0 MB')
  await expect(card).toContainText('Preview shows the first 96 KB')
  const shown = await text.evaluate((e) => e.textContent!.length)
  expect(shown).toBeGreaterThan(90 * 1024)
  expect(shown).toBeLessThanOrEqual(96 * 1024)
  // The preview box scrolls instead of growing with the file.
  const box = await text.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(260)
  await page
    .getByRole('textbox', { name: 'Start a new thread' })
    .fill('Still responsive')
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toHaveValue('Still responsive')
  await expect(
    card.getByRole('link', { name: 'Download huge.log' }),
  ).toBeVisible()
})

test('a PDF preview frames only real PDF bytes as a typed blob', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
      get: () => true,
    }),
  )
  const { endpoint, target } = await setupMedia(page)
  const parts = []
  for (const [name, bytes] of [
    ['report.pdf', fixture('report.pdf')],
    [
      'fake.pdf',
      Buffer.from('<script>window.mediaExecuted=true</script>%PDF'.repeat(40)),
    ],
  ] as const) {
    const { receipt } = await uploadMedia(
      page,
      endpoint,
      target,
      bytes,
      'attachment',
      name,
      'application/pdf',
    )
    parts.push({
      kind: 'file',
      artifactId: receipt.artifact.id,
      purpose: 'attachment',
    })
  }
  await submitMedia(page, target, parts)
  const real = page.getByRole('region', { name: 'File: report.pdf' })
  const frame = real.locator('iframe')
  await expect(frame).toHaveAttribute('title', 'PDF preview of report.pdf')
  await expect(frame).toHaveAttribute('src', /^blob:/)
  const type = await frame.evaluate(async (e: HTMLIFrameElement) => {
    const blob = await (await fetch(e.src)).blob()
    return blob.type
  })
  expect(type).toBe('application/pdf')
  const fake = page.getByRole('region', { name: 'File: fake.pdf' })
  await expect(
    fake.getByRole('link', { name: 'Download fake.pdf' }),
  ).toBeVisible()
  await expect(
    fake.locator('iframe, img, [aria-label^="Text preview"]'),
  ).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(1)
  expect(await page.evaluate(() => 'mediaExecuted' in window)).toBe(false)
})

function assertWav(bytes: Buffer) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8)
  expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ')
  expect(bytes.readUInt32LE(16)).toBe(16)
  expect(bytes.readUInt16LE(20)).toBe(1)
  expect(bytes.readUInt16LE(22)).toBe(1)
  expect(bytes.readUInt32LE(24)).toBe(16000)
  expect(bytes.readUInt32LE(28)).toBe(32000)
  expect(bytes.readUInt16LE(32)).toBe(2)
  expect(bytes.readUInt16LE(34)).toBe(16)
  expect(bytes.toString('ascii', 36, 40)).toBe('data')
  expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44)
  expect((bytes.length - 44) % 2).toBe(0)
  const samples = Array.from({ length: (bytes.length - 44) / 2 }, (_, i) =>
    bytes.readInt16LE(44 + i * 2),
  )
  expect(samples.length).toBeGreaterThan(0)
  expect(samples.some((sample) => sample !== 0)).toBe(true)
  return samples
}

for (const [mode, title, expected] of [
  ['stereo', 'mixes stereo samples to mono', 8192],
  ['positive-clipping', 'clamps positive samples', 32767],
  ['negative-clipping', 'clamps negative samples', -32768],
] as const)
  test(`WAV recording ${title}`, async ({ page }) => {
    await syntheticMicrophone(page, mode)
    await setupMedia(page)
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    await expect(page.getByText('Recording 0:01')).toBeVisible()
    const uploaded = page.waitForRequest(
      (request) =>
        request.method() === 'PUT' && request.url().includes('/media/uploads/'),
    )
    await page.getByRole('button', { name: 'Stop recording' }).click()
    const samples = assertWav((await uploaded).postDataBuffer()!)
    // Ignore the initial transient and allow four PCM steps for browser resampling.
    // Stereo's mean is (0.75 - 0.25) / 2.
    const tail = samples.slice(-1600)
    expect(
      tail.every((sample) => Math.abs(sample - expected) <= 4),
      JSON.stringify({
        min: Math.min(...tail),
        max: Math.max(...tail),
        mean: tail.reduce((a, b) => a + b, 0) / tail.length,
      }),
    ).toBe(true)
    expect((await microphoneState(page)).closed).toBe(1)
    expect((await microphoneState(page)).stopped).toBe(1)
  })

for (const mode of ['setup-error', 'processor-error'])
  test(`recording ${mode} releases tracks and AudioContext`, async ({
    page,
  }) => {
    await syntheticMicrophone(page, mode)
    await setupMedia(page)
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    await expect(page.locator('.voice-control [role=alert]')).toHaveText(
      'Recording failed. Please try again.',
    )
    await expect.poll(async () => (await microphoneState(page)).stopped).toBe(1)
    await expect.poll(async () => (await microphoneState(page)).closed).toBe(1)
    await expect(page.locator('.attachment-list')).toHaveCount(0)
  })
