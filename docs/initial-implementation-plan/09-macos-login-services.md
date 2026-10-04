# Decision block 9 — macOS login services

Status: accepted, 2026-10-04. Supersedes the system LaunchDaemon setup in
decision block 8; the Kipster app, its roles and Full Disk Access are unchanged.

## Outcome

The installer registers Core and the updater as per-user login jobs in
`~/Library/LaunchAgents`, loaded into the owner's login session with
`launchctl bootstrap gui/<uid>`. Installation, updates and uninstall need no
sudo. The jobs start when the owner logs in and run until logout, including
while the screen is locked. After a restart nothing runs until the owner logs in.

## Why

A system LaunchDaemon with `UserName` runs as the owner but outside the owner's
login session. Apple's TN2083 and its
[developer forum guidance](https://developer.apple.com/forums/thread/126148)
describe what that session provides and a daemon lacks:

- The login keychain. The Claude CLI keeps its sign-in there, so a daemon
  reports it as signed out. Copying its token elsewhere is not an option:
  Anthropic does not allow apps to store or relay Claude account credentials.
- The GUI, needed to open a browser or show windows for kips.
- macOS consent dialogs.

Desktop apps that run AI coding CLIs in the background (for example T3 Code)
use per-user login jobs for the same reasons.

## Consequences

- An always-on host, such as a Mac reached over Tailscale, stays logged in.
  Locking the screen keeps every job running; anything that captures the
  screen sees only the lock screen.
- After a power cut or restart the owner logs in once; the jobs then start by
  themselves.
- Installations from before this decision are reinstalled; there is no
  migration command before 0.1.0.
