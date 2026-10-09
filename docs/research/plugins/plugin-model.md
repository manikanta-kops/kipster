# Kipster plugin model

Status: research. This document describes what a Kipster plugin is, how it
connects to a person's accounts, which paths a service can take and how a
plugin would be checked before shipping. It proposes no implementation and
changes no product behavior.

Specification facts were checked against the sources linked below on
2026-10-08. **Unconfirmed** marks statements no primary source confirmed;
**Estimate** marks judgement, not measurement. The classes and paths below are
applied to 1,738 services in [catalog.csv](catalog.csv); [README.md](README.md)
has the counts (287 class A, 341 B, 219 C, 63 D and 828 E).

## 1. What a Kipster plugin is

A plugin lets kips work with one outside service, such as Notion or Todoist,
through the person's own account. It has three parts:

| Part | What it is | Standard |
| --- | --- | --- |
| Skills | Instructions that tell a kip how to do common jobs with the service, such as "plan my week from Todoist". | `SKILL.md` files in the [Agent Skills format](https://agentskills.io/specification): YAML front matter with a required `name` and `description`, then Markdown. |
| Tools | Callable operations, such as "search pages" or "create task", served by an MCP server. The service's official server is preferred. | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) tools. |
| Connection | The person's signed-in account. Kipster Core runs the sign-in and keeps the tokens on the person's Mac. | [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (OAuth 2.1), or an API key or personal token where the service offers one. |

### How it fits Kipster

Core owns state, sign-in and tokens. It defines the Kipster tools every
execution gets (`core/src/workflows/agent-tools.ts`) and names skill files in a
run's instructions (`core/src/workflows/skills.ts`); adapters pass Core's tools
through and define none, and skills and tools stay separate (decision record 3).
A plugin fits the same shape:

```text
Kip in a harness (Codex, Claude Code, ...)
  `-- plugin tool call -> adapter -> Kipster Core
                                      |  adds the person's token
                                      v
                                   Service MCP server (vendor-hosted or local)
```

Core acts as the MCP client: it holds the token and calls the service's MCP
server, and it offers that server's tools to executions alongside Kipster tools.
The harness and the model never see the token. Core lists the plugin's skills in
the run's instructions the same way it lists `kipster-admin` today. How Core
names, scopes and approves plugin tools is design work for a later step.

### The open plugin layout

**Agent Plugins 1.0.0** exists under that name. Its [specification](https://agent-plugins.org/specification)
defines a plugin as a directory with:

- `plugin.json` at the root (required). Only `$schema` and `name` are required;
  the optional fields are `version`, `description`, `author`, `homepage`,
  `repository`, `license`, `keywords` and `extensions`. No other top-level
  field is allowed; a client reports and ignores one it finds.
- `skills/<name>/SKILL.md` (optional), in the Agent Skills format.
- `mcp.json` (optional), listing MCP servers of type `stdio`,
  `streamable-http` or legacy `sse`.
- Client-specific additions in reverse-domain folders and under
  `extensions.<reverse-domain>` in `plugin.json`.

The specification states that it defines no OAuth configuration or portable
credential fields, and that plugins must not put secrets in `env` or headers.
The connection part of a Kipster plugin therefore lives outside the portable
files: in Core's own catalog, or under a Kipster `extensions` namespace. That
namespace needs a reverse-domain name the project controls, which is not chosen
yet.

Client support, as published:

- **Codex and ChatGPT:** listed as [compatible clients](https://agent-plugins.org/compatible-clients).
  OpenAI's [packaging guide](https://developers.openai.com/plugins/build/plugins)
  makes root `plugin.json` the portable entry point, keeps
  `.codex-plugin/plugin.json` as a compatibility fallback and says it also
  accepts Claude-compatible manifests.
- **Claude Code:** **Unconfirmed.** It is not on the compatible-clients list;
  its [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)
  uses `.claude-plugin/plugin.json` and `.mcp.json` (remote transports `http`,
  `sse` or `ws`) with the same `skills/<name>/SKILL.md` folder. Whether it reads
  a root `plugin.json` or `mcp.json` was not found in its documentation.

Illustrative layout for a Notion plugin:

```text
notion/
├── plugin.json
├── mcp.json
└── skills/notion-pages/SKILL.md
```

`plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "notion",
  "version": "0.1.0",
  "description": "Find, read and update Notion pages with the person's own Notion account.",
  "keywords": ["notes", "docs"]
}
```

`mcp.json`, pointing at Notion's vendor-hosted server:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "notion": { "type": "streamable-http", "url": "https://mcp.notion.com/mcp" }
  }
}
```

## 2. Connection classes

Every service is placed in one class by what the person and the Kipster project
must do before a kip can use it.

| Class | Name | What the person does | What the Kipster project does | Reference points |
| --- | --- | --- | --- | --- |
| A | Plug in the MCP | Clicks Connect and signs in in the browser. | Nothing per service. The service has an official MCP (vendor-remote or vendor-local) whose sign-in accepts a client ID metadata document (`oauth-cimd`) or dynamic client registration (`oauth-dcr`), with no app registration, review, allowlist or paid API tier. | Notion, Linear, Todoist, Airtable, Trello |
| B | One-time free setup | Creates and pastes a free self-serve key or token, installs or turns on the vendor's local MCP, or signs in through the project's registered app. | Registers one free developer app once, with no vendor review, and ships its client ID (for a public API or an MCP that needs a pre-registered client); or nothing, when the person's key, token or local server is enough. | GitHub and Asana (pre-registered client), Bitwarden (personal token), 1Password (local server), Microsoft personal accounts (Graph) |
| C | Review or gate | Same as A or B once access is granted. | Passes a vendor review, marketplace listing, allowlist, waitlist, invitation, sales contact or partner programme, or waits for a paused MCP to return. Includes vendors that closed new app creation but document a partner route. | Slack (directory-published or internal apps only), Monarch Money (MCP paused) |
| D | Paid or audit | May need a paid plan. | Pays for an API tier (including a plan whose product is the API itself; every `paid-api` row is class D), passes a security audit such as Google's CASA, or completes business verification such as Meta's. | Gmail and full Google Drive (restricted scopes), Perplexity (metered MCP) |
| E | No public API | Cannot connect through an API. | Nothing available: no public API, or one that accepts no new apps and has no partner route; see section 3. | Services with no API |

What each class means:

- **A** scales with no per-service paperwork: Core needs only Kipster's own
  client identity. An open public beta or preview with no access gate counts.
- **B** is free and needs no vendor decision, but either the project owns one
  app registration under its name and must keep it working (Microsoft's
  [app registration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
  offers "Personal accounts only" with a free Azure account), or Core stores a
  key or token, or starts a local server. Client credentials a customer's own
  admin creates count as pre-registered; the project registers nothing.
- **C** depends on a vendor decision, can take an unknown time and can be
  refused. Slack's [MCP server documentation](https://docs.slack.dev/ai/mcp-server)
  allows only directory-published or internal apps. Customer-side admin
  switches inside the person's own organisation are not a vendor gate.
- **D** costs money or a recurring audit. Google's restricted scopes, such as
  `gmail.readonly` and full `drive` ([Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes),
  [Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)),
  need a security assessment at least every 12 months for apps reaching the
  data "from or through a third-party server" ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification));
  Meta requires [business verification](https://developers.facebook.com/docs/development/release/business-verification)
  for advanced access. An ordinary subscription that includes API or MCP access
  is `user-paid-plan`, not class D.
- **E** cannot become a tool plugin; at most an `other` path applies.

### Observed sign-in metadata

Public discovery metadata on 2026-10-08, read with unauthenticated GET requests
only. MCP URLs come from vendor documentation or, for Notion, the server's own
metadata.

| Service | MCP server | Registration endpoint (DCR) | Client ID metadata documents | Token endpoint auth methods | Class |
| --- | --- | --- | --- | --- | --- |
| Notion | `https://mcp.notion.com/mcp` | yes | yes | `none`, client secret | A |
| Linear | `https://mcp.linear.app/mcp` | yes | yes | `none`, client secret | A |
| Todoist | `https://ai.todoist.net/mcp` | yes | yes | `none`, client secret | A |
| Airtable | `https://mcp.airtable.com/mcp` | yes | yes | `none`, client secret | A |
| Trello | `https://mcp.trello.com/v1` | yes | yes | `none`, client secret, `private_key_jwt` | A |
| GitHub | `https://api.githubcopilot.com/mcp/` | no | not advertised | not advertised | B |
| Asana | `https://mcp.asana.com/v2/mcp` | no | not advertised | client secret only | B |
| Slack | `https://mcp.slack.com/mcp` | no | not advertised | client secret only | C |

All eight advertised PKCE with `S256`. The Todoist URL is named in Doist's
[Todoist MCP repository](https://github.com/Doist/todoist-mcp).

### How MCP sign-in works

In plain language, under MCP [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):

1. **Ask and get turned away.** Core calls the MCP server without a token; the
   server answers `401` with a `WWW-Authenticate` header pointing to its
   protected resource metadata.
2. **Find the sign-in server.** Core reads `/.well-known/oauth-protected-resource`
   ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), which names the
   authorization server and expected scopes ([discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)),
   then that server's metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414),
   or OpenID Connect discovery): endpoints, PKCE support and client
   identification methods.
