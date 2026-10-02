// Settings belong in Core, so Kip and every window can read and change them. The interface keeps in browser
// storage only what is listed here. A new storage write fails this test: keep the setting in Core and add it to the
// admin catalog (core/src/workflows/admin-tools.ts), or add the write here with the reason it is window-local.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = new URL('../src/', import.meta.url).pathname
const allowed = {
  'app/appearance.ts': {
    keys: ["'palette'", "'theme'"],
    reason: 'Cache of the palette and theme Core keeps, for the first paint.',
  },
  'features/notifications/settings.ts': {
    keys: ['desktopAlertsKey(scope)', 'key(name)'],
    reason:
      'Cache of the notification choices Core keeps; the choices themselves while Core keeps none.',
  },
  'features/notifications/use-notifications.ts': {
    keys: ['permissionAskedKey'],
    reason:
      'Whether this app already asked the operating system for notification permission.',
  },
  'platform/preferences.ts': {
    keys: ['`kipster:${key}`'],
    reason: 'The storage behind platform preferences.',
  },
  'data/backend-connection.ts': {
    keys: ['backendStorageKey'],
    reason: 'Which Core this window connects to.',
  },
  'data/software-updates.ts': {
    keys: ['this.policyKey', 'pinKey'],
    reason:
      'The desktop app version pin, and the update policy the app updater reads before Core answers.',
  },
  'data/use-settings-draft.ts': {
    keys: ['storageKey'],
    reason: 'Unsaved edits in this window.',
  },
  'features/workspace/LifecyclePanel.tsx': {
    keys: ['storageKey'],
    reason: 'Progress of archive and delete requests this window sent.',
  },
  'data/preferences.ts': {
    keys: ["'kipster-client'"],
    reason:
      'Navigation: the open workspace, kip and chat, and the sidebar state.',
  },
  'data/conversation-storage.ts': {
    keys: ["'kipster-conversations'"],
    reason: 'Conversation cache and unsent messages.',
  },
  'data/management-journal.ts': {
    keys: ["'kipster-management'"],
    reason: 'Retry journal of management requests.',
  },
  'data/use-settings-save.ts': {
    keys: ["'kipster-core-settings-saves'"],
    reason: 'Retry journal of settings saves.',
  },
  'data/work-journal.ts': {
    keys: ["'kipster-work-commands'"],
    reason: 'Retry journal of work commands.',
  },
  'features/notifications/use-delivery.ts': {
    keys: ["'kipster-notification-attention'"],
    reason: 'Which alerts this browser profile already showed.',
  },
}
const writes =
  /(?:localStorage\.setItem|sessionStorage\.setItem|preferences\.set|new Dexie|indexedDB\.open)\(\s*([^,()]+(?:\([^()]*\))?)/g

async function* sources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== 'fake-core') yield* sources(path)
    else if (/\.tsx?$/.test(entry.name)) yield path
  }
}

test('browser storage holds only window-local state; settings live in Core', async () => {
  const found = {}
  for await (const path of sources(root)) {
    const keys = [...(await readFile(path, 'utf8')).matchAll(writes)].map(
      (match) => match[1].trim(),
    )
    if (keys.length) found[relative(root, path)] = [...new Set(keys)].sort()
  }
  assert.deepEqual(
    found,
    Object.fromEntries(
      Object.entries(allowed).map(([file, { keys }]) => [
        file,
        [...keys].sort(),
      ]),
    ),
  )
})
