import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { startDemo, demo, DEMO_IDS } from './demo.ts'
export const scope = {
  installationId: DEMO_IDS.installation,
  callerId: DEMO_IDS.caller,
}
export async function setupMedia(
  page: Page,
  faults: Record<string, string> = {},
) {
  const session = await startDemo(page, { faults })
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  const endpoint = `/__test-core/${session}`
  const context = {
    kind: 'organization',
    organizationId: DEMO_IDS.organization,
  }
  const response = await page.request.post(`${endpoint}/v1/direct-chats`, {
    data: { version: 1, context, agentId: DEMO_IDS.researcher },
  })
  expect(response.ok()).toBeTruthy()
  const { chatId } = await response.json()
  return { session, endpoint, target: { ...scope, context, chatId } }
}
export async function submitMedia(
  page: Page,
  target: object,
  parts: unknown[],
  threadId?: string,
) {
  const endpoint = `/__test-core/${new URL(page.url()).searchParams.get('testCore')}`
  const response = await page.request.post(`${endpoint}/v1/text/submissions`, {
    data: {
      version: 1,
      submissionId: crypto.randomUUID(),
      scope,
      target: {
        context: Reflect.get(target, 'context'),
        chatId: Reflect.get(target, 'chatId'),
      },
      mode: threadId ? 'reply' : 'root',
      ...(threadId ? { threadId } : {}),
      parts,
    },
  })
  expect(response.ok()).toBeTruthy()
  return response.json()
}
export async function uploadMedia(
  page: Page,
  endpoint: string,
  target: object,
  bytes = Buffer.from('original bytes'),
  purpose = 'attachment',
  name = 'same.bin',
  mimeType = 'application/octet-stream',
) {
  const intent = {
    uploadId: crypto.randomUUID(),
    target,
    name,
    mimeType,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    purpose,
  }
  const url = `${endpoint}/conversations/media/uploads/${intent.uploadId}?intent=${encodeURIComponent(JSON.stringify(intent))}`
  const response = await page.request.put(url, {
    data: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
  expect(response.ok()).toBeTruthy()
  return { receipt: await response.json(), intent, url, bytes }
}
export async function attach(
  page: Page,
  text = 'actual bytes',
  name = 'sample.txt',
  mimeType = 'text/plain',
) {
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name, mimeType, buffer: Buffer.from(text) })
}
export async function send(page: Page, text = '') {
  if (text)
    await page.getByRole('textbox', { name: 'Start a new thread' }).fill(text)
  const button = page
    .getByRole('button', { name: 'Send message', exact: true })
    .first()
  await expect(button).toBeEnabled()
  await button.click()
}
export async function mediaMessages(page: Page) {
  await page.waitForFunction(
    () => Reflect.get(window, 'kipsterTest')?.ready === true,
  )
  const state = await demo(page, '/inspect')
  return state.threads
    .flatMap(
      (t: {
        messages: {
          id: string
          threadId: string
          parts: {
            kind: string
            artifactId?: string
            text?: string
            purpose?: string
          }[]
          preparation?: unknown[]
        }[]
      }) => t.messages,
    )
    .filter((m: { parts: { kind: string; artifactId?: string }[] }) =>
      m.parts.some(
        (p) => p.kind === 'file' && !p.artifactId?.startsWith('00000000-'),
      ),
    )
}
export async function syntheticMicrophone(page: Page, mode = 'normal') {
  await page.addInitScript((mode) => {
    const state = { requested: 0, stopped: 0, created: 0 }
    Object.assign(window, { syntheticMicrophone: state })
    if (mode === 'unsupported')
      Object.defineProperty(window, 'MediaRecorder', { value: undefined })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => {
          state.requested++
          if (mode === 'denied')
            throw new DOMException('Permission denied', 'NotAllowedError')
          if (mode === 'unavailable')
            throw new DOMException('No microphone', 'NotFoundError')
          if (mode === 'late')
            await new Promise((resolve) => setTimeout(resolve, 600))
          const audio = new AudioContext()
          const oscillator = audio.createOscillator()
          const destination = audio.createMediaStreamDestination()
          oscillator.connect(destination)
          oscillator.start()
          void audio.resume()
          state.created++
          const tracks = destination.stream.getTracks()
          for (const track of tracks) {
            const stop = track.stop.bind(track)
            let stopped = false
            track.stop = () => {
              if (!stopped) {
                stopped = true
                state.stopped++
                oscillator.stop()
                void audio.close()
              }
              stop()
            }
          }
          // WebKit can collect native-track JS wrappers and lose their stop overrides.
          // Retain the instrumented wrappers so release remains observable after GC.
          Object.defineProperty(destination.stream, 'getTracks', {
            value: () => tracks,
          })
          return destination.stream
        },
      },
    })
  }, mode)
}
export async function microphoneState(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          syntheticMicrophone: {
            requested: number
            stopped: number
            created: number
          }
        }
      ).syntheticMicrophone,
  )
}
