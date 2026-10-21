import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isolatedEnvironment, replaceEnvironment } from '../isolation.mjs'
import { drive, scenarios } from './scenarios.mjs'

const name = process.argv[2]
if (name === '--list') {
  console.log(scenarios.join('\n'))
  process.exit(0)
}
if (!scenarios.includes(name)) throw Error('Choose a scenario listed by --list')
if (!process.env.APP_URL || !process.env.EVIDENCE_DIR)
  throw Error('Set APP_URL and EVIDENCE_DIR from the factory-provided handle')
const url = new URL(process.env.APP_URL)
if (
  url.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !url.port
)
  throw Error('Expected the allocated local factory URL')
const origin = url.origin
const audioFile = process.env.VOICE_WAV
  ? resolve(process.env.VOICE_WAV)
  : undefined
const silence = process.env.VOICE_EXPECT === 'no-speech'
const mediaFile = process.env.MEDIA_FILE
  ? resolve(process.env.MEDIA_FILE)
  : undefined
const mediaExpect = process.env.VOICE_EXPECT ?? 'succeeded'
if (['voice-file', 'voice-path'].includes(name) && !mediaFile)
  throw Error('Set MEDIA_FILE to an audio or video file')
if (name === 'voice-real' && !audioFile)
  throw Error('Set VOICE_WAV to a generated 16 kHz mono PCM WAV')
const recordingMs = audioFile
  ? await (await import('./voice-audio.mjs')).recordingDuration(audioFile)
  : undefined
// The plugin sign-in page is the instance's fixture service on another loopback
// origin. Allow exactly the origin the instance publishes, and only for plugins.
const allowed = new Set([origin])
if (name === 'plugins') {
  const response = await fetch(`${origin}/__fixture/plugins`)
  if (!response.ok) throw Error('The instance publishes no plugin fixture')
  const signIn = new URL((await response.json()).signInOrigin)
  if (
    signIn.protocol !== 'http:' ||
    signIn.hostname !== '127.0.0.1' ||
    !signIn.port ||
    signIn.origin === origin
  )
    throw Error('Expected a separate loopback plugin fixture origin')
  allowed.add(signIn.origin)
}
const evidenceDir = resolve(process.env.EVIDENCE_DIR)
await mkdir(evidenceDir, { recursive: true })
const home = resolve(evidenceDir, 'browser-home')
await mkdir(home, { recursive: true, mode: 0o700 })
replaceEnvironment(isolatedEnvironment(home))
const { chromium, expect } = await import('@playwright/test')
// A new Chrome profile, never an owner's browser session. The browser child gets
// an isolated home and no provider credentials. Chrome must already be installed.
const browser = await chromium.launch({
  channel: 'chrome',
  env: isolatedEnvironment(home),
  headless: true,
  args: audioFile
    ? [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${audioFile}%noloop`,
      ]
    : [],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  ...(audioFile ? { permissions: ['microphone'] } : {}),
})
const findings = []
// Chrome's built-in PDF viewer loads its own bundled resources; none leave the browser.
const builtIn = ({ protocol, host }) =>
  (protocol === 'chrome-extension:' &&
    host === 'mhjfbmdgcfjbbpaeojofohoefgiehjai') ||
  (protocol === 'chrome:' && host === 'resources')
await context.route('**/*', async (route) => {
  const destination = new URL(route.request().url())
  if (builtIn(destination)) await route.continue()
  else if (!allowed.has(destination.origin)) {
    findings.push(`Blocked destination: ${destination.origin}`)
    await route.abort('blockedbyclient')
  } else await route.continue()
})
await context.tracing.start({
  screenshots: true,
  snapshots: true,
  sources: true,
})
const page = await context.newPage()
page.on('pageerror', (error) => findings.push(error.message))
let result = 'failed'
try {
  const verdict = await drive(name, {
    page,
    expect,
    origin,
    evidenceDir,
    recordingMs,
    silence,
    mediaFile,
    mediaExpect,
  })
  expect(findings).toEqual([])
  result = verdict?.result ?? 'passed'
} catch (error) {
  findings.push(error.stack ?? error.message)
  await page
    .screenshot({ path: `${evidenceDir}/${name}-failure.png`, fullPage: true })
    .catch(() => {})
  process.exitCode = 1
} finally {
  await context.tracing.stop({ path: `${evidenceDir}/${name}-trace.zip` })
  await writeFile(
    `${evidenceDir}/${name}.json`,
    JSON.stringify({ scenario: name, result, findings }, null, 2) + '\n',
  )
  await browser.close()
}
console.log(`${name}: ${result}`)
