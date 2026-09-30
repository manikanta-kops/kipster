import type { Platform } from '../src/platform/platform.ts'
import {
  conversationStorage,
  mediaStorage,
} from '../src/data/conversation-storage.ts'
import { controlJournal } from '../src/data/control-journal.ts'
import { workJournal } from '../src/data/work-journal.ts'
import { navigationPreferences } from '../src/data/preferences.ts'
import {
  requestNotification,
  sendExistingNotification,
} from '../src/platform/notification-service.ts'

export function prepareBrowser(platform: Platform) {
  const parameters = new URLSearchParams(location.search)
  const modes: Record<string, string> = JSON.parse(
    parameters.get('faults') || '{}',
  )
  const pending = new Map<string, Array<() => void>>()
  const calls: Record<string, number> = {}
  function gate(key: string): Promise<void> | undefined {
    calls[key] = (calls[key] || 0) + 1
    const check = () => {
      if (modes[key] === 'fail')
        throw new DOMException(`${key} unavailable`, 'QuotaExceededError')
    }
    if (modes[key] === 'hold')
      return new Promise<void>((resolve) => {
        const queue = pending.get(key) || []
        queue.push(resolve)
        pending.set(key, queue)
      }).then(check)
    check()
  }
  function wrap<T extends object, K extends keyof T>(
    object: T,
    method: K,
    key: string,
    after?: string,
  ) {
    const original = object[method] as (...args: unknown[]) => Promise<unknown>
    object[method] = ((...args: unknown[]) => {
      try {
        // Invoke normal reads synchronously so Dexie liveQuery retains its observation scope.
        const blocked = gate(key)
        const result = blocked
          ? blocked.then(() => original.apply(object, args))
          : original.apply(object, args)
        return after
          ? result.then(async (value) => {
              const completion = gate(after)
              if (completion) await completion
              return value
            })
          : result
      } catch (error) {
        return Promise.reject(error)
      }
    }) as T[K]
  }
  wrap(conversationStorage, 'readDraft', 'draft-read')
  wrap(conversationStorage, 'writeDraft', 'draft-write')
  wrap(conversationStorage, 'reserve', 'draft-reserve')
  wrap(conversationStorage, 'list', 'outbox-read')
  wrap(mediaStorage, 'add', 'media-add', 'media-commit')
  wrap(controlJournal, 'list', 'control-read')
  wrap(controlJournal, 'reserve', 'control-reserve')
  wrap(workJournal, 'list', 'work-read')
  wrap(workJournal, 'reserve', 'work-reserve')
  wrap(navigationPreferences, 'read', 'navigation-read')
  wrap(navigationPreferences, 'write', 'navigation-write')
  const notificationTest = {
    prompts: 0,
    attentionChecks: 0,
    sends: [] as string[],
    permission: 'granted',
    failure: false,
  }
  if (parameters.has('notification')) {
    const driver = {
      async isPermissionGranted() {
        return notificationTest.permission === 'granted'
      },
      async requestPermission() {
        notificationTest.prompts++
        return notificationTest.permission
      },
      sendNotification(message: { title: string }) {
        if (notificationTest.failure)
          throw new Error('Notification delivery failed')
        notificationTest.sends.push(message.title)
      },
    }
    platform.attention = {
      isForeground() {
        notificationTest.attentionChecks++
        return parameters.get('notification') === 'foreground'
      },
    }
    platform.notifications = {
      supported: true,
      send: (message) => requestNotification(driver, message),
      sendExisting: (message) => sendExistingNotification(driver, message),
    }
  }
  Object.assign(window, {
    notificationTest,
    kipsterTest: {
      ready: false,
      calls,
      fault(key: string, mode: string) {
        modes[key] = mode
        if (mode !== 'hold') {
          pending
            .get(key)
            ?.splice(0)
            .forEach((resolve) => resolve())
          pending.delete(key)
        }
      },
    },
  })
}

export async function sharedHandler(request: Request): Promise<Response> {
  const session =
    new URLSearchParams(location.search).get('testCore') || 'default'
  const url = new URL(request.url)
  return fetch(
    `/__test-core/${encodeURIComponent(session)}${url.pathname}${url.search}`,
    {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method)
        ? undefined
        : await request.arrayBuffer(),
      signal: request.signal,
    },
  )
}

export function testOrigin() {
  return `https://${new URLSearchParams(location.search).get('testCore') || 'default'}.demo.kipster.invalid`
}

export function markTransportReady() {
  ;(
    window as unknown as { kipsterTest: { ready: boolean } }
  ).kipsterTest.ready = true
}
