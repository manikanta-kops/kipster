import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { adminOperations } from '../dist/workflows/admin-tools.js'

// Kip, the admin agent, can do everything a person can do in the interface. Every HTTP route is either served by
// administration operations or listed here with the reason Kip does not need it. A new route fails this test until it
// is added to the catalog in core/src/workflows/admin-tools.ts or given a reason below.

const routes = {
  '/v1/bootstrap': 'Connection setup of an interface.',
  '/v1/app/snapshot': 'Interface event stream.',
  '/v1/app/events': 'Interface event stream.',
  '/v1/threads/{id}/(snapshot|events)': 'Interface event stream.',
  '/v1/direct-chats': 'Opening and writing in chats is messaging, which the admin tools do not cover yet.',
  '/v1/text/submissions': 'Opening and writing in chats is messaging, which the admin tools do not cover yet.',
  '/v1/text/receipts/([^/]+)': 'Receipt of an interface message submission.',
  '/v1/work/controls': 'Stopping or retrying work in a chat is messaging, which the admin tools do not cover yet.',
  '/v1/work/controls/receipt': 'Receipt of an interface work control.',
  '/v1/work/interactions/answer': 'The person answers questions and approvals; Kip asks them.',
  '/v1/work/interactions/receipt': 'Receipt of an interface answer.',
  '/v1/notifications/{id}/read': 'Read state of the person\'s own inbox.',
  '/v1/notifications/read': 'Read state of the person\'s own inbox.',
  '/v1/notifications/clear': 'Clearing the person\'s own inbox.',
  '/conversations/media/capabilities': 'File upload from an interface.',
  '/conversations/media/uploads/{id}': 'File upload from an interface.',
  '/conversations/media/artifacts/{id}(/content)?': 'File download to an interface.',
  '/v1/directory': ['directory.get'],
  '/v1/settings/interface': ['interface.get', 'interface.set'],
  '/v1/settings/learning': ['learning.get', 'learning.set'],
  '/v1/agents/{id}/learning': ['learning.agent_set'],
  '/v1/agents/{id}/identity/(AGENTS\\.md|soul\\.md|identity\\.md)(?:/(backups)(?:/([^/]+)(/restore)?)?)?': ['identity.get', 'identity.set', 'identity.backups', 'identity.backup_get', 'identity.restore'],
  '/v1/settings/updates': ['updates.get', 'updates.settings_set'],
  '/v1/updates': ['updates.get'],
  '/v1/updates/check': ['updates.check'],
  '/v1/updates/install': ['updates.install'],
  '/v1/updates/unpin': ['updates.unpin'],
  '/v1/settings': ['settings.list'],
  '/v1/execution-adapters': ['adapters.list'],
  '/v1/execution-adapters/refresh': ['adapters.refresh'],
  '/v1/organizations': ['organizations.create'],
  '/v1/agents': ['agents.create'],
  '/v1/operations/([^/]{1,600})': ['operations.get'],
  '/v1/(agents|organizations)/{id}/settings': ['settings.set', 'settings.clear'],
  '/v1/agents/{id}/effective-settings': ['settings.effective'],
  '/v1/organizations/{id}(/instructions)?': ['organizations.update', 'organizations.delete', 'organizations.instructions_get', 'organizations.instructions_set'],
  '/v1/agents/{id}': ['agents.update', 'agents.delete'],
  '/v1/agents/{id}/(archive|restore)': ['agents.archive', 'agents.restore'],
  '/v1/organizations/{id}/(memberships|groups|groups/order)': ['memberships.add', 'groups.create', 'groups.reorder'],
  '/v1/memberships/{id}': ['memberships.remove'],
  '/v1/groups/{id}': ['groups.rename', 'groups.delete'],
  '/v1/groups/{id}/appearances(?:/(order|[0-9a-f-]{36}))?': ['appearances.add', 'appearances.remove', 'appearances.reorder'],
}

/** The routes the HTTP server matches, as their path literals or regular expressions with `{id}` for a UUID. */
async function served() {
  const found = new Set()
  for (const file of ['text.ts', 'admin.ts']) {
    const source = await readFile(new URL(`../src/transport/http/${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/'(\/(?:v1|conversations)\/[^']*)'/g)) found.add(match[1])
    for (const match of source.matchAll(/\/\^(\\\/(?:v1|conversations)\\\/.*?)\$\//g)) found.add(match[1].replaceAll('\\/', '/').replaceAll('([0-9a-f-]{36})\\/', '{id}/').replace(/\(\[0-9a-f-\]\{36\}\)(?=$|[/(])/g, '{id}'))
  }
  return found
}

test('every HTTP route is served by administration operations or has a reason Kip does not need it', async () => {
  const found = await served()
  const missing = [...found].filter(route => !Object.hasOwn(routes, route))
  assert.deepEqual(missing, [], 'Add each new route to the admin catalog and to this list, or give the reason Kip does not need it')
  const stale = Object.keys(routes).filter(route => !found.has(route))
  assert.deepEqual(stale, [], 'Remove routes the server no longer has')
  for (const [route, served] of Object.entries(routes)) {
    if (typeof served === 'string') continue
    for (const name of served) assert.ok(Object.hasOwn(adminOperations, name), `${route}: ${name} is not an administration operation`)
  }
})

test('every administration operation is described for the model', () => {
  for (const [name, operation] of Object.entries(adminOperations)) {
    assert.match(name, /^[a-z]+\.[a-z_]+$/, name)
    assert.ok(operation.description.length > 20, name)
    assert.equal(operation.input.describe().type, 'object', name)
  }
})
