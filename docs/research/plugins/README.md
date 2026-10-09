# Which everyday services can become Kipster plugins

Status: research. This report summarizes [catalog.csv](catalog.csv), which
classifies 1,738 widely used services by how a kip could reach a person's own
account in each one. The 400 highest-ranked services were researched deeply from
vendor documentation and live discovery metadata; the other 1,338 were checked
more lightly. Rows were checked on 2026-10-08 (803 rows) and 2026-10-09 (935
rows).

Each service has one connection class, which says what must happen before a kip
can connect, and one plugin path, which says what Kipster would build.
[plugin-model.md](plugin-model.md) explains both in detail.

Classes:

- **A, instant:** an official vendor MCP the person connects with nothing for
  the project to register: browser sign-in, or a free key or token the person
  creates.
- **B, register once:** the project registers one free developer app, or the
  person creates a free key, with no vendor review.
- **C, review:** a vendor review, marketplace listing, allowlist, partner
  programme or waitlist stands in the way.
- **D, paid or audit:** a paid API tier, a security audit such as Google CASA,
  or business verification.
- **E, no public API:** no public API, or one that accepts no new apps and
  offers no partner route.

Paths:

- **`mcp`:** use the vendor's own MCP server.
- **`api`:** Kipster builds tools on the vendor's public API.
- **`other`:** Kipster reads the person's data another documented way: mailbox
  emails, an export or data request, Mac and Apple features, calendar or news
  feeds, or an official CLI.
- **`not-feasible`:** no qualifying route was found.

## The answer in numbers

417 services (24%) can be plugged in through an official MCP today with no
project paperwork. Another 227 need one free registration, 204 need a vendor
review, 62 need money or an audit, and 828 have no public API. Almost every
service without a usable API still has a documented route to the person's own
data: only 34 services (2%) have none.

| Class | Services | Share |
| --- | ---: | ---: |
| A | 417 | 24% |
| B | 227 | 13% |
| C | 204 | 12% |
| D | 62 | 4% |
| E | 828 | 48% |
| Total | 1,738 | 100% |

| Path | Services | Share |
| --- | ---: | ---: |
| `mcp` | 508 | 29% |
| `api` | 348 | 20% |
| `other` | 848 | 49% |
| `not-feasible` | 34 | 2% |
| Total | 1,738 | 100% |

Class by path:

| Class | `mcp` | `api` | `other` | `not-feasible` | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 417 | 0 | 0 | 0 | 417 |
| B | 17 | 206 | 4 | 0 | 227 |
| C | 62 | 108 | 34 | 0 | 204 |
| D | 12 | 34 | 15 | 1 | 62 |
| E | 0 | 0 | 795 | 33 | 828 |
| Total | 508 | 348 | 848 | 34 | 1,738 |

Class A by how the person signs in:

