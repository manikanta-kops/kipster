import type { Page } from '@playwright/test'
import { test, expect, startDemo, demo } from './demo.ts'

type SignIn = { id: string; plugin: string; returnAddress?: string }
const signIns = async (page: Page) =>
  ((await demo(page, '/plugins')) as { signIns: SignIn[] }).signIns
const lastSignIn = async (page: Page, plugin: string) =>
  (await signIns(page)).filter((s) => s.plugin === plugin).at(-1)!

/** The provider's page opens in a new tab; serve its return to Core from the test Core session. */
async function serveSignInPages(page: Page) {
  await page
    .context()
    .route(
      /^https:\/\/[\w-]+\.demo\.kipster\.invalid\/plugins\/callback/,
      async (route) => {
        const url = new URL(route.request().url())
        const session = url.hostname.split('.')[0]
        const response = await route.fetch({
          url: `${new URL(page.url()).origin}/__test-core/${session}${url.pathname}${url.search}`,
        })
        await route.fulfill({ response })
      },
    )
}
async function refuseSignInPages(page: Page) {
  await page
    .context()
    .route(/^https:\/\/[\w-]+\.demo\.kipster\.invalid\//, (route) =>
      route.abort(),
    )
}
const settings = (page: Page) =>
  page.getByRole('dialog', { name: 'Settings', exact: true })
async function openPlugins(page: Page) {
  await page
    .getByRole('complementary', { name: 'Workspace' })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click()
  await expect(
    settings(page).getByRole('heading', { name: 'Plugins', exact: true }),
  ).toBeVisible()
}
async function openPlugin(page: Page, name: string) {
  await settings(page)
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
  await expect(
    settings(page).getByRole('heading', { name, exact: true }),
  ).toBeVisible()
}
const accounts = (page: Page) =>
  settings(page).getByRole('region', { name: 'Accounts' })

test('the Plugins screen lists the catalogue by category and searches it', async ({
  page,
}) => {
  await startDemo(page)
  await openPlugins(page)
  const sheet = settings(page)
  const management = sheet.getByRole('region', { name: 'Project management' })
  await expect(
    management.getByRole('button', { name: /^Linear/ }),
  ).toContainText('Available')
  await expect(management.getByRole('button', { name: /^Jira/ })).toContainText(
    'Jira changed how it signs people in',
  )
  await expect(management.getByRole('button', { name: /^Jira/ })).toContainText(
    'Unavailable',
  )
  await expect(
    sheet.getByRole('region', { name: 'Documents' }).getByRole('button', {
      name: /^Notion/,
    }),
  ).toContainText('2 accounts')
  await expect(sheet.getByRole('region', { name: 'Design' })).toBeVisible()
  await expect(
    sheet.getByRole('region', { name: 'Developer tools' }),
  ).toBeVisible()

  await sheet.getByRole('searchbox', { name: 'Search plugins' }).fill('design')
  await expect(sheet.getByRole('button', { name: /^Figma/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /^Canva/ })).toBeVisible()
  await expect(sheet.getByRole('button', { name: /^Linear/ })).toHaveCount(0)
  await sheet
    .getByRole('searchbox', { name: 'Search plugins' })
    .fill('nothing like this')
  await expect(
    sheet.getByText('No plugins match “nothing like this”.'),
  ).toBeVisible()

  await sheet.getByRole('searchbox', { name: 'Search plugins' }).fill('')
  await openPlugin(page, 'Jira')
  await expect(
    sheet.getByRole('button', { name: 'Connect', exact: true }),
  ).toBeDisabled()
})

