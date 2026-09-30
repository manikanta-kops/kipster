import type { NotificationMessage, NotificationResult } from './platform.ts'

/** The adapter supplies the driver; tests exercise permission handling without OS prompts. */
export interface NotificationDriver {
  isPermissionGranted(): Promise<boolean>
  requestPermission(): Promise<string>
  sendNotification(message: NotificationMessage): void | Promise<void>
}

export async function requestNotification(
  driver: NotificationDriver,
  message: NotificationMessage,
): Promise<NotificationResult> {
  try {
    const granted = await driver.isPermissionGranted()
    if (!granted && (await driver.requestPermission()) !== 'granted') {
      return { status: 'denied' }
    }
    await driver.sendNotification(message)
    return { status: 'requested' }
  } catch {
    return { status: 'failed' }
  }
}

/** Background dispatch never asks for permission and never confirms OS visibility. */
export async function sendExistingNotification(
  driver: NotificationDriver,
  message: NotificationMessage,
): Promise<NotificationResult> {
  try {
    if (!(await driver.isPermissionGranted())) return { status: 'denied' }
    await driver.sendNotification(message)
    return { status: 'requested' }
  } catch {
    return { status: 'failed' }
  }
}