3. **Introduce Kipster.** In the specification's [priority order](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration):
   a client ID registered in advance (class B); a [client ID metadata document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00),
   an HTTPS URL of a small public JSON document describing Kipster and its
   redirect addresses; or dynamic client registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)).
   Version 2026-07-28 deprecates dynamic registration in favor of metadata
   documents and keeps it for older servers ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
4. **Sign in with PKCE.** Core sends only the hash of a one-time secret in the
   browser sign-in link ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)) and
   names the MCP server as the resource ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)).
   Clients must refuse a server that does not advertise `S256`
   ([security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).
5. **Trade the code.** The browser returns a one-time code; Core checks the
   issuer ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)) and trades the
   code plus the secret for an access token and usually a refresh token.
6. **Use the token.** Core sends `Authorization: Bearer <token>` on every
   request and refreshes it, keeping credentials per authorization server.

Class A means steps 3 to 6 need no work from the project beyond Kipster's own
client identity. With client ID metadata documents, the project hosts one
static public JSON document at a stable HTTPS URL; it holds no personal data.

### Kipster on the Mac as the OAuth client

Kipster is a native app in OAuth terms ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)):

- **Loopback redirect.** Core listens briefly on `http://127.0.0.1:<port>/…`
  and opens the sign-in page in the browser. The service redirects back to that
  address; authorization servers must accept any port for loopback redirects
  (RFC 8252 section 7.3).