test('a connected plugin that becomes unavailable still shows its accounts', async ({
  page,
}) => {
  await page.route('**/__test-core/*/v1/plugins', async (route) => {
    const response = await route.fetch()
    const list = (await response.json()) as {
      plugins: { id: string; available: boolean; unavailableReason?: string }[]
    }
    const notion = list.plugins.find((p) => p.id === 'notion')!
    notion.available = false
    notion.unavailableReason = 'Notion is down for maintenance.'
    await route.fulfill({ response, json: list })
  })
  await startDemo(page)
  await openPlugins(page)
  const notion = settings(page).getByRole('button', { name: /^Notion/ })
  await expect(notion).toContainText('Notion is down for maintenance.')
  await expect(notion).toContainText('Unavailable · 2 accounts')
})

test('a person connects an account, adds a second, renames it, makes it the default and disconnects the first', async ({
  page,
}) => {
  const session = await startDemo(page)
  await serveSignInPages(page)
  await openPlugins(page)
  await openPlugin(page, 'Linear')
  const sheet = settings(page)

  const firstTab = page.waitForEvent('popup')
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click()
  const tab = await firstTab
  await expect(tab.getByRole('heading', { name: 'Connected' })).toBeVisible()
  await tab.close()
  await expect(sheet.getByText('Connected Linear.')).toBeVisible()
  expect((await lastSignIn(page, 'linear')).returnAddress).toBe(
    `https://${session}.demo.kipster.invalid/plugins/callback`,
  )
  const first = accounts(page)
    .locator('.set-row', { hasText: /^Linear/ })
    .first()
  await expect(first).toContainText('Default')
  await expect(first).toContainText('Working')

  const secondTab = page.waitForEvent('popup')
  await sheet.getByRole('button', { name: 'Add another account…' }).click()
  await (await secondTab).close()
  await expect(sheet.getByText('Connected Linear 2.')).toBeVisible()

  await sheet.getByRole('button', { name: 'Rename Linear 2' }).click()
  const name = sheet.getByRole('textbox', { name: 'New name for Linear 2' })
  await name.fill('linear')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet.getByRole('alert')).toContainText(
    'another account is named “linear”',
  )
  await name.fill('Side project')
  await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(sheet.getByText('Account renamed')).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: 'Rename Side project' }),
  ).toBeVisible()

  await sheet
    .getByRole('button', { name: 'Make Side project the default' })
    .click()
  await expect(sheet.getByText('Default account changed')).toBeVisible()
  await expect(
    accounts(page).locator('.set-row', { hasText: 'Side project' }),
  ).toContainText('Default')
  await expect(
    sheet.getByRole('button', { name: 'Make Linear the default' }),
  ).toBeVisible()

  await sheet
    .getByRole('button', { name: 'Disconnect Linear', exact: true })
    .click()
  const confirm = page.getByRole('alertdialog', { name: 'Disconnect Linear?' })
  await expect(confirm).toContainText(
    'Kips can no longer use this Linear account',
  )
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(
    sheet.getByRole('button', { name: 'Rename Linear' }),
  ).toBeVisible()
  await sheet
    .getByRole('button', { name: 'Disconnect Linear', exact: true })
    .click()
  await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(sheet.getByText('Account disconnected')).toBeVisible()
  await expect(
    sheet.getByRole('button', { name: 'Rename Linear' }),
  ).toHaveCount(0)
  await expect(
    accounts(page).locator('.set-row', { hasText: 'Side project' }),
  ).toContainText('Default')

  await sheet.getByRole('button', { name: 'Back to Plugins' }).click()
  await expect(sheet.getByRole('button', { name: /^Linear/ })).toContainText(
    '1 account',
  )
})

