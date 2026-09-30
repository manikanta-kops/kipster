import { expect, test, startDemo } from './demo.ts'
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

test('browser preview explains that notifications need the desktop app', async ({
  page,
}) => {
  await startDemo(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Desktop', exact: true }).click()
  await expect(
    page.getByText('Open the Kipster desktop app to try native notifications.'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Enable and test notifications' }),
  ).toBeDisabled()
})
