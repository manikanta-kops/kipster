import { test, expect, startDemo, storageFault, DEMO_IDS } from './demo.ts'
import type { Page } from '@playwright/test'
const organization = (page: Page) =>
  page.getByRole('combobox', { name: 'Organization', exact: true })
const heading = (page: Page, name = 'Atlas') =>
  page.getByRole('heading', { name, exact: true })
async function saved(page: Page, expected: Record<string, unknown>) {
  const scope = await page.evaluate(async () => {
    const origin = `https://${new URLSearchParams(location.search).get('testCore')}.demo.kipster.invalid`
    const identity = await (await fetch(origin + '/v1/bootstrap')).json()
    return JSON.stringify([origin, identity.installationId, identity.callerId])
  })
  await expect
    .poll(() =>
      page.evaluate(
        ({ scope, expected }) =>
          new Promise<boolean>((resolve, reject) => {
            const opening = indexedDB.open('kipster-client')
            opening.onerror = () => reject(opening.error)
            opening.onsuccess = () => {
              const db = opening.result
              const request = db
                .transaction('navigation')
                .objectStore('navigation')
                .get(scope)
              request.onsuccess = () => {
                resolve(
                  !!request.result &&
                    Object.entries(expected).every(
                      ([key, value]) => request.result.value[key] === value,
                    ),
                )
                db.close()
              }
              request.onerror = () => reject(request.error)
            }
          }),
        { scope, expected },
      ),
    )
    .toBe(true)
}
test('organization, agent, sidebar and group preferences restore alongside accepted history', async ({
  page,
}) => {
  await startDemo(page)
  await organization(page).selectOption(DEMO_IDS.studio)
  await page.getByRole('button', { name: 'Mira', exact: true }).first().click()
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Saved across frontend reload')
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page
      .locator('.feed-message')
      .getByText('Saved across frontend reload', { exact: true }),
  ).toBeVisible()
  await page.getByRole('tab', { name: 'Studio', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await saved(page, {
    organizationId: DEMO_IDS.studio,
    agentId: DEMO_IDS.designer,
    collapsed: true,
    segment: '00000000-0000-4000-8000-000000000042',
  })
  await page.reload()
  await expect(heading(page, 'Mira')).toBeVisible()
  await expect(organization(page)).toHaveValue(DEMO_IDS.studio)
  await expect(
    page.getByRole('button', { name: 'Expand sidebar' }),
  ).toBeVisible()
  await expect(
    page
      .locator('.feed-message')
      .getByText('Saved across frontend reload', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(
    page.getByRole('tab', { name: 'Studio', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('tab', { name: 'All', exact: true }),
  ).toHaveAttribute('aria-selected', 'false')
})
test('empty organizations and removed memberships cannot dispatch through the previous conversation', async ({
  page,
}) => {
  const session = await startDemo(page)
  await expect(heading(page)).toBeVisible()
  expect(
    (
      await page.request.post(`/__test-core/${session}/v1/organizations`, {
        data: {
          version: 1,
          operationId: crypto.randomUUID(),
          name: 'Empty workspace',
        },
      })
    ).ok(),
  ).toBe(true)
  const directory = await (
    await page.request.get(`/__test-core/${session}/v1/directory`)
  ).json()
  const empty = directory.organizations.find(
    (o: any) => o.name === 'Empty workspace',
  )
  await organization(page).selectOption(empty.id)
  await expect(heading(page, 'Kip')).toBeVisible()
  await expect(
    page.getByRole('button', {
      name: 'Open thread: Shape a calmer workspace for the next release',
      exact: true,
    }),
  ).toHaveCount(0)
  await page.reload()
  await expect(organization(page)).toHaveValue(empty.id)
  await organization(page).selectOption(DEMO_IDS.organization)
  await page.getByRole('button', { name: 'Atlas', exact: true }).first().click()
  const member = directory.memberships.find(
    (m: any) =>
      m.organizationId === DEMO_IDS.organization &&
      m.agentId === DEMO_IDS.researcher,
  )
  expect(
    (
      await page.request.delete(
        `/__test-core/${session}/v1/memberships/${member.id}`,
        { data: { version: 1, operationId: crypto.randomUUID() } },
      )
    ).ok(),
  ).toBe(true)
  await expect(page.getByText('Former members', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toHaveCount(0)
  await expect(page.getByText(/This chat is read only/)).toBeVisible()
})
test('group appearances share a chat and root-admin targeting survives organization changes', async ({
  page,
}) => {
  await startDemo(page)
  await expect(heading(page)).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Shared appearance')
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page
    .getByRole('region', { name: 'Delivery', exact: true })
    .getByRole('button', { name: 'Atlas', exact: true })
    .click()
  await expect(
    page.getByText('Shared appearance', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Kip', exact: true }).click()
  const admin = page.getByRole('textbox', { name: 'Start a new thread' })
  await admin.fill('Installation conversation')
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await admin.press('Enter')
  await page
    .getByRole('button', {
      name: 'Open thread: Installation conversation',
      exact: true,
    })
    .press('Enter')
  await organization(page).selectOption(DEMO_IDS.studio)
  await expect(
    page.getByRole('region', {
      name: 'Thread: Installation conversation',
      exact: true,
    }),
  ).toBeVisible()
  await saved(page, { agentId: DEMO_IDS.rootAgent, target: 'installation' })
  await page.reload()
  await expect(heading(page, 'Kip')).toBeVisible()
})
test('loading malformed data retry and recovery are explicit', async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let bad = true
  await page.route('**/v1/directory', async (route) => {
    await held
    if (bad) await route.fulfill({ json: { version: 1, broken: true } })
    else await route.continue()
  })
  await startDemo(page)
  await expect(page.getByText(/Connecting|Opening/).first()).toBeVisible()
  release()
  await expect(page.getByText(/invalid|incompatible/i).first()).toBeVisible()
  bad = false
  await page
    .getByRole('button', { name: /Try again|Reconnect|Retry/ })
    .first()
    .click()
  await expect(heading(page)).toBeVisible()
})
test('duplicate display names remain distinguishable and no organizations is safe', async ({
  page,
}) => {
  await page.route('**/v1/directory', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.organizations[1].name = data.organizations[0].name
    data.agents.find((a: any) => a.id === DEMO_IDS.designer).name = 'Atlas'
    await route.fulfill({ json: data })
  })
  await startDemo(page)
  await expect(
    page.getByRole('option', { name: `Kipster (${DEMO_IDS.studio})` }),
  ).toHaveCount(1)
  await expect(
    page.getByRole('button', {
      name: `Atlas (${DEMO_IDS.designer})`,
      exact: true,
    }),
  ).toBeVisible()
  await page.unroute('**/v1/directory')
  await page.route('**/v1/directory', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.organizations = []
    data.memberships = []
    data.groups = []
    await route.fulfill({ json: data })
  })
  await page.reload()
  await expect(organization(page)).toBeDisabled()
  await page.getByRole('button', { name: 'Kip', exact: true }).click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
})
test('reduced-motion keyboard segments and phone drawer preserve agent access', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await startDemo(page)
  await page.getByRole('tab', { name: 'All', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(
    page.getByRole('tab', { name: 'Research', exact: true }),
  ).toBeFocused()
  await expect(
    page.getByRole('tab', { name: 'Research', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('button', { name: 'Rowan', exact: true }),
  ).toHaveCount(0)
  expect(
    await page
      .locator('.app-shell')
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole('button', { name: 'Mira', exact: true }),
  ).toBeHidden()
  const menu = page.getByRole('button', { name: 'Show sidebar' })
  await menu.click()
  await expect(
    page.getByRole('button', { name: 'Close sidebar' }).first(),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toBeFocused()
  await menu.click()
  await page.getByRole('button', { name: 'Mira', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Mira', exact: true }),
  ).toBeHidden()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await page.screenshot({ path: info.outputPath('narrow-navigation.png') })
})
test('unavailable local storage does not block navigation', async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'indexedDB', {
      get() {
        throw new Error('Storage unavailable')
      },
    }),
  )
  await startDemo(page)
  await expect(
    page.getByText(/Saved (navigation|thread selection) is unavailable/),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Mira', exact: true }).click()
  await expect(heading(page, 'Mira')).toBeVisible()
})
test('delayed preferences never delay context changes or retarget subsequent text', async ({
  page,
}) => {
  await startDemo(page)
  await expect(heading(page)).toBeVisible()
  await storageFault(page, 'navigation-write', 'hold')
  await page
    .getByRole('button', { name: 'Collapse sidebar', exact: true })
    .evaluate((button) => {
      ;(button as HTMLButtonElement).click()
      ;(button as HTMLButtonElement).click()
    })
  await expect(
    page.getByRole('button', { name: 'Collapse sidebar' }),
  ).toBeVisible()
  await organization(page).selectOption(DEMO_IDS.studio)
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Only Design studio')
  await expect(
    page.getByRole('button', { name: 'Send message', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only Design studio', { exact: true }),
  ).toBeVisible()
  await organization(page).selectOption(DEMO_IDS.organization)
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only Design studio', { exact: true }),
  ).toHaveCount(0)
  await organization(page).selectOption(DEMO_IDS.studio)
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only Design studio', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Mira', exact: true }).first().click()
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await storageFault(page, 'navigation-write', 'allow')
  await saved(page, {
    organizationId: DEMO_IDS.studio,
    agentId: DEMO_IDS.designer,
    collapsed: true,
  })
  await page.reload()
  await expect(heading(page, 'Mira')).toBeVisible()
})
test('write rejection preserves navigation and subsequent writes recover', async ({
  page,
}) => {
  await startDemo(page)
  await expect(heading(page)).toBeVisible()
  await storageFault(page, 'navigation-write', 'fail')
  await organization(page).selectOption(DEMO_IDS.studio)
  await page.getByRole('button', { name: 'Mira', exact: true }).first().click()
  await expect(heading(page, 'Mira')).toBeVisible()
  await expect(
    page.getByText('This selection could not be saved on this device.'),
  ).toBeVisible()
  await storageFault(page, 'navigation-write', 'allow')
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await saved(page, {
    organizationId: DEMO_IDS.studio,
    agentId: DEMO_IDS.designer,
    collapsed: true,
  })
  await page.reload()
  await expect(heading(page, 'Mira')).toBeVisible()
})
test('blocked restoration does not block navigation and late preferences cannot override it', async ({
  page,
}) => {
  const session = await startDemo(page)
  await organization(page).selectOption(DEMO_IDS.studio)
  await saved(page, { organizationId: DEMO_IDS.studio })
  await startDemo(page, { session, faults: { 'navigation-read': 'hold' } })
  await expect(heading(page)).toBeVisible()
  await page.getByRole('button', { name: 'Rowan', exact: true }).click()
  await storageFault(page, 'navigation-read', 'allow')
  await expect(heading(page, 'Rowan')).toBeVisible()
  await saved(page, {
    organizationId: DEMO_IDS.organization,
    agentId: DEMO_IDS.engineer,
  })
})
test('collapsed group stacks open keyboard-accessible flyouts and the shortcut toggles the sidebar', async ({
  page,
}) => {
  await startDemo(page)
  await expect(heading(page)).toBeVisible()
  await page.keyboard.press('ControlOrMeta+\\')
  const stack = page.getByRole('button', { name: /^Research, 2 kips/ })
  await expect(stack).toHaveAttribute('aria-expanded', 'false')
  await stack.focus()
  await page.keyboard.press('Enter')
  const flyout = page.getByRole('dialog', { name: 'Research kips' })
  await expect(flyout.getByRole('button', { name: 'Atlas' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(flyout.getByRole('button', { name: 'Mira' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(stack).toBeFocused()
  await stack.click()
  await flyout.getByRole('button', { name: 'Mira' }).click()
  await expect(heading(page, 'Mira')).toBeVisible()
  await saved(page, { collapsed: true, agentId: DEMO_IDS.designer })
  await expect(flyout).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(
    page.getByRole('button', { name: 'Collapse sidebar' }),
  ).toBeVisible()
})

test('installation and caller identities namespace saved navigation', async ({
  page,
}) => {
  const session = await startDemo(page)
  await organization(page).selectOption(DEMO_IDS.studio)
  await saved(page, { organizationId: DEMO_IDS.studio })
  await page.request.post(`/__test-core/${session}/__demo/identity`, {
    data: { installationId: crypto.randomUUID() },
  })
  await page.reload()
  await expect(organization(page)).toHaveValue(DEMO_IDS.organization)
  await organization(page).selectOption(DEMO_IDS.studio)
  await saved(page, { organizationId: DEMO_IDS.studio })
  await page.request.post(`/__test-core/${session}/__demo/identity`, {
    data: { callerId: crypto.randomUUID() },
  })
  await page.reload()
  await expect(organization(page)).toHaveValue(DEMO_IDS.organization)
})
test('changing destination isolates same-identity preferences and history', async ({
  page,
}) => {
  const first = await startDemo(page)
  await organization(page).selectOption(DEMO_IDS.studio)
  await saved(page, { organizationId: DEMO_IDS.studio })
  await page
    .getByRole('textbox', { name: 'Start a new thread' })
    .fill('Only first destination owns this history')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only first destination owns this history', { exact: true }),
  ).toBeVisible()
  const second = await startDemo(page)
  expect(second).not.toBe(first)
  await expect(organization(page)).toHaveValue(DEMO_IDS.organization)
  await organization(page).selectOption(DEMO_IDS.studio)
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only first destination owns this history', { exact: true }),
  ).toHaveCount(0)
  await organization(page).selectOption(DEMO_IDS.organization)
  await page.getByRole('button', { name: 'Rowan', exact: true }).click()
  await saved(page, { agentId: DEMO_IDS.engineer })
  await startDemo(page, { session: first })
  await expect(organization(page)).toHaveValue(DEMO_IDS.studio)
  await expect(
    page
      .locator('.feed-message')
      .getByText('Only first destination owns this history', { exact: true }),
  ).toBeVisible()
  await startDemo(page, { session: second })
  await expect(heading(page, 'Rowan')).toBeVisible()
})
test('held writes stay scoped and preserve ordering across simultaneous connections', async ({
  page,
  context,
}) => {
  const first = await startDemo(page)
  await expect(heading(page)).toBeVisible()
  await storageFault(page, 'navigation-write', 'hold')
  await organization(page).selectOption(DEMO_IDS.studio)
  await page.getByRole('button', { name: 'Mira', exact: true }).first().click()
  const other = await context.newPage()
  const second = await startDemo(other)
  expect(second).not.toBe(first)
  await other.getByRole('button', { name: 'Rowan', exact: true }).click()
  await saved(other, {
    organizationId: DEMO_IDS.organization,
    agentId: DEMO_IDS.engineer,
  })
  await storageFault(page, 'navigation-write', 'allow')
  await saved(page, {
    organizationId: DEMO_IDS.studio,
    agentId: DEMO_IDS.designer,
  })
  await page.reload()
  await other.reload()
  await expect(heading(page, 'Mira')).toBeVisible()
  await expect(heading(other, 'Rowan')).toBeVisible()
})

test('cached workspace keeps draft and attachment through unavailable transport and reconnect', async ({
  page,
}) => {
  const session = await startDemo(page)
  await expect(heading(page)).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Start a new thread' })
  await input.fill('Retain through offline recovery')
  await page.locator('input[type=file]').setInputFiles({
    name: 'retained.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('retained original bytes'),
  })
  await expect(page.locator('.pending-media')).toContainText('Uploaded')
  await page.request.post(`/__test-core/${session}/__demo/connection`, {
    data: { offline: true },
  })
  await expect(page.locator('.connection-notice').first()).toBeVisible()
  await expect(input).toBeDisabled()
  await expect(input).toHaveValue('Retain through offline recovery')
  await expect(page.locator('.pending-media')).toContainText('retained.txt')
  await page.request.post(`/__test-core/${session}/__demo/connection`, {
    data: { offline: false },
  })
  await page
    .getByRole('button', { name: 'Reconnect', exact: true })
    .first()
    .click()
  await expect(input).toBeEnabled()
  await expect(input).toHaveValue('Retain through offline recovery')
  await expect(page.locator('.pending-media')).toContainText('retained.txt')
})
