import { expect, test, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'
import { requestNotification } from '../src/platform/notification-service.ts'
import type { NotificationDriver } from '../src/platform/notification-service.ts'

const message = { title: 'Kipster test', body: 'Test notification' }

for (const permission of ['granted', 'denied', 'default']) {
  test(`notification permission ${permission} is respected`, async () => {
    let requests = 0
    let sends = 0
    const driver: NotificationDriver = {
      async isPermissionGranted() {
        return false
      },
      async requestPermission() {
        requests++
        return permission
      },
      sendNotification(value) {
        expect(value).toEqual(message)
        sends++
      },
    }
    expect(await requestNotification(driver, message)).toEqual({
      status: permission === 'granted' ? 'requested' : 'denied',
    })
    expect(requests).toBe(1)
    expect(sends).toBe(permission === 'granted' ? 1 : 0)
  })
}

test('existing permission does not prompt again', async () => {
  let sent = false
  const outcome = await requestNotification(
    {
      async isPermissionGranted() {
        return true
      },
      async requestPermission() {
        throw new Error('Must not request again')
      },
      sendNotification() {
        sent = true
      },
    },
    message,
  )
  expect(outcome.status).toBe('requested')
  expect(sent).toBe(true)
})

test('plugin failure is reported without claiming success', async () => {
  expect(
    await requestNotification(
      {
        async isPermissionGranted() {
          throw new Error('IPC unavailable')
        },
        async requestPermission() {
          return 'granted'
        },
        sendNotification() {
          throw new Error('Must not send')
        },
      },
      message,
    ),
  ).toEqual({ status: 'failed' })
})

const openNotificationSettings = async (page: Page) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('dialog', { name: 'Settings', exact: true })
    .getByRole('button', { name: 'Notifications', exact: true })
    .click()
}

test('the browser shows only in-app banner settings, off by default', async ({
  page,
}) => {
  await startDemo(page)
  await openNotificationSettings(page)
  const banners = page.getByRole('switch', { name: /^In-app banners/ })
  await expect(banners).not.toBeChecked()
  await expect(page.getByRole('switch')).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: 'Send test notification' }),
  ).toHaveCount(0)
  await expect(page.getByText('Open at login')).toHaveCount(0)
  await banners.check()
  await page.reload()
  await openNotificationSettings(page)
  await expect(
    page.getByRole('switch', { name: /^In-app banners/ }),
  ).toBeChecked()
})

test('desktop settings follow the host: permission, test, keep running and open at login', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await openNotificationSettings(page)
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.getByText('Allowed in System Settings')).toBeVisible()
  const master = page.getByRole('switch', { name: /^macOS notifications/ })
  await expect(master).toBeChecked()
  for (const name of ['Needs you', 'Failures', 'Replies', 'Dock badge'])
    await expect(
      page.getByRole('switch', { name: new RegExp(`^${name}`) }),
    ).toBeChecked()
  await expect(
    page.getByRole('switch', { name: /^In-app banners/ }),
  ).not.toBeChecked()
  await expect(
    page.getByRole('switch', { name: /^Keep running/ }),
  ).toBeChecked()
  const login = page.getByRole('switch', { name: /^Open at login/ })
  await expect(login).not.toBeChecked()
  await login.check()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).notificationTest.openAtLogin),
    )
    .toBe(true)
  await master.uncheck()
  await expect(page.getByRole('switch', { name: /^Replies/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Send test notification' }).click()
  await expect(settings.getByText(/^Sent\./)).toBeVisible()
  expect(
    await page.evaluate(() => (window as any).notificationTest.sends.length),
  ).toBe(1)
  await page.evaluate(() => {
    ;(window as any).notificationTest.permission = 'denied'
  })
  await page.getByRole('button', { name: 'Send test notification' }).click()
  await expect(
    settings.getByText('Turned off for Kipster in System Settings.', {
      exact: true,
    }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open System Settings' }).click()
  expect(
    await page.evaluate(() => (window as any).notificationTest.settingsOpened),
  ).toBe(1)
})

const coreInterface = (page: Page, change?: Record<string, unknown>) =>
  page.evaluate(async (change) => {
    const core =
      new URLSearchParams(location.search).get('testCore') || 'default'
    const response = await fetch(
      `https://${core}.demo.kipster.invalid/v1/settings/interface`,
      change === undefined
        ? undefined
        : {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ version: 1, ...change }),
          },
    )
    return response.json()
  }, change)

test('notification switches live in Core, so Kip and other windows share them', async ({
  page,
}) => {
  await startDemo(page, { notification: 'background' })
  await openNotificationSettings(page)
  // Kip changes two switches through Core; the open window follows.
  await coreInterface(page, { notifyReplies: false, dockBadge: false })
  await expect(page.getByRole('switch', { name: /^Replies/ })).not.toBeChecked()
  await expect(
    page.getByRole('switch', { name: /^Dock badge/ }),
  ).not.toBeChecked()
  await expect(page.getByRole('switch', { name: /^Needs you/ })).toBeChecked()
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).notificationTest.badges.at(-1)),
    )
    .toBe(0)
  await page.getByRole('switch', { name: /^In-app banners/ }).check()
  await expect
    .poll(async () => (await coreInterface(page)).inAppBanners)
    .toBe(true)
})
