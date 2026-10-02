import { test, expect, demo, startDemo as startDemoPage } from './demo.ts'
import type { Page, TestInfo } from '@playwright/test'
import { protocolRange } from '@kipster/core/protocol'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

async function startDemo(page: Page) {
  // Emit fixture changes after the initial snapshot and live subscription.
  const events = page.waitForRequest(
    (request) =>
      request.method() === 'GET' &&
      new URL(request.url()).pathname.endsWith('/v1/app/events'),
  )
  const [session] = await Promise.all([startDemoPage(page), events])
  await expect(page.locator('.app-shell')).toBeVisible()
  return session
}

const updates = (page: Page) =>
  page.getByRole('dialog', { name: 'Settings', exact: true })
async function openUpdates(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Updates', exact: true }).click()
  await expect(
    updates(page).getByRole('heading', { name: 'Updates', exact: true }),
  ).toBeVisible()
}
async function capture(page: Page, info: TestInfo, name: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const screenshot = await page.screenshot()
  await info.attach(name, { body: screenshot, contentType: 'image/png' })
  if (process.env.KIPSTER_UPDATE_SCREENSHOTS) {
    await mkdir(process.env.KIPSTER_UPDATE_SCREENSHOTS, { recursive: true })
    await page.screenshot({
      path: join(process.env.KIPSTER_UPDATE_SCREENSHOTS, name + '.png'),
    })
  }
}

test('the update pill sits above Notifications and opens Updates directly', async ({
  page,
}, info) => {
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('updates.kipster.app'))
      requests.push(request.url())
  })
  await startDemo(page)
  await demo(page, '/updates', { app: { state: 'ready' } })
  const pill = page.getByRole('button', {
    name: 'Restart to update',
    exact: true,
  })
  await expect(pill).toBeVisible()
  const [pillBox, noteBox] = await Promise.all([
    pill.boundingBox(),
    page.getByRole('button', { name: /Notifications,/ }).boundingBox(),
  ])
  expect(pillBox!.y).toBeLessThan(noteBox!.y)
  await pill.click()
  await expect(
    updates(page).getByRole('heading', { name: 'Updates', exact: true }),
  ).toBeVisible()
  await expect(updates(page).getByLabel('App update')).toContainText(
    '0.0.0 → 0.8.0',
  )
  await updates(page)
    .getByLabel('App update')
    .getByText('Release notes · 0.8.0')
    .click()
  await expect(updates(page).getByLabel('App update')).toContainText(
    'Small improvements and fixes.',
  )
  await capture(page, info, 'software-updates-ready')
  expect(requests).toEqual([])
  await updates(page)
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
  await expect(updates(page).getByLabel('App update')).toContainText('0.8.0')
  await expect(page.locator('.software-update-pill')).toHaveCount(0)
})

for (const [state, label] of [
  ['available', 'Backend update available'],
  ['scheduled', 'Backend update available'],
  ['checking', 'Backend update available'],
  ['installing', 'Updating backend'],
  ['failed', 'Update failed'],
  ['rolled-back', 'Update rolled back'],
  ['pinned', 'Backend update available'],
] as const) {
  test(`backend ${state} is shown in the pill and settings`, async ({
    page,
  }) => {
    await startDemo(page)
    await demo(page, '/updates', { state, step: 'Restoring database' })
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(
      updates(page).getByRole('heading', { name: 'Updates', exact: true }),
    ).toBeVisible()
    if (state === 'scheduled')
      await expect(updates(page)).toContainText('Scheduled for 02:00–05:00')
    if (state === 'checking')
      await expect(updates(page)).toContainText('Checking for backend updates')
    if (state === 'installing')
      await expect(updates(page)).toContainText('Restoring database')
    if (state === 'failed')
      await expect(updates(page).getByRole('alert')).toBeVisible()
    if (state === 'rolled-back')
      await expect(updates(page)).toContainText('rolled back')
    if (state === 'pinned') {
      await expect(updates(page)).toContainText(
        'Automatic backend installs are paused',
      )
      await page.getByRole('button', { name: 'Unpin backend' }).click()
      await expect(
        page.getByRole('button', { name: 'Unpin backend' }),
      ).toHaveCount(0)
    }
  })
}

