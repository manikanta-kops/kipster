import { test, expect, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'

async function core(page: Page, path: string, body?: unknown) {
  const session = new URL(page.url()).searchParams.get('testCore')
  const response = await page.request.fetch(
    `/__test-core/${session}${path}`,
    body === undefined ? {} : { method: 'PUT', data: body },
  )
  expect(response.ok()).toBeTruthy()
  return response.json()
}
async function openPermissions(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Permissions', exact: true }).click()
}
const mode = (page: Page, name: string) =>
  page.getByRole('radio', { name, exact: true })

test('the permission picker offers four modes, starts on Auto and saves the choice in Core', async ({
  page,
}) => {
  await startDemo(page)
  await openPermissions(page)
  for (const [label, description] of [
    ['Supervised', 'Ask before commands and file changes.'],
    ['Auto-accept edits', 'Auto-approve edits, ask before other actions.'],
    ['Auto', 'Supported providers approve routine actions; others still ask.'],
    ['Full access', 'Allow commands and edits without prompts.'],
  ])
    await expect(
      page.locator('.permission-option', { hasText: description }),
    ).toContainText(label)
  await expect(page.getByRole('radio')).toHaveCount(4)
  await expect(mode(page, 'Auto')).toBeChecked()
  await expect(mode(page, 'Auto')).toHaveAccessibleDescription(
    'Supported providers approve routine actions; others still ask.',
  )

  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (
      request.url().endsWith('/v1/settings/permissions') &&
      request.method() === 'PUT'
    )
      bodies.push(request.postDataJSON())
  })
  await mode(page, 'Supervised').check()
  await expect
    .poll(async () => (await core(page, '/v1/settings/permissions')).mode)
    .toBe('supervised')
  expect(bodies).toEqual([{ version: 1, mode: 'supervised' }])
  await expect(mode(page, 'Supervised')).toBeChecked()
})

test('full access needs a confirmation, and cancelling keeps the saved mode', async ({
  page,
}) => {
  await startDemo(page)
  await openPermissions(page)
  await mode(page, 'Full access').check()
  const warning = page.getByText(
    'Full access lets every kip run commands and change files without asking you.',
  )
  await expect(warning).toBeVisible()
  expect((await core(page, '/v1/settings/permissions')).mode).toBe('auto')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(warning).toHaveCount(0)
  await expect(mode(page, 'Auto')).toBeChecked()
  expect((await core(page, '/v1/settings/permissions')).mode).toBe('auto')

  await mode(page, 'Full access').check()
  await page
    .getByRole('button', { name: 'Allow full access', exact: true })
    .click()
  await expect(warning).toHaveCount(0)
  await expect(mode(page, 'Full access')).toBeChecked()
  await expect
    .poll(async () => (await core(page, '/v1/settings/permissions')).mode)
    .toBe('fullAccess')
})

test('a change made elsewhere, such as by Kip, appears in the open picker', async ({
  page,
}) => {
  await startDemo(page)
  await openPermissions(page)
  await expect(mode(page, 'Auto')).toBeChecked()
  await core(page, '/v1/settings/permissions', {
    version: 1,
    mode: 'acceptEdits',
  })
  await expect(mode(page, 'Auto-accept edits')).toBeChecked()
})

test('a Core without permission modes shows no Permissions settings', async ({
  page,
}) => {
  await page.route('**/v1/bootstrap', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    delete body.capabilities.permissionModes
    await route.fulfill({ response, json: body })
  })
  const reads: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/v1/settings/permissions'))
      reads.push(request.url())
  })
  await startDemo(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Learning', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Permissions', exact: true }),
  ).toHaveCount(0)
  expect(reads).toEqual([])
})

test('a mode this app does not know is shown as unrecognized, with nothing chosen', async ({
  page,
}) => {
  await page.route('**/v1/settings/permissions', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: { ...(await response.json()), mode: 'askNever' },
    })
  })
  await startDemo(page)
  await openPermissions(page)
  await expect(
    page.getByText(
      'Kipster uses a permission mode this app does not recognize.',
    ),
  ).toBeVisible()
  for (const radio of await page.getByRole('radio').all())
    await expect(radio).not.toBeChecked()
})

test('a failed save says so and keeps the saved mode chosen', async ({
  page,
}) => {
  await page.route('**/v1/settings/permissions', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 400,
          json: { version: 1, code: 'invalid', message: 'Refused by Core.' },
        })
      : route.continue(),
  )
  await startDemo(page)
  await openPermissions(page)
  await mode(page, 'Supervised').click()
  await expect(page.getByRole('alert')).toContainText(
    'Not saved: Refused by Core.',
  )
  await expect(mode(page, 'Auto')).toBeChecked()
})
