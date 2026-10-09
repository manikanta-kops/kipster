# Kipster plugin model

Status: research. This document describes what a Kipster plugin is, how it
connects to a person's accounts, which paths a service can take and how a
plugin would be checked before shipping. It proposes no implementation and
changes no product behavior.

Specification facts were checked against the sources listed at the end on
2026-10-08. Statements marked **Unconfirmed** could not be confirmed from a
primary source. Statements marked **Estimate** are judgement, not measurement.

The classes and paths below are applied to 1,738 services in
[catalog.csv](catalog.csv), summarized in [README.md](README.md): 417 are class
A, 227 B, 204 C, 62 D and 828 E; 508 take path `mcp`, 348 `api` and 848
`other`, and 34 are not feasible.

## 1. What a Kipster plugin is

A plugin lets kips work with one outside service, such as Notion or Todoist,
through the person's own account. It has three parts:

| Part | What it is | Standard |
| --- | --- | --- |
| Skills | Instructions that tell a kip how to do common jobs with the service, such as "plan my week from Todoist". | `SKILL.md` files in the [Agent Skills format](https://agentskills.io/specification): YAML front matter with a required `name` and `description`, then Markdown. |
| Tools | Callable operations, such as "search pages" or "create task", served by an MCP server. The service's official server is preferred. | [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) tools. |
| Connection | The person's signed-in account. Kipster Core runs the sign-in and keeps the tokens on the person's Mac. | [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) (OAuth 2.1), or an API key or personal token where the service offers one. |

### How it fits Kipster

Core owns state, sign-in and tokens. It already defines the Kipster tools every
execution gets (`core/src/workflows/agent-tools.ts`) and names skill files in a
run's instructions (`core/src/workflows/skills.ts`); execution adapters pass
Core's tools to their harness and define none of their own. Skills and tools
stay separate, as decision record 3
(`docs/initial-implementation-plan/03-execution-adapters-and-agent-capabilities.md`)
requires.

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
- **Claude Code:** **Unconfirmed.** Claude Code is not on the compatible-clients
  list, and its [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)
  describes its own layout: the manifest at `.claude-plugin/plugin.json` and MCP
  servers in `.mcp.json`, with remote transports named `http`, `sse` or `ws`.
  The `skills/<name>/SKILL.md` folder is the same in both layouts. A plugin that
  must load in Claude Code today would add a `.claude-plugin/plugin.json`
  manifest; whether Claude Code reads a root `plugin.json` or `mcp.json` was not
  found in its documentation.

Illustrative layout for a Notion plugin:

```text
notion/
├── plugin.json
├── mcp.json
└── skills/
    └── notion-pages/
        └── SKILL.md
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
    "notion": {
      "type": "streamable-http",
      "url": "https://mcp.notion.com/mcp"
    }
  }
}
```

`skills/notion-pages/SKILL.md`:

```markdown
---
name: notion-pages
description: Find, summarize and update the person's Notion pages. Use when they mention Notion, a Notion page or their notes there.
---

Search before you read. Ask before you create, move or change a page.
```

## 2. Connection classes

Every service is placed in one class by what the person and the Kipster project
must do before a kip can use it.

| Class | Name | What the person does | What the Kipster project does | Reference points |
| --- | --- | --- | --- | --- |
| A | Instant | Clicks Connect and signs in in the browser, or pastes a free self-serve key or token. | Nothing per service. The service has an official vendor MCP; Kipster identifies itself with a client ID metadata document or registers itself automatically (dynamic client registration), or Core stores the person's key. | Notion, Linear, Todoist, Airtable, Trello |
| B | Register once | Same as A, or creates a free self-serve key for a public API. | Registers one free developer app with the service once, with no review, and ships its client ID with Kipster: for a public API, or for an MCP that needs a pre-registered client. | GitHub, Asana, Microsoft personal accounts |
| C | Review | Same as A once approved. | Passes a vendor review, marketplace listing, allowlist, partner programme or waitlist before anyone can connect, including where the vendor closed new app creation but documents a partner route. | Slack (directory-published or internal apps only) |
| D | Paid or audit | May need a paid plan. | Pays for an API tier (including a paid plan whose product is the API itself), passes a security audit such as Google's CASA, or completes business verification such as Meta's. | Gmail and full Google Drive (restricted scopes) |
| E | No public API | Cannot connect through an API. | Nothing available: there is no public API, or it no longer accepts new apps and has no partner route; see section 3, Plugin paths. | Services with no API |

What each class means:

- **A** scales with no per-service paperwork. It is the target for most
  plugins.
- **B** puts one long-lived app registration under the project's name. The
  project accepts the service's developer terms, owns the app and must keep it
  working. Microsoft's [app registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)
  offers a "Personal accounts only" account type and needs an Azure account,
  which can be created for free. OAuth client credentials that a customer's own
  admin creates also count as pre-registered, but the project registers nothing.
- **C** depends on a vendor decision, can take an unknown time and can be
  refused. Slack's [MCP server documentation](https://docs.slack.dev/ai/mcp-server)
  says only directory-published or internal apps may use MCP, and that
  unlisted apps may not.
- **D** costs money or a recurring audit. Google classes `gmail.readonly`,
  `gmail.modify` and the full `drive` scope as restricted
  ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
  [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
  Restricted scopes need restricted-scope verification, and apps that can reach
  that data "from or through a third-party server" need a security assessment
  at least every 12 months ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
  Meta requires [business verification](https://developers.facebook.com/docs/development/release/business-verification)
  for advanced access. A service stays in class B with a paid plan only when
  the person's ordinary subscription includes API access.
- **E** cannot become a tool plugin; at most an `other` path applies.

### Observed sign-in metadata

The table shows what each service's public discovery metadata advertised on
2026-10-08. It was read with unauthenticated GET requests only; nothing was
registered and no one signed in. MCP URLs come from vendor documentation or,
for Notion, from the resource the server's own metadata names.

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

All eight advertised PKCE with `S256`. Todoist's sign-in runs on `todoist.com`,
Airtable's on `airtable.com` and Trello's on `auth.atlassian.com`; the others
run on the MCP host or the service's main site. The Todoist URL is named in
Doist's own [Todoist MCP repository](https://github.com/Doist/todoist-mcp).

### How MCP sign-in works

The current MCP specification is version
[2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
In plain language:

1. **Ask and get turned away.** Core calls the MCP server without a token. The
   server answers `401 Unauthorized` with a `WWW-Authenticate` header that
   points to its protected resource metadata.
2. **Find out who signs people in.** Core reads the protected resource metadata
   at `/.well-known/oauth-protected-resource` ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)).
   It names the authorization server and the scopes the server expects
   ([discovery rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)).
3. **Learn how that sign-in works.** Core reads the authorization server
   metadata at `/.well-known/oauth-authorization-server` ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)),
   or OpenID Connect discovery as a fallback: endpoints, PKCE support and how
   clients may identify themselves.
