# Which everyday services can become Kipster plugins

Status: research. [catalog.csv](catalog.csv) is the canonical file: one row per
service for 1,738 widely used services, sorted by rank, saying how a kip could
reach a person's own account in each one. [batches/](batches/) holds the six
working files the catalog is merged from. The 400 highest-ranked services were
researched deeply from vendor documentation and live discovery metadata; the
other 1,338 were checked more lightly. Rows were last checked on 2026-10-08 (693
rows) or 2026-10-09 (1,045 rows).

Each service has one connection class (what must happen before a kip can
connect) and one plugin path (what Kipster would build), explained in
[plugin-model.md](plugin-model.md):

- **A, plug in the MCP:** an official MCP (vendor-remote or vendor-local) that a
  person connects with a standard browser sign-in using dynamic client
  registration (`oauth-dcr`) or a client ID metadata document (`oauth-cimd`),
  with no app registration, review, allowlist or paid API tier.
- **B, one-time free setup:** no vendor review; the Kipster project registers a
  free developer app, or the person creates a free key or token, or installs a
  vendor-local MCP.
- **C, review or gate:** a vendor review, marketplace listing, allowlist,
  waitlist, invitation, sales contact or partner programme, or a paused MCP.
- **D, paid or audit:** a paid API tier, a security audit such as Google CASA,
  or business verification. Every row with `cost` `paid-api` is class D.
- **E, no public API:** no public API, or one that accepts no new apps and
  offers no partner route.

Paths: **`mcp`** uses the vendor's own MCP server; **`api`** means Kipster
builds tools on the vendor's public API; **`other`** reads the person's data
another documented way (data-bearing mailbox emails, an export or data request,
Mac and Apple features, calendar or news feeds, an official CLI);
**`not-feasible`** means no qualifying route was found.

## The answer in numbers

287 services (17%) can be plugged in today through an official MCP with a
browser sign-in and nothing to register. 341 (20%) need one free setup step, 219
(13%) a vendor review or gate, 63 (4%) money or an audit, and 828 (48%) have no
public API. Only 42 services (2%) have no qualifying route at all.

Counts per class (rows), per path (columns) and class by path:

| Class | `mcp` | `api` | `other` | `not-feasible` | Total | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 287 | 0 | 0 | 0 | 287 | 17% |
| B | 130 | 207 | 4 | 0 | 341 | 20% |
| C | 76 | 108 | 34 | 1 | 219 | 13% |
| D | 13 | 34 | 15 | 1 | 63 | 4% |
| E | 0 | 0 | 788 | 40 | 828 | 48% |
| Total | 506 | 349 | 841 | 42 | 1,738 | 100% |
| Share | 29% | 20% | 48% | 2% | 100% | |

## Answers to the research questions

### Which services are plug-in-the-MCP easy? (class A)

287 services, all on path `mcp` and all vendor-hosted: 193 advertise dynamic
client registration and 94 client ID metadata documents. 246 accept personal
accounts; 40 are business-only and 1 is unknown. The highest-ranked with
personal accounts are Todoist (55), Evernote (56), Robinhood (79), Philips Hue
(114), TickTick (177), Adobe Acrobat (211), Any.do (235), Webull (251),
TradingView (336), Upwork (342), Binance (357), Fastmail (366), Home Assistant
(390) and Readwise (398). Open public betas without an access gate, such as
Evernote's and Clerk's, count here.

### Which need a one-time registration or a review? (classes B and C)

**Class B, one-time free setup: 341 services.** 207 are on path `api`, 4 on
`other` and 130 on `mcp`. The 130 `mcp` rows split by how the person connects:

| Group | `auth` | Services | Setup |
| --- | --- | ---: | --- |
| Official MCP, no browser sign-in | `api-key` | 37 | The person pastes a self-serve API key (17 hosted servers, 20 local). |
| Official MCP, no browser sign-in | `personal-token` | 39 | The person pastes a personal access token (18 hosted, 21 local). |
| Official MCP, no browser sign-in | `none` | 37 | No account (20 hosted public-data servers), or a local server that uses the app's own session (17). |
| Official MCP, pre-registered client | `oauth-preregistered` | 17 | The project registers one free app and ships its client ID. |
| Total | | 130 | |

