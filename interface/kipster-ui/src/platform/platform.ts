import type { RecordingService } from './recording.js'
export interface NotificationMessage {
  notificationId?: string
  title: string
  body: string
}

/** Requested means handed to the notification API, not confirmed visible. */
export type NotificationResult =
  | { status: 'requested' }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'failed' }

/** Host services, separate from the Kipster Protocol and execution adapters. */
export interface Platform {
  attention?: { isForeground(): boolean }
  recording?: RecordingService
  preferences: {
    get(key: string): string | null
    set(key: string, value: string): void
  }
  notifications: {
    supported: boolean
    sendExisting?(message: NotificationMessage): Promise<NotificationResult>
    send(message: NotificationMessage): Promise<NotificationResult>
  }
}
