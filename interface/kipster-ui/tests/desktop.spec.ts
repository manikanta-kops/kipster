import { startDemo } from './demo.ts'
import { managementDialog, openManagement } from './management-helpers.ts'
import { expect, test } from '@playwright/test'
import { backendURL } from '../src/data/backend-connection.js'

test('connection addresses reject credentials, remote plaintext and ambiguous scopes', () => {
  expect(backendURL('https://garden.example/')).toBe('https://garden.example')
  expect(backendURL('http://127.0.0.1:43128')).toBe('http://127.0.0.1:43128')
  for (const value of [
    'http://garden.example',
    'https://u:p@garden.example',
    'https://garden.example/path',
    'https://garden.example?secret=x',
    'file:///tmp/a',
    'https://garden.example/#a',
  ])
    expect(() => backendURL(value)).toThrow()
})

test('connection setup persists and changing destination replaces the unavailable workspace', async ({
  page,
}) => {
  const requests: string[] = []
  await page.route('http://127.0.0.1:4312*/**', async (route) => {
    requests.push(route.request().url())
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 1,
        code: 'unavailable',
        message: 'Disposable backend unavailable',
      }),
    })
  })
  await page.goto('/tests/desktop.html')
  await page.getByLabel('Backend address').fill('http://127.0.0.1:43128')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Disposable backend unavailable')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Disposable backend unavailable')).toBeVisible()
  await page.getByRole('button', { name: 'Change connection' }).click()
  const previous = requests.filter((url) => url.includes(':43128/')).length
  await page.getByLabel('Backend address').fill('http://127.0.0.1:43129')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Disposable backend unavailable')).toBeVisible()
  expect(requests.filter((url) => url.includes(':43128/'))).toHaveLength(
    previous,
  )
  expect(requests.some((url) => url.includes(':43129/v1/bootstrap'))).toBe(true)
  expect(
    await page.evaluate(() => localStorage.getItem('kipster-backend-url')),
  ).toBe('http://127.0.0.1:43129')
})

test('identity restore uses the current hash, shows conflicts and archived read-only state', async ({
  page,
}) => {
  let archived = false
  let version = 1
  const posts: unknown[] = []
  let reads = 0
  let streams = 0
  await page.route('http://127.0.0.1:43128/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    let data: unknown = { version: 1 }
    let status = 200
    if (path.endsWith('/events')) {
      streams++
      status = 500
    } else if (path === '/v1/settings') {
      reads++
      data = { version: 1, cursor: 'cursor', agents: [], organizations: [] }
    } else if (path === '/v1/execution-adapters')
      data = { version: 1, cursor: 'cursor', revision: 1, adapters: [] }
    else if (path === '/v1/settings/learning')
      data = {
        version: 1,
        available: false,
        enabled: false,
        sleepTime: '01:00',
        revision: 1,
        agents: [],
      }
    else if (path === '/v1/directory')
      data = {
        version: 1,
        organizations: [{ id: 'org', name: 'Garden', lifecycle: 'active' }],
        agents: [
          {
            id: 'agent',
            name: 'Scout',
            lifecycle: archived ? 'archived' : 'active',
            admin: false,
          },
        ],
        memberships: [],
      }
    else if (path.endsWith('/restore')) {
      posts.push(request.postDataJSON())
      status = version === 1 ? 409 : 200
    } else if (path.endsWith('/backups'))
      data = {
        version: 1,
        agentId: 'agent',
        file: 'identity.md',
        backups: [
          {
            id: 'backup',
            sha256: 'old',
            size: 5,
            createdAt: '2026-09-28T00:00:00.000Z',
          },
        ],
      }
    else
      data = {
        version: 1,
        agentId: 'agent',
        file: 'identity.md',
        content: path.includes('/backups/')
          ? 'Previous identity'
          : 'Current identity',
        sha256: 'current-' + version,
      }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(data),
    })
  })
  await page.goto('/tests/desktop.html?settings')
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page
    .getByRole('button', { name: 'Identity files', exact: true })
    .click()
  await expect(
    page.getByText('Current identity', { exact: true }),
  ).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Backups', exact: true })
    .selectOption('backup')
  await expect(
    page.getByText('Previous identity', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Restore this backup' }).click()
  await expect(
    page.getByText('The file changed. Refresh it before restoring a backup.'),
  ).toBeVisible()
  expect(posts).toEqual([{ version: 1, expectedSha256: 'current-1' }])
  version = 2
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/identity/identity.md') &&
        response.request().method() === 'GET',
    ),
    page.getByRole('button', { name: 'Refresh files' }).click(),
  ])
  await page.getByRole('button', { name: 'Restore this backup' }).click()
  await expect
    .poll(() => posts.at(-1))
    .toEqual({ version: 1, expectedSha256: 'current-2' })
  await expect(page.getByText('Backup restored.')).toBeVisible()
  expect(streams).toBe(0)
  const beforeReconnect = reads
  await page
    .getByRole('button', { name: 'Reconnected', exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect.poll(() => reads).toBeGreaterThan(beforeReconnect)
  const before = reads
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: 'Changed', exact: true }).click()
  expect(reads).toBe(before)
  archived = true
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page
    .getByRole('button', { name: 'Identity files', exact: true })
    .click()
  await expect(
    page.getByText('Archived identities are read-only.'),
  ).toBeVisible()
  await page
    .getByRole('combobox', { name: 'Backups', exact: true })
    .selectOption('backup')
  await expect(
    page.getByText('Previous identity', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Restore this backup' }),
  ).toHaveCount(0)
  expect(streams).toBe(0)
})

