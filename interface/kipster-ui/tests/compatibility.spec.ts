import { test, expect, startDemo, demo } from './demo.ts'
import type { Page } from '@playwright/test'
import { protocolRange } from '@kipster/core/protocol'
import { compatibility } from '../src/data/compatibility.ts'
import pkg from '../package.json' with { type: 'json' }

const app = protocolRange.current
const appVersion = pkg.version
const composer = (page: Page) =>
  page.getByRole('textbox', { name: 'Start a new thread' })
const release = (page: Page, oldest: number, current: number) =>
  demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: { oldest, current },
  })

test('the app blocks only outside the backend protocol range', () => {
  expect(compatibility({ oldest: app, current: app })).toBe('compatible')
  expect(compatibility({ oldest: app - 1, current: app + 1 })).toBe(
    'compatible',
  )
  expect(compatibility({ oldest: app + 1, current: app + 2 })).toBe(
    'update-app',
  )
  expect(compatibility({ oldest: app - 1, current: app - 1 })).toBe(
    'update-backend',
  )
})

test('a backend that still serves this protocol opens normally and shows both versions', async ({
  page,
}) => {
  await startDemo(page)
  await release(page, app, app + 1)
  await page.reload()
  await expect(composer(page)).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'About' }).click()
  const versions = page.getByRole('definition')
  await expect(page.getByLabel('Versions')).toContainText(
    `Kipster app${appVersion}`,
  )
  await expect(page.getByLabel('Versions')).toContainText('Backend0.7.0')
  await expect(versions.last()).toHaveText(
    `App ${app} · backend ${app}–${app + 1}`,
  )
})

test('an app older than the backend asks for an app update and recovers on check', async ({
  page,
}) => {
  await startDemo(page)
  await release(page, app + 1, app + 2)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the app' }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(
    'Kipster on this computer is older than the backend',
  )
  await expect(page.getByText(`${appVersion} · protocol ${app}`)).toBeVisible()
  await expect(
    page.getByText(`0.7.0 · protocol ${app + 1}–${app + 2}`),
  ).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Update backend' }),
  ).toHaveCount(0)

  await release(page, app, app)
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(composer(page)).toBeVisible()
})

test('a backend older than the app asks for a backend update', async ({
  page,
}) => {
  await startDemo(page)
  await release(page, app - 1, app - 1)
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the backend' }),
  ).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(
    'The backend is older than Kipster on this computer',
  )
  await expect(page.getByText(`0.7.0 · protocol ${app - 1}`)).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(
    page.getByRole('heading', { name: 'Update the backend' }),
  ).toBeVisible()
})

test('a backend updated while the app is open blocks on reconnect', async ({
  page,
}) => {
  await startDemo(page)
  await expect(composer(page)).toBeVisible()
  await release(page, app + 1, app + 1)
  await demo(page, '/connection', { offline: true })
  await demo(page, '/connection', { offline: false })
  await expect(
    page.getByRole('heading', { name: 'Update the app' }),
  ).toBeVisible()
  await expect(composer(page)).toHaveCount(0)
})

test('a bootstrap without a valid protocol range is an invalid response, not an old backend', async ({
  page,
}) => {
  for (const protocol of [
    undefined,
    { current: 1 },
    { current: 1, oldest: 2 },
  ]) {
    await page.route('**/__test-core/*/v1/bootstrap', async (route) => {
      const body = await (await route.fetch()).json()
      await route.fulfill({ json: { ...body, protocol } })
    })
    await startDemo(page)
    await expect(
      page.getByRole('heading', { name: 'Workspace unavailable' }),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toContainText(
      'Backend response is incompatible',
    )
    await expect(
      page.getByRole('heading', { name: /^Update the/ }),
    ).toHaveCount(0)
    await page.unrouteAll()
  }
})