| Sign-in | `auth` value | Services |
| --- | --- | ---: |
| Browser sign-in, dynamic client registration | `oauth-dcr` | 207 |
| Browser sign-in, client ID metadata document | `oauth-cimd` | 97 |
| Pasted API key | `api-key` | 37 |
| Pasted personal token | `personal-token` | 39 |
| No sign-in (public data, or a local server that uses the app's own session) | `none` | 37 |
| Total class A | | 417 |

That is 304 class A services with browser sign-in (`oauth-dcr` or `oauth-cimd`),
76 where the person pastes a key or token they create, and 37 that need no
sign-in. 359 of the class A servers are vendor-hosted and 58 run locally.

## Answers to the research questions

### Which services are plug-in-the-MCP easy?

All 417 class A services, all on path `mcp`; 363 of them accept personal
accounts and 54 are business-only or unknown. The highest-ranked everyday
examples are PayPal (22), Todoist (55), Evernote (56), Robinhood (79), 1Password
(101), Bitwarden (102), Perplexity (110), Philips Hue (114), Tripadvisor (147),
Substack (149), TickTick (177), Roblox (182), Fantastical (185), ZipRecruiter
(186), Monarch Money (205), Udemy (206), Adobe Acrobat (211), Dashlane (229),
Any.do (235), Adobe Lightroom (236), LINE (245), Webull (251), Pocket Casts
(256), Goodnotes (273), Shop (289).

### Which need a one-time registration or a review?

- **Registration (class B): 227 services.** 26 already have a vendor MCP (17 of
  them on path `mcp` with a pre-registered client; the rest use the API because
  the MCP is allowlisted, limited to work tenants or has no documented client
  registration); 206 are on path `api` and 4 on path `other`. Vendor MCPs:
  Coinbase (81), Ticketmaster (118), Microsoft 365 (161), UPS (442), Asana
  (1257), Webex (1264), Microsoft Teams (1270), Cognito Forms (1321), Lark
  (1323), Microsoft SharePoint (1328), DingTalk (1338), MeisterTask (1373),
  GitHub (1406), Shopify (1412), Salesforce (1420), Microsoft Dynamics 365
  (1451), BambooHR (1457), MongoDB Atlas (1461), Microsoft Entra ID (1465),
  Capsule CRM (1540), NetSuite (1556), Chargebee (1593), Microsoft Advertising
  (1640), Lattice (1648), Power BI (1655), Gong (1671).
- **Review (class C): 204 services.** 68 already have a vendor MCP (62 of them
  on path `mcp`); 108 are on path `api` and 34 on path `other`. Vendor MCPs:
  Google Calendar (2), Spotify (7), Google Docs (15), Google Sheets (23),
  DoorDash (24), Zoom (33), Dropbox (34), Uber Eats (39), Booking.com (40),
  Google Home (47), Instacart (67), Expedia (72), Credit Karma (82), Strava
  (85), Oura (88), Coursera (93), Audible (95), Indeed (105), Zillow (124),
  Google Slides (144), Canva (145), Quizlet (159), StubHub (172), Peloton (192),
  Shazam (203), Hotels.com (208), Box (222), SeatGeek (228), Resy (231), Copilot
  Money (248), Shipt (301), Thumbtack (307), TurboTax (361), AllTrails (450),
  Zomato (497), Adobe Express (640), Wyndham Hotels (738), Bloomberg (839),
  Norton (930), McAfee (976), Malwarebytes (1012), GetYourGuide (1030),
  idealista (1070), Carrefour (1130), Slack (1260), ClickUp (1281), Google Chat
  (1282), Setmore (1325), Figma (1332), Front (1333), DocuSign (1334), Square
  Appointments (1336), HubSpot (1407), Google Analytics (1411), QuickBooks
  (1413), Adobe Creative Cloud (1421), Vercel (1422), Google Ads (1423), Square
  (1432), Adobe Premiere Pro (1440), Adobe Firefly (1452), Google BigQuery
  (1456), Shutterstock (1511), Braze (1598), HighLevel (1602), Looker (1625),
  TikTok Ads (1661), Harvey (1710).

### Which need us to build on an API?

348 services take path `api`: 206 in class B, 108 in class C and 34 in class D.
The highest-ranked are YouTube (5), Microsoft Outlook (6), Instagram (12),
Google Docs (15), Google Photos (16), Uber (19), Google Sheets (23), Microsoft
OneDrive (25), Apple Music (26), TikTok (27), Microsoft To Do (29), Telegram
(31), Microsoft Word (35), Reddit (37), Google Gemini (44).

### Which need another route?

848 services take path `other` (795 of them in class E). Their alternatives
break down by route type as follows; [How rows were
classified](#how-rows-were-classified) documents the keyword rules.

| Route type | Services on path `other` |
| --- | ---: |
| Mailbox emails (IMAP) | 369 |
| Data export or data request | 351 |
| Mac or Apple device route | 65 |
| Calendar or feed (ICS, CalDAV, RSS) | 40 |
| Official CLI | 11 |
| Other | 12 |
| Total | 848 |

"Other" here covers Home Assistant or Matter control, game server consoles and a
few API-based workarounds.

### Which are not feasible?

34 services have no qualifying route anywhere:

| Rank | Service | Class | Reason |
| ---: | --- | --- | --- |
| 92 | Khan Academy | E | Public API removed in 2020; no download of a learner's own progress. |
| 155 | Google Messages | E | No API; messages live on the Android phone and the web client is only a paired mirror. |
| 237 | YouTube TV | E | No API, and YouTube TV is not a Google Takeout product. |
| 279 | Google Authenticator | E | No API; handing one-time codes to a kip would defeat two-step verification. |
| 297 | Overcast | E | No listener API, export or data-copy delivery. |
| 326 | theScore | E | No API; access requests go by email with no stated file delivery. |
| 335 | Microsoft Authenticator | E | No consumer API; handing codes or approvals to a kip would defeat two-step verification. |
| 362 | Photomath | E | No API; data requests by email only, with no download. |
| 422 | MyRadar | E | No API; the optional photo account cannot be downloaded. |
| 434 | NewsBreak | E | No reader API; privacy requests state no file delivery. |
| 470 | ESPN Fantasy | E | No public fantasy API or export. |
| 488 | Busuu | E | No learner API; data copies by email with no stated file delivery. |
| 507 | YouTube Kids | E | Not in the YouTube Data API; no export, Shortcuts actions or data-bearing emails. |
| 530 | Vivint | E | No customer API, Apple Home or Shortcuts; history only in the app. |
| 566 | WeatherBug | E | No API for saved places; only a privacy webform. |
| 572 | Philo | E | No API or Shortcuts; access right with no stated file delivery. |
| 584 | Chegg | E | No API or Shortcuts; no documented data download found. |
| 626 | Gauth | E | No API or Shortcuts; access requests by email only. |
| 669 | Starz | E | No API or Shortcuts; only subscription billing emails. |
| 686 | inDrive | E | No API; receipts and ride history only in the app. |
| 692 | Coffee Meets Bagel | E | No API; data copy by support ticket with no stated file. |
| 696 | Trader Joe's | E | No online account, orders or app to read. |
| 773 | Zalo | E | APIs serve business accounts only, not personal chats. |
| 779 | HelloTalk | E | No API, Siri actions or data export. |
| 854 | JioSaavn | E | No listener API, Shortcuts actions or download flow. |
| 855 | The Criterion Channel | E | No API, export or Shortcuts; only subscription billing emails. |
| 890 | Kanopy | E | No API or export for watch history. |
| 950 | Audacy | E | No listener API; request portal states no file delivery. |
| 1028 | Raya | E | No API; data copy by email with no stated file. |
| 1034 | Session | E | No API, bot, CLI or message backup. |
| 1058 | Praktika | E | No API, download or Shortcuts actions. |
| 1088 | SharkClean | E | No developer API or Apple Home; only unofficial community libraries. |
| 1160 | Kelley Blue Book | D | APIs licensed to business partners only; no consumer download. |
| 1203 | Watch Duty | E | No API, export or email alerts. |

## Top findings

- **A quarter of the catalog is ready now.** 417 services (24%) have an official
  MCP that a person connects with nothing for the project to register, 304 of
  them with browser sign-in.
- **The biggest services are the hardest.** Of the top 50 by rank, only 1 is
  class A; 16 are C, 7 are D and 20 are E. Google's sensitive and restricted
  scopes put Gmail, Google Calendar, Google Drive, Google Docs and Google Sheets
  behind verification or a security audit.
- **No API is common, no route is rare.** 828 services (48%) have no public API,
  but 795 of them have an `other` route; only 34 services in the whole catalog
  are not feasible.
- **The mailbox is the largest single building block.** 369 `other`-path
  services use the person's mailbox as their primary route, and 464 services
  outside class A mention mailbox emails somewhere in their alternative.
- **Data exports and data requests are the second route.** 351 `other`-path
  services rely on an export or a data request: one-off snapshots, often limited
  by country or state, that a kip reads as files.
- **One Microsoft registration covers many rows.** 19 Microsoft services are
  class B; one free Entra app that allows personal accounts reaches the everyday
  ones through Microsoft Graph: Microsoft Outlook, Microsoft OneDrive, Microsoft
  To Do, Microsoft Word, Microsoft Excel, Microsoft OneNote and Microsoft
  PowerPoint.
- **Negative claims are rarely provable.** 260 rows are fully verified, 1,444
  partly and 34 not; most "no API" or "no MCP" findings are marked partly.

## Hard cases and their best alternatives

catalog.csv gives an alternative for every C, D and E row (1,094 rows). The 40
highest-ranked:

| Rank | Service | Class | Path | Best alternative |
| ---: | --- | --- | --- | --- |
| 1 | Gmail | D | `mcp` | IMAP and SMTP with an app password (needs 2-Step Verification), or Mail on the Mac through Apple Events |
| 2 | Google Calendar | C | `mcp` | Mac Calendar through EventKit with the Google account added to macOS; or the Calendar API with the same verified OAuth client |
| 3 | Google Drive | D | `mcp` | drive.file scope with the Google Picker (only files the person picks, non-sensitive, no audit), or the Google Drive for desktop synced folder on the Mac |
| 4 | WhatsApp | E | `other` | The person's exported chats (Export chat) read on the Mac, and wa.me click-to-chat links to draft a message the person sends |
| 5 | YouTube | C | `api` | Public video, channel and search data through the YouTube Data API with the person's own free API key; watch history from the person's Google Takeout export |
| 7 | Spotify | C | `mcp` | the person's own Development Mode app on the Web API (needs Spotify Premium, at most 5 users), or local playback control of the Spotify Mac app |
| 8 | Amazon | E | `other` | Order emails in the person's mailbox; or the person's Amazon data request export |
| 9 | Apple Notes | E | `other` | Mac Notes through Apple Events (AppleScript/JXA) run by Core, plus Notes actions in Shortcuts via shortcuts run |
| 10 | Apple Reminders | E | `other` | Mac Reminders through EventKit run by Core (one full-access prompt), plus Reminders actions in Shortcuts via shortcuts run |
| 11 | Google Maps | D | `mcp` | Apple Maps through MapKit or Shortcuts on the Mac for place search and routes, Google Maps links Kipster builds for the person to open, and saved places from the person's Google Takeout export |
| 12 | Instagram | D | `api` | The person's Instagram data download from Accounts Center (JSON), read from the downloaded files |
| 13 | iCloud Drive | E | `other` | the iCloud Drive folder synced on the person's Mac, read and written as local files (with Desktop and Documents if the person syncs them) |
| 14 | Apple Calendar | E | `other` | CalDAV to iCloud with an app-specific password |
| 15 | Google Docs | C | `api` | Docs API with the sensitive documents scope plus drive.file and the Google Picker to choose files; or export the person's documents from Google Takeout |
| 16 | Google Photos | C | `api` | The person's Google Takeout export of their Photos library |
| 17 | ChatGPT | E | `other` | The person's ChatGPT data export (conversation history as a downloadable archive from ChatGPT's data controls settings), imported into Kipster |
| 18 | Facebook | D | `other` | The person's Facebook data export (Accounts Center > Download your information, JSON), read locally from the downloaded files |
| 19 | Uber | C | `api` | Uber trip receipt emails in the person's mailbox; ride requests through Uber's Siri support on iPhone |
| 20 | Netflix | E | `other` | The person's viewing activity CSV download, or the full account data request at netflix.com/account/getmyinfo |
| 21 | Messages (iMessage) | E | `other` | Send through Mac Messages Apple Events; find messages and conversations with the Shortcuts Find Message and Find Conversation actions via shortcuts run |
| 23 | Google Sheets | C | `api` | Sheets API with the sensitive spreadsheets scope after Google app verification, or drive.file plus the Google Picker so the person chooses spreadsheets; or export the person's spreadsheets from Google Takeout |
| 24 | DoorDash | C | `mcp` | Order confirmation and receipt emails in the person's mailbox, or DoorDash actions in iOS Shortcuts if the app offers them |
| 26 | Apple Music | D | `api` | Mac Music app through AppleScript or the person's shortcuts |
| 27 | TikTok | C | `api` | The person's TikTok data download (JSON); in the EEA and UK the Data Portability API, which needs its own application and privacy and security review |
| 28 | Google Keep | E | `other` | The person's Google Takeout export of their Keep notes (read-only) |
| 30 | Apple Health | E | `other` | The person's Export All Health Data archive (XML) from the Health app on iPhone, saved to the Mac and read locally; HealthKit in a Kipster iPhone app only once Apple's rules on sharing health data with AI providers are settled |
| 32 | Venmo | E | `other` | The person's monthly Venmo statement CSV download |
| 33 | Zoom | C | `mcp` | The person creates a private General app in their own Zoom account and enters its client ID and secret; otherwise meeting invites from the person's calendar |
| 34 | Dropbox | C | `mcp` | The Dropbox folder synced to the Mac by the Dropbox desktop app, or the person's own Dropbox app credentials for the MCP |
| 36 | X | D | `mcp` | The person's X data archive (Settings > Download an archive of your data), read from the downloaded files |
| 37 | Reddit | C | `api` | the person's Reddit data request export (CSV files of their posts, comments and saved items) |
| 38 | Walmart | E | `other` | Order emails in the person's mailbox; or a privacy access request |
| 39 | Uber Eats | C | `mcp` | Order confirmation emails in the person's mailbox, the Uber privacy data download, or Uber Eats actions in iOS Shortcuts if the app offers them |
| 40 | Booking.com | C | `mcp` | Booking confirmation emails in the person's mailbox |
| 41 | Airbnb | E | `other` | Booking confirmation and itinerary emails in the person's mailbox, and the person's Airbnb data download (Account > Privacy, machine-readable format) |
| 42 | Cash App | E | `other` | Monthly statements and the activity CSV export the person downloads from cash.app/account, read from the saved files |
| 43 | Chase | C | `other` | the person's transaction download from Chase on desktop (CSV, QFX, QIF or QBO, last two years), plus Chase alert emails in their mailbox |
| 45 | Claude | E | `other` | The person's Claude data export (Settings, Privacy, Export data: conversations and account data, emailed download link) |
| 46 | Apple Home | E | `other` | The person's Home shortcuts (scenes and accessory actions) run by Core via shortcuts run |
| 47 | Google Home | C | `mcp` | Matter and HomeKit-capable devices shared to Apple Home and controlled through Shortcuts on the Mac; or the person sets up their own Home MCP Early Access OAuth client as Google's guide describes |

Primary route type of the alternative across all 1,094 C, D and E rows:

| Route type | C, D and E services |
| --- | ---: |
| Mailbox emails (IMAP) | 430 |
| Data export or data request | 408 |
| Mac or Apple device route | 82 |
| Calendar or feed (ICS, CalDAV, RSS) | 44 |
| Official CLI | 15 |
| Other | 115 |
| Total | 1,094 |

Of the 115 "Other" alternatives, 64 are an API or MCP variant: the person's own
developer app, a narrower scope, a different API or a key.

## Data flow through third parties

Aggregators such as Composio, Pipedream, Zapier and Arcade are never a route: no
alternative in the catalog uses one. 34 alternatives do route the person's data
through a service, software or device not made by the vendor, and a plugin built
on them must say so before the person connects:

- **Fitness services the person also uses (6):** Peloton (192) via Strava; Nike
  Run Club (209) via Strava; Suunto (490) via a connected fitness service with
  an open API; Zwift (532) via Strava or Garmin Connect; TrainingPeaks (550) via
  Garmin or Strava; Runna (569) via Strava.
- **Home Assistant or other non-vendor software or hardware (13):** Ring (113)
  via Home Assistant (community integration); Blink (197) via Home Assistant;
  myQ (263) via a ratgdo controller; TP-Link Kasa (306) via Home Assistant;
  Roborock (410) via Home Assistant; Reolink (552) via Home Assistant; Aqara
  (729) via Home Assistant; SwitchBot (755) via Home Assistant; Smart Life (785)
  via Home Assistant; Xiaomi Home (807) via Home Assistant; Schlage (910) via
  Home Assistant; IQAir (960) via Home Assistant; MySQL (1594) via a community
  MySQL MCP server.
- **Notes, read-later or cloud storage services (4):** Notability (329) via Box,
  Dropbox, Google Drive, OneDrive or WebDAV; Matter (554) via Obsidian, Notion
  or Readwise; Snipd (598) via Notion, Obsidian or Readwise; BetterSleep (625)
  via Health Connect export to a cloud storage app.
- **Accounting software (2):** Novo (1660) via QuickBooks or Xero; Dext (1712)
  via Xero or QuickBooks.
- **Blockchain explorer or RPC provider (1):** MetaMask (968) via Etherscan or a
  public RPC.
- **Privacy-request portal run by another company (2):** ABCmouse (873) via
  my.datasubject.com; Avast (1083) via OneTrust.
- **Other non-vendor services (6):** Credit Karma (82) via
  AnnualCreditReport.com; Amazon Music (142) via Spotify or Apple Music; UFC
  (601) via UFCalendar (unofficial ICS feed); McAfee (976) via Malwarebytes;
  Malwarebytes (1012) via McAfee; DHL (1232) via a tracker app such as Parcel.

Not flagged, but noted: 12 alternatives read the person's own account at the
provider an app sits on top of (Fantastical (185), Notion Calendar (420), Spark
Mail (424), Edison Mail (907), Morgen (954), Spike (1008), Tiimo (1009), Saturn
(1151), Superhuman (1279), Setmore (1325), Shortwave (1327), Zcal (1375)), and
17 replace the person's data with a different public source (Google Maps (11)
via Apple Maps, The Weather Channel (116) via US National Weather Service, Yelp
(133) via Apple Maps, Citymapper (157) via Apple Maps, Weather Underground (187)
via Apple WeatherKit, Transit (204) via transit agencies' GTFS feeds, Moovit
(247) via transit agencies' GTFS feeds, Windy (343) via Apple WeatherKit or
another forecast API, Epic Games (372) via Home Assistant's free-game calendar,
MyRadar (422) via US National Weather Service, Bing (544) via another web search
API, WeatherBug (566) via US National Weather Service, RadarScope (763) via US
National Weather Service, Flashscore (863) via public sports data APIs,
PlugShare (917) via Open Charge Map, Kelley Blue Book (1160) via NHTSA vPIC,
Watch Duty (1203) via US National Weather Service). The second group sends only
queries, such as a place or a VIN, to that source, not the person's account
data.

