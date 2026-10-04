import { test, expect, startDemo, DEMO_IDS } from './demo.ts'
import type { Page } from '@playwright/test'
import { sendExistingNotification } from '../src/platform/notification-service.ts'
import {
  mergeSettingsRecord,
  mergeSettingsSnapshot,
} from '../src/data/core-settings.ts'
const org = DEMO_IDS.organization
async function core(page: Page, path: string, body?: unknown, method = 'PUT') {
  const session = new URL(page.url()).searchParams.get('testCore')
  const response = await page.request.fetch(
    `/__test-core/${session}${path}`,
    body === undefined ? {} : { method, data: body },
  )
  expect(response.ok()).toBeTruthy()
  return response.json()
}
const save = (
  page: Page,
  kind: string,
  id: string,
  settings: unknown,
  operationId = crypto.randomUUID(),
) =>
  core(page, `/v1/${kind}/${id}/settings`, {
    version: 1,
    operationId,
    settings,
  })
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Organization', exact: true }).click()
}
const dialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Settings', exact: true })
const instructions = (page: Page) =>
  page.getByRole('textbox', { name: 'Organization instructions', exact: true })
/** Shared instructions open from their row on the Organization page. */
async function openInstructions(page: Page) {
  await dialog(page)
    .getByRole('button', { name: /^Instructions/ })
    .click()
  await expect(instructions(page)).toBeVisible()
}
const back = (page: Page) =>
  dialog(page)
    .getByRole('button', { name: /^Back to/ })
    .click()
const effort = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Effort', exact: true })
/** Effort is a segmented control when a model offers four levels or fewer. */
const chooseEffort = (page: Page, level: string) =>
  effort(page)
    .locator('label')
    .filter({ hasText: new RegExp(`^${level}$`) })
    .click()
const effortIs = (page: Page, level: string) =>
  expect(
    effort(page).getByRole('radio', {
      name: level === 'Default' ? /default/ : level,
      exact: level !== 'Default',
    }),
  ).toBeChecked()
async function setup(page: Page) {
  const session = await startDemo(page)
  await openSettings(page)
  await expect(page.getByLabel('Adapter', { exact: true })).toHaveValue('demo')
  return session
}
const editor = (page: Page) =>
  page.getByRole('region', { name: 'Default execution settings' })
const saveButton = (page: Page) =>
  editor(page).getByRole('button', { name: 'Save', exact: true })
