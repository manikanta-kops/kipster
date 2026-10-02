import type { RecordingService } from './recording.js'
export interface NotificationMessage {
  notificationId?: string
  /** Clicking the notification opens this thread. */
  threadId?: string
  title: string
  subtitle?: string
  body: string
}

/** Requested means handed to the notification API, not confirmed visible. */
export type NotificationResult =
  | { status: 'requested' }
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'failed' }

export type NotificationPermission =
  'granted' | 'denied' | 'prompt' | 'unavailable'

export interface NotificationTarget {
  threadId: string
  notificationId?: string
}

/** A persisted host switch, such as open at login. */
export interface HostSetting {
  get(): Promise<boolean>
  set(on: boolean): Promise<void>
}

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
    /** The operating system's current answer, without prompting. */
    permission?(): Promise<NotificationPermission>
    /** Prompts once if the user was never asked. */
    requestPermission?(): Promise<NotificationPermission>
    sendExisting?(message: NotificationMessage): Promise<NotificationResult>
    send(message: NotificationMessage): Promise<NotificationResult>
    /**
     * Calls `listener` when the user clicks a notification, including the click
     * that launched the app. Returns an unsubscribe function.
     */
    onOpen?(listener: (target: NotificationTarget) => void): () => void
    /** Opens the operating system's notification settings for this app. */
    openSettings?(): Promise<void>
  }
  /** The app icon badge; 0 clears it. */
  badge?: { set(count: number): Promise<void> }
  app?: {
    /** Closing the window hides it and keeps the app running. */
    keepRunning: HostSetting
    /** Start hidden when the user signs in. */
    openAtLogin: HostSetting
  }
}
