# Desktop platform adapters

Kipster UI is a React application. Tauri hosts its compiled HTML/CSS/JavaScript in a system webview. Rust starts the native shell and registers native plugins; React components are never translated into Rust.

This is the **platform-services contract**, not the Kipster Protocol. The Kipster Protocol connects the UI to Core. Core's execution adapters connect Core to harnesses. Platform adapters connect the UI to the local operating system.

```text
React UI ── Kipster Protocol client ── Core ── execution adapter ── harness
    │
    └── Platform interface ── Tauri adapter ── plugin IPC ── Rust plugin ── OS
```

## Where to start

| File                                           | Responsibility                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `src/platform/platform.ts`                     | Host-neutral input/result types and service interface                       |
| `src/platform/resolve.ts`                      | Detect the Tauri host and dynamically load its adapter                      |
| `src/platform/tauri.ts`                        | Map the interface to the Rust shell's commands and events                   |
| `src/platform/notification-service.ts`         | Permission flow with an injectable driver for tests                         |
| `src/platform/browser.ts`                      | Explicit unsupported result for native notifications in the browser preview |
| `src/platform/preferences.ts`                  | Non-secret webview/browser preferences                                      |
| `src/features/settings/DesktopPreferences.tsx` | Explicit enable/test and scoped local preferences                           |
| `src-tauri/src/notifications.rs`               | Native notifications, permission and click routing                          |
| `src-tauri/src/shell.rs`                       | Keep running, open at login and the Quit menu item                          |
| `src-tauri/capabilities/default.json`          | Grant the main window the events, badge and updater permissions it uses     |
| `src-tauri/tauri.conf.json`                    | Window, frontend build, application identifier, CSP and packaging           |
| `tests/notifications.spec.ts`                  | Permission and failure behavior, plus unsupported browser UI                |

## Run it

Install Node as described in the UI README, Rust stable, and your platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). macOS needs Xcode command-line tools; Windows needs the documented C++ tools and WebView2; Linux needs the documented WebKitGTK/system development packages.

After `npm ci` at the repository root, from `interface/kipster-ui`:

```sh
npm run desktop:dev
```

Tauri starts a dedicated Vite server on port **1420** and opens a native Kipster window. The ordinary browser preview stays on **5173**, so the two can coexist. Rust dependencies compile on the first run.

Open **Settings → Desktop → Enable and test notifications**. Permission is checked and, if needed, requested only after this user action. There are no startup notifications or automatic permission prompts. OS consent remains the user's choice.

```sh
npm run check           # Frontend types/lint/format/build
npm run desktop:check   # Rust compile check (Rust must be on PATH)
npm run desktop:build   # Frontend + native build and platform bundles
npm run test:e2e        # Production frontend and driver-level tests
```

Before `desktop:check` on a fresh checkout, run `npm run build` to create frontend assets. Keep `Cargo.lock` and the root `package-lock.json` committed. `src-tauri/target` and generated schemas are ignored.

## Calling from React

Components receive `Platform` through the application entry point. They import its types, not Tauri APIs:

```ts
const result = await platform.notifications.send({
  title: 'Hello from Kipster',
  body: 'Your React interface is connected to native desktop notifications.',
})
```

The settings control disables repeated clicks while a request is pending. Its outcomes are explicit:

- `requested`: the operating system accepted the request. This is **not delivery confirmation**; Focus modes and notification settings can still suppress the banner.
- `denied`: permission was not granted, including a dismissed/default response. Nothing was sent.
- `unavailable`: this host has no implemented notification adapter. The browser intentionally does not request Web Notification permission.
- `failed`: checking or requesting permission failed, or the system rejected the request. Do not report success.

Focus modes, OS settings and notification-center behavior can prevent a visible banner. Windows notifications must be validated from an installed application; development identity/icon behavior differs. Linux requires a working desktop notification service. Verify permission denial, granting, app restart and OS settings on every supported platform. Mock-driver tests do not prove native delivery.

## Native notifications on macOS

A bundled macOS app uses `UNUserNotificationCenter` directly. The Tauri notification plugin uses the deprecated `NSUserNotification` API and drops clicks, so it is only the fallback for `tauri dev` (an unbundled binary, which cannot use the native center) and for other platforms. The fallback has no click routing and always reports permission as granted.

| Command                            | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `notification_permission`          | `granted`, `denied`, `prompt` or `unavailable`, without prompting   |
| `request_notification_permission`  | Prompts only if the user was never asked                            |
| `send_notification`                | `{ title, subtitle?, body, threadId?, notificationId? }`            |
| `take_pending_notification_target` | Returns and clears the last clicked `{ threadId, notificationId? }` |
| `open_notification_settings`       | Opens this app's page in System Settings → Notifications            |