test('the update pill and settings remain usable in a dark phone layout', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await startDemo(page)
  await demo(page, '/updates', { app: { state: 'ready' } })
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await page
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
  await expect(
    updates(page).getByRole('heading', { name: 'Updates', exact: true }),
  ).toBeVisible()
  await expect(updates(page).getByLabel('Update channel')).toBeVisible()
  await expect(updates(page).getByLabel('App update')).toContainText(
    'Downloaded and ready',
  )
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390)
})

test('a backend restart stays an update, reconnects, and then enables the app', async ({
  page,
}, info) => {
  await startDemo(page)
  await demo(page, '/updates', { state: 'available', app: { state: 'ready' } })
  await openUpdates(page)
  await expect(
    updates(page).getByRole('button', { name: 'Restart to update' }),
  ).toBeDisabled()
  await page
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
  const accepted = await demo(page, '/updates')
  expect(accepted.installs[0]).toMatchObject({ version: 1, target: '0.8.0' })
  await demo(page, '/updates', {
    state: 'disconnect',
    disconnectMs: 1200,
    step: 'Restarting backend',
  })
  await expect(page.locator('.software-update-pill')).toHaveAccessibleName(
    'Updating backend',
  )
  await expect(updates(page)).toContainText('Waiting for it to restart')
  await capture(page, info, 'software-updates-restarting')
  await demo(page, '/updates', { state: 'installed' })
  await expect(updates(page).getByLabel('Backend update')).toContainText(
    'Updated from',
  )
  await expect(
    updates(page).getByRole('button', { name: 'Restart to update' }),
  ).toBeEnabled()
})

test('Beta needs confirmation and mode and channel settings survive reopening', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await page.getByLabel('Update channel').selectOption('next')
  const confirm = page.getByRole('dialog', { name: 'Are you sure?' })
  await expect(confirm).toContainText('whole installation')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByLabel('Update channel')).toHaveValue('stable')
  expect((await demo(page, '/updates')).status.channel).toBe('stable')
  await page.getByLabel('Update channel').selectOption('next')
  await confirm.getByRole('button', { name: 'Switch to Beta' }).click()
  await expect(page.getByLabel('Update channel')).toHaveValue('next')
  await page.getByLabel('Update mode').selectOption('notify')
  await expect(page.getByLabel('Update mode')).toHaveValue('notify')
  await expect
    .poll(async () => (await demo(page, '/updates')).status.mode)
    .toBe('notify')
  await updates(page).getByRole('button', { name: 'Close settings' }).click()
  await openUpdates(page)
  await expect(page.getByLabel('Update mode')).toHaveValue('notify')
  await page.getByLabel('Update channel').selectOption('stable')
  await expect(page.getByLabel('Update channel')).toHaveValue('stable')
  await expect(page.getByRole('dialog', { name: 'Are you sure?' })).toHaveCount(
    0,
  )
  await expect(updates(page)).toContainText(
    'waits until Stable passes your current version',
  )
})

test('Check now shows scheduled updates, check times, and backend priority', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await expect(updates(page)).toContainText('Not yet checked')
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(updates(page)).toContainText('Scheduled for 02:00–05:00')
  await expect(updates(page).getByLabel('Backend update')).toContainText(
    '0.8.0',
  )
  await expect(updates(page)).not.toContainText(
    'Backend checked: Not yet checked',
  )
})