## By category

| Category | Services | A | B | C | D | E | `mcp` | `api` | `other` | `not-feasible` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| travel | 72 | 7 | 4 | 10 | 1 | 50 | 12 | 7 | 53 | 0 |
| shopping | 69 | 2 | 4 | 7 | 1 | 55 | 3 | 11 | 55 | 0 |
| health-and-fitness | 65 | 1 | 4 | 20 | 1 | 39 | 3 | 21 | 41 | 0 |
| finance-and-banking | 56 | 0 | 2 | 7 | 6 | 41 | 0 | 3 | 53 | 0 |
| developer-tools | 52 | 39 | 9 | 0 | 3 | 1 | 40 | 10 | 2 | 0 |
| smart-home | 52 | 7 | 13 | 10 | 0 | 22 | 8 | 19 | 23 | 2 |
| food-and-delivery | 47 | 3 | 0 | 7 | 1 | 36 | 8 | 2 | 37 | 0 |
| learning | 46 | 6 | 5 | 10 | 0 | 25 | 8 | 13 | 21 | 4 |
| video-and-streaming | 46 | 1 | 6 | 1 | 1 | 37 | 1 | 7 | 32 | 6 |
| design-and-creative | 43 | 21 | 4 | 7 | 5 | 6 | 31 | 5 | 7 | 0 |
| news-and-reading | 42 | 3 | 6 | 3 | 3 | 27 | 4 | 7 | 29 | 2 |
| investing-and-crypto | 40 | 21 | 4 | 2 | 0 | 13 | 21 | 6 | 13 | 0 |
| sports | 40 | 0 | 4 | 2 | 0 | 34 | 0 | 5 | 33 | 2 |
| chat-and-messaging | 37 | 7 | 11 | 4 | 3 | 12 | 11 | 13 | 10 | 3 |
| maps-and-rides | 36 | 2 | 4 | 6 | 4 | 20 | 4 | 10 | 21 | 1 |
| productivity | 36 | 30 | 4 | 0 | 0 | 2 | 30 | 4 | 2 | 0 |
| automotive | 35 | 1 | 2 | 4 | 4 | 24 | 1 | 7 | 26 | 1 |
| crm-and-sales | 33 | 19 | 10 | 4 | 0 | 0 | 25 | 7 | 1 | 0 |
| groceries | 32 | 2 | 1 | 3 | 0 | 26 | 5 | 1 | 25 | 1 |
| marketing-and-email-marketing | 32 | 22 | 3 | 7 | 0 | 0 | 26 | 6 | 0 | 0 |
| podcasts-and-books | 31 | 2 | 2 | 2 | 0 | 25 | 3 | 3 | 24 | 1 |
| project-management | 31 | 20 | 10 | 1 | 0 | 0 | 23 | 8 | 0 | 0 |
| events-and-tickets | 30 | 1 | 2 | 4 | 2 | 21 | 3 | 5 | 22 | 0 |
| music-and-audio | 30 | 3 | 2 | 6 | 2 | 17 | 4 | 8 | 16 | 2 |
| password-and-security | 30 | 5 | 0 | 3 | 0 | 22 | 8 | 0 | 20 | 2 |
| utilities-and-telecom | 29 | 0 | 1 | 3 | 0 | 25 | 0 | 3 | 26 | 0 |
| hr-and-recruiting | 28 | 10 | 7 | 9 | 1 | 1 | 11 | 16 | 1 | 0 |
| notes | 27 | 16 | 2 | 1 | 0 | 8 | 16 | 2 | 9 | 0 |
| payments | 27 | 7 | 3 | 1 | 1 | 15 | 9 | 3 | 15 | 0 |
| home-and-family | 26 | 1 | 0 | 3 | 0 | 22 | 2 | 1 | 23 | 0 |
| budgeting-and-taxes | 24 | 4 | 4 | 3 | 0 | 13 | 7 | 4 | 13 | 0 |
| docs-and-office | 24 | 5 | 7 | 3 | 1 | 8 | 5 | 10 | 9 | 0 |
| social | 23 | 1 | 5 | 5 | 4 | 8 | 2 | 11 | 10 | 0 |
| analytics-and-data | 22 | 13 | 4 | 5 | 0 | 0 | 17 | 5 | 0 | 0 |
| email | 20 | 4 | 3 | 2 | 1 | 10 | 5 | 2 | 13 | 0 |
| forms-and-surveys | 20 | 7 | 9 | 1 | 2 | 1 | 7 | 12 | 1 | 0 |
| jobs-and-careers | 20 | 3 | 1 | 2 | 0 | 14 | 4 | 2 | 14 | 0 |
| accounting-and-invoicing | 19 | 9 | 4 | 4 | 1 | 1 | 12 | 5 | 2 | 0 |
| ai-assistants | 19 | 4 | 2 | 0 | 2 | 11 | 4 | 4 | 11 | 0 |
| ecommerce-platforms | 19 | 6 | 10 | 3 | 0 | 0 | 7 | 12 | 0 | 0 |
| real-estate | 19 | 0 | 1 | 3 | 1 | 14 | 2 | 2 | 15 | 0 |
| sleep-and-wellbeing | 19 | 0 | 0 | 0 | 0 | 19 | 0 | 0 | 19 | 0 |
| files-and-storage | 18 | 4 | 4 | 2 | 1 | 7 | 7 | 3 | 8 | 0 |
| language-learning | 18 | 1 | 2 | 0 | 1 | 14 | 1 | 3 | 11 | 3 |
| scheduling | 18 | 7 | 4 | 3 | 0 | 4 | 9 | 4 | 5 | 0 |
| weather | 18 | 1 | 5 | 0 | 4 | 8 | 1 | 9 | 6 | 2 |
| tasks-and-reminders | 17 | 7 | 3 | 1 | 0 | 6 | 7 | 4 | 6 | 0 |
| dating | 16 | 0 | 0 | 0 | 0 | 16 | 0 | 0 | 14 | 2 |
| social-media-management | 16 | 10 | 0 | 2 | 0 | 4 | 10 | 2 | 4 | 0 |
| customer-support | 15 | 10 | 2 | 2 | 1 | 0 | 11 | 4 | 0 | 0 |
| databases | 15 | 13 | 2 | 0 | 0 | 0 | 14 | 1 | 0 | 0 |
| games | 15 | 1 | 5 | 1 | 0 | 8 | 1 | 6 | 8 | 0 |
| government-and-civic | 14 | 0 | 4 | 5 | 0 | 5 | 0 | 7 | 7 | 0 |
| photos | 14 | 1 | 3 | 1 | 0 | 9 | 1 | 4 | 9 | 0 |
| security-and-it | 14 | 8 | 5 | 1 | 0 | 0 | 9 | 5 | 0 | 0 |
| website-and-cms | 13 | 10 | 2 | 1 | 0 | 0 | 10 | 2 | 1 | 0 |
| cloud-and-hosting | 11 | 10 | 0 | 1 | 0 | 0 | 11 | 0 | 0 | 0 |
| knowledge-base | 11 | 10 | 1 | 0 | 0 | 0 | 10 | 1 | 0 | 0 |
| pets | 11 | 0 | 1 | 0 | 0 | 10 | 0 | 1 | 10 | 0 |
| video-calls | 11 | 2 | 3 | 2 | 0 | 4 | 3 | 4 | 4 | 0 |
| calendar | 10 | 2 | 1 | 1 | 0 | 6 | 3 | 1 | 6 | 0 |
| legal-and-signatures | 9 | 4 | 0 | 3 | 2 | 0 | 6 | 3 | 0 | 0 |
| other | 6 | 1 | 1 | 0 | 2 | 2 | 2 | 2 | 2 | 0 |
| Total | 1,738 | 417 | 227 | 204 | 62 | 828 | 508 | 348 | 848 | 34 |

