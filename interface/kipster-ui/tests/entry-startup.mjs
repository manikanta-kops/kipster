import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer, preview } from 'vite'
import { chromium, webkit, expect } from '@playwright/test'
import { createFakeCore } from '../src/fake-core/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'kipster-entry-'))
const other = 'https://other.kipster.invalid'
const saved = 'https://saved.kipster.invalid'
const demo = 'https://demo.kipster.invalid'
const key = 'kipster-backend-url'
const local = 'http://127.0.0.1:43120'
const browsers = []
let checks = 0
async function assets(directory) {
  let result = ''
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    result += entry.isDirectory()
      ? await assets(path)
      : await readFile(path, 'utf8')
  }
  return result
}
async function exercise(browser, origin, test) {
  const context = await browser.newContext()
  const core = createFakeCore({ autoAdvance: false })
  const requests = []
  try {
    await context.addInitScript(
      ({ key, value }) => {
        if (!sessionStorage.getItem('entry-seeded')) {
          if (value !== null) localStorage.setItem(key, value)
          sessionStorage.setItem('entry-seeded', 'true')
        }
      },
      { key, value: test.saved ?? null },
    )
    await context.route(
      /^(https:\/\/[^/]+\.kipster\.invalid|http:\/\/127\.0\.0\.1:43120)\//,
      async (route) => {
        const request = route.request()
        requests.push(request.url())
        if (new URL(request.url()).origin === local && !test.local)
          return route.abort('connectionrefused')
        if (new URL(request.url()).origin === demo) return route.abort()
        if (new URL(request.url()).pathname.endsWith('/events')) {
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: '',
          })
        }
        const response = await core.handle(
          new Request(
            demo +
              new URL(request.url()).pathname +
              new URL(request.url()).search,
            {
              method: request.method(),
              headers: request.headers(),
              ...(request.postData() ? { body: request.postData() } : {}),
            },
          ),
        )
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        })
      },
    )
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(origin)
    if (test.setup) {
      await expect(
        page.getByRole('heading', { name: 'Connect to Kipster' }),
      ).toBeVisible()
      if (test.invalid) assert.deepEqual(requests, [])
      else {
        assert.ok(requests.length > 0)
        assert.ok(requests.every((url) => url === local + '/v1/bootstrap'))
        await expect(page.getByLabel('Backend address')).toHaveValue(local)
      }
      const initialRequests = [...requests]
      if (test.invalid) await expect(page.getByRole('alert')).toBeVisible()
      if (test.connect) {
        await page.getByLabel('Backend address').fill('http://example.com')
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.getByRole('alert')).toBeVisible()
        assert.deepEqual(requests, initialRequests)
        await page.getByLabel('Backend address').fill(saved)
        await page.getByRole('button', { name: 'Connect', exact: true }).click()
        await expect(page.locator('.app-shell')).toBeVisible()
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), key),
          saved,
        )
        await page.reload()
        await expect(page.locator('.app-shell')).toBeVisible()
      }
    } else {
      await expect(page.locator('.app-shell')).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Settings', exact: true }),
      ).toBeVisible()
      if (test.demo) {
        const status = await page.evaluate(
          async (demo) => (await fetch(demo + '/__demo/inspect')).status,
          demo,
        )
        assert.equal(status, 200)
        assert.deepEqual(
          requests,
          [],
          'embedded demo must not make real network requests',
        )
        await page.reload()
        await expect(page.locator('.app-shell')).toBeVisible()
        assert.deepEqual(requests, [], 'reload remains isolated')
      } else {
        assert.ok(
          requests.some((url) => url === test.endpoint + '/v1/bootstrap'),
        )
        assert.ok(
          requests.every((url) => new URL(url).origin === test.endpoint),
          requests.join('\n'),
        )
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(
        page.getByRole('button', { name: 'Manage workspace', exact: true }),
      ).toBeVisible()
      if (test.demo) {
        await expect(
          page.getByRole('button', { name: 'Change connection', exact: true }),
        ).toHaveCount(0)
      } else {
        await page
          .getByRole('button', { name: 'Change connection', exact: true })
          .click()
        await expect(page.getByLabel('Backend address')).toHaveValue(
          test.endpoint,
        )
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(page.locator('.app-shell')).toBeVisible()
      }
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), key),
        test.saved ?? (test.local ? local : null),
      )
      if (!test.demo) {
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click()
        await page
          .getByRole('button', { name: 'Change connection', exact: true })
          .click()
        await page.getByLabel('Backend address').fill(other)
        await Promise.all([
          page.waitForEvent('load'),
          page.getByRole('button', { name: 'Connect', exact: true }).click(),
        ])
        await expect(page.locator('.app-shell')).toBeVisible()
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), key),
          other,
        )
        assert.ok(requests.some((url) => url === other + '/v1/bootstrap'))
      }
    }
    assert.deepEqual(
      pageErrors,
      [],
      'startup must not raise uncaught page errors',
    )
    checks++
  } finally {
    await context.close()
    core.dispose()
  }
}
try {
  browsers.push([
    'chrome',
    await chromium.launch({ channel: 'chrome', headless: true }),
  ])
  browsers.push(['webkit', await webkit.launch({ headless: true })])
  for (const variant of [
    {
      name: 'production',
      tests: [
        { setup: true, connect: true },
        { endpoint: local, local: true },
        { saved, endpoint: saved },
        { saved: 'invalid', setup: true, invalid: true },
        { saved: 'http://[', setup: true, invalid: true },
        { saved: 'ftp://example.test', setup: true, invalid: true },
      ],
    },
    {
      name: 'browser-demo',
      mode: 'demo',
      tests: [
        { saved, endpoint: demo, demo: true },
        { endpoint: demo, demo: true },
      ],
    },
    {
      name: 'default-dev',
      dev: true,
      tests: [
        { setup: true, connect: true },
        { endpoint: local, local: true },
        { saved, endpoint: saved },
      ],
    },
    {
      name: 'dev-demo',
      dev: true,
      mode: 'demo',
      tests: [{ saved, endpoint: demo, demo: true }],
    },
  ]) {
    const outDir = join(scratch, variant.name)
    const config = {
      root,
      mode: variant.mode ?? (variant.dev ? 'development' : 'production'),
      logLevel: 'warn',
      build: { outDir, emptyOutDir: true },
      server: { port: 0 },
      preview: { port: 0 },
    }
    let server
    try {
      if (variant.dev) {
        server = await createServer(config)
        await server.listen()
      } else {
        await build(config)
        const output = await assets(outDir)
        for (const marker of [
          '/__test-core/',
          'kipsterTest',
          'notificationTest',
        ])
          assert.equal(
            output.includes(marker),
            false,
            `${variant.name} includes test harness ${marker}`,
          )
        if (!variant.mode) {
          for (const marker of [
            '/__demo/',
            'Demo Core is stopped',
            '/__fixtures/',
          ]) {
            assert.equal(
              output.includes(marker),
              false,
              `${variant.name} includes ${marker}`,
            )
          }
          console.log(
            `PASS ${variant.name}: fake payload and controls excluded`,
          )
        }
        server = await preview(config)
      }
      const origin = server.resolvedUrls.local[0]
      for (const [name, browser] of browsers) {
        for (const test of variant.tests) await exercise(browser, origin, test)
        console.log(
          `PASS ${variant.name}: ${name} (${variant.tests.length} scenarios)`,
        )
      }
    } finally {
      if (server) {
        if (variant.dev) await server.close()
        else
          await new Promise((resolve, reject) =>
            server.httpServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          )
      }
    }
  }
  const desktop = JSON.parse(
    await readFile(join(root, 'src-tauri/tauri.demo.conf.json'), 'utf8'),
  )
  assert.equal(desktop.productName, 'Kipster Demo')
  assert.equal(desktop.identifier, 'app.kipster.demo')
  assert.match(desktop.build.beforeBuildCommand, /build:desktop-demo/)
  console.log(
    `PASS ${checks} entry scenarios; desktop demo identity and build command`,
  )
} finally {
  for (const [, browser] of browsers) await browser.close()
  await rm(scratch, { recursive: true, force: true })
}