- **Public client.** A secret shipped inside an installed app is not a secret;
  servers that require one must still treat the app as a public client
  (RFC 8252 section 8.5). Asana and Slack advertise only client-secret methods,
  so how Kipster signs in to them needs checking before either plugin is
  planned.
- **Token storage.** Core keeps tokens in the macOS Keychain
  ([Keychain Services](https://developer.apple.com/documentation/security/keychain-services)),
  not in the database, settings or browser storage, as Claude Code does for MCP
  client secrets ([Claude Code MCP](https://code.claude.com/docs/en/mcp)).

### API keys and personal tokens

Some services also accept a personal token instead of OAuth: Linear accepts an
API key as a bearer token ([Linear](https://linear.app/docs/mcp)), Airtable
accepts personal access tokens ([Airtable](https://airtable.com/developers/agents/mcp/getting-started))
and GitHub's server accepts a personal access token
([GitHub MCP server](https://github.com/github/github-mcp-server)). Trello
does not support API tokens for MCP connections
([Atlassian](https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/)).
A token is a fallback when OAuth is not workable: the person creates and pastes
it, and Core stores it in the Keychain and sends it as a header or passes it in
the environment of a local `stdio` server, as the MCP specification tells local
servers to get credentials. Tokens are often broader and longer-lived than
OAuth grants, so the person should be told what they grant. A service whose
official MCP is reached only with a key, a token, a local install or no sign-in
is class B, not A.

## 3. Plugin paths

Each service takes one path.

| Path | What Kipster builds | Where it runs | Where data goes | Typical example |
| --- | --- | --- | --- | --- |
| `mcp` | `plugin.json`, `mcp.json` pointing at the official server, and skills. | Vendor-hosted server, called by Core on the Mac; or the vendor's local server started by Core. | Between the Mac and the service. | Notion's `https://mcp.notion.com/mcp`. |
| `api` | A small MCP server or set of tools on the service's documented public API, plus skills. | Locally on the Mac, as a `stdio` server or inside Core. | Between the Mac and the service's API. | A service with a documented REST API and OAuth or personal keys but no MCP server (illustrative). |
| `other` | Tools on a local or standard interface instead of a cloud API. | On the Mac, or on the person's own device. | Stays on the person's devices, goes to their own mail or calendar provider, or arrives from the service as a file. | See below. |
| `not-feasible` | Nothing. | — | — | No qualifying route anywhere: no usable API and none of the `other` routes below. |

The `other` path is a documented route to the person's own data for that
service; routes limited to some countries or states count, with the limit noted
in the catalog. It covers:

- **Mac and Apple routes:** apps that support AppleScript
  ([guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html))
  or [App Intents](https://developer.apple.com/documentation/appintents), the
  vendor's Shortcuts actions, and devices in Apple Home. iPhone-only App Intents
  would need a Kipster app or shortcut on the phone (**Unconfirmed**
  feasibility).
- **The person's own exported data:** an archive the person downloads, a copy
  the service sends through a documented data-request flow, or the person's own
  content saved as files. Read-only and as fresh as the last export. A bare
  statement of legal access rights with no way to receive a copy does not count.
- **Mailbox emails that carry the service's data:** statements, ride receipts,
  order, delivery or booking confirmations and bills, read over IMAP
  ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051)). Subscription billing
  and account-status emails do not count.
- **Calendar and feed standards:** CalDAV ([RFC 4791](https://www.rfc-editor.org/rfc/rfc4791)),
  CardDAV ([RFC 6352](https://www.rfc-editor.org/rfc/rfc6352)), ICS feeds
  ([RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)) and the service's own
  RSS, signed in with an app-specific password or read without sign-in.
- **An official CLI** the person installs and signs in to, such as GitHub's `gh`.

**Aggregators are excluded.** Services such as Composio, Pipedream, Arcade,
Zapier, n8n cloud or Airbyte's hosted Agent MCP would let one connection reach
many services, but every request and its personal data would pass through, and
often be stored by, a third party's cloud, which would also hold the person's
tokens. This breaks the rule that tokens stay on the person's Mac and that data
flows only between the Mac and the service the person chose. A data or
automation platform's own account (its pipelines, flows or settings) can be a
plugin when the route does not proxy other services' data; the catalog flags
those rows. A service's own vendor-hosted MCP server is not an aggregator.

## 4. How a plugin is checked before shipping

Research level only; none of these checks exist yet.

| Check | What it does | Needs an account | When |
| --- | --- | --- | --- |
| Manifest | Validates `plugin.json` and `mcp.json` against the Agent Plugins [JSON Schemas](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json), each `SKILL.md` against the Agent Skills rules, and any Claude Code or Codex overlay with that client's validator (for example `claude plugin validate`). | No | Every change |
| Connection probe | Reads the protected resource and authorization server metadata, confirms PKCE `S256` and the expected class (metadata document, dynamic registration or pre-registered client), and records the scopes offered. | No | Every change and on a schedule |
| Tool listing | After sign-in, asks the server what it supports and lists its tools. Servers on MCP 2026-07-28 answer [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), which replaced the `initialize` handshake; older servers still need `initialize`, so the probe must handle both. Every tool a skill names must exist with a compatible input schema. | Yes | Every change and on a schedule |
| Test sign-in | Completes a real sign-in with a project-owned test account, never a person's or owner's account, and checks that the token works and refreshes. | Yes | Before release and on a schedule |
| Smoke task | A kip performs one read-only task end to end, such as "list my three most recent pages", with write tools withheld, and the result is checked. | Yes | Before release |

**Re-checking and pinning.** Vendor MCP servers change without notice, so a
scheduled job re-runs the probe (often) and the signed-in checks (less often).
Each release records the tool names and a hash of their input schemas; a
difference marks the plugin for review instead of silently shipping changed
behavior. MCP 2026-07-28 asks servers for a deterministic tool order and a
freshness hint (`ttlMs`), which makes this simpler.

## 5. Adding a plugin when an official MCP server exists

Core first needs the shared parts once: an MCP client, the OAuth flow, Keychain
storage, plugin loading and the checks above. That is platform work, not
per-plugin work. With it in place, a class A plugin takes these steps:

1. Confirm the official MCP server URL on the vendor's own documentation.
2. Run the connection probe and confirm class A: a client ID metadata document
   or dynamic registration is advertised, along with PKCE `S256`, and the
   vendor documents no allowlist, waitlist or approval for new clients.
3. Write `plugin.json` and `mcp.json`.
4. Sign in with the test account, list the tools, decide which are read and
   which are write actions, and pin the list.
5. Write one to three skills for the jobs people actually ask for, naming the
   tools they use and saying when to ask the person first.
6. Run the manifest check and the smoke task, then add the plugin to the
   catalog.

**Estimate:** about half a day to a day per class A service, most of it spent on
skills and checking tool behavior.

What changes for other classes:

- **B with a key, token or local server:** confirm in step 2 that the vendor
  documents self-serve keys or the local server; Core stores the key in the
  Keychain or starts the server. About the effort of class A (**Estimate**).
- **B with a pre-registered client:** before step 2, the project registers one
  developer app through an owner account, outside any automated work, and
  records its client ID and redirect addresses. Add about a day once, plus
  ongoing ownership of the app and its terms (**Estimate**). If the service
  requires a client secret, decide first how a desktop app can sign in (see
  section 2, Kipster on the Mac as the OAuth client).
- **C:** all of B, plus a vendor review or access request that may ask for a
  company entity, privacy policy, security answers or a demo. Approval is not
  certain; plan in weeks to months (**Estimate**).

## 6. Risks and open questions

- **Vendor MCP stability and specification churn.** Servers are young; tool
  names and arguments move between releases, and MCP 2026-07-28 removed the
  `initialize` handshake and deprecated dynamic client registration. Scheduled
  checks and pinned tool lists reduce breakage, and Kipster must support older
  and newer servers at once.
- **Tool count and context size.** Some servers expose dozens of tools that take
  model context on every run. Remedies: offer only the tools the run's skills
  use, read-only variants (Linear's `https://mcp.linear.app/mcp/readonly`) and
  server toolsets (GitHub's `GITHUB_TOOLSETS`).
- **Broad scopes and write actions.** Request the fewest scopes and show them
  before sign-in (Slack's metadata lists about thirty). Creating, changing,
  sending or deleting goes through Core's approval flow until the person grants
  it; which tools write must be recorded per plugin, because MCP does not
  guarantee it.
- **Rate limits and terms.** Several kips sharing one account can hit a
  service's limits. Some API terms restrict AI use or sending data to model
  providers; check them before shipping.
- **Data leaves the Mac for the model.** Tokens stay local, but tool results go
  to the AI provider that runs the kip. Whether that counts as "through a
  third-party server" under Google's restricted-scope policy is **Unconfirmed**;
  it decides whether a local Gmail plugin needs a CASA assessment.
- **Local vs remote MCP.** Prefer the vendor-hosted server; a local server keeps
  more on the Mac but needs packaging, updates and credentials in its
  environment.
- **Remote interfaces and loopback sign-in.** A loopback redirect works only in
  a browser on the Mac that runs Core, so sign-in from another device needs a
  design.
- **Client identity.** Client ID metadata documents need a stable public HTTPS
  URL owned by the project, and the `extensions` namespace a reverse-domain
  name; neither is chosen. Whether Claude Code reads the open layout is
  unconfirmed (section 1).

## Sources

Sources linked in the text above are not repeated here.

Plugin formats:

- Agent Plugins home: <https://agent-plugins.org/>
- Agent Plugins MCP schema: <https://agent-plugins.org/schemas/1.0.0/mcp.schema.json>
- Agent Plugins 1.0 announcement (GitHub Changelog): <https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/>
- OpenAI plugin authentication: <https://developers.openai.com/plugins/build/auth>

Vendors and platforms:

- Notion MCP: <https://developers.notion.com/docs/mcp>
- Asana MCP server: <https://developers.asana.com/docs/using-asanas-mcp-server>

Discovery metadata read on 2026-10-08 (GET only):

- <https://mcp.notion.com/.well-known/oauth-protected-resource/mcp>
- <https://mcp.linear.app/.well-known/oauth-protected-resource/mcp>
- <https://ai.todoist.net/.well-known/oauth-protected-resource/mcp>
- <https://mcp.airtable.com/.well-known/oauth-protected-resource>
- <https://mcp.trello.com/.well-known/oauth-protected-resource/v1>
- <https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/>
- <https://mcp.asana.com/.well-known/oauth-protected-resource/v2>
- <https://mcp.slack.com/.well-known/oauth-protected-resource>
