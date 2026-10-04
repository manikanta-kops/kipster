// Standalone browser checks. No Core or database is required.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer, preview } from 'vite'
import { webkit, expect } from '@playwright/test'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'kipster-ui-publication-'))
let server, browser, demo
try {
  server = await createServer({
    root,
    server: { host: '127.0.0.1', port: 4199, strictPort: true },
  })
  await server.listen()
  browser = await webkit.launch()
  const page = await browser.newPage()
  const saves = []
  let outcome = 'unknown'
  let canonical = { adapterId: 'fixture', modelId: 'old', effort: 'low' }
  const record = () => ({
    target: 'organization',
    id: 'org',
    revision: 2,
    settings: canonical,
  })
  await page.route('**/test-core/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(
      '/test-core',
      '',
    )
    if (route.request().method() === 'PUT') {
      saves.push(route.request().postDataJSON())
      if (outcome === 'unknown') return route.abort('failed')
      if (outcome === 'rejected')
        return route.fulfill({
          status: 400,
          json: { code: 'invalid', message: 'Invalid settings' },
        })
      const body = saves.at(-1)
      for (const [field, patch] of Object.entries(body.settings)) {
        if ('set' in patch) canonical[field] = patch.set
        else delete canonical[field]
      }
      return route.fulfill({
        json: {
          version: 1,
          operationId: body.operationId,
          alreadyApplied: true,
          settings: record(),
        },
      })
    }
    const data = {
      '/v1/settings': {
        cursor: 'cursor',
        organizations: [record()],
        agents: [],
      },
      '/v1/execution-adapters': {
        cursor: 'cursor',
        revision: 1,
        adapters: [
          {
            id: 'fixture',
            version: '1',
            available: true,
            reason: null,
            models: [
              { id: 'old', efforts: ['low', 'high'] },
              { id: 'new', efforts: ['low', 'high'] },
            ],
            defaultModel: null,
            supportedOptions: [],
            capabilities: null,
          },
        ],
      },
      '/v1/settings/learning': {
        enabled: false,
        sleepTime: '03:00',
        revision: 1,
        available: true,
        agents: [],
      },
      '/v1/directory': {
        organizations: [{ id: 'org', name: 'Garden', lifecycle: 'active' }],
        agents: [],
        memberships: [],
      },
      '/v1/organizations/org/instructions': {
        organizationId: 'org',
        content: '',
      },
    }[path]
    if (data) return route.fulfill({ json: { version: 1, ...data } })
    if (path === '/v1/app/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: ': heartbeat\n\n',
      })
    throw new Error(`Unexpected route: ${path}`)
  })
  const open = async () => {
    await page
      .getByRole('button', { name: 'Open settings', exact: true })
      .click()
    await page
      .getByRole('button', { name: 'Organization', exact: true })
      .click()
    await expect(
      page.getByRole('combobox', { name: 'Model', exact: true }),
    ).toBeVisible()
  }
  await page.goto('http://127.0.0.1:4199/tests/settings-recovery.html')
  await open()
  await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('new')
  // Effort is a segmented control; Default clears the saved level.
  await page
    .getByRole('radiogroup', { name: 'Effort', exact: true })
    .locator('label')
    .filter({ hasText: /^Default$/ })
    .click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toBeVisible()
  assert.equal(saves.length, 1)
  const original = structuredClone(saves[0])
  assert.deepEqual(original.settings, {
    modelId: { set: 'new' },
    effort: { clear: true },
  })
  await page
    .getByRole('button', { name: 'Close settings', exact: true })
    .click()
  canonical = { adapterId: 'fixture', modelId: 'old', effort: 'high' }
  await open()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toBeVisible()
  assert.equal(saves.length, 1, 'reopening does not replay')
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toHaveValue('new')
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect.poll(() => saves.length).toBe(2)
  assert.deepEqual(saves[1], original)
  await page.reload()
  await open()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toBeVisible()
  assert.equal(saves.length, 2, 'reload does not replay')
  // A different caller cannot see or dispatch this saved request.
  await page.goto(
    'http://127.0.0.1:4199/tests/settings-recovery.html?caller=another',
  )
  await open()
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toHaveCount(0)
  await page.goto('http://127.0.0.1:4199/tests/settings-recovery.html')
  await open()
  outcome = 'accepted'
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  assert.deepEqual(saves[2], original)
  await page.reload()
  await open()
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toHaveCount(0)
  console.log(
    'PASS: settings retain exact save ID and set/clear payload across close/reopen and reload; scoped recovery never auto-replays; acknowledgement clears journal',
  )
  outcome = 'rejected'
  await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('old')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Invalid settings')
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toBeEnabled()
  await page.reload()
  await open()
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }),
  ).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Retry save', exact: true }),
  ).toHaveCount(0)
  console.log('PASS: definite settings rejection releases the saved request')
  // A local journal failure must block the network write entirely.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'pending')
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return original.apply(this, args)
    }
  })
  const beforeStorageFailure = saves.length
  await page
    .getByRole('combobox', { name: 'Model', exact: true })
    .selectOption('old')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Nothing was sent')
  assert.equal(saves.length, beforeStorageFailure)
  console.log('PASS: failed settings journal write blocks dispatch')
  await page.close()
  await server.close()
  server = undefined
  for (const mode of ['demo']) {
    const outDir = join(temporary, mode)
    await build({
      root,
      mode,
      build: { outDir, emptyOutDir: true },
      logLevel: 'warn',
    })
    demo = await preview({
      root,
      build: { outDir },
      preview: { host: '127.0.0.1', port: 4199, strictPort: true },
    })
    const demoPage = await browser.newPage()
    await demoPage.addInitScript(() =>
      localStorage.setItem('kipster-backend-url', 'http://127.0.0.1:9'),
    )
    const realRequests = []
    demoPage.on('request', (request) => {
      if (request.url().startsWith('http://127.0.0.1:9/'))
        realRequests.push(request.url())
    })
    await demoPage.goto('http://127.0.0.1:4199')
    await expect(
      demoPage.getByRole('textbox', { name: 'Start a new thread' }),
    ).toBeVisible()
    assert.deepEqual(realRequests, [])
    console.log(
      `PASS: production demo ${mode} ignores the saved real Core connection and renders fake Core data without calling it`,
    )
    await demoPage.close()
    await new Promise((resolve, reject) =>
      demo.httpServer.close((error) => (error ? reject(error) : resolve())),
    )
    demo = undefined
  }
} finally {
  await browser?.close()
  await server?.close()
  if (demo) await new Promise((resolve) => demo.httpServer.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
