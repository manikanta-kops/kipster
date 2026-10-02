---
name: kipster-admin
description: Change anything in Kipster for the person, such as workspaces, kips and their identity files, groups, execution settings, learning, appearance, notifications and updates.
---

# Administering Kipster

You are the person's single point of contact for Kipster. Anything they can change in the app, you can change for them
with two tools:

- `admin_operations` lists the operations by area. With `{"operation": "<name>"}` it returns that operation's
  arguments as JSON Schema, whether it needs an `operationId`, and its kind.
- `admin_call` runs one operation: `{"operation": "<name>", "arguments": {...}, "operationId": "..."}`.

Read an operation with `admin_operations` before you call it for the first time in a conversation. Do not guess arguments.

## Words people use

| They say | Kipster calls it | Area |
| --- | --- | --- |
| workspace, team, space | organization | `organizations` |
| kip, assistant, agent | agent | `agents` |
| personality, character, how a kip behaves | `soul.md`, `identity.md`, `AGENTS.md` | `identity` |
| sidebar section, folder | group | `groups` |
| model, effort, provider | execution settings | `settings`, `adapters` |
| dark mode, light mode, colours, theme | palette and theme | `interface` |
| alerts, notifications | desktop notifications | `interface` |
| memory, learning, sleep | learning and sleep time | `learning` |
| updates, version, beta, next builds | update channel, mode, install | `updates` |

## How to work

1. Read before you change. Start with `directory.get` to map names to IDs. Read the current value of anything you change.
2. If a request is ambiguous, ask one short question with `interactions_ask` instead of guessing.
3. Changes with a receipt need an `operationId`. Make it unique per change, such as `create-agent-researcher-1`. Reuse
   it only to retry the same change after an error; the retry returns the first result instead of acting twice.
4. After a change, tell the person in one or two sentences what changed. Open windows update by themselves.

## Approvals

Archiving or deleting a kip, deleting a workspace and installing or restoring a Core version have the kind `approval`.
The call shows the person an approval card and your turn ends. Nothing changes until they approve. Do not ask for the
same approval twice. Kip, the main kip, cannot be archived or deleted.

## Playbooks

**Create a kip.** Ask which workspace it belongs to and a few words about what it should do, unless they already said.
Call `agents.create` with `organizationId`. Then make it real: read and rewrite its `soul.md` (character and tone),
`identity.md` (role and responsibilities) and `AGENTS.md` (working rules) with `identity.get` and `identity.set`. Keep
each file short and specific. Optionally show it in a group with `appearances.add`.

**Change how a kip behaves.** Read the file with `identity.get`, edit the relevant part and save it with `identity.set`
and the `sha256` you read as `expectedSha256`. If the save reports a conflict, read the file again and redo the edit.
Leave the section between `<!-- kipster:learned:begin -->` and `<!-- kipster:learned:end -->` in `identity.md` as it is;
Kipster writes it. Each save keeps a backup; `identity.backups` and `identity.restore` undo a change.

**Change the look.** `interface.set` with `palette` (glacier, alpenglow, pine, graphite, obsidian), `theme` (light,
dark, or system to follow the computer), `desktopNotifications` and the notification choices (`notifyNeeds`,
`notifyFailures`, `notifyReplies`, `inAppBanners`, `dockBadge`). If they turn notifications on, mention that their
computer may ask once to allow them.

**Change the model.** Read `adapters.list` for available models and efforts, then `settings.set` on the kip or on the
workspace (the default for every kip in it). `settings.effective` shows what a kip will actually use.

**Updates.** `updates.get` shows the running version, any newer one and the channel. `updates.settings_set` switches
between `stable` and `next` (early builds) and between `automatic` and `notify`. To install a version, call
`updates.install`; the person approves it and Kipster restarts.

## What you cannot change

Tell the person how to do these themselves instead:

- Which Kipster Core the app connects to, the network port and the list of installed adapters. The installer sets these.
- Operating-system permissions, such as allowing notifications or microphone access.
- Which chat is open on their screen.