test('history keeps a selected reading slice stable during arrivals and reaches page boundaries', async ({
  page,
}) => {
  await page.goto('/tests/desktop.html?history')
  const rows = page.getByTestId('history-message')
  await expect(rows).toHaveCount(100)
  await expect(rows.first()).toHaveText('Message 151')
  await page.getByRole('button', { name: 'Stream tail' }).click()
  await expect(rows.last()).toHaveText('Message 250 streamed')
  await page.locator('.thread-scroll').evaluate((element) => {
    element.scrollTop = 300
    element.dispatchEvent(new Event('scroll'))
  })
  await rows.first().evaluate((element) => {
    const selection = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(element)
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page
    .getByRole('button', { name: 'Append message' })
    .evaluate((element) => (element as HTMLButtonElement).click())
  await expect(rows.first()).toHaveText('Message 151')
  await expect(rows.last()).toHaveText('Message 250 streamed')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'Message 151',
  )
  await expect(
    page.getByRole('button', { name: 'Latest messages' }),
  ).toBeVisible()
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.getByRole('button', { name: 'Older messages' }).click()
  await expect(rows.first()).toHaveText('Message 51')
  await page.getByRole('button', { name: 'Older messages' }).click()
  await expect(rows.first()).toHaveText('Message 1')
  await expect(
    page.getByRole('button', { name: 'Older messages' }),
  ).toBeDisabled()
  await page.getByRole('button', { name: 'Newer messages' }).click()
  await expect(rows.first()).toHaveText('Message 101')
  await page.getByRole('button', { name: 'Latest messages' }).click()
  await expect(rows.last()).toHaveText('Message 251')
  await expect(rows.first()).toHaveText('Message 152')
  await page.getByRole('button', { name: 'Append message' }).click()
  await expect(rows.last()).toHaveText('Message 252')
  await expect(rows).toHaveCount(100)
})

test('management Shift+Tab from dialog itself lands on the last visible control', async ({
  page,
}) => {
  await startDemo(page)
  await openManagement(page)
  const dialog = managementDialog(page)
  await dialog.focus()
  await page.keyboard.press('Shift+Tab')
  expect(
    await dialog.evaluate((element) => {
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ),
      ].filter((control) => control.getClientRects().length)
      return document.activeElement === controls.at(-1)
    }),
  ).toBe(true)
})