## Cost and verification

| Cost | Meaning | Services |
| --- | --- | ---: |
| `free` | Connecting costs nothing beyond a free account. | 1,356 |
| `user-paid-plan` | The person's ordinary paid plan includes the access. | 328 |
| `paid-api` | API access is sold separately, or the API is the product. | 40 |
| `audit-or-review-fee` | The project pays for a security audit or review. | 14 |

| Verified | Meaning | Deep | Light | Services |
| --- | --- | ---: | ---: | ---: |
| `yes` | The row's claims were confirmed from vendor pages or live discovery metadata. | 41 | 219 | 260 |
| `partly` | Some claims were confirmed; at least one, usually a negative such as "no API" or "no MCP", could not be confirmed from a primary source. | 357 | 1,087 | 1,444 |
| `no` | The row could not be confirmed from a primary source, for example because vendor pages refused automated reads. | 2 | 32 | 34 |

## Reference points

[plugin-model.md](plugin-model.md) used these services as reference points for
the classes. catalog.csv agrees with every one:

| Service | Rank | Expected | Class | Path | `auth` |
| --- | ---: | --- | --- | --- | --- |
| Notion | 1256 | A | A | `mcp` | `oauth-cimd` |
| Linear | 1271 | A | A | `mcp` | `oauth-cimd` |
| Todoist | 55 | A | A | `mcp` | `oauth-cimd` |
| Airtable | 1261 | A | A | `mcp` | `oauth-cimd` |
| Trello | 1263 | A | A | `mcp` | `oauth-cimd` |
| GitHub | 1406 | B | B | `mcp` | `oauth-preregistered` |
| Asana | 1257 | B | B | `mcp` | `oauth-preregistered` |
| Slack | 1260 | C | C | `mcp` | `oauth-preregistered` |
| Gmail | 1 | D | D | `mcp` | `oauth-preregistered` |
| Google Drive | 3 | D | D | `mcp` | `oauth-preregistered` |
| Microsoft Outlook | 6 | B | B | `api` | `oauth-preregistered` |
| Microsoft OneDrive | 25 | B | B | `api` | `oauth-preregistered` |
| Microsoft To Do | 29 | B | B | `api` | `oauth-preregistered` |

