# Decision block 6 — Application assembly and operations

Status: initial direction recorded from discussion, 2026-09-18. Desktop framework and precise platform support remain implementation choices. Node.js is the user's proposed backend runtime; TypeScript on Node.js LTS is the recommended implementation choice.

This block complements blocks 1–5. It describes distribution, setup, and the operating model. Detailed scheduler/memory algorithms, schemas, dependency installation commands, service definitions, and upgrade mechanics are designed during their implementation tasks. This record does not authorize installation or service changes on any machine.

## 1. Backend host and desktop client

Kipster runs on the computer on which its owner installs it. That host runs Core, its execution integrations, and the managed storage/dependencies established in earlier blocks.

The first interface is a separately installed desktop application. It can run on the backend host or on another computer. It connects to the configured backend URL through Tailscale; a client-only computer does not need its own Kipster database or execution harness.

```text
Backend computer
  Core + execution adapters/harnesses + PostgreSQL/pgvector
  Managed Kipster home + configured supporting services
                    |
          Private Tailscale URL
                    |
         +----------+----------+
         |                     |
   Desktop client A      Desktop client B
```

The desktop framework is deliberately undecided. Swift and Flutter are candidates mentioned by the user; select the framework and supported client operating systems when starting the UI task. Distribute a platform-appropriate desktop installer/application rather than treating a Windows `.exe` as a universal format.

"Runs on a computer" describes the deployment model, not a verified promise of support for every operating system. Publish supported host/client platforms with their setup instructions once their dependencies and service integration are validated. Preserve the possibility of other hosts without claiming current cross-platform acceptance.

## 2. AI-guided installation is the entry point

Provide a clear installation instruction file that the user gives to an AI assistant with local setup capabilities. That assistant follows the documented procedure to prepare the machine, install Kipster and its dependencies, configure the installation, and verify readiness.

The host procedure covers:

- Check the platform and prerequisites, and preserve an existing installation.
- Install/configure the supported runtime and Kipster Core distribution.
- Install/configure PostgreSQL with pgvector using the selected Kipster home.
- Install/register the initial execution adapter and prepare its harness dependency.
- Prepare the configured embedding and transcription services.
- Install/configure Tailscale and guide any required human account authorization.
- Bootstrap the installation identity, initial owner, organization, and root admin agent through repeatable operations.
- Register and start the background service and verify its dependencies/readiness.
- Download the desktop application when requested and report the actual private backend URL to enter into its connection settings.

The guide coordinates installable artifacts and repeatable setup commands/scripts; it does not ask the AI to invent an installation from scratch. Package names, release hosting, exact commands, and database packaging are implementation details. Existing decisions that Core and execution adapters are separately installable packages remain in effect.

Bootstrap must work before the root admin agent is operational. An external setup assistant can guide the procedure; runtime administration can then use the root agent. Resume interrupted setup without duplicating identities or replacing authored configuration. Human sign-ins or operating-system consent may still be necessary; do not promise unattended account enrollment.

For another client computer, provide a shorter guide: install/connect Tailscale, install the desktop application, enter the existing backend URL, and verify connectivity. Do not provision another backend merely to add a client.

## 3. Backend technology and packaging

Node.js is the proposed backend runtime. The recommendation is TypeScript for implementation, built/distributed for a supported Node.js LTS release. The orchestration workload consists primarily of HTTP/SSE, database operations, and harness process/API communication. Heavy computation should not block the Core event loop; embeddings and transcription use the configured services/processes.

Maintain these distribution boundaries:

| Deliverable | Purpose |
| --- | --- |
| Installation instruction file | Entry point for AI-guided host/client setup. |
| Core package and setup/service commands | Installable backend and its lifecycle operations. |
| Execution adapter packages | Separately installable integrations using the Core-exported contract. |
| Desktop application release | Independently installed client connecting through the Kipster Protocol. |

The instruction file and backend packages are complementary. A graphical backend installer, package marketplace, or dedicated adapter SDK is not required. Desktop implementation does not need to use the backend language.

Node.js replaces Bun as the current runtime direction; final runtime version and libraries are selected during implementation. No technical requirement identified in this architecture requires moving to another backend language.

## 4. Always-on background operation

The backend is a background service independent of the desktop UI, setup assistant, and any open terminal. Closing the application must not stop accepted work. Register it with the host's service manager so it starts automatically after restart and is supervised after unexpected exit.

Provide inspectable start, stop, restart, and status operations. "Hidden process" means no continuously open application window is required; it does not mean an unmanaged or inaccessible process.

The service must start with its intended user context, home, environment, credentials, and dependency ordering. Exact service mechanisms and boot-versus-login constraints are platform implementation work; validate them explicitly rather than assuming a process that works in an interactive terminal will work unattended. Do not run the harness as an unrestricted system administrator merely to achieve automatic startup.

Startup reconciles saved work before admitting conflicting replacement execution, preserving blocks 2–5. Closing a client, losing Tailscale connectivity, or losing an SSE stream is not a stop command.

Continuous operation requires an awake, running host and available dependencies. Automatic startup does not make work execute while the computer is asleep or powered off. Any sleep-related installation choices must be explicit, not silent changes to the user's machine.

## 5. Connection and scope

The installer reports a verified private HTTPS backend URL. The desktop application stores that URL and connects through the existing HTTP/SSE/file contracts. Detailed Tailscale exposure and connection UX are implementation work. Preserve the initial trusted-owner access mode; no new login or token feature is introduced here.

Detailed framework selection, notifications when closed, installer format, service definitions, package publishing, and operational diagnostics are resolved in their respective implementation tasks. This does not change the durable notification requirements already agreed in block 5.

Memory remains in scope as established in block 4. Scheduling and its triggers retain their separately recorded scope and need subsystem design when undertaken. Neither is expanded or deferred by choosing a deployment model.

## 6. Implementation acceptance direction

- A supported host can be prepared by following the provided guide and setup commands, with required human authorization surfaced.
- Repeating or resuming setup preserves existing data and installation identity.
- Core and the selected adapter can run without an open desktop client or setup terminal.
- Automatic service startup and recovery are verified on the supported host configuration.
- A second computer connects as a client without installing another Kipster backend.
- The connection instructions contain the actual working URL, not an unverified example.
- Host/client support and any login, sleep, or dependency limitations are documented honestly.

## References

- [Node.js production release guidance](https://nodejs.org/en/about/previous-releases).
- [Node.js asynchronous child-process APIs](https://nodejs.org/api/child_process.html).
