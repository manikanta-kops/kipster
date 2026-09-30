import { expect, test } from '@playwright/test'

const backend = process.env.KIPSTER_TEST_CORE_URL

test('generated browser recording reaches real Core and voice-only failure dispatches original once', async ({
  page,
  request,
}) => {
  test.skip(!backend, 'Requires disposable real Core voice fixture')
  await page.addInitScript(() => {
    const state = { requested: 0, stopped: 0 }
    Object.assign(window, { syntheticMicrophone: state })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          state.requested++
          const audio = new AudioContext()
          const oscillator = audio.createOscillator()
          const destination = audio.createMediaStreamDestination()
          oscillator.connect(destination)
          oscillator.start()
          void audio.resume()
          const originalStop = MediaStreamTrack.prototype.stop
          let stopped = false
          MediaStreamTrack.prototype.stop = function () {
            if (!stopped) {
              stopped = true
              state.stopped++
              oscillator.stop()
              void audio.close()
            }
            return originalStop.call(this)
          }
          return destination.stream
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Root', exact: true }).click()
  await expect(
    page.locator('.installation-agents [aria-current="page"]'),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Record voice note', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Stop recording' }),
  ).toBeVisible()
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  await expect(page.locator('.pending-media .voice-play')).toBeVisible()
  const send = page.getByRole('button', { name: 'Send message' }).first()
  await expect(send).toBeEnabled()
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/text/submissions') &&
      response.request().method() === 'POST',
  )
  await send.click()
  const submitted = await (await accepted).json()
  await page
    .locator('.feed-message')
    .filter({ has: page.getByRole('region', { name: 'Voice preparation' }) })
    .getByRole('button', { name: /^Open thread:/ })
    .press('Enter')
  const preparation = page
    .getByRole('region', { name: 'Thread' })
    .getByRole('region', { name: 'Voice preparation' })
  await expect(preparation).toContainText('Preparing voice note')
  expect((await request.post('/__test-transcription/release')).ok()).toBe(true)
  await expect(preparation).toContainText('Transcription unavailable')
  const bootstrap = await (await request.get(`${backend}/v1/bootstrap`)).json()
  expect(bootstrap.capabilities.voiceRecording).toBe(true)
  let thread: { threadId: string; chatId: string } | undefined
  await expect
    .poll(async () => {
      const app = await (await request.get(`${backend}/v1/app/snapshot`)).json()
      thread = app.threads.find(
        (item: any) => item.threadId === submitted.threadId,
      )
      return Boolean(thread)
    })
    .toBe(true)
  const threadId = thread!.threadId
  let saved: any
  await expect
    .poll(
      async () => {
        saved = await (
          await request.get(`${backend}/v1/threads/${threadId}/snapshot`)
        ).json()
        return saved.work[0]?.state
      },
      { timeout: 20000 },
    )
    .toBe('completed')
  const original = saved.messages.find(
    (item: any) => item.authorId === bootstrap.callerId,
  )
  expect(original.parts).toHaveLength(1)
  expect(original.parts[0].purpose).toBe('voice_note')
  expect(original.preparation[0].status).toBe('unavailable')
  expect(original.preparation[0].error).toBe('provider-error')
  const response = saved.messages.find(
    (item: any) => item.authorId !== bootstrap.callerId,
  )
  expect(response.parts[0].text).toContain(
    'Fixture received voice_note; original available; transcription unavailable; caption ',
  )
  const target = {
    installationId: bootstrap.installationId,
    callerId: bootstrap.callerId,
    context: { kind: 'installation', installationId: bootstrap.installationId },
    chatId: thread!.chatId,
    threadId,
  }
  const content = await request.get(
    `${backend}/conversations/media/artifacts/${original.parts[0].artifactId}/content?target=${encodeURIComponent(JSON.stringify(target))}`,
  )
  expect(content.ok()).toBe(true)
  expect((await content.body()).length).toBeGreaterThan(100)
  expect(
    await page.evaluate(() => (window as any).syntheticMicrophone.stopped),
  ).toBe(1)
  await page.reload()
  const after = await (
    await request.get(`${backend}/v1/threads/${threadId}/snapshot`)
  ).json()
  expect(after.work).toHaveLength(1)
  expect(
    after.messages.filter((item: any) => item.authorId !== bootstrap.callerId),
  ).toHaveLength(1)
  expect(
    await page.evaluate(() => (window as any).syntheticMicrophone.stopped),
  ).toBe(0)
})
