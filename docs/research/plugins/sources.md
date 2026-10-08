# Plugin research: sources and service list

This document records where the service list in
[`batches/master-list.csv`](batches/master-list.csv) came from and how it was
built. The list names 1,742 services, ranked by everyday relevance. Later
research checks each service for an official MCP server, a sign-in method and
a plugin path; this document does not.

All sources were read on 8 October 2026 with public pages, sitemaps and public
GET APIs only. No accounts, sign-ins or write requests were used.

## Sources

Third-party aggregators (Composio, Pipedream, Zapier and similar) are used only
as reference lists of which services exist. They are not a plugin option for
Kipster.

The `listed_in` column of the master list uses the keys below. "Rows" is the
number of master-list rows that carry the key.

| Key | Source | URL | What was used | Size | Rows | Access notes |
| --- | --- | --- | --- | --- | --- | --- |
| `mcp-registry` | Official MCP Registry | https://registry.modelcontextprotocol.io | `GET /v0/servers?version=latest`, all pages | 40,791 server entries | 562 | Public API |
| `github-mcp` | GitHub MCP Registry (the list behind https://code.visualstudio.com/mcp) | https://github.com/mcp | `GET https://api.mcp.github.com/v0/servers`, all pages | 394 servers | 39 | Public API |
| `claude-connectors` | Claude connectors directory | https://claude.com/connectors | Connector pages listed in https://claude.com/sitemap.xml | 922 connectors | 237 | https://claude.ai/directory returned HTTP 403 |
| `cursor` | Cursor marketplace (MCP directory) | https://cursor.com/docs/context/mcp/directory | Publisher and plugin pages in https://cursor.com/sitemap-marketplace.xml | 3,466 pages | 106 | Public sitemap |
| `docker-mcp` | Docker MCP Catalog | https://github.com/docker/mcp-registry | `servers/` directory listing | 328 servers | 66 | Public GitHub API |
| `glama` | Glama MCP directory | https://glama.ai/mcp/servers | Connector and server pages in https://glama.ai/sitemap.xml | 26,905 connectors, 97,619 servers | 706 | API needs a key and robots.txt disallows `/api/`; sitemaps used instead |
| `mcpso` | mcp.so | https://mcp.so | Server pages in https://mcp.so/sitemap.xml | 18,374 servers | 335 | robots.txt disallows `/api/`; sitemap used |
| `smithery` | Smithery registry | https://smithery.ai | `GET https://registry.smithery.ai/servers` | First 500 of 19,106 servers | 16 | Public listing returns at most 500 entries |
| `awesome-mcp` | awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | README entries | 4,125 entries | 138 | MIT |
| `composio` | Composio toolkits | https://docs.composio.dev/toolkits | Toolkit index page | 1,600 toolkits | 313 | Reference only; the API needs a key |
| `pipedream` | Pipedream apps | https://pipedream.com/apps | App pages in https://pipedream.com/sitemap-apps.xml | 3,223 apps | 443 | Reference only; the API needs a key |
| `zapier` | Zapier app directory | https://zapier.com/apps | `GET https://zapier.com/api/v4/apps/`, all pages, popularity order | 10,231 apps (built-in tools excluded) | 471 | Reference only |
| `nango` | Nango provider catalog | https://github.com/NangoHQ/nango | `packages/providers/providers.yaml` | 1,046 providers | 308 | ELv2 |
| `activepieces` | Activepieces community pieces | https://github.com/activepieces/activepieces | `packages/pieces/community` directory | 736 pieces | 241 | MIT outside enterprise directories |
| `n8n` | n8n built-in nodes | https://github.com/n8n-io/n8n | `packages/nodes-base/nodes` directory, with Google and Microsoft sub-nodes | 345 nodes | 154 | Sustainable Use License |
| `home-assistant` | Home Assistant integrations | https://www.home-assistant.io/integrations/ | https://www.home-assistant.io/integrations.json, with install counts from https://analytics.home-assistant.io/data.json | 1,371 integrations (helpers and system integrations excluded) | 138 | Apache-2.0 |
| `appstore` | Apple App Store top charts, US store | https://itunes.apple.com/us/rss/ | Top free and top grossing iPhone apps for 24 categories and overall (`topfreeapplications` and `topgrossingapplications` JSON feeds) | 4,994 chart entries (100 per chart) | 793 | Public feed |
| `appstore-listing` | Apple App Store listing, US store | https://itunes.apple.com/search | iTunes Search API lookup for rows with no other evidence; each match checked by app name and developer | 249 confirmed listings | 249 | Public API |
| `google-play` | Google Play listing, US store | https://play.google.com/store/apps | Store page of a known package, for Android-only apps | 5 listings | 5 | Public page |

Not used:

- ChatGPT apps directory (https://chatgpt.com/apps): returned HTTP 403 to
  automated requests.
- The Composio, Pipedream and Glama APIs need an account or key.
- Other vendor-run directories, for example for Gemini, Microsoft Copilot or
  Mistral, were not checked.

## Open-source projects worth knowing

| Project | Note | Licence |
| --- | --- | --- |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Reference MCP servers (filesystem, fetch, git, memory, time) and archived early integrations | MIT, moving to Apache-2.0 |
| [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) | Source of the official MCP Registry and its server metadata schema | MIT, moving to Apache-2.0 |
| [github/github-mcp-server](https://github.com/github/github-mcp-server) | GitHub's official MCP server | MIT |
| [microsoft/mcp](https://github.com/microsoft/mcp) | Index of Microsoft's official MCP servers | MIT |
| [docker/mcp-registry](https://github.com/docker/mcp-registry) | Docker's curated catalog of containerised MCP servers | MIT |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | Largest community list of MCP servers, grouped by category | MIT |
| [wong2/awesome-mcp-servers](https://github.com/wong2/awesome-mcp-servers) | Smaller community list of MCP servers | MIT |
| [NangoHQ/nango](https://github.com/NangoHQ/nango) | `providers.yaml` records OAuth and API settings for 1,000+ APIs | ELv2 |
| [activepieces/activepieces](https://github.com/activepieces/activepieces) | 700+ integration "pieces" written in TypeScript | MIT, except enterprise directories |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 300+ built-in integration nodes | Sustainable Use License (source-available) |
| [PipedreamHQ/pipedream](https://github.com/PipedreamHQ/pipedream) | Source of Pipedream's app components | Pipedream Source Available License |
| [ComposioHQ/composio](https://github.com/ComposioHQ/composio) | Composio SDK; the toolkit catalog itself is a hosted service | MIT |
| [home-assistant/core](https://github.com/home-assistant/core) | 1,300+ smart-home integrations with local and cloud APIs | Apache-2.0 |
| [airbytehq/airbyte](https://github.com/airbytehq/airbyte) | Data connectors for hundreds of business APIs | ELv2 for the platform; connectors licensed individually |
| [meltano/hub](https://github.com/meltano/hub) | Catalog of Singer taps and targets | Apache-2.0 |

## How the list was built

**Inclusion.** A row is a service with its own accounts, data or API that a
person might want a kip to use: apps and services such as Gmail, Stripe or
Uber, not individual actions. Candidates came from the sources above and from
known services in each category. Every row has at least one `listed_in` key;
candidates with no evidence in any source were dropped. Major regional services
are included where they are everyday in a large market.

**Exclusion.**

- Integration platforms and aggregators (Zapier, Make, IFTTT, n8n, Pipedream,
  Composio).
- Utility tools that are not services, such as webhooks, formatters and
  generic MCP utilities.
- Discontinued services, for example Skype, Pocket, Mint and Postmates.
- Individual games, apart from platforms and a few account-based titles.
- Small regional duplicates such as further supermarket banners, airlines and
  streaming services.
- Services with no app or API, such as Zelle.

**De-duplication.** One row per service brand. A product with its own app or
its own API or sign-in scope keeps its own row: Gmail, Google Calendar and
Google Drive are separate, and so are Uber and Uber Eats. Editions, regional
variants and renamed products share one row, listed under the current name:
Jira covers Cloud, Server and Data Center; X was Twitter; HBO Max was Max;
Fandango at Home was Vudu; Kit was ConvertKit; Brevo was Sendinblue. Where two
different services share a name, a short qualifier keeps them apart, as in
"DICE (live events)" and "Affinity (CRM)". Names are unique case-insensitively.

**Ranking.** Rows are ranked in three bands:

1. Everyday consumer services (ranks 1–1,256): email, calendar, notes, tasks,
   documents, files, chat, social, music, video, travel, rides, food, shopping,
   banking, payments, health, smart home, learning, news and similar.
2. Work and productivity tools (ranks 1,257–1,409), such as Notion, Slack,
   Asana and Jira.
3. Developer and business tools (ranks 1,410–1,742), such as GitHub, Stripe,
   HubSpot and AWS.

Within the consumer band, the first 147 rows are ordered by hand. These are the
most widely used services across all categories, with Gmail first. The
remaining rows fall into two popularity tiers. Inside each tier, rows are
ordered by popularity within their category, and the categories are
interleaved so each one is spread evenly through the tier. Popularity is judged
from App Store chart position, presence across several catalogs and known user
base. The work and developer bands use the same interleaving.

**Tier.** Ranks 1–400 are `deep`: the everyday services most worth verifying in
depth. All other rows are `light`. Every deep row is a consumer service. Work
tools such as Notion and Slack fall in the light tier because they rank after
the consumer band, and their plugin paths are already well known.

**`listed_in`.** A source key is added when the service's name, or a known
former or alternative name, matches an entry in that source after
normalisation. Rules by source:

- Directory and package sources (MCP registries and community lists) count
  any listed server for the service, official or community-built.
- Single-word names that are also dictionary words are matched only against
  curated catalogs, so that unrelated servers with the same word do not count.
- App Store matches were checked against the developer name, and known false
  matches were removed.

**Website.** The `website` value is the service's official homepage. Each one
was requested once with a single GET:

- 1,298 pages loaded and named the service (21 of these after correcting to a
  renamed domain).
- 387 answered with bot protection, a sign-in redirect or a regional redirect.
- 23 well-known domains did not answer the automated request.

The website is left blank for 34 rows, mainly Apple system apps such as Apple
Notes, which have no separate homepage, and services whose homepage could not
be confirmed.

## Counts

By tier: 400 `deep`, 1,342 `light`. By band: 1,256 consumer, 153 work and
productivity, 333 developer and business.

| Category | Rows | Deep |
| --- | ---: | ---: |
| email | 20 | 8 |
| calendar | 10 | 5 |
| notes | 27 | 9 |
| tasks-and-reminders | 17 | 8 |
| docs-and-office | 24 | 12 |
| files-and-storage | 18 | 9 |
| photos | 14 | 6 |
| chat-and-messaging | 37 | 12 |
| video-calls | 11 | 3 |
| social | 23 | 13 |
| music-and-audio | 30 | 11 |
| podcasts-and-books | 31 | 10 |
| video-and-streaming | 46 | 18 |
| news-and-reading | 42 | 17 |
| travel | 72 | 19 |
| maps-and-rides | 36 | 11 |
| food-and-delivery | 47 | 13 |
| groceries | 32 | 9 |
| shopping | 69 | 20 |
| finance-and-banking | 56 | 17 |
| payments | 27 | 11 |
| investing-and-crypto | 40 | 12 |
| budgeting-and-taxes | 24 | 8 |
| health-and-fitness | 65 | 21 |
| sleep-and-wellbeing | 19 | 6 |
| smart-home | 52 | 18 |
| home-and-family | 26 | 8 |
| pets | 11 | 3 |
| learning | 46 | 8 |
| language-learning | 18 | 3 |
| jobs-and-careers | 20 | 5 |
| dating | 16 | 4 |
| events-and-tickets | 30 | 7 |
| games | 15 | 7 |
| sports | 40 | 7 |
| weather | 18 | 5 |
| password-and-security | 30 | 8 |
| utilities-and-telecom | 29 | 8 |
| government-and-civic | 15 | 2 |
| automotive | 35 | 5 |
| real-estate | 19 | 3 |
| ai-assistants | 19 | 8 |
| productivity | 36 | 0 |
| project-management | 31 | 0 |
| knowledge-base | 13 | 0 |
| forms-and-surveys | 20 | 0 |
| scheduling | 19 | 0 |
| crm-and-sales | 33 | 0 |
| marketing-and-email-marketing | 32 | 0 |
| social-media-management | 16 | 0 |
| design-and-creative | 43 | 2 |
| website-and-cms | 13 | 0 |
| ecommerce-platforms | 19 | 0 |
| accounting-and-invoicing | 19 | 0 |
| hr-and-recruiting | 28 | 0 |
| customer-support | 15 | 0 |
| analytics-and-data | 22 | 0 |
| databases | 15 | 0 |
| developer-tools | 52 | 0 |
| cloud-and-hosting | 11 | 0 |
| security-and-it | 14 | 0 |
| legal-and-signatures | 9 | 0 |
| other | 6 | 1 |

The six `other` rows are web search engines (Google Search, Bing, DuckDuckGo,
Brave Search, Kagi and Ecosia).

## Known gaps and biases

- **Region.** The list leans towards the United States, then the United
  Kingdom, Canada, Australia, India and the European Union. App Store evidence
  comes from the US store only. Large markets in China, Japan, Korea, Latin
  America, Africa and the Middle East are represented by a few major services
  each. Most local banks, telecoms, utilities, supermarkets, government portals
  and delivery apps are missing.
- **Platform.** Popularity evidence comes from iPhone charts. Android-only
  services rely on catalog presence or a Google Play listing and may rank low.
- **Charts are a snapshot.** Chart positions on one day favour seasonal and
  trending apps (sports betting during the season, short-drama apps, new AI
  apps) and miss steady services.
- **Catalog bias.** Automation and MCP catalogs list business and developer
  tools far more than consumer apps. A missing `listed_in` key does not mean a
  service has no API.
- **Name matching.** Matching by normalised name can miss services listed
  under a different name and can credit a community server that only
  mentions the service. `listed_in` shows that a service appears in a source,
  not that an official integration exists.
- **Thin categories.** Pets, government and civic, video calls and games have
  few rows, because few such services offer accounts or data worth connecting.
- **Ranking is a judgement.** Order within each band reflects judged
  popularity, not usage data. Neighbouring ranks are not meaningfully
  different.
