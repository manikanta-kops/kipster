# Install another Mac client

Install the supplied Kipster app from the release operator's verified artifact.
Unsigned local builds may require signing/notarization before distribution; do
not bypass macOS security prompts as part of automated setup. No published
release URL is implied here.

The client contains no backend, database or provider account. If this Mac is
only a client, do not provision a second installation. Connect Tailscale to the
existing private network with the owner's explicit sign-in, then open Kipster and
enter the verified private HTTPS backend URL. A local host may use a loopback
HTTP address with its configured port. The address is saved on this device and
can be changed from **Connection**, including when the backend is unavailable.
Drafts and unsent operations remain scoped to their original backend,
installation and owner. Changing the address disconnects the old workspace.

If connection fails, check that the host is awake, its service/database are
ready, the URL is correct, and Tailscale is connected. The host must explicitly
allow the Mac app's exact `tauri://localhost` origin and the intended HTTP Host.
Do not work around failure with wildcard/null origins, public exposure or
certificate-verification bypasses. Settings shows actual provider availability;
a reachable backend does not establish a working provider account.

Verify a saved conversation, reconnect/reopen, an attachment and the durable
inbox against the intended installation. A second client reads the same durable
state. Settings → Identity files reads authored files and at most five backups;
restoring checks the current file hash. Archived identities are read-only.

Settings → Desktop can request notification permission only when the user
chooses to enable/test it. Do not grant OS permission on the user's behalf.
Alerts require an open, running app and existing permission; delivery depends
on macOS. Fully closed-app live delivery has no resident helper or push service.
Reopening restores the durable inbox without replaying old desktop alerts.
Native notification click routing is currently unavailable; open the inbox to
visit the original context. Physical microphone and OS consent require separate
human validation. Browser/synthetic-media tests do not establish those behaviors.

For a local development package, use `npm run desktop:build` in the UI package.
The production app uses a configured URL first, then a saved URL, otherwise
connection setup. A build-configured URL is fixed until the app is rebuilt. Demo
builds use a separate app identity and are not an installation test. macOS is the
current release target; Windows/Linux installers and services are not supplied.