test('sign-in explains loopback-only, denied, metadata documents and reconnects, and asks for an address', async ({
  page,
}) => {
  await startDemo(page)
  await refuseSignInPages(page)
  await openPlugins(page)
  const sheet = settings(page)
  const back = () =>
    sheet.getByRole('button', { name: 'Back to Plugins' }).click()

  await openPlugin(page, 'Figma')
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(sheet.getByRole('alert')).toContainText(
    'only connects from the computer running Kipster',
  )
  await back()

  await openPlugin(page, 'Canva')
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(sheet.getByRole('alert')).toContainText(
    'client metadata document',
  )
  await back()

  await openPlugin(page, 'Linear')
  const denyTab = page.waitForEvent('popup')
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click()
  await (await denyTab).close()
  await expect(
    sheet.getByText('Finish signing in to Linear in the new tab.'),
  ).toBeVisible()
  await expect(
    sheet.getByRole('link', { name: 'Open sign-in page' }),
  ).toHaveAttribute('href', /\/plugins\/callback\?state=/)
  await demo(page, '/plugins', {
    signIn: (await lastSignIn(page, 'linear')).id,
    outcome: 'deny',
  })
  await expect(sheet.getByRole('alert')).toContainText('Sign-in was denied')
  await expect(
    sheet.getByRole('button', { name: 'Connect', exact: true }),
  ).toBeEnabled()
  await back()

  await openPlugin(page, 'Notion')
  await expect(
    accounts(page).locator('.set-row', { hasText: 'Personal' }),
  ).toContainText('Reconnect needed')
  const reconnectTab = page.waitForEvent('popup')
  await sheet.getByRole('button', { name: 'Reconnect Personal' }).click()
  await (await reconnectTab).close()
  await demo(page, '/plugins', {
    signIn: (await lastSignIn(page, 'notion')).id,
    outcome: 'complete',
  })
  await expect(
    sheet.getByText(
      'Reconnected Personal. This account was already connected.',
    ),
  ).toBeVisible()
  await expect(
    accounts(page).locator('.set-row', { hasText: 'Personal' }),
  ).toContainText('Working')
  await expect(
    sheet.getByRole('button', { name: 'Reconnect Personal' }),
  ).toHaveCount(0)
  await back()

  await openPlugin(page, 'Sentry')
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click()
  const address = sheet.getByRole('textbox', {
    name: 'Your Sentry address, such as https://acme.sentry.io',
  })
  await address.fill('acme.sentry.io')
  await sheet.getByRole('button', { name: 'Continue' }).click()
  await expect(sheet.getByRole('alert')).toContainText(
    'That address did not work',
  )
  const addressTab = page.waitForEvent('popup')
  await address.fill('https://acme.sentry.io')
  await sheet.getByRole('button', { name: 'Continue' }).click()
  await (await addressTab).close()
  await demo(page, '/plugins', {
    signIn: (await lastSignIn(page, 'sentry')).id,
    outcome: 'complete',
  })
  await expect(sheet.getByText('Connected acme.sentry.io.')).toBeVisible()
})

test('an expired sign-in says so', async ({ page }) => {
  await startDemo(page)
  await refuseSignInPages(page)
  await openPlugins(page)
  await openPlugin(page, 'Linear')
  const tab = page.waitForEvent('popup')
  await settings(page)
    .getByRole('button', { name: 'Connect', exact: true })
    .click()
  await (await tab).close()
  await demo(page, '/plugins', {
    signIn: (await lastSignIn(page, 'linear')).id,
    outcome: 'expire',
  })
  await expect(settings(page).getByRole('alert')).toContainText('expired')
})

test('without plugins from Core there is no Plugins entry', async ({
  page,
}) => {
  const session = await startDemo(page)
  await expect(
    page
      .getByRole('complementary', { name: 'Workspace' })
      .getByRole('button', { name: 'Plugins', exact: true }),
  ).toBeVisible()
  await demo(page, '/plugins', { enabled: false })
  await startDemo(page, { session })
  const sidebar = page.getByRole('complementary', { name: 'Workspace' })
  await expect(
    sidebar.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible()
  await expect(
    sidebar.getByRole('button', { name: 'Plugins', exact: true }),
  ).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(
    settings(page).getByRole('button', { name: 'Adapters', exact: true }),
  ).toBeVisible()
  await expect(
    settings(page).getByRole('button', { name: 'Plugins', exact: true }),
  ).toHaveCount(0)
})