The notification id is the request identifier, so sending the same id replaces the earlier banner. Notifications are grouped by `threadId`. They are shown even while Kipster is in front; the UI decides when to notify.

Clicking a notification shows and focuses the main window, stores the target and emits `notification-open`. `onOpen` listens for that event and takes the stored target, so the click that launched the app is delivered once the interface subscribes.

## App lifecycle on macOS

- **Keep running** (default on): closing the main window hides it; clicking the Dock icon shows it again. When off, closing the window quits. The setting is stored in `desktop-shell.json` in the app configuration directory, so it applies before the interface loads.
- **Open at login** (default on): the first launch of an installed app adds a LaunchAgent (`~/Library/LaunchAgents/<identifier>.plist`) that starts Kipster with `--hidden`, without a window. The default is applied once; it never overrides the user's later choice. Development, demo and translocated (quarantined, not yet moved) copies do not register. A hidden copy that finds Kipster already running exits.
- **Quit** (⌘Q) is a custom menu item that requests exit, so an update downloaded for install-on-quit is installed first. Quitting from the Dock menu or logging out ends the app directly and skips that step.
- **Badge**: `badge.set(count)` sets the Dock badge; `0` clears it.

The main window starts hidden (`"visible": false`) and the shell shows it unless `--hidden` was passed.

## Permissions

App commands such as the ones above need no capability entry. The capability grants the main window event listening (for `notification-open` and updates), `core:window:allow-set-badge-count`, and the updater and process permissions. No filesystem, shell or remote-origin native privileges are granted. CSP permits Tauri IPC and HTTPS connections to `*.ts.net` for the planned private backend, plus the dedicated development server for HMR. Other backend origins need a deliberate configuration choice.

## Adding another host feature

1. Add a small, typed operation and explicit unsupported/error behavior to `Platform`.
2. Implement it in the Tauri adapter, preferring a maintained official plugin.
3. Register the native plugin in Rust and grant only the commands actually used to the intended window.
4. Implement or explicitly mark unsupported in the browser adapter. Add an Electron adapter only if we actually adopt Electron.
5. Call the contract from a React feature component. Keep platform branching out of shared components.
6. Test the service's result paths and a real packaged desktop build. Add permission prompts only to deliberate user actions.

For genuinely custom native behavior, add a typed `#[tauri::command]` and register it with `generate_handler!`, then wrap the corresponding `invoke` call inside the adapter. Define narrow permissions; do not expose a generic arbitrary-command bridge. See [calling Rust](https://v2.tauri.app/develop/calling-rust/).

## Scope

Desktop alerts operate while the app can receive updates. The shared UI renders canonical inbox/read state through an injected client; the in-memory fake Core does not establish Core durability. Background `sendExisting` only checks existing permission. Local atomic claims suppress repeat attempts per notification and destination/installation/caller within one browser profile; failed requests remain in the inbox and are not automatically retried as popups. Other devices may independently alert. Snapshot/replay history never produces a burst of old alerts. Push delivery while the app is not running, background agents and cross-platform release acceptance are not implemented; notification clicks are routed on macOS only. Webview visibility/focus provides the typed attention capability; browser native alerts are explicitly unavailable. The development application identifier is `app.kipster.desktop`; confirm the production identifier and signing before distribution.

The same React bundle can run in a browser. Native bindings are dynamically loaded only inside Tauri; browser-only use does not initialize them. Both hosts keep their own local theme preferences. Preferences are not shared between installations and are not appropriate for secrets.

Sources: [official notification plugin](https://v2.tauri.app/plugin/notification/), [Vite integration](https://v2.tauri.app/start/frontend/vite/), [Tauri capabilities](https://v2.tauri.app/security/capabilities/).

## Voice capture

The injected `Platform.recording` service owns permission requests, MediaRecorder and media tracks. Browser and Tauri webviews use the web capability when available; unsupported hosts return an explicit error. Microphone permission is requested only after the recording action. Cancel, errors and obsolete permission results stop tracks. Stopped recordings enter the ordinary durable attachment path with explicit voice-note purpose. There is no browser transcription or live two-way voice.

Tauri permits Blob image/media rendering without enabling uploaded scripts, and macOS includes the microphone usage description. Actual packaged webview recording and OS consent remain unverified; browser synthetic-media tests do not establish desktop support.
