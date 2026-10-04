---
"@kipster/installer": minor
---

Run Core and the updater through a signed Kipster backend app, so macOS shows
their file access, and that of everything kips run, as Kipster instead of node.
One Full Disk Access grant now survives Node, Core and installer updates.
Add `kipster permissions` to open Full Disk Access for Kipster, `kipster runtime
--node` to switch Node without changing system jobs, and `kipster repair-services`
to move existing installations to the Kipster app. Release builds sign, notarize
and staple the app and refuse to publish it unsigned.