Notion, Linear, Todoist, Airtable and Trello advertise both dynamic client
registration and client ID metadata documents; the catalog records `oauth-cimd`,
the method the current MCP specification prefers. The Microsoft personal-account
rows are class B as expected but take path `api`, because Microsoft's own MCP
servers serve work tenants with Microsoft 365 Copilot licences only. Gmail and
Google Drive are class D on path `mcp`: Google's MCP servers exist, but their
restricted scopes need verification and a yearly security assessment; Drive's
alternative is the non-sensitive `drive.file` scope with the Google Picker.

## What this means for building a plugin catalog

A suggested order, after Core has its shared MCP client, OAuth flow and Keychain
storage:

1. **Class A everyday services (417, 363 with personal accounts).** Start with
   the 304 that use browser sign-in; the 76 that need a pasted key or token
   follow once Core can store one.
2. **Shared `other`-path building blocks.** One IMAP mail plugin serves the 369
   services whose primary route is the mailbox; a reader for exported files and
   data-request copies serves 351; Mac and Apple plugins (Shortcuts, EventKit,
   Apple Home, AppleScript) serve 65; a calendar and feed reader serves 40; and
   11 official CLIs follow one pattern.
3. **Class B registrations (227).** Each is one free app under the project's
   name; one Entra app covers the Microsoft rows, and the 26 B services with a
   vendor MCP need only a client ID.