Examples without browser sign-in: Bitwarden (102), 1Password (101), Fantastical
(185), Dashlane (229), LINE (245), Day One (379), Kraken (391), Joplin (481),
Logseq (673). Pre-registered examples: UPS (442), Asana (1257), GitHub (1406),
Salesforce (1420), MongoDB Atlas (1461). 10 more class B services have a vendor
MCP but take path `api`, because the MCP serves only work tenants, needs
approval, or is excluded: Coinbase (81), Ticketmaster (118), Microsoft 365
(161), Webex (1264), Microsoft Teams (1270), Cognito Forms (1321), Microsoft
SharePoint (1328), Shopify (1412), Lattice (1648) and Airbyte (1716).

**Class C, review or gate: 219 services.** 108 are on path `api`, 76 on `mcp`,
34 on `other` and 1 is not feasible. 83 have a vendor MCP that a review, gate or
pause stands in front of, for example Google Calendar (2), Spotify (7), DoorDash
(24), Zoom (33), Dropbox (34), Booking.com (40), Feedly (193), Monarch Money
(205, MCP paused), Udemy (206), Slack (1260), Ramp (1589), Plaid (1595),
Riverside (1603) and Semrush (1669).

### Which need us to build on an API?

349 services take path `api`: 207 in class B, 108 in class C and 34 in class D.
The highest-ranked are YouTube (5), Microsoft Outlook (6), Instagram (12),
Google Docs (15), Google Photos (16), Uber (19), Google Sheets (23), Microsoft
OneDrive (25), Apple Music (26), TikTok (27), Microsoft To Do (29), Telegram
(31), Microsoft Word (35), Reddit (37) and Google Gemini (44).

### Which need another route?