test('older backends are offered only with backups and explicit data-loss confirmation', async ({
  page,
}, info) => {
  await startDemo(page)
  await demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: protocolRange,
  })
  await demo(page, '/updates', { state: 'backups' })
  await openUpdates(page)
  await page.getByText('Advanced', { exact: true }).click()
  const picker = page.getByLabel('Backend version', { exact: true })
  await expect(picker.locator('option[value="0.5.0"]')).toHaveCount(0)
  await expect(picker.locator('option[value="0.6.0"]')).toHaveCount(1)
  await picker.selectOption('0.6.0')
  await expect(page.getByLabel('Restore backup')).toHaveValue('backup-0.6.0')
  await page.getByRole('button', { name: 'Install and pin backend' }).click()
  const confirm = page.getByRole('dialog', {
    name: 'Restore an older backend?',
  })
  await expect(confirm).toContainText(
    'Data written since that backup will be lost',
  )
  await capture(page, info, 'software-updates-restore')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await demo(page, '/updates')).installs).toEqual([])
  await page.getByRole('button', { name: 'Install and pin backend' }).click()
  await confirm
    .getByRole('button', { name: 'Restore backup and install' })
    .click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
  expect((await demo(page, '/updates')).installs[0]).toMatchObject({
    target: '0.6.0',
    pin: true,
    backupId: 'backup-0.6.0',
    confirmDataLoss: true,
  })
})

test('a backend protocol warning must be accepted before installing', async ({
  page,
}) => {
  await startDemo(page)
  await demo(page, '/updates', { state: 'available', channel: 'next' })
  await openUpdates(page)
  await page.getByText('Advanced', { exact: true }).click()
  await page
    .getByLabel('Backend version', { exact: true })
    .selectOption('0.9.0-next.1')
  await expect(updates(page)).toContainText(
    'This backend version requires a newer app protocol',
  )
  await page
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  const confirm = page.getByRole('dialog', {
    name: 'This app will need an update',
  })
  await expect(confirm).toContainText(
    'will need an update after the backend restarts',
  )
  expect((await demo(page, '/updates')).installs).toEqual([])
  await confirm.getByRole('button', { name: 'Update backend' }).click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
})

test('app version pinning warns about protocol, permits downgrades and persists per device', async ({
  page,
}) => {
  await startDemo(page)
  await demo(page, '/updates', { app: { version: '0.8.0', state: 'idle' } })
  await openUpdates(page)
  await page.getByText('Advanced', { exact: true }).click()
  await expect(
    page.getByLabel('App version').locator('option[value="0.6.0"]'),
  ).toHaveAttribute('disabled', '')
  await page.getByLabel('App version').selectOption('0.7.0')
  await expect(updates(page)).toContainText(
    'This app version speaks protocol 0',
  )
  await page.getByRole('button', { name: 'Install and pin app' }).click()
  const confirm = page.getByRole('dialog', { name: 'Check app compatibility' })
  await expect(confirm).toContainText('outside the backend’s supported range')
  await confirm.getByRole('button', { name: 'Install and pin app' }).click()
  await expect(updates(page)).toContainText('Pinned to 0.7.0 on this device')
  expect(
    await page.evaluate(() => localStorage.getItem('kipster-app-update-pin')),
  ).toBe('0.7.0')
  await page.getByRole('button', { name: 'Unpin app' }).click()
  await expect(page.getByRole('button', { name: 'Unpin app' })).toHaveCount(0)
  expect(
    await page.evaluate(() => localStorage.getItem('kipster-app-update-pin')),
  ).toBeNull()
  await expect(updates(page).getByLabel('App update')).not.toContainText(
    '→ 0.7.0',
  )
  await expect(page.locator('.software-update-pill')).toHaveCount(0)
})

for (const state of [
  'checking',
  'downloading',
  'failed',
  'unavailable',
] as const) {
  test(`app ${state} stays visible with appropriate controls`, async ({
    page,
  }) => {
    await startDemo(page)
    await demo(page, '/updates', {
      app: {
        state,
        ...(state === 'failed' ? { error: 'The signature is invalid.' } : {}),
        ...(state === 'unavailable'
          ? { message: 'Updates are not available in this build' }
          : {}),
      },
    })
    await openUpdates(page)
    const row = updates(page).getByLabel('App update')
    if (state === 'checking')
      await expect(
        row.getByRole('button', { name: 'Checking…' }),
      ).toBeDisabled()
    if (state === 'downloading')
      await expect(
        row.getByRole('button', { name: 'Downloading…' }),
      ).toBeDisabled()
    if (state === 'failed') {
      await expect(page.locator('.software-update-pill')).toHaveAccessibleName(
        'Update failed',
      )
      await expect(updates(page).getByRole('alert')).toContainText('signature')
    }
    if (state === 'unavailable') {
      await expect(row).toContainText('Updates are not available in this build')
      await expect(row.getByRole('button')).toBeDisabled()
    }
  })
}

