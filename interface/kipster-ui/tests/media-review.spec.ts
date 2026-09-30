import { test, expect } from '@playwright/test'
import { demo, storageFault } from './demo.ts'
import {
  setupMedia,
  uploadMedia,
  submitMedia,
  mediaMessages,
  syntheticMicrophone,
} from './media-helpers.ts'

test('caption Enter cannot submit while voice recording is still active', async ({
  page,
}) => {
  await syntheticMicrophone(page)
  await setupMedia(page)
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Caption belongs with voice')
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await expect(send).toBeEnabled()
  let writes = 0
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/text/submissions')) writes++
  })
  await page
    .getByRole('button', { name: 'Record voice note', exact: true })
    .click()
  await expect(page.getByText('Recording 0:01')).toBeVisible()
  await expect(send).toBeDisabled()
  await input.press('Enter')
  await demo(page, '/inspect')
  expect(writes).toBe(0)
  await expect(input).toHaveValue('Caption belongs with voice')
  await expect(send).toBeDisabled()
})

for (const cancel of [false, true])
  test(`recording guards slow permission and ${cancel ? 'cancellation releases caption' : 'finalization waits for saved audio review'}`, async ({
    page,
  }) => {
    await syntheticMicrophone(page, 'late')
    await setupMedia(page, { 'media-add': 'hold' })
    const input = page.getByRole('textbox', { name: 'Start a new thread' }),
      send = page.getByRole('button', { name: 'Send message', exact: true })
    let writes = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/v1/text/submissions')) writes++
    })
    await input.fill('Caption with recording')
    await page
      .getByRole('button', { name: 'Record voice note', exact: true })
      .click()
    await expect(page.getByText('Requesting microphone…')).toBeVisible()
    await expect(send).toBeDisabled()
    await input.press('Enter')
    await input.evaluate((el) => el.closest('form')!.requestSubmit())
    expect(writes).toBe(0)
    if (cancel) {
      await page.getByRole('button', { name: 'Cancel recording' }).click()
      await expect(send).toBeEnabled()
      await send.click()
      await expect.poll(() => writes).toBe(1)
      await expect(
        page
          .locator('.feed')
          .getByText('Caption with recording', { exact: true }),
      ).toBeVisible()
      return
    }
    await expect(page.getByText('Recording 0:01')).toBeVisible()
    await page.getByRole('button', { name: 'Stop recording' }).click()
    await expect(page.getByText('Saving recording for review…')).toBeVisible()
    await expect(send).toBeDisabled()
    await input.press('Enter')
    await input.evaluate((el) => el.closest('form')!.requestSubmit())
    expect(writes).toBe(0)
    await storageFault(page, 'media-add', 'allow')
    await expect(page.locator('.pending-media .voice-play')).toBeVisible()
    await expect(send).toBeEnabled()
    await send.click()
    await expect.poll(() => writes).toBe(1)
    const [message] = await mediaMessages(page)
    expect(message.parts[0]).toEqual({
      kind: 'text',
      text: 'Caption with recording',
    })
    expect(message.parts[1].purpose).toBe('voice_note')
  })

for (const resume of [false, true])
  test(`cancelling preparing queue head advances later reply${resume ? ' only after explicit Resume' : ''}`, async ({
    page,
  }) => {
    const { endpoint, target } = await setupMedia(page)
    const root = await submitMedia(page, target, [
      { kind: 'text', text: 'Running root' },
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
    const a = await submitMedia(
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
    const b = await submitMedia(
      page,
      target,
      [{ kind: 'text', text: 'Later ready reply' }],
      root.threadId,
    )
    const thread = async () =>
      (await demo(page, '/inspect')).threads.find(
        (t: { summary: { threadId: string } }) =>
          t.summary.threadId === root.threadId,
      )
    let current = await thread()
    const run = current.work.find(
      (w: { runId: string }) => w.runId === root.runId,
    )
    await demo(page, '/work', {
      threadId: root.threadId,
      work: {
        ...run,
        state: resume ? 'cancelled' : 'completed',
        queueHold: resume,
        revision: run.revision + 1,
      },
    })
    const control = async (runId: string, action: string) => {
      const response = await page.request.post(`${endpoint}/v1/work/controls`, {
        data: {
          version: 1,
          operationId: crypto.randomUUID(),
          context: target.context,
          chatId: target.chatId,
          threadId: root.threadId,
          runId,
          action,
        },
      })
      expect(response.ok()).toBeTruthy()
      expect((await response.json()).outcome).toBe('accepted')
    }
    await control(a.runId, 'cancel-queued')
    await demo(page, '/advance', { threadId: root.threadId, steps: 1 })
    current = await thread()
    expect(
      current.work.find((w: { runId: string }) => w.runId === a.runId).state,
    ).toBe('cancelled')
    expect(
      current.work.find((w: { runId: string }) => w.runId === b.runId).state,
    ).toBe(resume ? 'queued' : 'running')
    if (resume) {
      await control(root.runId, 'resume')
      await demo(page, '/advance', { threadId: root.threadId, steps: 1 })
      expect(
        (await thread()).work.find(
          (w: { runId: string }) => w.runId === b.runId,
        ).state,
      ).toBe('running')
    }
    const message = current.messages.find(
      (m: { id: string }) => m.id === a.messageId,
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
    expect((await thread()).work).toHaveLength(3)
    expect(
      (await thread()).work.find((w: { runId: string }) => w.runId === a.runId)
        .state,
    ).toBe('cancelled')
  })
