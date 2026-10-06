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
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
})
const findings = []
await context.route('**/*', async (route) => {
  const destination = new URL(route.request().url())
  if (destination.origin !== origin) {
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
  await drive(name, { page, expect, origin, evidenceDir })
  expect(findings).toEqual([])
  result = 'passed'
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
