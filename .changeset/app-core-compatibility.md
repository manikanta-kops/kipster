---
'@kipster/ui': minor
---

Check protocol compatibility when connecting. The app blocks with "Update the app" or "Update the backend" only when its protocol is outside the backend's range, and rechecks after a reconnect. Settings → About shows the app and backend versions. Unknown event kinds, control frames, work, interaction and operation states, context kinds and error codes now get a neutral fallback instead of breaking the view.