4. **Introduce Kipster.** In the specification's
   [priority order](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration):
   a client ID registered in advance (class B); a
   [client ID metadata document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00),
   where Kipster's client ID is an HTTPS URL of a small public JSON document
   describing Kipster and its redirect addresses; or dynamic client
   registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)), where Kipster
   registers itself by request. Version 2026-07-28 deprecates dynamic client
   registration in favor of metadata documents and keeps it for older servers
   ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
5. **Sign in with PKCE.** Core creates a one-time secret, sends only its hash
   in the browser sign-in link ([PKCE, RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)),
   and names the MCP server as the intended resource
   ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). The specification
   requires `S256` and tells clients to refuse a server that does not advertise
   PKCE ([security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)).
6. **Come back with a code.** The browser returns to Kipster with a one-time
   code. Core checks the issuer ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)),
   then trades the code plus the original secret for an access token and
   usually a refresh token.
7. **Use the token.** Core sends `Authorization: Bearer <token>` on every MCP
   request and refreshes it when it expires. Credentials are kept per
   authorization server and never reused with another one.

Class A means steps 4 to 7 need no work from the project beyond Kipster's own
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
- **Token storage.** Core keeps access and refresh tokens in the macOS Keychain
  ([Keychain Services](https://developer.apple.com/documentation/security/keychain-services)),
  not in the database, settings or browser storage. Other clients do the same;
  Claude Code, for example, stores MCP client secrets in the macOS keychain
  ([Claude Code MCP](https://code.claude.com/docs/en/mcp)).

### API keys and personal tokens

Some services also accept a personal token instead of OAuth: Linear accepts an
API key as a bearer token ([Linear](https://linear.app/docs/mcp)), Airtable
accepts personal access tokens ([Airtable](https://airtable.com/developers/agents/mcp/getting-started))
and GitHub's server accepts a personal access token
([GitHub MCP server](https://github.com/github/github-mcp-server)). Trello
does not support API tokens for MCP connections
([Atlassian](https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/)).
A token is a fallback when OAuth is not workable: the person creates and pastes
it, Core stores it in the Keychain and sends it as a header, or passes it in the
environment of a local `stdio` server, which is how the MCP specification tells
local servers to get credentials. Tokens are often broader and longer-lived than
OAuth grants, so the person should be told what they grant.

## 3. Plugin paths

Each service takes one path.

| Path | What Kipster builds | Where it runs | Where data goes | Typical example |
| --- | --- | --- | --- | --- |
| `mcp` | `plugin.json`, `mcp.json` pointing at the official server, and skills. | Vendor-hosted server, called by Core on the Mac; or the vendor's local server started by Core. | Between the Mac and the service. | Notion's `https://mcp.notion.com/mcp`. |
| `api` | A small MCP server or set of tools on the service's documented public API, plus skills. | Locally on the Mac, as a `stdio` server or inside Core. | Between the Mac and the service's API. | A service with a documented REST API and OAuth or personal keys but no MCP server (illustrative). |
| `other` | Tools on a local or standard interface instead of a cloud API. | On the Mac, or on the person's own device. | Stays on the person's devices, goes to their own mail or calendar provider, or arrives from the service as a file. | See below. |
| `not-feasible` | Nothing. | — | — | No qualifying route anywhere: no usable API and none of the `other` routes below. |

The `other` path is a documented route to the person's own data for that
service. Routes limited to some countries or states count, with the limit
noted in the catalog. It covers:

- **Local app scripting on the Mac:** apps that support AppleScript
  ([AppleScript guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html))
  or App Intents ([App Intents](https://developer.apple.com/documentation/appintents)),
  the vendor's Shortcuts actions, and devices in Apple Home.
- **iOS App Intents:** actions an iPhone app exposes. Reaching them would need a
  Kipster app or shortcut on the phone, which does not exist (**Unconfirmed**
  feasibility).
- **The person's own exported data:** an archive the person downloads from the
  service and keeps on the Mac, a copy the service sends through a documented
  data-request flow, or the person's own content or saved lists saved as files,
  with the limits noted. Read-only and as fresh as the last export. A bare
  statement of legal access rights, with no documented way to receive a copy,
  does not count.
- **Mailbox emails that carry the service's data:** vendor-documented emails in
  the person's mailbox with the service's core data, such as statements, ride
  receipts, order, delivery or booking confirmations and bills, read over IMAP.
  Subscription billing receipts do not count.
- **Mail and calendar standards:** IMAP ([RFC 9051](https://www.rfc-editor.org/rfc/rfc9051))
  and SMTP for mail, CalDAV ([RFC 4791](https://www.rfc-editor.org/rfc/rfc4791))
  and CardDAV ([RFC 6352](https://www.rfc-editor.org/rfc/rfc6352)) for calendars
  and contacts, ICS feeds ([RFC 5545](https://www.rfc-editor.org/rfc/rfc5545))
  and the service's own RSS feeds. Usually signed in with an app-specific
  password, or read without sign-in for public feeds.
- **An official CLI:** a vendor command-line tool the person installs and signs
  in to, such as GitHub's `gh`.

**Aggregators are excluded.** Services such as Composio, Pipedream, Arcade,
Zapier and n8n cloud would let one connection reach many services, but every
request and its personal data would pass through, and often be stored by, a
third party's cloud, and that third party would hold the person's tokens. This
breaks the rule that tokens stay on the person's Mac and that data flows only
between the Mac and the service the person chose. Their catalogs may be used only
as lists of which services exist. A service's own vendor-hosted MCP server is
not an aggregator and is acceptable.

## 4. How a plugin is checked before shipping

Research level only; none of these checks exist yet.

| Check | What it does | Needs an account | When |
| --- | --- | --- | --- |
| Manifest | Validates `plugin.json` and `mcp.json` against the Agent Plugins [JSON Schemas](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json), each `SKILL.md` against the Agent Skills rules, and any Claude Code or Codex overlay with that client's validator (for example `claude plugin validate`). | No | Every change |
| Connection probe | Reads the protected resource and authorization server metadata, confirms PKCE `S256` and the expected class (metadata document, dynamic registration or pre-registered client), and records the scopes offered. | No | Every change and on a schedule |
| Tool listing | After sign-in, asks the server what it supports and lists its tools. Servers on MCP 2026-07-28 answer [`server/discover`](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), which replaced the `initialize` handshake; older servers still need `initialize`, so the probe must handle both. Every tool a skill names must exist with a compatible input schema. | Yes | Every change and on a schedule |
| Test sign-in | Completes a real sign-in with a project-owned test account, never a person's or owner's account, and checks that the token works and refreshes. | Yes | Before release and on a schedule |
| Smoke task | A kip performs one read-only task end to end, such as "list my three most recent pages", with write tools withheld, and the result is checked. | Yes | Before release |

**Re-checking.** Vendor MCP servers change without notice: tools appear,
disappear or change arguments. A scheduled job re-runs the probe and tool
listing. The anonymous probe can run often; the signed-in checks need test
account tokens and can run less often.

**Pinning.** Each plugin release records the tool names and a hash of their
input schemas. A difference marks the plugin for review instead of silently
shipping changed behavior. MCP 2026-07-28 asks servers to return tools in a
deterministic order and to give list results a freshness hint (`ttlMs`), which
makes this comparison simpler ([changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).

## 5. Adding a plugin when an official MCP server exists

Core first needs the shared parts once: an MCP client, the OAuth flow, Keychain
storage, plugin loading and the checks above. That is platform work, not
per-plugin work. With it in place, a class A plugin takes these steps:

1. Confirm the official MCP server URL on the vendor's own documentation.
2. Run the connection probe and confirm class A: a client ID metadata document
   or dynamic registration is advertised, along with PKCE `S256`.
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

- **B:** before step 2, the project registers one developer app through an
  owner account, outside any automated work, and records its client ID and
  redirect addresses. Add about a day once, plus ongoing ownership of the app
  and its terms (**Estimate**). If the service requires a client secret, decide
  first how a desktop app can sign in (see section 2, Kipster on the Mac as
  the OAuth client).
- **C:** all of B, plus a vendor review that may ask for a company entity,
  privacy policy, security answers or a demo. The plugin cannot ship until it is
  approved, and approval is not certain. Plan in weeks to months
  (**Estimate**).

## 6. Risks and open questions

- **Vendor MCP stability.** Servers are young and change; tool names and
  arguments can move between releases. Scheduled checks and pinned tool lists
  reduce, but do not remove, breakage.
- **Specification churn.** MCP 2026-07-28 removed the `initialize` handshake
  and deprecated dynamic client registration. Kipster must support older and
  newer servers at the same time.
- **Tool count and context size.** Some servers expose dozens of tools, and
  every tool definition takes model context on every run. Possible remedies:
  offering only the tools the run's skills use, read-only variants (Linear has
  `https://mcp.linear.app/mcp/readonly`) and server toolsets (GitHub's
  `GITHUB_TOOLSETS`).
- **Broad scopes.** Many servers ask for wide scopes; Slack's metadata lists
  about thirty. Request the fewest scopes the plugin needs and show them before
  sign-in.
- **Write actions.** Creating, changing, sending or deleting should go through
  Core's existing approval flow until the person grants that action. Which
  tools count as writes must be recorded per plugin, because MCP does not
  guarantee it.
- **Rate limits.** Several kips sharing one account can hit a service's limits;
  Core may need per-connection pacing and clear errors.
- **Terms of service on AI use.** Some API terms restrict AI or automated use,
  or sending data to model providers. Check each service's terms before
  shipping.
- **Data leaves the Mac for the model.** Tokens stay local, but tool results are
  sent to whichever AI provider runs the kip. Whether that counts as data
  transmitted "through a third-party server" under Google's restricted-scope
  policy is **Unconfirmed**; it decides whether a local Gmail plugin needs a
  CASA assessment.
- **Local vs remote MCP.** A vendor-hosted server needs no installation and is
  maintained by the vendor, but runs vendor code on vendor infrastructure. A
  local server keeps more on the Mac but needs packaging, updates and
  credentials in its environment. Prefer the official hosted server; run local
  servers only when no hosted one exists.
- **Remote interfaces and loopback sign-in.** Kipster's interface can connect to
  Core from another device. A loopback redirect only works in a browser on the
  Mac that runs Core, so sign-in from a phone or another computer needs a
  design.
- **Client identity.** Client ID metadata documents need a stable public HTTPS
  URL owned by the project, and the `extensions` namespace needs a
  reverse-domain name. Neither is chosen yet.
- **Claude Code reading the open layout** is unconfirmed (see section 1, The
  open plugin layout); Kipster plugins may need a Claude Code manifest as well.

## Sources

Plugin formats:

- Agent Plugins home: <https://agent-plugins.org/>
- Agent Plugins specification 1.0.0: <https://agent-plugins.org/specification>
- Agent Plugins compatible clients: <https://agent-plugins.org/compatible-clients>
- Agent Plugins plugin schema: <https://agent-plugins.org/schemas/1.0.0/plugin.schema.json>
- Agent Plugins MCP schema: <https://agent-plugins.org/schemas/1.0.0/mcp.schema.json>
- Agent Plugins 1.0 announcement (GitHub Changelog): <https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/>
- Agent Skills specification: <https://agentskills.io/specification>
- Claude Code plugin manifest reference: <https://code.claude.com/docs/en/plugins/manifest-reference>
- Claude Code MCP: <https://code.claude.com/docs/en/mcp>
- OpenAI plugin packaging (ChatGPT and Codex): <https://developers.openai.com/plugins/build/plugins>
- OpenAI plugin authentication: <https://developers.openai.com/plugins/build/auth>

MCP and OAuth:

- MCP authorization (2026-07-28): <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- MCP authorization server discovery: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery>
- MCP client registration: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration>
- MCP authorization security considerations: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations>
- MCP 2026-07-28 changelog: <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- MCP `server/discover`: <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>
- MCP tools: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- RFC 9728, OAuth 2.0 Protected Resource Metadata: <https://www.rfc-editor.org/rfc/rfc9728>
- RFC 8414, OAuth 2.0 Authorization Server Metadata: <https://www.rfc-editor.org/rfc/rfc8414>
- RFC 7591, OAuth 2.0 Dynamic Client Registration: <https://www.rfc-editor.org/rfc/rfc7591>
- OAuth Client ID Metadata Document (draft 00): <https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00>
- RFC 7636, PKCE: <https://www.rfc-editor.org/rfc/rfc7636>
- RFC 8707, Resource Indicators: <https://www.rfc-editor.org/rfc/rfc8707>
- RFC 9207, Authorization Server Issuer Identification: <https://www.rfc-editor.org/rfc/rfc9207>
- RFC 8252, OAuth 2.0 for Native Apps: <https://www.rfc-editor.org/rfc/rfc8252>

Vendors and platforms:

- Notion MCP: <https://developers.notion.com/docs/mcp>
- Linear MCP: <https://linear.app/docs/mcp>
- Airtable MCP: <https://airtable.com/developers/agents/mcp/getting-started>
- Todoist MCP (Doist): <https://github.com/Doist/todoist-mcp>
- Trello MCP: <https://support.atlassian.com/trello/docs/connect-trello-to-ai-assistants-with-trello-mcp/>
- GitHub MCP server: <https://github.com/github/github-mcp-server>
- Asana MCP server: <https://developers.asana.com/docs/using-asanas-mcp-server>
- Slack MCP server: <https://docs.slack.dev/ai/mcp-server>
- Microsoft app registration: <https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app>
- Google restricted scope verification: <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>
- Gmail API scopes: <https://developers.google.com/workspace/gmail/api/auth/scopes>
- Google Drive API scopes: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- Meta business verification: <https://developers.facebook.com/docs/development/release/business-verification>
- Apple Keychain Services: <https://developer.apple.com/documentation/security/keychain-services>
- Apple App Intents: <https://developer.apple.com/documentation/appintents>
- AppleScript Language Guide: <https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html>
- IMAP4rev2, RFC 9051: <https://www.rfc-editor.org/rfc/rfc9051>
- CalDAV, RFC 4791: <https://www.rfc-editor.org/rfc/rfc4791>
- CardDAV, RFC 6352: <https://www.rfc-editor.org/rfc/rfc6352>
- iCalendar, RFC 5545: <https://www.rfc-editor.org/rfc/rfc5545>

Discovery metadata read on 2026-10-08 (GET only):

- <https://mcp.notion.com/.well-known/oauth-protected-resource/mcp>
- <https://mcp.linear.app/.well-known/oauth-protected-resource/mcp>
- <https://ai.todoist.net/.well-known/oauth-protected-resource/mcp>
- <https://mcp.airtable.com/.well-known/oauth-protected-resource>
- <https://mcp.trello.com/.well-known/oauth-protected-resource/v1>
- <https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/>
- <https://mcp.asana.com/.well-known/oauth-protected-resource/v2>
- <https://mcp.slack.com/.well-known/oauth-protected-resource>
