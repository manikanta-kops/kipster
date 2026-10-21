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
  bytes: Buffer = Buffer.from('original bytes'),
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
    const state = {
      requested: 0,
      stopped: 0,
      created: 0,
      contexts: 0,
      closed: 0,
    }
    Object.assign(window, { syntheticMicrophone: state })
    const NativeAudioContext = window.AudioContext
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(
          mode === 'native-rate' ? { ...options, sampleRate: 48000 } : options,
        )
        state.contexts++
        if (mode === 'setup-error')
          this.audioWorklet.addModule = async () => {
            throw new Error('Recording failed. Please try again.')
          }
        if (mode === 'processor-error') {
          const addModule = this.audioWorklet.addModule.bind(this.audioWorklet)
          this.audioWorklet.addModule = async () => {
            const url = URL.createObjectURL(
              new Blob(
                [
                  `registerProcessor('kipster-recording', class extends AudioWorkletProcessor {
                process() { throw new Error('Test processor failure') }
              })`,
                ],
                { type: 'text/javascript' },
              ),
            )
            try {
              await addModule(url)
            } finally {
              URL.revokeObjectURL(url)
            }
          }
        }
      }
      async close() {
        await super.close()
        state.closed++
      }
    }
    if (mode === 'unsupported')
      Object.defineProperty(window, 'AudioWorkletNode', { value: undefined })
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          state.requested++
          Object.assign(state, { constraints })
          if (mode === 'denied')
            throw new DOMException('Permission denied', 'NotAllowedError')
          if (mode === 'unavailable')
            throw new DOMException('No microphone', 'NotFoundError')
          if (mode === 'late')
            await new Promise((resolve) => setTimeout(resolve, 600))
          const audio = new NativeAudioContext()
          const oscillator = audio.createOscillator()
          const destination = audio.createMediaStreamDestination()
          let constants: ConstantSourceNode[] = []
          if (
            ['stereo', 'positive-clipping', 'negative-clipping'].includes(mode)
          ) {
            const merger = audio.createChannelMerger(2)
            const offsets =
              mode === 'stereo'
                ? [0.75, -0.25]
                : mode === 'positive-clipping'
                  ? [2, 2]
                  : [-2, -2]
            constants = offsets.map((offset, channel) => {
              const source = audio.createConstantSource()
              source.offset.value = offset
              source.connect(merger, 0, channel)
              source.start()
              return source
            })
            merger.connect(destination)
          } else oscillator.connect(destination)
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
                constants.forEach((source) => source.stop())
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
            contexts: number
            closed: number
            constraints: MediaStreamConstraints
          }
        }
      ).syntheticMicrophone,
  )
}
