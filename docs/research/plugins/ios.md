# Apple platforms: what Kipster can connect to on iPhone and Mac

Research note, October 2026 (iOS 27 and macOS 27 are current). Every claim
links an Apple source unless it says otherwise. **Unconfirmed** marks anything
we could not confirm from a primary source. Press reports are labelled as press.

Summary:

- An iPhone app can read and write Calendar, Reminders, Contacts, Health,
  Photos, Home, Apple Music and location, each behind its own permission
  prompt. It cannot read Messages, Mail or Notes.
- On iPhone, Kipster can offer its own actions to Siri, Shortcuts and Apple
  Intelligence through App Intents. It cannot call other apps' actions; the
  only route into them is running a shortcut the user has built.
- Apple has not shipped MCP for apps. MCP ships only inside Xcode.
- On the Mac, Kipster Core can reach Notes, Mail, Messages (send only), Music
  and Photos through Apple Events. It can reach Calendar, Reminders and
  Contacts through EventKit and Contacts, and any shortcut through the
  `shortcuts` command. This is the strongest Apple path for plugins.

## 1. iPhone frameworks

| Source                                                                                                                                | What the app gets                                                                                                                                                                                                                                                                          | Permission                                                                                                                                                                                                                                                                                                       | Read / write                                                                                   | Background                                                                                                                                                                                                                                                        | Review conditions                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar ([EventKit](https://developer.apple.com/documentation/eventkit/accessing-the-event-store))                                   | Events and calendars                                                                                                                                                                                                                                                                       | Full access (`NSCalendarsFullAccessUsageDescription`) or write-only (`NSCalendarsWriteOnlyAccessUsageDescription`).                                                                                                                                                                                              | Full: create, view, edit, delete. Write-only: create only, can't read any event, even its own. | No separate limit found                                                                                                                                                                                                                                           | Purpose strings must describe the use ([5.1.1(ii)](https://developer.apple.com/app-store/review/guidelines/))                                                    |
| Reminders ([EventKit](https://developer.apple.com/documentation/eventkit/accessing-the-event-store))                                  | Reminders and lists                                                                                                                                                                                                                                                                        | Full access only (`NSRemindersFullAccessUsageDescription`). No read-only access exists.                                                                                                                                                                                                                          | Read and write                                                                                 | As above                                                                                                                                                                                                                                                          | As above                                                                                                                                                         |
| Calendar, no permission ([EventKit](https://developer.apple.com/documentation/eventkit/accessing-the-event-store))                    | Apple's event editor and chooser screens                                                                                                                                                                                                                                                   | None                                                                                                                                                                                                                                                                                                             | User saves the event in Apple's screen                                                         | Foreground only                                                                                                                                                                                                                                                   | None                                                                                                                                                             |
| [Contacts](https://developer.apple.com/documentation/contacts/accessing-a-person-s-contact-data-using-contacts-and-contactsui)        | Contact cards and groups                                                                                                                                                                                                                                                                   | `NSContactsUsageDescription`. Since iOS 18 users may grant [limited access](https://developer.apple.com/documentation/contacts/cnauthorizationstatus/limited) to chosen contacts; [`ContactAccessButton`](https://developer.apple.com/documentation/contactsui/contactaccessbutton) adds contacts one at a time. | Read and write                                                                                 | No separate limit found                                                                                                                                                                                                                                           | The notes field needs an [Apple-approved entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.contacts.notes) |
| [HealthKit](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)                                              | Health samples and workouts                                                                                                                                                                                                                                                                | Granted per data type, separately for reading (`NSHealthShareUsageDescription`) and writing (`NSHealthUpdateUsageDescription`). The app [can't tell](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data) whether reading was denied: denied data looks like no data.          | Read and write                                                                                 | Data is encrypted while the phone is locked, so background reads may fail. Observer queries need the [background-delivery entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery). | See below                                                                                                                                                        |
| Photos ([PhotoKit](https://developer.apple.com/documentation/photokit/delivering-an-enhanced-privacy-experience-in-your-photos-app))  | Library assets and albums                                                                                                                                                                                                                                                                  | Read/write (`NSPhotoLibraryUsageDescription`) or add-only (`NSPhotoLibraryAddUsageDescription`). Users may allow only selected photos. The system photo picker needs no permission.                                                                                                                              | Read and write, or add-only                                                                    | No separate limit found                                                                                                                                                                                                                                           | —                                                                                                                                                                |
| [HomeKit](https://developer.apple.com/documentation/homekit/enabling-homekit-in-your-app)                                             | Homes, rooms, accessories, scenes                                                                                                                                                                                                                                                          | HomeKit entitlement and `NSHomeKitUsageDescription`                                                                                                                                                                                                                                                              | Read and control                                                                               | An Apple engineer [said in 2015](https://developer.apple.com/forums/thread/22279) apps may not control accessories in the background. **Unconfirmed** in current documentation.                                                                                   | —                                                                                                                                                                |
| [Matter](https://developer.apple.com/documentation/matter) / [MatterSupport](https://developer.apple.com/documentation/mattersupport) | Set up and control Matter devices; MatterSupport adds them to the app's own ecosystem through an app extension                                                                                                                                                                             | **Unconfirmed**                                                                                                                                                                                                                                                                                                  | Control                                                                                        | **Unconfirmed**                                                                                                                                                                                                                                                   | —                                                                                                                                                                |
| [MusicKit](https://developer.apple.com/documentation/musickit)                                                                        | Apple Music catalog search, the user's library, playback                                                                                                                                                                                                                                   | `NSAppleMusicUsageDescription`. Catalog playback needs an [Apple Music subscription](https://developer.apple.com/documentation/musickit/musicsubscription).                                                                                                                                                      | Read; library changes need cloud library                                                       | Playback only                                                                                                                                                                                                                                                     | The user must start playback, and access to Apple Music may not be monetized ([4.5.2](https://developer.apple.com/app-store/review/guidelines/))                 |
| Location ([Core Location](https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services))  | Position, [region monitoring](https://developer.apple.com/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions), [significant changes](<https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringsignificantlocationchanges()>) | When In Use (`NSLocationWhenInUseUsageDescription`). Always also needs `NSLocationAlwaysAndWhenInUseUsageDescription`. Users can grant [approximate location only](https://developer.apple.com/documentation/corelocation/claccuracyauthorization).                                                              | Read                                                                                           | Continuous updates need the [background mode](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background). Always lets the system relaunch the app for regions and visits. At most 20 monitored conditions.               | Only when directly relevant, with consent ([5.1.5](https://developer.apple.com/app-store/review/guidelines/))                                                    |

**Health data rules.** Apple's [HealthKit privacy page](https://developer.apple.com/documentation/healthkit/protecting-user-privacy) bans advertising use and selling health data. It also bans giving the data to third parties without express permission. App Review Guidelines ([5.1.3](https://developer.apple.com/app-store/review/guidelines/)) allow health data only for health management or research, with permission. Apps must not store personal health information in iCloud. Guideline 5.1.2(i) requires apps to disclose and get explicit permission before sharing personal data "with third parties, including with third-party AI". Apple [added the AI wording](https://developer.apple.com/news/?id=ey6d8onl) in November 2025.

For Kipster, Health data may leave the device only with explicit consent and disclosure. That covers sending it to Core and on to an AI provider.

**Other useful pieces.**

- **Files.** The [document picker](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller) gives access only to files the user picks. Saved bookmarks let the app return to them later. [File Provider](https://developer.apple.com/documentation/fileprovider) lets an app show its own files in Files.
- **Mail and Messages compose sheets.** [Mail](https://developer.apple.com/documentation/messageui/mfmailcomposeviewcontroller) and [Messages](https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller) compose sheets prepare a message. The user must tap Send. Once the Mail sheet is shown, the app can't change the message.
- **Notifications.** Notifications need [permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications). Provisional authorization delivers quietly without a prompt.
- **Focus filters.** A [Focus filter](https://developer.apple.com/documentation/appintents/setfocusfilterintent) lets the app change its behavior when a Focus turns on.
- **Wallet.** [FinanceKit](https://developer.apple.com/financekit/) reads Apple Card, Apple Cash and Savings in the US, and connected bank accounts in the UK. It needs an Apple-approved entitlement, limited to finance-management apps in the Finance category. [PassKit](https://developer.apple.com/documentation/passkit) adds and updates Wallet passes.
- **Background work.** [Background work](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app) runs when the system decides. App refresh gets up to 30 seconds. Background pushes get 30 seconds and are rate-limited above three per hour. Since iOS 26, a [continued processing task](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask) can finish a job the user started, showing progress the user can cancel.

## 2. App Intents and Shortcuts

**Exposing Kipster's actions.** [App Intents](https://developer.apple.com/documentation/appintents) describe an app's actions (intents) and data (entities) to Siri, Spotlight, Shortcuts, widgets and Apple Intelligence. [App Shortcuts](https://developer.apple.com/documentation/appintents/app-shortcuts) are available as soon as the app is installed, with no setup by the user. Intents are read from the app at build time ([WWDC25](https://developer.apple.com/videos/play/wwdc2025/244/)). Our conclusion: a Kipster plugin cannot add new iPhone intents at runtime; they ship with app updates.

Since iOS 27 the system can [connect App Intents to Siri AI](https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai), Apple's new assistant. This works through indexed entities, onscreen content, shareable data types and donated actions. Also new in iOS 27 are intents that [run past the old 30-second limit](https://developer.apple.com/videos/play/wwdc2026/345/).

**Schemas and domains.** An app can conform its intents to [system schemas](https://developer.apple.com/documentation/appintents/app-schema-domains) so the system knows what they do. For example, a mail app's `.mail.createDraft` lets the system create a draft in that app. The domains fall into three groups:

- **Primary:** Audio, Calendar, Camera, Clock, Mail, Maps, Messages, Notes, Phone, Photos, Reminders, and system and in-app search.
- **Single-purpose:** Assistant and Visual Intelligence.
- **Shortcuts-only:** Books, Browser, Files, Journaling, Presentation, Reader, Spreadsheet, Whiteboard and Word processor.

The [Notes](https://developer.apple.com/documentation/appintents/app-schema-domain-notes) and [Messages](https://developer.apple.com/documentation/appintents/app-schema-domain-messages) domains are for an app's _own_ notes or messaging. They give no access to Apple Notes or iMessage. The [Assistant domain](https://developer.apple.com/documentation/appintents/app-schema-domain-assistant), which launches a voice assistant app from the side button, is "available only in Japan". [SiriKit](https://developer.apple.com/documentation/sirikit) is now legacy.

**Acting through other apps.** App Intents let an app declare, donate and test its _own_ intents. We found no public API to list or call another app's intents. **Unconfirmed:** Apple states no such ban; this conclusion rests on the API not existing. The [security guide](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web) limits apps to services iOS explicitly provides. What remains:

- Kipster can [run a shortcut by name](https://support.apple.com/guide/shortcuts/apd624386f42/ios) with `shortcuts://run-shortcut?name=…&input=…`. With [x-callback-url](https://support.apple.com/guide/shortcuts/apdcd7f20a6f/ios) (`shortcuts://x-callback-url/run-shortcut?…&x-success=…`) it gets the shortcut's text output back. The user must first build the shortcut, which can use any app's actions (section 4).
- **Unconfirmed:** opening the URL switches to Shortcuts in the foreground, so this can't run unattended in the background.
- Kipster can open another app's URL scheme or universal link. [`canOpenURL`](<https://developer.apple.com/documentation/uikit/uiapplication/canopenurl(_:)>) only works for schemes declared in advance, at most 25 for apps built for iOS 27.
- Shortcuts' [Use Model action](https://support.apple.com/guide/shortcuts/use-apple-intelligence-in-shortcuts-tpg3vrvwmclv/ios) lets a user's shortcut call Apple's on-device or cloud models, or ChatGPT.
- Shortcuts can [trigger automations on incoming email or messages](https://support.apple.com/guide/shortcuts/communication-triggers-apdd711f9dff/ios). The user sets these up; an app cannot.

## 3. What the iPhone sandbox forbids

- **Other apps' data.** Each app is sandboxed so it can't gather or change other apps' information. Apps reach other data only through services iOS provides ([Apple Platform Security](https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web)). Apps also may not read or write outside their container ([guideline 2.5.2](https://developer.apple.com/app-store/review/guidelines/)).
- **Messages.** There is no API for message history. Sending goes through the [compose sheet](https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller), which needs the user's approval. **Unconfirmed** as an explicit Apple statement: the history point rests on no framework existing.
- **Mail.** iOS has only the [compose sheet](https://developer.apple.com/documentation/messageui/mfmailcomposeviewcontroller). [MailKit](https://developer.apple.com/documentation/mailkit) Mail extensions exist only on macOS. Reading the inbox is not possible. **Unconfirmed** as an explicit statement: it rests on no API existing.
- **Notes.** No public framework reads or writes Apple Notes. The Notes schema domain covers only the app's own notes (section 2). **Unconfirmed** as an explicit statement.
- **Automating other apps.** Apps may use only public APIs, for their intended purposes ([2.5.1](https://developer.apple.com/app-store/review/guidelines/)). There is no API to drive another app's interface. **Unconfirmed** as an explicit statement.
- **Background.** Background services may be used only for their intended purposes ([2.5.4](https://developer.apple.com/app-store/review/guidelines/)). Timing and length are [decided by the system](https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app). Kipster's iPhone app can't watch other apps or run long jobs on its own; Core on the Mac stays the place for unattended work.
- **AI and plug-in rules.** Guideline 4.7 bans exposing native platform APIs to plug-in software without Apple's permission (4.7.2). It requires explicit consent each time data or permissions are shared (4.7.3). Guideline 5.1.2(i) requires consent before personal data reaches third-party AI ([guidelines](https://developer.apple.com/app-store/review/guidelines/)).

## 4. iPhone apps with Shortcuts or Siri actions

Apple's [iOS 18](https://support.apple.com/en-us/121131) and [iOS 26](https://support.apple.com/en-us/125148) "What's new in Shortcuts" notes list app actions; other Apple pages are linked per row. "Vendor" means the vendor's own help page or announcement; "App Store" means the vendor's App Store listing.

| App                             | Kinds of actions                                              | Source                                                                                                            |
| ------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Reminders                       | Find reminders, quick reminder                                | [Apple](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios)              |
| Calendar                        | Find events, add event, attendees                             | [Apple](https://support.apple.com/guide/shortcuts/share-actions-apdaf74d75a5/ios)                                 |
| Notes                           | Append to note, scan, checklist items, folders                | [Apple](https://support.apple.com/en-us/121131)                                                                   |
| Mail                            | Find messages; automations on incoming mail                   | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Messages                        | Find message or conversation, open conversation, Check In     | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Music                           | Find music, playlists, current song                           | [Apple](https://support.apple.com/guide/shortcuts/navigate-the-action-list-apdc33e4f4da/ios)                      |
| Photos                          | Find and search photos, albums, memories                      | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Maps                            | Directions with stops, find places                            | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Home                            | Control accessories and scenes, home automations              | [Apple](https://support.apple.com/en-us/121131)                                                                   |
| Health                          | Log samples and workouts, find samples                        | [Apple](https://support.apple.com/guide/shortcuts/share-actions-apdaf74d75a5/ios)                                 |
| Files                           | Save and filter files                                         | [Apple](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios)              |
| Safari                          | Run JavaScript on a page, settings                            | [Apple](https://support.apple.com/guide/shortcuts/intro-to-the-run-javascript-on-webpage-action-apd218e2187d/ios) |
| Weather                         | Current weather, locations                                    | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Journal                         | Create entry, audio entry, search                             | [Apple](https://support.apple.com/en-us/121131)                                                                   |
| Voice Memos                     | Find recordings, play last memo                               | [Apple](https://support.apple.com/en-us/125148)                                                                   |
| Contacts                        | Find contacts                                                 | [Apple](https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios)              |
| Freeform, Stocks, Wallet, Clock | Boards, watchlists, open card, world clock                    | [Apple](https://support.apple.com/en-us/121131)                                                                   |
| Things 3                        | Create, find, edit and delete to-dos and projects; show lists | [Vendor](https://culturedcode.com/things/support/articles/9596775/)                                               |
| Todoist                         | Create task with date, project, priority, labels              | [Vendor](https://www.todoist.com/help/articles/use-shortcuts-with-todoist-for-ios-xGxBVSMr)                       |
| Fantastical                     | Create from text, show schedule, upcoming items, events       | [Vendor](https://flexibits.com/fantastical-ios/help/integration)                                                  |
| OmniFocus                       | Add items, find items, projects and tags, forecast            | [Vendor](https://support.omnigroup.com/documentation/omnifocus/ios/3.13/en/automating-with-shortcuts/)            |
| TickTick                        | Create tasks, Shortcuts actions                               | [App Store](https://apps.apple.com/us/app/ticktick-to-do-list-calendar/id626144601)                               |
| Due                             | Create and find reminders, mark done, timers                  | [App Store](https://apps.apple.com/us/app/due-reminders-timers/id390017969)                                       |
| Day One                         | Create, find and append entries                               | [Vendor](https://dayoneapp.com/guides/day-one-ios/day-one-shortcuts/)                                             |
| Bear                            | Create, search, open, tag, archive, export notes              | [Vendor](https://bear.app/faq/how-to-use-siri-shortcuts-with-bear/)                                               |
| Drafts                          | Create and get drafts, workspaces, publish                    | [Vendor](https://docs.getdrafts.com/docs/automation/shortcuts)                                                    |
| Craft                           | Create document, add to document, open                        | [Vendor](https://support.craft.do/en/integrate/apple-shortcuts)                                                   |
| Notion                          | Open Notion AI from Siri or the Action button                 | [Vendor](https://www.notion.com/help/notion-for-mobile)                                                           |
| Actions for Obsidian            | Create, search and edit Obsidian notes, daily notes           | [App Store](https://apps.apple.com/app/actions-for-obsidian/id1659667937)                                         |
| Data Jar                        | Store and read values                                         | [App Store](https://apps.apple.com/us/app/data-jar/id1453273600)                                                  |
| Scriptable                      | Run JavaScript with input and output                          | [App Store](https://apps.apple.com/us/app/scriptable/id1405459188)                                                |
| Actions                         | 180+ utility actions                                          | [Vendor](https://sindresorhus.com/actions)                                                                        |
| Toggl Track                     | Start, stop and continue timers, reports                      | [Vendor](https://support.toggl.com/using-toggl-track-with-ios-shortcuts)                                          |
| Timery                          | Toggl time entries and reports                                | [App Store](https://apps.apple.com/us/app/timery-for-toggl/id1425368544)                                          |
| Pocket Casts                    | Play, pause, skip podcasts                                    | [Vendor](https://support.pocketcasts.com/knowledge-base/siri/)                                                    |
| CARROT Weather                  | Weather data, radar                                           | [App Store](https://apps.apple.com/us/app/carrot-weather-alerts-radar/id961390574)                                |
| Streaks                         | Complete tasks, notes                                         | [App Store](https://apps.apple.com/us/app/streaks/id963034692)                                                    |
| Strava                          | Start, pause and resume recording                             | [Vendor](https://support.strava.com/en-us/articles/15401777-siri-integration)                                     |
| Waze                            | Drive home, work or a saved place; sound settings             | [Vendor](https://support.google.com/waze/answer/9245980?hl=en)                                                    |
| Monzo                           | Pay, request and move money                                   | [Vendor](https://community.monzo.com/t/ios-shortcuts-integration-is-here/189478)                                  |
| Claude                          | Ask Claude, analyze photo                                     | [Vendor](https://support.claude.com/en/articles/10263469-use-claude-app-intents-shortcuts-and-widgets-on-ios)     |
| Uber                            | Request a ride with Siri (announced 2016)                     | [Vendor](https://www.uber.com/newsroom/siri-integration)                                                          |
| Venmo                           | Pay or request with Siri                                      | [Vendor](https://help.venmo.com/cs/articles/imessage-siri-payments-vhel331)                                       |
| Citymapper                      | Directions with Siri                                          | [App Store](https://apps.apple.com/us/app/citymapper-all-live-transit/id469463298)                                |
| WhatsApp                        | Siri support; actions not listed                              | [App Store](https://apps.apple.com/us/app/whatsapp-messenger/id310633997)                                         |
| Telegram                        | Siri support; actions not listed                              | [App Store](https://apps.apple.com/us/app/telegram-messenger/id686449807)                                         |

**Unconfirmed** (seen only in press or forums, or nothing found from the vendor): Microsoft To Do, Outlook, Slack, Evernote, Spotify, Overcast, ChatGPT, Perplexity, Google Maps, Gmail, Google Calendar, Google Drive, PayPal, Revolut, Chase, Starling, Lyft, Airbnb, Starbucks, Duolingo, Dropbox, 1Password, Withings, Oura and Gentler Streak.

## 5. Apple and MCP or agents, as of October 2026

| Status                                                                                 | Date     | What                                                                                                                                                                                                         | Source                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reported (press)                                                                       | Sep 2025 | Code in the iOS and macOS 26.1 betas hinted at MCP support in App Intents. Apple has not confirmed this.                                                                                                     | [9to5Mac](https://9to5mac.com/2025/09/22/macos-tahoe-26-1-beta-1-mcp-integration/)                                                                                                                               |
| Shipped                                                                                | 2025     | Foundation Models framework (apps can use Apple's on-device model, with tool calling). Shortcuts can call Apple Intelligence models.                                                                         | [Apple Newsroom](https://www.apple.com/newsroom/2025/06/apple-intelligence-gets-even-more-powerful-with-new-capabilities-across-apple-devices/), [WWDC25](https://developer.apple.com/videos/play/wwdc2025/275/) |
| Reported (press quoting Apple)                                                         | Mar 2025 | Apple delayed the personal Siri that acts "within and across your apps".                                                                                                                                     | [Daring Fireball](https://daringfireball.net/2025/03/apple_is_delaying_the_more_personalized_siri_apple_intelligence_features)                                                                                   |
| Announced (joint statement)                                                            | Jan 2026 | Apple's next foundation models will be based on Google Gemini.                                                                                                                                               | [Google blog](https://blog.google/company-news/inside-google/company-announcements/joint-statement-google-apple/)                                                                                                |
| Shipped                                                                                | Feb 2026 | Xcode 26.3 added agentic coding with Claude Agent and Codex, and exposed Xcode's tools through MCP.                                                                                                          | [Apple Newsroom](https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/)                                                                                                   |
| Announced; Xcode 27 [now out](https://developer.apple.com/news/releases/?id=09182026a) | Jun 2026 | Xcode 27 plug-ins can bring in tools through MCP and connect Agent Client Protocol agents. Foundation Models can use other providers' models such as Claude and Gemini. App Intents connect apps to Siri AI. | [Apple Newsroom](https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/), [WWDC26](https://developer.apple.com/videos/play/wwdc2026/339/)        |
| Announced                                                                              | Jun 2026 | Siri AI: a more personal Siri that acts in apps. "Describe a Shortcut" builds a shortcut from a description. No MCP mentioned.                                                                               | [Apple Newsroom](https://www.apple.com/newsroom/2026/06/apple-intelligence-brings-powerful-ai-capabilities-into-everyday-experiences/)                                                                           |
| Announced                                                                              | Jun 2026 | Siri AI is delayed in the EU on iPhone and iPad because of the Digital Markets Act.                                                                                                                          | [Apple Newsroom](https://www.apple.com/newsroom/2026/06/due-to-dma-siri-ai-delayed-in-eu-for-ios-27-and-ipados-27/)                                                                                              |
| Shipped                                                                                | Sep 2026 | iOS 27 and macOS 27 shipped with Siri AI as an English beta. It is not in China or for users under 13; in the EU it is only on Mac and Vision Pro. The release text mentions no MCP or third-party agents.   | [Apple Newsroom](https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/)                                                                                          |

In short, MCP ships only inside Xcode. The WWDC26 [App Intents session](https://developer.apple.com/videos/play/wwdc2026/343/) does not mention MCP. **Unconfirmed:** press reports of Siri extensions for third-party chatbots in iOS 27; we found no developer documentation for them.

## 6. The Mac: reaching Apple's apps

Kipster Core runs on the Mac, so the Mac is where Apple app data is most reachable.

**Apple Events (AppleScript or [JavaScript for Automation](https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/Introduction.html)).**

- **Info.plist key.** An app that sends Apple Events needs [`NSAppleEventsUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription).
- **Hardened runtime.** A hardened-runtime app also needs the [`com.apple.security.automation.apple-events`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) entitlement.
- **Prompt.** The user sees one prompt per target app, and can change the answer under Privacy & Security > [Automation](https://support.apple.com/guide/mac-help/mchl108e1718/mac).
- **Sandboxed apps** also need [scripting-target or temporary-exception entitlements](https://developer.apple.com/library/archive/qa/qa1888/_index.html).
- **Driving an app's interface** with UI scripting needs [Accessibility permission](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html).

What each app's scripting dictionary offers, read with `sdef` on macOS 26.3 (local evidence, not a web page):

| App       | Read                                                    | Write                                           |
| --------- | ------------------------------------------------------- | ----------------------------------------------- |
| Notes     | Accounts, folders, notes (HTML body, plain text, dates) | Create and edit notes and folders               |
| Reminders | Lists, reminders (due dates, priority, completed)       | Create and edit reminders                       |
| Calendar  | Calendars, events, attendees                            | Create and edit events and calendars            |
| Contacts  | People, groups, addresses                               | Add, edit, remove                               |
| Messages  | Chats and participants; **no message text**             | Send a message or file to a participant or chat |
| Mail      | Accounts, mailboxes, messages (headers, content)        | Compose, send, reply, forward, move, flag       |
| Music     | Tracks, playlists, AirPlay devices                      | Play and pause, playlists, add to library       |
| Photos    | Albums, media items, keywords                           | Import, export, add to albums, create albums    |

**EventKit and Contacts on macOS.** These are the same frameworks as on iPhone, with the same [full or write-only calendar access](https://developer.apple.com/documentation/eventkit/accessing-the-event-store). The full-access request is available [since macOS 14](<https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:)>). Hardened or sandboxed apps need the [calendars](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars) and [address book](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.addressbook) entitlements. Prompts appear under the [Calendars, Reminders and Contacts privacy settings](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac). Use these rather than scripting Calendar, Reminders or Contacts. **Unconfirmed:** whether framework access and Automation access are granted separately.

**The `shortcuts` command.** [`shortcuts run`, `list`, `view` and `sign`](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac) run the user's shortcuts with file or piped input and output. Shortcuts that ask for input pause the process, so unattended shortcuts should avoid alerts. This lets Core use any Shortcuts action of an app installed on the Mac. **Unconfirmed:** that iPhone-only apps' actions are unavailable on the Mac.

**Full Disk Access.** [Full Disk Access](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac) grants "all files … including data from other apps (for example, Mail, Messages, Safari, and Home)". Granting it is the user's choice in System Settings. Apple documents no Messages or Notes database. **Unconfirmed**, from third-party writing only:

- Message history sits in a SQLite file, `~/Library/Messages/chat.db`, readable with Full Disk Access ([Simon Willison](https://simonwillison.net/2020/May/22/using-sql-look-through-all-your-imessage-text-messages/)).
- Notes keeps a private `NoteStore.sqlite` ([OSXDaily](https://osxdaily.com/2020/01/15/where-notes-stored-locally-mac/)).

Both formats are private and can change.

## 7. What this means for Kipster plugins

**Plugin path `other`.** No Apple source has an MCP server or a hosted sign-in. Each needs a local MCP server that Kipster ships, running on the user's Mac beside Core, plus a skill. The "connection" is a macOS permission prompt, not an account sign-in:

- EventKit for Calendar and Reminders.
- Contacts.
- Apple Events for Notes, Mail, Messages (send), Music and Photos.
- `shortcuts run` as a general bridge.

The iPhone app's App Intents are the other `other` source. They let Siri, Shortcuts and Siri AI start Kipster actions, such as asking a kip or adding to a conversation.

**On the phone.** These sources are best reached through the iPhone app, because the phone holds or senses the data:

- Health
- Location
- Home and Matter control

Photos and Music are also scriptable on the Mac (section 6). Sending phone data to Core on the Mac makes them personal data shared with Kipster's AI providers. The app must disclose that and get explicit permission ([5.1.2(i)](https://developer.apple.com/app-store/review/guidelines/)). Health data must not be stored in iCloud.

**Recommended first candidates.**

1. **Mac Calendar and Reminders** through EventKit: documented, read and write, one prompt each.
2. **Mac Contacts** through the Contacts framework.
3. **Mac Notes and Mail** through Apple Events: the only documented route to Notes. Mail's dictionary covers IMAP, POP and iCloud accounts, so a Gmail account added to Mail can be read without Google's restricted API scopes. Reading mail this way needs the Mail app.
4. **The `shortcuts` bridge**: one plugin that exposes the user's chosen shortcuts as tools, reaching any app on the Mac that has Shortcuts actions (section 4 lists iPhone examples).
5. **iPhone App Shortcuts** for Kipster's own actions, then Health and location as opt-in feeds.

**Not recommended.**

- Reading the Messages or Notes databases through Full Disk Access: undocumented formats and a very broad permission.
- UI scripting.

## Sources

Apple developer documentation:

- https://developer.apple.com/documentation/eventkit/accessing-the-event-store
- https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:)
- https://developer.apple.com/documentation/contacts/accessing-a-person-s-contact-data-using-contacts-and-contactsui
- https://developer.apple.com/documentation/contacts/cnauthorizationstatus/limited
- https://developer.apple.com/documentation/contactsui/contactaccessbutton
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.contacts.notes
- https://developer.apple.com/documentation/healthkit/protecting-user-privacy
- https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery
- https://developer.apple.com/documentation/photokit/delivering-an-enhanced-privacy-experience-in-your-photos-app
- https://developer.apple.com/documentation/homekit/enabling-homekit-in-your-app
- https://developer.apple.com/forums/thread/22279
- https://developer.apple.com/documentation/matter
- https://developer.apple.com/documentation/mattersupport
- https://developer.apple.com/documentation/musickit
- https://developer.apple.com/documentation/musickit/musicsubscription
- https://developer.apple.com/documentation/corelocation/requesting-authorization-to-use-location-services
- https://developer.apple.com/documentation/corelocation/claccuracyauthorization
- https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background
- https://developer.apple.com/documentation/corelocation/monitoring-the-user-s-proximity-to-geographic-regions
- https://developer.apple.com/documentation/corelocation/cllocationmanager/startmonitoringsignificantlocationchanges()
- https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller
- https://developer.apple.com/documentation/fileprovider
- https://developer.apple.com/documentation/messageui/mfmailcomposeviewcontroller
- https://developer.apple.com/documentation/messageui/mfmessagecomposeviewcontroller
- https://developer.apple.com/documentation/mailkit
- https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications
- https://developer.apple.com/documentation/appintents/setfocusfilterintent
- https://developer.apple.com/financekit/
- https://developer.apple.com/documentation/passkit
- https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app
- https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask
- https://developer.apple.com/documentation/appintents
- https://developer.apple.com/documentation/appintents/app-shortcuts
- https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai
- https://developer.apple.com/documentation/appintents/app-schema-domains
- https://developer.apple.com/documentation/appintents/app-schema-domain-notes
- https://developer.apple.com/documentation/appintents/app-schema-domain-messages
- https://developer.apple.com/documentation/appintents/app-schema-domain-assistant
- https://developer.apple.com/documentation/sirikit
- https://developer.apple.com/documentation/uikit/uiapplication/canopenurl(_:)
- https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.calendars
- https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.personal-information.addressbook
- https://developer.apple.com/library/archive/qa/qa1888/_index.html
- https://developer.apple.com/library/archive/releasenotes/InterapplicationCommunication/RN-JavaScriptForAutomation/Articles/Introduction.html
- https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html

Apple policy, news and sessions:

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/news/?id=ey6d8onl
- https://developer.apple.com/news/releases/?id=09182026a
- https://developer.apple.com/videos/play/wwdc2025/244/
- https://developer.apple.com/videos/play/wwdc2025/275/
- https://developer.apple.com/videos/play/wwdc2026/339/
- https://developer.apple.com/videos/play/wwdc2026/343/
- https://developer.apple.com/videos/play/wwdc2026/345/
- https://www.apple.com/newsroom/2025/06/apple-intelligence-gets-even-more-powerful-with-new-capabilities-across-apple-devices/
- https://www.apple.com/newsroom/2026/02/xcode-26-point-3-unlocks-the-power-of-agentic-coding/
- https://www.apple.com/newsroom/2026/06/apple-aids-app-development-with-new-intelligence-frameworks-and-advanced-tools/
- https://www.apple.com/newsroom/2026/06/apple-intelligence-brings-powerful-ai-capabilities-into-everyday-experiences/
- https://www.apple.com/newsroom/2026/06/due-to-dma-siri-ai-delayed-in-eu-for-ios-27-and-ipados-27/
- https://www.apple.com/newsroom/2026/09/major-updates-for-apples-software-platforms-are-now-available/

Apple support:

- https://support.apple.com/guide/security/security-of-runtime-process-sec15bfe098e/web
- https://support.apple.com/guide/shortcuts/apd624386f42/ios
- https://support.apple.com/guide/shortcuts/apdcd7f20a6f/ios
- https://support.apple.com/guide/shortcuts/use-apple-intelligence-in-shortcuts-tpg3vrvwmclv/ios
- https://support.apple.com/guide/shortcuts/communication-triggers-apdd711f9dff/ios
- https://support.apple.com/guide/shortcuts/intro-to-find-and-filter-actions-apd3c845e881/ios
- https://support.apple.com/guide/shortcuts/share-actions-apdaf74d75a5/ios
- https://support.apple.com/guide/shortcuts/navigate-the-action-list-apdc33e4f4da/ios
- https://support.apple.com/guide/shortcuts/intro-to-the-run-javascript-on-webpage-action-apd218e2187d/ios
- https://support.apple.com/en-us/121131
- https://support.apple.com/en-us/125148
- https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac
- https://support.apple.com/guide/mac-help/mchl108e1718/mac
- https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac

Vendors and App Store listings:

- https://culturedcode.com/things/support/articles/9596775/
- https://www.todoist.com/help/articles/use-shortcuts-with-todoist-for-ios-xGxBVSMr
- https://flexibits.com/fantastical-ios/help/integration
- https://support.omnigroup.com/documentation/omnifocus/ios/3.13/en/automating-with-shortcuts/
- https://apps.apple.com/us/app/ticktick-to-do-list-calendar/id626144601
- https://apps.apple.com/us/app/due-reminders-timers/id390017969
- https://dayoneapp.com/guides/day-one-ios/day-one-shortcuts/
- https://bear.app/faq/how-to-use-siri-shortcuts-with-bear/
- https://docs.getdrafts.com/docs/automation/shortcuts
- https://support.craft.do/en/integrate/apple-shortcuts
- https://www.notion.com/help/notion-for-mobile
- https://apps.apple.com/app/actions-for-obsidian/id1659667937
- https://apps.apple.com/us/app/data-jar/id1453273600
- https://apps.apple.com/us/app/scriptable/id1405459188
- https://sindresorhus.com/actions
- https://support.toggl.com/using-toggl-track-with-ios-shortcuts
- https://apps.apple.com/us/app/timery-for-toggl/id1425368544
- https://support.pocketcasts.com/knowledge-base/siri/
- https://apps.apple.com/us/app/carrot-weather-alerts-radar/id961390574
- https://apps.apple.com/us/app/streaks/id963034692
- https://support.strava.com/en-us/articles/15401777-siri-integration
- https://support.google.com/waze/answer/9245980?hl=en
- https://community.monzo.com/t/ios-shortcuts-integration-is-here/189478
- https://support.claude.com/en/articles/10263469-use-claude-app-intents-shortcuts-and-widgets-on-ios
- https://www.uber.com/newsroom/siri-integration
- https://help.venmo.com/cs/articles/imessage-siri-payments-vhel331
- https://apps.apple.com/us/app/citymapper-all-live-transit/id469463298
- https://apps.apple.com/us/app/whatsapp-messenger/id310633997
- https://apps.apple.com/us/app/telegram-messenger/id686449807

Press and third-party writing (not primary):

- https://9to5mac.com/2025/09/22/macos-tahoe-26-1-beta-1-mcp-integration/
- https://daringfireball.net/2025/03/apple_is_delaying_the_more_personalized_siri_apple_intelligence_features
- https://blog.google/company-news/inside-google/company-announcements/joint-statement-google-apple/
- https://simonwillison.net/2020/May/22/using-sql-look-through-all-your-imessage-text-messages/
- https://osxdaily.com/2020/01/15/where-notes-stored-locally-mac/