test('compatibility recovery buttons use the update APIs', async ({ page }) => {
  await startDemo(page)
  await demo(page, '/updates', { state: 'available' })
  await demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: { oldest: 0, current: 0 },
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the backend' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  await expect(page.getByRole('status')).toContainText('Updating backend')
  await demo(page, '/updates', { state: 'installed' })
  await expect(page.locator('.app-shell')).toBeVisible()
  await demo(page, '/updates', {
    app: {
      state: 'ready',
      available: {
        ...(await demo(page, '/updates')).releases.packages['@kipster/ui'][0],
      },
    },
  })
  await demo(page, '/release', {
    coreVersion: '0.8.0',
    protocol: { oldest: 2, current: 2 },
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the app' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Restart to update', exact: true })
    .click()
  await expect
    .poll(async () => (await demo(page, '/updates')).app.version)
    .toBe('0.9.0-next.1')
})

test('an incompatible app still offers the backend-first recovery action', async ({
  page,
}) => {
  await startDemo(page)
  await demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: { oldest: 2, current: 2 },
  })
  await demo(page, '/updates', {
    state: 'available',
    channel: 'next',
    app: { state: 'ready' },
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the app', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Restart to update' }),
  ).toBeDisabled()
  await expect(
    page.getByText('Update the backend first, then update this app.'),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  const confirm = page.getByRole('dialog', {
    name: 'This app will need an update',
  })
  await confirm.getByRole('button', { name: 'Update backend' }).click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
})

test('unknown backend update states remain neutral and unsupported backends remain usable', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await demo(page, '/updates', { core: { state: 'future-state' } })
  await expect(updates(page)).toContainText(
    'Backend update status not recognized',
  )
  await updates(page).getByRole('button', { name: 'Close settings' }).click()
  await page.route('**/__test-core/*/v1/updates', (route) =>
    route.fulfill({ status: 404, json: { message: 'Route not found' } }),
  )
  await page.reload()
  await openUpdates(page)
  await expect(updates(page)).toContainText(
    'does not support software updates yet',
  )
  await expect(page.getByLabel('Update channel')).toBeDisabled()
})

test('unmanaged backends offer manual instructions while app updates stay available', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await demo(page, '/updates', { state: 'unmanaged' })
  await expect(page.locator('.software-update-pill')).toHaveCount(0)
  await expect(updates(page).getByLabel('Backend update')).toContainText(
    'This backend is updated manually',
  )
  await expect(
    updates(page).getByRole('button', { name: 'Update backend', exact: true }),
  ).toHaveCount(0)
  await page.getByText('Advanced', { exact: true }).click()
  await expect(page.getByLabel('Backend version', { exact: true })).toHaveCount(
    0,
  )
  await expect(
    page.getByRole('button', { name: 'Install and pin backend' }),
  ).toHaveCount(0)
  await expect(page.getByLabel('App version', { exact: true })).toBeVisible()
  for (const state of ['scheduled', 'installing', 'failed']) {
    await demo(page, '/updates', { core: { state } })
    await expect(page.locator('.software-update-pill')).toHaveCount(0)
    await expect(updates(page).getByLabel('Backend update')).toContainText(
      'This backend is updated manually',
    )
    await expect(updates(page)).not.toContainText('Waiting for it to restart')
  }
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect(updates(page)).not.toContainText('Scheduled for 02:00–05:00')
  await expect
    .poll(async () => (await demo(page, '/updates')).status.core)
    .toMatchObject({
      managed: false,
      state: 'idle',
    })
  await demo(page, '/updates', { app: { state: 'ready' } })
  await expect(page.locator('.software-update-pill')).toHaveAccessibleName(
    'Restart to update',
  )
  await expect(
    updates(page).getByRole('button', { name: 'Restart to update' }),
  ).toBeEnabled()
  await updates(page).getByRole('button', { name: 'Restart to update' }).click()
  expect((await demo(page, '/updates')).installs).toEqual([])
})

