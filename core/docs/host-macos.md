# Set up a Kipster host on macOS

For released packages, use the [macOS installer](../../installer/README.md).
It assembles Core and configured adapters, keeps database backups, and registers
Core and its updater as system LaunchDaemons running as the backend owner.
The lower-level host commands and login-service template below remain available
for manually managed installations; do not register both supervisors.

Give this guide to a local setup assistant. Ask it to inspect every command and
report the configured installation before changing the machine. Installing
software, signing in, registering a service and exposing a private URL are
explicit operator actions. A desktop client alone does not need this setup.

## Prerequisites

Use the Node version declared in the installed Core package (currently
`>=26.10.0 <27`), PostgreSQL with pgvector, and separately installed execution and
transcription adapters. macOS is the current validation platform. Windows/Linux
service installation is not supplied. Do not run the backend as root.

Prepare a private PostgreSQL database and its login. Install the `vector`
extension in that database. Core manages its own schema on setup. Task-data SQL
uses a separate restricted login, configured as `taskDataUrl`; follow the Core
README for its role grants. Database/source data belongs to this installation and must
survive unavailable providers. Do not substitute demo adapters or embeddings.

Install the supplied Core and adapter packages into an explicit local package
installation, using their actual supplied tarball paths. No release registry or
download URL is implied by this guide. Inspect package versions and exports.
Choose a short absolute Kipster home (macOS local socket paths are limited).
Keep the host configuration private (`chmod 600`). For example:

```json
{
  "version": 1,
  "home": "/absolute/path/kipster",
  "databaseUrl": "postgresql://kipster@localhost/kipster",
  "listen": {
    "host": "127.0.0.1",
    "port": 43120,
    "allowedHosts": ["your-host.your-network.ts.net"],
    "allowedOrigins": ["tauri://localhost"]
  },
  "adapters": [],
  "environment": { "PATH": "/absolute/runtime/bin:/usr/bin:/bin" }
}
```

`databaseUrl` is the PostgreSQL connection string, and the optional `taskDataUrl`
is the restricted task-data login. Both may contain credentials, so the
configuration file must remain private. Never put them in command-line arguments
or a public report. The generated service template contains no credential values.
launchd does not source shell profiles, so set `PATH` in `environment`.

Add execution adapters as `{ "id": "codex-cli", "root":
"/absolute/package/installation", "entry": "node_modules/@kipster/codex-cli/dist/index.js" }`
using the actual installed export path. The root includes the adapter's complete
dependency installation. An optional `config` object belongs to the adapter; Core
passes it through without interpreting provider settings. Core gives each adapter
a private data directory, `<home>/providers/<adapter id>`. Codex runs with the
execution user's Codex home and login. Follow
the adapter's configuration/authentication guide; provider sign-in requires the operator. The first configured adapter is the default: agents without their
own adapter and model use it with its default model. Change settings through
Kipster after discovery.

Configure memory with `embedding: { "module": "/absolute/path/to/embedding-ollama/dist/index.js",
"options": { "endpoint": "http://127.0.0.1:11434", "model": "nomic-embed-text" } }`
when that model is installed. An optional `apiKeyEnv` in options names a bearer-token
environment variable. Changing the provider ID or model re-embeds all retained memory
and vector text on the next start; searches use only the new generation.

Configure Spokenly with `transcription: { "module": "/absolute/path/to/adapter/dist/index.js",
"options": { "executable": "/absolute/path/to/spokenly",
"ffmpegExecutable": "/absolute/path/to/ffmpeg", "timeoutMs": 60000,
"maxOutputBytes": 1048576 } }`.
Install FFmpeg separately to enable conversion of WebM and other unsupported
inputs. Compatible formats are passed through with a suitable temporary filename;
original artifacts are preserved.
The adapter selects no fallback and downloads no model. Configure its supported
recognition route explicitly; microphone consent is separate from a CLI check.

## Inspect and start

Use the installed `kipster-host` binary (or `node /absolute/core/dist/host.js`).
Replace `host.json` with the absolute private configuration path:

```sh
kipster-host doctor --config host.json
kipster-host setup --config host.json
kipster-host doctor --config host.json --probe
kipster-host serve --config host.json
```

`doctor` is passive: bounded database and file/configuration checks, with provider
readiness explicitly marked unprobed. `--probe` can launch the configured
harness, access its account, invoke a CLI and send synthetic embedding text to
the configured provider; obtain operator authorization first. No conversation or
microphone recording is part of the probe. `serve` likewise initializes configured
providers. The first setup creates the installation: the owner, the Playground
organization, the Admin agent, and the Planner, Researcher, Writer and Coach
agents in the Team and Personal groups, each with starter instructions. Setup
repeats bootstrap without replacing authored identity files or changing
installation identity. Stop this installation before repeating setup.

Foreground `serve` is the service-manager entry point. It initializes storage,
registers configured adapters, reconciles durable work, then opens the listener.
Provider failures remain visible; a missing adapter is not replaced with a
fixture. In a terminal, Ctrl-C shuts down the owned host. For local operation:

```sh
kipster-host start --config host.json
kipster-host status --config host.json
kipster-host restart --config host.json
kipster-host stop --config host.json
```

Commands address a private installation-local control socket and instance token.
They never find/kill a port owner or signal a PID read from an ownership file.
Start and stop are idempotent. An occupied port fails without disturbing its
owner. Unexpected death can leave `.host-control`; commands deliberately refuse
to reclaim it automatically. Inspect status, logs and the recorded process,
verify no startup/host still owns that home, and only then have the operator
remove that stale directory. Preserve the rest of the home and database.

## Login service and private access

Generate an inspectable template, then review it before any registration:

```sh
kipster-host service-template --config host.json > kipster-host.plist
plutil -lint kipster-host.plist
```

Create the private `logs` directory under the home. The template invokes the
exact Node/CLI/config paths, uses a restrictive umask, and writes home-local logs.
Install it as a per-user LaunchAgent only with explicit authorization. It starts
at login, not before login, and restarts after unsuccessful exit. A normal stop
does not request automatic restart. Use the rendered label with explicit
`launchctl bootstrap gui/$(id -u)`, `kickstart`, or `bootout` operator commands
when managing the registered job; never register both another supervisor and a
second copy of Core. Local CLI start is a detached convenience, not a replacement
for login supervision. Templates and disposable process tests do not establish
installed-service behavior. An awake, powered host and available dependencies
are required; this setup does not change sleep settings.

For other devices, explicitly configure Tailscale private HTTPS to proxy to the
loopback listener. Do not use public exposure/Funnel. Preserve the exact Host
allowlist for the proxy's chosen forwarding behavior; never trust forwarded
identity headers. The packaged Mac client sends `tauri://localhost`, which must
be explicitly allowed. Null and wildcard origins remain disallowed. A local
application origin is not multi-user authentication: this is the trusted-owner
private-network deployment model. Verify the actual HTTPS URL from another
client before reporting it as ready. Do not infer private-network or service
installation success from a rendered template or loopback fixture.