841 services take path `other` (788 of them class E). Primary route type of the
alternative ([method](#method-and-limits)):

| Route type | Services on path `other` |
| --- | ---: |
| Mailbox emails (IMAP) | 360 |
| Data export or data request | 353 |
| Mac or Apple device route | 65 |
| Calendar or feed (ICS, CalDAV, RSS) | 40 |
| Official CLI | 11 |
| Other (Home Assistant or Matter, game consoles, API workarounds) | 12 |
| Total | 841 |

### Which are not feasible?

42 services have no qualifying route: 40 in class E, PressReader (C) and Kelley
Blue Book (D). Grouped by reason:

- **No API and no export, data copy or other route (26):** Khan Academy (92,
  API removed in 2020), Google Messages (155, messages live on the phone),
  YouTube TV (237), Overcast (297), theScore (326), Photomath (362), MyRadar
  (422), NewsBreak (434), ESPN Fantasy (470), Busuu (488), YouTube Kids (507),
  Vivint (530), WeatherBug (566), Philo (572), Chegg (584), Gauth (626), inDrive
  (686), Coffee Meets Bagel (692), HelloTalk (779), JioSaavn (854), Kanopy (890),
  Audacy (950), Raya (1028), Session (1034), Praktika (1058), Watch Duty (1203).
  Where these offer a privacy request, it states no file or copy delivery.
- **Handing codes to a kip would defeat two-step verification (2):** Google
  Authenticator (279), Microsoft Authenticator (335).
- **Only subscription billing or account-status emails or invoices (10):** Sling
  TV (389), MasterClass (517), DAZN (655), Starz (669), Pimsleur (715), AMC+
  (731), BritBox (793), The Criterion Channel (855), ViX (925), PressReader
  (1129). For Sling TV, MasterClass, Pimsleur, AMC+, BritBox, ViX and
  PressReader the privacy policy also offers a copy of personal data on request, mostly in some
  regions; whether it carries viewing or reading history needs confirming
  before any of them moves to `other`.
- **API only for business partners or business accounts (2):** Kelley Blue Book
  (1160), Zalo (773, personal chats not covered).
- **Nothing to read (2):** Trader Joe's (696, no online account or orders),
  SharkClean (1088, no developer API or Apple Home).

## Top findings

- **One in six services is ready now.** 287 services (17%) have an official MCP
  with browser sign-in and nothing to register or review.
- **The biggest services are the hardest.** Of the top 50 by rank, only PayPal
  (22) is class A, and its MCP needs a Business account; 6 are B, 16 C, 7 D and
  20 E. Google's sensitive and restricted scopes put Gmail, Google Calendar,
  Google Drive, Google Docs and Google Sheets behind verification or an audit.
- **Official MCPs often skip OAuth.** 113 class B services have an official MCP
  that the person connects with a pasted key or token, a local install, or no
  account at all. Many of the no-account servers only search public data
  (hotels, flights, jobs, market prices), not the person's account.
- **Gates are common even with OAuth.** 15 MCPs with dynamic registration or
  metadata documents are class C because the vendor allowlists clients or
  redirect addresses, enables access per customer, sells it through sales, or
  has paused it.
- **No API is common, no route is rare.** 828 services (48%) have no public
  API, but 788 of them have an `other` route, led by the mailbox (360 services
  on path `other`; 495 outside class A mention it) and exports (353).
- **One Microsoft registration covers eight rows.** One free Entra app reaches
  Outlook (6), OneDrive (25), To Do (29), Word (35), Excel (54), OneNote (57),
  PowerPoint (143) and Microsoft 365 (161) on personal accounts through Graph.

## Hard cases and their best alternatives

catalog.csv gives an alternative for every C, D and E row (1,110 rows). By
primary route type:

| Route type | C | D | E | Total | Examples |
| --- | ---: | ---: | ---: | ---: | --- |
| Mailbox emails | 73 | 12 | 345 | 430 | Uber (19) ride receipts, Booking.com (40) confirmations, Amazon (8) order emails, Gmail (1) over IMAP with an app password |
| Export or data request | 60 | 21 | 335 | 416 | Google Photos (16) Takeout, Instagram (12) data download, Netflix (20) viewing CSV, Monarch Money (205) CSV download |
| Mac or Apple route | 12 | 8 | 62 | 82 | Apple Notes (9) and Reminders (10) on the Mac, Dropbox (34) synced folder, Apple Music (26) scripting |
| Calendar or feed | 6 | 2 | 36 | 44 | Google Calendar (2) through Mac Calendar, Apple Calendar (14) CalDAV, Google News (99) RSS |
| Official CLI | 3 | 1 | 11 | 15 | Box (222), Vercel (1422), LastPass (173), Proton Drive (330) |
| Other | 65 | 19 | 39 | 123 | YouTube (5) with the person's own API key, Spotify (7) development-mode app, Google Drive (3) `drive.file` with the Picker |
| Total | 219 | 63 | 828 | 1,110 | |

67 of the 123 "Other" alternatives are an API or MCP variant (the person's own
developer app, a narrower scope, a different API or a key).

Class D: 40 are paid API tiers, such as Google Maps (11), X (36) and Perplexity
(110), whose MCP bills every tool call at API prices (its alternative is a data
request or threads exported as PDF, Markdown or DOCX); 11 need an audit or review
fee (Gmail, Google Drive, Instagram, Facebook); 12 need a commercial licence or
enterprise agreement, such as Reuters (320) and Equifax (799).

## Data flow through third parties

Aggregators (Composio, Pipedream, Zapier, Arcade) are never a route, nor is
Airbyte's hosted Agent MCP, which stores other services' credentials and data
in Airbyte's cloud; Airbyte (1716) uses its public API for the person's own
pipelines. Eight routes manage the person's own account on a data or automation
platform without proxying other services' data; their notes flag the platform's
data flow: Segment (1548), Plaid (1595), Microsoft Power Automate (1658),
Retool (1667), Clay (1683), Fivetran (1688), Airbyte (1716) and Apify (1733).
Amie (757) uses only its notes and todo scopes and Morgen (954) only its own
tasks, because their calendar and mail tools read Google or Microsoft accounts
through their cloud. Superhuman (1279), Missive (1381), Reclaim.ai (1276) and
Akiflow (1354) keep their MCPs as the person's own mail or calendar client;
notes flag the Google or Outlook data passing through.

34 alternatives route the person's data through a service, software or device
not made by the vendor, which a plugin must disclose: fitness services such as
Strava or Garmin for Peloton (192), Nike Run Club (209), Suunto (490), Zwift
(532), TrainingPeaks (550) and Runna (569); Home Assistant, a ratgdo controller
or a community server for Ring (113), Blink (197), myQ (263), TP-Link Kasa
(306), Roborock (410), Reolink (552), Aqara (729), SwitchBot (755), Smart Life
(785), Xiaomi Home (807), Schlage (910), IQAir (960) and MySQL (1594); notes or
storage services for Notability (329), Matter (554), Snipd (598) and BetterSleep
(625); QuickBooks or Xero for Novo (1660) and Dext (1712); a block explorer for
MetaMask (968); another company's privacy portal for ABCmouse (873) and Avast
(1083); and other services for Credit Karma (82), Amazon Music (142), UFC (601),
McAfee (976), Malwarebytes (1012) and DHL (1232). Another 17 alternatives use a
public source instead of the person's data, such as Apple Maps for Google Maps
(11), and send only queries.

## By category

| Category | Services | A | B | C | D | E | `mcp` | `api` | `other` | `not-feasible` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 72 | 1 | 10 | 10 | 1 | 50 | 12 | 7 | 53 | 0 |
| shopping | 69 | 2 | 4 | 7 | 1 | 55 | 3 | 11 | 55 | 0 |
| health-and-fitness | 65 | 1 | 4 | 20 | 1 | 39 | 3 | 21 | 41 | 0 |
| finance-and-banking | 56 | 0 | 2 | 7 | 6 | 41 | 0 | 3 | 53 | 0 |
| developer-tools | 52 | 28 | 19 | 1 | 3 | 1 | 40 | 10 | 2 | 0 |
| smart-home | 52 | 3 | 17 | 10 | 0 | 22 | 8 | 19 | 23 | 2 |
| food-and-delivery | 47 | 2 | 1 | 7 | 1 | 36 | 8 | 2 | 37 | 0 |
| learning | 46 | 4 | 6 | 11 | 0 | 25 | 8 | 13 | 20 | 5 |
| video-and-streaming | 46 | 1 | 6 | 1 | 1 | 37 | 1 | 7 | 28 | 10 |
| design-and-creative | 43 | 17 | 7 | 8 | 5 | 6 | 31 | 5 | 7 | 0 |
| news-and-reading | 42 | 2 | 6 | 4 | 3 | 27 | 4 | 7 | 28 | 3 |
| investing-and-crypto | 40 | 11 | 13 | 3 | 0 | 13 | 21 | 6 | 13 | 0 |
| sports | 40 | 0 | 4 | 2 | 0 | 34 | 0 | 5 | 32 | 3 |
| chat-and-messaging | 37 | 2 | 16 | 4 | 3 | 12 | 11 | 13 | 10 | 3 |
| maps-and-rides | 36 | 1 | 5 | 6 | 4 | 20 | 4 | 10 | 21 | 1 |
| productivity | 36 | 26 | 8 | 0 | 0 | 2 | 30 | 4 | 2 | 0 |
| automotive | 35 | 0 | 3 | 4 | 4 | 24 | 1 | 7 | 26 | 1 |
| crm-and-sales | 33 | 19 | 10 | 4 | 0 | 0 | 25 | 7 | 1 | 0 |
| groceries | 32 | 2 | 1 | 3 | 0 | 26 | 5 | 1 | 25 | 1 |
| marketing-and-email-marketing | 32 | 18 | 4 | 10 | 0 | 0 | 26 | 6 | 0 | 0 |
| podcasts-and-books | 31 | 1 | 3 | 2 | 0 | 25 | 3 | 3 | 24 | 1 |
| project-management | 31 | 14 | 16 | 1 | 0 | 0 | 23 | 8 | 0 | 0 |
| events-and-tickets | 30 | 1 | 2 | 4 | 2 | 21 | 3 | 5 | 22 | 0 |
| music-and-audio | 30 | 3 | 2 | 6 | 2 | 17 | 4 | 8 | 16 | 2 |
| password-and-security | 30 | 1 | 4 | 3 | 0 | 22 | 8 | 0 | 20 | 2 |
| utilities-and-telecom | 29 | 0 | 1 | 3 | 0 | 25 | 0 | 3 | 26 | 0 |
| hr-and-recruiting | 28 | 8 | 8 | 10 | 1 | 1 | 11 | 16 | 1 | 0 |
| notes | 27 | 7 | 11 | 1 | 0 | 8 | 16 | 2 | 9 | 0 |
| payments | 27 | 5 | 5 | 1 | 1 | 15 | 9 | 3 | 15 | 0 |
| home-and-family | 26 | 0 | 1 | 3 | 0 | 22 | 2 | 1 | 23 | 0 |
| budgeting-and-taxes | 24 | 2 | 5 | 4 | 0 | 13 | 6 | 4 | 14 | 0 |
| docs-and-office | 24 | 4 | 8 | 3 | 1 | 8 | 5 | 10 | 9 | 0 |
| social | 23 | 1 | 5 | 5 | 4 | 8 | 2 | 11 | 10 | 0 |
| analytics-and-data | 22 | 7 | 9 | 6 | 0 | 0 | 16 | 6 | 0 | 0 |
| email | 20 | 3 | 4 | 2 | 1 | 10 | 5 | 2 | 13 | 0 |
| forms-and-surveys | 20 | 6 | 10 | 1 | 2 | 1 | 7 | 12 | 1 | 0 |
| jobs-and-careers | 20 | 1 | 2 | 3 | 0 | 14 | 4 | 2 | 14 | 0 |
| accounting-and-invoicing | 19 | 6 | 6 | 5 | 1 | 1 | 12 | 5 | 2 | 0 |
| ai-assistants | 19 | 3 | 2 | 0 | 3 | 11 | 4 | 4 | 11 | 0 |
| ecommerce-platforms | 19 | 4 | 12 | 3 | 0 | 0 | 7 | 12 | 0 | 0 |
| real-estate | 19 | 0 | 1 | 3 | 1 | 14 | 2 | 2 | 15 | 0 |
| sleep-and-wellbeing | 19 | 0 | 0 | 0 | 0 | 19 | 0 | 0 | 19 | 0 |
| files-and-storage | 18 | 2 | 6 | 2 | 1 | 7 | 7 | 3 | 8 | 0 |
| language-learning | 18 | 1 | 2 | 0 | 1 | 14 | 1 | 3 | 10 | 4 |
| scheduling | 18 | 6 | 5 | 3 | 0 | 4 | 9 | 4 | 5 | 0 |
| weather | 18 | 0 | 6 | 0 | 4 | 8 | 1 | 9 | 6 | 2 |
| tasks-and-reminders | 17 | 7 | 3 | 1 | 0 | 6 | 7 | 4 | 6 | 0 |
| dating | 16 | 0 | 0 | 0 | 0 | 16 | 0 | 0 | 14 | 2 |
| social-media-management | 16 | 8 | 1 | 3 | 0 | 4 | 10 | 2 | 4 | 0 |
| customer-support | 15 | 7 | 5 | 2 | 1 | 0 | 11 | 4 | 0 | 0 |
| databases | 15 | 7 | 8 | 0 | 0 | 0 | 14 | 1 | 0 | 0 |
| games | 15 | 0 | 6 | 1 | 0 | 8 | 1 | 6 | 8 | 0 |
| government-and-civic | 14 | 0 | 4 | 5 | 0 | 5 | 0 | 7 | 7 | 0 |
| photos | 14 | 1 | 3 | 1 | 0 | 9 | 1 | 4 | 9 | 0 |
| security-and-it | 14 | 4 | 9 | 1 | 0 | 0 | 9 | 5 | 0 | 0 |
| website-and-cms | 13 | 8 | 4 | 1 | 0 | 0 | 10 | 2 | 1 | 0 |
| cloud-and-hosting | 11 | 6 | 4 | 1 | 0 | 0 | 11 | 0 | 0 | 0 |
| knowledge-base | 11 | 7 | 3 | 1 | 0 | 0 | 10 | 1 | 0 | 0 |
| pets | 11 | 0 | 1 | 0 | 0 | 10 | 0 | 1 | 10 | 0 |
| video-calls | 11 | 1 | 4 | 2 | 0 | 4 | 3 | 4 | 4 | 0 |
| calendar | 10 | 1 | 2 | 1 | 0 | 6 | 3 | 1 | 6 | 0 |
| legal-and-signatures | 9 | 4 | 0 | 3 | 2 | 0 | 6 | 3 | 0 | 0 |
| other | 6 | 0 | 2 | 0 | 2 | 2 | 2 | 2 | 2 | 0 |
| Total | 1,738 | 287 | 341 | 219 | 63 | 828 | 506 | 349 | 841 | 42 |

## Reference points

[plugin-model.md](plugin-model.md) uses these services to illustrate the
classes, and catalog.csv agrees: Notion (1256), Linear (1271), Todoist (55),
Airtable (1261) and Trello (1263) are A (`oauth-cimd`, the method the current
MCP specification prefers; all five also offer dynamic registration); GitHub
(1406) and Asana (1257) are B on `mcp` with a pre-registered client; Microsoft
Outlook (6), OneDrive (25) and To Do (29) are B on `api`, because Microsoft's
own MCP servers serve work tenants only; Slack (1260) is C; Gmail (1) and Google
Drive (3) are D, because their restricted scopes need verification and a yearly
security assessment.

## What this means for building a plugin catalog

After Core has its shared MCP client, OAuth flow and Keychain storage:

1. **Class A (287, 246 with personal accounts):** configuration plus skills.
2. **Shared `other` building blocks:** one IMAP plugin serves the 360
   mailbox-first services, an export and data-copy reader 353, Mac and Apple
   plugins 65, a calendar and feed reader 40, and 11 official CLIs.
3. **Class B MCPs without browser sign-in (113):** add key and token storage
   and a way to start vendor-local servers; then each is like class A.
4. **Other class B (228):** one free app registration per vendor; one Entra
   app covers the eight personal Microsoft Graph rows.
5. **Class C (219)** where the rank justifies weeks of review, starting with the
   83 that have a vendor MCP; one Google verification covers several rows.
6. **Class D (63)** only where the value justifies the cost.
7. **Class E (828)** only through step 2; 40 have no route.

## Method and limits

- Only public vendor pages, the MCP Registry and unauthenticated discovery
  metadata were read; nothing was registered and no one signed in.
- Every class A row's cited vendor pages were searched for allowlists,
  waitlists, invitations, approvals, sales contact and pauses; rows with such a
  gate are class C, with the gate quoted in notes.
- `consumer_accounts` describes the selected route: `business-only` when it
  needs a business, merchant, team-admin or organisation account rather than a
  personal one; self-serve tools an individual can sign up for stay `yes`.
- Route types come from the `alternative` column: its first clause (text before
  `;\s|,\s+or\s`) is matched case-insensitively against these patterns in order,
  first match wins, and no match is Other. Mailbox emails count only when they
  carry the service's data (statements, ride receipts, order, delivery or
  booking confirmations, bills); subscription billing and account-status
  emails do not.

```text
mailbox            mailbox|\bIMAP\b|\binbox\b|mail plugin|own email|\be-?mails\b(?! a\b)
official-cli       \bCLIs?\b|command[- ]line|\bctl\b
export-or-request  export|download|\bcopy\b|request|privacy|portab|\barchive|backup|takeout|FOIA|statements?\b|\bPDFs?\b|\bCSV\b|Blue Button|Green Button|\bsaves?\b|personal (data|information)|data report
ics-caldav-rss     \bICS\b|\biCal\b|CalDAV|CardDAV|\bRSS\b|\bAtom\b|\bOPML\b|\bfeeds?\b|calendar
mac-apple          Shortcuts|shortcuts run|App Intents|AppleScript|Apple ?Events|\bJXA\b|Apple Home|HomeKit|HealthKit|Apple Health|Siri|EventKit|PhotoKit|MapKit|WeatherKit|ShazamKit|FinanceKit|Apple Wallet|Spotlight|URL scheme|x-callback|on the Mac|to the Mac|Mac (app|Calendar|Notes|Messages|Reminders)|local files|sync(ed)? folders?
```

- 291 rows are fully verified, 1,413 partly and 34 not; negative claims (no
  API, no MCP, no export) are `partly` unless a vendor states them. Vendors
  change MCP servers and programmes often; re-check a row before building.

Also: [sources.md](sources.md) (service rankings), [ios.md](ios.md) (Apple).