async function reopen(page: Page) {
  await page.getByRole('button', { name: 'Close settings' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
  ).toHaveCount(0)
  await openSettings(page)
}

test('organization edit sends only intentional fields and retains opaque options', async ({
  page,
}) => {
  await setup(page)
  await save(page, 'organizations', org, {
    options: { set: { preserved: 'opaque' } },
  })
  const bodies: any[] = []
  await page.route('**/v1/organizations/*/settings', async (route) => {
    if (route.request().method() === 'PUT')
      bodies.push(route.request().postDataJSON())
    await route.continue()
  })
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  expect(bodies[0].settings).toEqual({ effort: { set: 'high' } })
  const settings = await core(page, '/v1/settings')
  expect(
    settings.organizations.find((r: any) => r.id === org).settings.options,
  ).toEqual({ preserved: 'opaque' })
  await openInstructions(page)
  await instructions(page).fill('Use concise answers.')
  await page.getByRole('button', { name: 'Save instructions' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.reload()
  await openSettings(page)
  await openInstructions(page)
  await expect(instructions(page)).toHaveValue('Use concise answers.')
})

test('global overrides span organizations and each explicit clear reveals local defaults', async ({
  page,
}) => {
  await setup(page)
  await save(page, 'organizations', DEMO_IDS.studio, { effort: { set: 'low' } })
  await save(page, 'agents', DEMO_IDS.researcher, {
    adapterId: { set: 'demo' },
    modelId: { set: 'demo-model' },
    effort: { set: 'high' },
  })
  const effective = (organizationId: string) =>
    core(
      page,
      `/v1/agents/${DEMO_IDS.researcher}/effective-settings?organizationId=${organizationId}`,
    )
  for (const id of [org, DEMO_IDS.studio])
    expect((await effective(id)).settings.effort).toBe('high')
  for (const field of ['adapterId', 'modelId', 'effort']) {
    await save(page, 'agents', DEMO_IDS.researcher, {
      [field]: { clear: true },
    })
    for (const id of [org, DEMO_IDS.studio])
      expect((await effective(id)).sources[field]).toBe('organization')
  }
  expect((await effective(DEMO_IDS.studio)).settings.effort).toBe('low')
})

test('root administrator never inherits selected organization and incompatible inheritance is explicit', async ({
  page,
}) => {
  await setup(page)
  await save(page, 'organizations', org, {
    adapterId: { set: 'missing-adapter' },
  })
  expect(
    (
      await core(
        page,
        `/v1/agents/${DEMO_IDS.researcher}/effective-settings?organizationId=${org}`,
      )
    ).status,
  ).toBe('incompatible')
  await save(page, 'agents', DEMO_IDS.rootAgent, { adapterId: { clear: true } })
  const root = await core(
    page,
    `/v1/agents/${DEMO_IDS.rootAgent}/effective-settings`,
  )
  expect([
    root.settings.adapterId,
    root.sources.adapterId,
    root.status,
  ]).toEqual(['demo', 'default', 'ready'])
  await page.getByRole('button', { name: 'Kips', exact: true }).click()
  await dialog(page).getByRole('button', { name: /Admin/ }).click()
  await expect(
    page.getByText(
      'Your main kip works outside organizations. Without its own settings, it uses the default adapter and model.',
    ),
  ).toBeVisible()
})

test('catalog refresh keeps dirty input and missing saved selections without fallback', async ({
  page,
}) => {
  await setup(page)
  await openInstructions(page)
  await instructions(page).fill('Retain this draft')
  await page.route('**/v1/execution-adapters', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.revision += 100
    data.adapters = []
    await route.fulfill({ json: data })
  })
  await reopen(page)
  await expect(page.getByLabel('Adapter', { exact: true })).toHaveValue('demo')
  await expect(
    page.getByLabel('Adapter', { exact: true }).locator('option:checked'),
  ).toContainText('not offered')
  await openInstructions(page)
  await expect(instructions(page)).toHaveValue('Retain this draft')
  await page.reload()
  await openSettings(page)
  await openInstructions(page)
  await expect(instructions(page)).toHaveValue('Retain this draft')
})

test('latest backend save wins supplied fields and repeated IDs retain acceptance', async ({
  page,
}) => {
  await setup(page)
  const first = await save(page, 'organizations', org, {
    effort: { set: 'high' },
  })
  const latest = await save(page, 'organizations', org, {
    effort: { set: 'low' },
  })
  const reuse = await save(
    page,
    'organizations',
    org,
    { effort: { set: 'low' } },
    latest.operationId,
  )
  expect(reuse.settings).toEqual(latest.settings)
  expect(reuse.alreadyApplied).toBe(true)
  const old = { organizations: { [org]: first.settings }, agents: {} }
  const current = mergeSettingsRecord(old, latest.settings)
  expect(
    mergeSettingsRecord(current, first.settings).organizations[org].settings
      .effort,
  ).toBe('low')
  expect(
    mergeSettingsSnapshot(current, old).organizations[org].settings.effort,
  ).toBe('low')
})

test('lost save acknowledgement remains read-only after reload until explicit exact retry', async ({
  page,
}) => {
  await setup(page)
  const bodies: any[] = []
  await page.route(
    '**/v1/organizations/*/settings',
    async (route) => {
      bodies.push(route.request().postDataJSON())
      await route.fetch()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
  await page.reload()
  await openSettings(page)
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
  expect(bodies).toHaveLength(1)
  await page.route('**/v1/organizations/*/settings', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.continue()
  })
  await page.getByRole('button', { name: 'Retry save' }).click()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
})

test('uncertain save retains immutable retry and dirty input through close', async ({
  page,
}) => {
  await setup(page)
  const sent: any[] = []
  await page.route('**/v1/organizations/*/settings', async (route) => {
    sent.push(route.request().postDataJSON())
    if (sent.length === 1) await route.abort('failed')
    else await route.continue()
  })
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
  await reopen(page)
  await effortIs(page, 'High')
  await page.getByRole('button', { name: 'Retry save' }).click()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
})

test('background notification driver never prompts and reports unavailable permission or errors honestly', async () => {
  let prompts = 0,
    sends = 0
  const driver = {
    isPermissionGranted: async () => false,
    requestPermission: async () => {
      prompts++
      return 'granted'
    },
    sendNotification: () => {
      sends++
    },
  }
  expect(
    await sendExistingNotification(driver, {
      title: 'Test',
      body: 'Synthetic',
    }),
  ).toEqual({ status: 'denied' })
  expect(prompts).toBe(0)
  expect(sends).toBe(0)
  driver.isPermissionGranted = async () => true
  expect(
    await sendExistingNotification(driver, {
      title: 'Test',
      body: 'Synthetic',
    }),
  ).toEqual({ status: 'requested' })
  expect(prompts).toBe(0)
  expect(sends).toBe(1)
  driver.sendNotification = () => {
    throw Error('Suppressed transport')
  }
  expect(
    await sendExistingNotification(driver, {
      title: 'Test',
      body: 'Synthetic',
    }),
  ).toEqual({ status: 'failed' })
})

test('unsupported effort remains selected until deliberate organization effort clear', async ({
  page,
}) => {
  await setup(page)
  await save(page, 'organizations', org, { effort: { set: 'unsupported' } })
  await expect(page.getByLabel('Effort', { exact: true })).toHaveValue(
    'unsupported',
  )
  expect(
    (
      await core(
        page,
        `/v1/agents/${DEMO_IDS.researcher}/effective-settings?organizationId=${org}`,
      )
    ).status,
  ).toBe('incompatible')
  await page.getByLabel('Effort', { exact: true }).selectOption('')
  await saveButton(page).click()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  expect(
    (
      await core(
        page,
        `/v1/agents/${DEMO_IDS.researcher}/effective-settings?organizationId=${org}`,
      )
    ).settings.effort,
  ).toBeUndefined()
})

test('global override selectors use inherited catalog and explicit clear returns inheritance', async ({
  page,
}) => {
  await setup(page)
  await page.getByRole('button', { name: 'Kips', exact: true }).click()
  await dialog(page)
    .getByRole('button', { name: /^Atlas/ })
    .click()
  await chooseEffort(page, 'High')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await chooseEffort(page, 'Default')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  expect(
    (
      await core(
        page,
        `/v1/agents/${DEMO_IDS.researcher}/effective-settings?organizationId=${org}`,
      )
    ).sources.effort,
  ).toBe('organization')
})

for (const failure of ['read', 'reserve'])
  test(`settings ${failure} failure preserves input and prevents dispatch`, async ({
    page,
  }) => {
    await setup(page)
    await chooseEffort(page, 'High')
    await page.evaluate((failure) => {
      const method = failure === 'read' ? 'get' : 'add'
      const original = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (...args: any[]) {
        if (this.transaction.db.name === 'kipster-core-settings-saves')
          throw new DOMException('Storage unavailable', 'UnknownError')
        return Reflect.apply(original, this, args)
      }
    }, failure)
    let sent = 0
    await page.route('**/v1/organizations/*/settings', async (route) => {
      sent++
      await route.continue()
    })
    await saveButton(page).click()
    await expect(editor(page).getByRole('alert')).toContainText(
      'Nothing was sent',
    )
    await effortIs(page, 'High')
    expect(sent).toBe(0)
  })

test('catalog failure and refresh retain dirty fields and recovery', async ({
  page,
}) => {
  await setup(page)
  await openInstructions(page)
  await instructions(page).fill('Keep while refreshing')
  await page.getByRole('button', { name: 'Adapters', exact: true }).click()
  await page.route('**/v1/execution-adapters/refresh', (route) =>
    route.abort('failed'),
  )
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Could not check adapters',
  )
  await page.unroute('**/v1/execution-adapters/refresh')
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(
    page.getByText('1 of 1 available', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Organization', exact: true }).click()
  await openInstructions(page)
  await expect(instructions(page)).toHaveValue('Keep while refreshing')
})

test('late save acknowledgement cannot overwrite another client newer canonical fields', async ({
  page,
}) => {
  await setup(page)
  let release!: () => void, applied!: () => void
  const gate = new Promise<void>((r) => (release = r)),
    accepted = new Promise<void>((r) => (applied = r))
  await page.route(
    '**/v1/organizations/*/settings',
    async (route) => {
      const response = await route.fetch()
      applied()
      await gate
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await accepted
  await save(page, 'organizations', org, { effort: { set: 'low' } })
  release()
  await effortIs(page, 'Low')
})

test('dirty settings survive organization changes without retargeting', async ({
  page,
}) => {
  await setup(page)
  await openInstructions(page)
  await instructions(page).fill('Garden draft only')
  await back(page)
  await chooseEffort(page, 'High')
  const select = dialog(page).getByRole('combobox', {
    name: 'Organization',
    exact: true,
  })
  await select.selectOption(DEMO_IDS.studio)
  await openInstructions(page)
  await expect(instructions(page)).not.toHaveValue('Garden draft only')
  await back(page)
  await select.selectOption(org)
  await openInstructions(page)
  await expect(instructions(page)).toHaveValue('Garden draft only')
  await back(page)
  await effortIs(page, 'High')
  await page.reload()
  await openSettings(page)
  await effortIs(page, 'High')
})

test('another tab settlement removes explicit retry without automatic replay', async ({
  page,
  context,
}) => {
  const session = await setup(page)
  let commands = 0
  await page.route('**/v1/organizations/*/settings', async (route) => {
    commands++
    await route.abort('failed')
  })
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
  const other = await context.newPage()
  await startDemo(other, { session })
  await openSettings(other)
  await other.getByRole('button', { name: 'Retry save' }).click()
  await expect(other.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry save' })).toHaveCount(0)
  expect(commands).toBe(1)
})

test('explicit retry remains available after an unknown save while settings refresh is in flight', async ({
  page,
}) => {
  await setup(page)
  let commands = 0
  await page.route('**/v1/organizations/*/settings', async (route) => {
    commands++
    if (commands === 1) await route.abort('failed')
    else await route.continue()
  })
  await chooseEffort(page, 'High')
  await saveButton(page).click()
  await expect(page.getByRole('button', { name: 'Retry save' })).toBeVisible()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await page.route(
    '**/v1/settings',
    async (route) => {
      const response = await route.fetch()
      await gate
      await route.fulfill({ response })
    },
    { times: 1 },
  )
  await save(page, 'agents', DEMO_IDS.researcher, { effort: { set: 'low' } })
  await page.getByRole('button', { name: 'Retry save' }).click()
  release()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  expect(commands).toBe(2)
})

test('unavailable catalog adapter retains canonical selection and reports reason independently of connection', async ({
  page,
}) => {
  await setup(page)
  await page.route('**/v1/execution-adapters/refresh', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.revision += 100
    data.adapters[0].available = false
    data.adapters[0].reason = 'Harness not available on the host'
    await route.fulfill({ json: data })
  })
  await page.getByRole('button', { name: 'Adapters', exact: true }).click()
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(
    page.getByText('Harness not available on the host', { exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled()
  await page.getByRole('button', { name: 'Organization', exact: true }).click()
  await expect(page.getByLabel('Adapter', { exact: true })).toHaveValue('demo')
})

test('late save acknowledgement preserves another tab’s newer persisted draft', async ({
  page,
  context,
}) => {
  const session = await setup(page)
  await chooseEffort(page, 'High')
  let release!: () => void
  let received = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/v1/organizations/*/settings', async (route) => {
    const response = await route.fetch()
    received = true
    await gate
    await route.fulfill({ response })
  })
  const other = await context.newPage()
  await startDemo(other, { session })
  await openSettings(other)
  await chooseEffort(other, 'Low')
  await saveButton(page).click()
  await expect.poll(() => received).toBeTruthy()
  release()
  await expect(editor(page).getByText('Saved', { exact: true })).toBeVisible()
  await other.reload()
  await openSettings(other)
  await effortIs(other, 'Low')
})
