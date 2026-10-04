---
"@kipster/installer": minor
"@kipster/core": patch
"@kipster/claude-cli": patch
---

Core and the updater now run as per-user login jobs in `~/Library/LaunchAgents` instead of system LaunchDaemons, so installation, updates and uninstall no longer need sudo. They start when you log in and keep running while the screen is locked. Running in your login session gives kips your login keychain, so the Claude CLI's normal sign-in works, and the GUI for browsers. After a restart, Kipster starts once you log in. Reinstall existing installations; `repair-services` is removed.