test('an unmanaged backend compatibility screen explains how to update on its host', async ({
  page,
}) => {
  await startDemo(page)
  await demo(page, '/updates', { state: 'unmanaged' })
  await demo(page, '/updates', { core: { state: 'installing' } })
  await demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: { oldest: 0, current: 0 },
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the backend' }),
  ).toBeVisible()
  await expect(
    page.getByText(/This backend is updated manually/),
  ).toContainText('install a compatible Core release and restart the service')
  await expect(
    page.getByRole('button', { name: 'Update backend', exact: true }),
  ).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check again' })).toBeEnabled()
  await demo(page, '/release', {
    coreVersion: '0.8.0',
    protocol: protocolRange,
  })
  await page.getByRole('button', { name: 'Check again' }).click()
  await expect(page.locator('.app-shell')).toBeVisible()
  expect((await demo(page, '/updates')).installs).toEqual([])
})

test('update-unmanaged refusals clear the optimistic restart state and explain manual updates', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await demo(page, '/updates', { state: 'available', app: { state: 'ready' } })
  await page.route('**/__test-core/*/v1/updates/install', async (route) => {
    await demo(page, '/updates', { state: 'unmanaged' })
    await route.fulfill({
      status: 409,
      json: {
        version: 1,
        code: 'update-unmanaged',
        message:
          'Software installation requires a managed updater on this host',
        requestId: 'unmanaged-test',
      },
    })
  })
  await updates(page)
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  await expect(updates(page).getByRole('alert')).toContainText(
    'This backend is updated manually',
  )
  await expect(updates(page).getByRole('alert')).toContainText(
    'Software installation requires a managed updater on this host',
  )
  await expect(
    updates(page).getByRole('button', { name: 'Update backend', exact: true }),
  ).toHaveCount(0)
  await expect(updates(page)).not.toContainText('Waiting for it to restart')
  await expect(page.locator('.software-update-pill')).toHaveAccessibleName(
    'Restart to update',
  )
})

test('an updater that never starts shows its failure alongside an app failure', async ({
  page,
}) => {
  await startDemo(page)
  await openUpdates(page)
  await demo(page, '/updates', { state: 'available' })
  await updates(page)
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
  expect((await demo(page, '/updates')).installs[0]).toMatchObject({
    pin: false,
  })
  await demo(page, '/updates', {
    state: 'not-started',
    app: { state: 'failed', error: 'The app signature is invalid.' },
  })
  await expect(
    updates(page)
      .getByRole('alert')
      .filter({ hasText: 'The updater did not start' }),
  ).toBeVisible()
  await expect(
    updates(page)
      .getByRole('alert')
      .filter({ hasText: 'The app signature is invalid.' }),
  ).toBeVisible()
  await expect(updates(page)).not.toContainText('Waiting for it to restart')
  await expect(page.locator('.software-update-pill')).toHaveAccessibleName(
    'Update failed',
  )
  await expect(
    updates(page).getByRole('button', { name: 'Update backend', exact: true }),
  ).toBeEnabled()
})

test('backend compatibility recovery displays an updater startup failure', async ({
  page,
}) => {
  await startDemo(page)
  await demo(page, '/updates', { state: 'available' })
  await demo(page, '/release', {
    coreVersion: '0.7.0',
    protocol: { oldest: 0, current: 0 },
  })
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Update the backend' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Update backend', exact: true })
    .click()
  await expect
    .poll(async () => (await demo(page, '/updates')).installs.length)
    .toBe(1)
  await demo(page, '/updates', { state: 'not-started' })
  await expect(
    page.getByRole('alert').filter({ hasText: 'The updater did not start' }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
})