4. **Class C applications worth filing (204).** File where the rank justifies
   weeks of review, starting with the 68 that already have a vendor MCP; one
   Google verification covers several Google rows.
5. **Class D only where the value justifies the cost (62).** Use the documented
   alternative until then.
6. **Class E (828)** is reached only through step 2; 33 of these services have
   no route.

## How rows were classified

- **Class A:** an official vendor MCP that a person connects with nothing for
  the project to register: OAuth with dynamic client registration or client ID
  metadata documents, or a free self-serve key or token. The `auth` column shows
  which.
- **Class B:** no review; the project registers one free developer app, or the
  person creates a free self-serve key, for a public API, or for an MCP that
  needs a pre-registered client.
- **Class C:** vendor review, marketplace listing, allowlist, partner programme
  or waitlist, including vendors that closed new app creation but document a
  partner route.
- **Class D:** paid API tier (including a paid plan whose product is the API
  itself), a security audit such as Google CASA, or business verification such
  as Meta's. A service stays in class B with `user-paid-plan` only when the
  person's ordinary subscription includes API access.
- **Class E:** no public API, or a public API that no longer accepts new apps
  and has no partner route (`auth` is `no-public-api`).
- **Path `other`:** a documented route to the person's own data: vendor
  Shortcuts or App Intents actions, Apple Home, Mac scripting, a self-service
  data export or documented data-request flow, ICS, the service's RSS, an
  official CLI, or vendor-documented emails in the person's mailbox that carry
  the service's core data (statements, ride receipts, order, delivery or booking
  confirmations, bills). Subscription billing receipts and bare statements of
  legal access rights do not count. Saving or exporting the person's own content
  or saved lists counts, with its limits noted. Routes limited to some countries
  or states count, with the limit noted.
- **Path `not-feasible`:** no qualifying route anywhere.
- A vendor-local MCP built into firmware or an app uses the vendor's
  documentation or download page for that feature as its URL, never a product or
  sales page.
- OAuth client credentials that the customer's own admin creates are
  `oauth-preregistered`; the project registers nothing.

Route types in this report come from the `alternative` column. Its first clause
(the text before the first "; " or ", or ") is tested against keyword groups in
this order, and the first match wins:

1. Mailbox emails: mailbox, IMAP, inbox, mail plugin, own email, emails.
2. Official CLI: CLI, command-line.
3. Data export or data request: export, download, copy, request, privacy,
   portability, archive, backup, Takeout, FOIA, statement, PDF, CSV, Blue
   Button, Green Button, save, personal data or information, data report.
4. Calendar or feed: ICS, iCal, CalDAV, CardDAV, RSS, Atom, OPML, feed,
   calendar.
5. Mac or Apple device route: Shortcuts, App Intents, AppleScript, Apple Events,
   JXA, Apple Home, HomeKit, HealthKit, Apple Health, Siri, EventKit and other
   Apple frameworks, Apple Wallet, URL schemes, on the Mac, local files, synced
   folders.
6. Other: no match.

## Method and limits

- The deep tier (400 services) was verified from vendor documentation and
  unauthenticated reads of OAuth and MCP discovery metadata; the light tier
  (1,338) was checked against vendor pages and the MCP Registry with less depth.
- Nothing was registered and no one signed in; only public pages and discovery
  metadata were read.
- Negative claims (no API, no MCP, no export) are hard to prove and are marked
  `partly` unless a vendor states them.
- Vendors change MCP servers, scopes and programmes often; re-check a row before
  building on it.
- The route-type and third-party counts come from the keyword rules and the
  review described above; a service can offer several routes, and only its
  primary one is counted.

Files:

- [catalog.csv](catalog.csv): the canonical catalog, one row per service, sorted
  by rank.
- [plugin-model.md](plugin-model.md): plugin parts, classes, paths and checks.
- [sources.md](sources.md): where the service list and rankings came from.
- [ios.md](ios.md): what Kipster can reach on iPhone and Mac through Apple
  frameworks.
