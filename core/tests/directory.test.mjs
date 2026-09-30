import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../dist/platform/postgres/public.js'
import { openRuntime, startTextServer } from '../dist/runtime.js'
import { resolveDirectChat, acceptText } from '../dist/modules/conversations/public.js'
import { snapshot, readEvents } from '../dist/modules/synchronization/public.js'
import { addMembership, readDirectory, publishDirectoryChange, publishDirectoryRemoval } from '../dist/modules/administration/public.js'
import { appSnapshot, directorySnapshot, textEvent } from '../dist/protocol/index.js'
import { adminUrl, noDatabase } from './support/database.mjs'

// Directory read model, directory events and thread-summary chat context against real PostgreSQL.
// Organizations, agents and groups are written directly until their administration services exist.

async function database(t) {
  const admin = new Postgres(adminUrl)
  const name = `kipster_directory_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-directory-home-'))
  const closers = []
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })
  return { url: url.href, home, closers }
}

async function setup(t) {
  const base = await database(t)
  const runtime = await openRuntime({ connectionString: base.url, home: base.home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
  base.closers.push(() => runtime.close())
  const { installationId, ownerId, organizationId, rootAgentId } = runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const db = runtime.db
  const organization = async name => {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.organizations(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,true)', [id, installationId, name])
    await db.query('INSERT INTO kipster.human_memberships VALUES ($1,$2)', [id, ownerId])
    return id
  }
  const agent = async (name, provisioned = true) => {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.agents(id,installation_id,display_name,provisioned) VALUES ($1,$2,$3,$4)', [id, installationId, name, provisioned])
    return id
  }
  const member = async (orgId, agentId) => {
    const { membership } = await addMembership(db, actor, randomUUID(), orgId, agentId)
    return membership.id
  }
  const group = async (orgId, name, position, membershipIds) => {
    const id = randomUUID()
    await db.query('INSERT INTO kipster.groups(id,organization_id,name,position) VALUES ($1,$2,$3,$4)', [id, orgId, name, position])
    for (const [index, membershipId] of membershipIds.entries()) await db.query('INSERT INTO kipster.group_appearances(group_id,membership_id,organization_id,position) VALUES ($1,$2,$3,$4)', [id, membershipId, orgId, index])
    return id
  }
  const serve = async as => {
    const server = await startTextServer(runtime, as, { host: '127.0.0.1', port: 0 })
    base.closers.push(() => server.close())
    return async (method, path, body) => {
      const response = await fetch(server.url + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
      return { status: response.status, data: await response.json() }
    }
  }
  const say = async (context, chatId, text) => acceptText(db, runtime.jobs, runtime.artifacts, actor, { version: 1, submissionId: randomUUID(), scope: { installationId, callerId: ownerId }, target: { context, chatId }, mode: 'root', parts: [{ kind: 'text', text }] })
  const appScope = { kind: 'application', installationId, callerId: ownerId }
  return { ...base, runtime, db, actor, installationId, ownerId, organizationId, rootAgentId, organization, agent, member, group, serve, say, appScope }
}

/**
 * Applies directory events the way a client does: a record replaces one with an older or equal
 * revision. An organization that leaves `active` or is removed drops its memberships and groups;
 * a removed membership drops its appearances.
 */
function merge(directory, events) {
  const next = structuredClone(directory)
  const lists = { organization: 'organizations', agent: 'agents', membership: 'memberships', group: 'groups' }
  const dropChildren = organizationId => { for (const owned of ['memberships', 'groups']) next[owned] = next[owned].filter(item => item.organizationId !== organizationId) }
  for (const event of events) {
    next.cursor = event.cursor
    const [, kind, change] = /^(organization|agent|membership|group)-(changed|removed)$/.exec(event.type) ?? []
    if (!kind) continue
    const list = lists[kind]
    const current = next[list].find(item => item.id === event.resourceId)
    if (change === 'changed' && (!current || current.revision <= event.revision)) {
      next[list] = [...next[list].filter(item => item.id !== event.resourceId), event.data]
      if (kind === 'organization' && event.data.lifecycle !== 'active') dropChildren(event.resourceId)
    }
    if (change === 'removed') {
      next[list] = next[list].filter(item => item.id !== event.resourceId)
      if (kind === 'organization') dropChildren(event.resourceId)
      if (kind === 'membership') for (const g of next.groups) g.appearances = g.appearances.filter(item => item.membershipId !== event.resourceId)
    }
  }
  return next
}
/** Applies thread summaries the way a client does: a summary replaces one with an older or equal revision. */
function mergeThreads(threads, events) {
  let next = [...threads]
  for (const event of events) {
    if (event.type !== 'thread-summary') continue
    const current = next.find(item => item.threadId === event.resourceId)
    if (!current || current.revision <= event.revision) next = [...next.filter(item => item.threadId !== event.resourceId), event.data]
  }
  return next
}
/** Former-member chats, derived as a client does: organization chats in an active organization without a membership for their agent. */
function formerMemberChats(directory, threads) {
  const active = new Set(directory.organizations.filter(o => o.lifecycle === 'active').map(o => o.id))
  const members = new Set(directory.memberships.map(m => `${m.organizationId}/${m.agentId}`))
  const chats = new Map()
  for (const t of threads) {
    if (t.contextKind === 'organization' && active.has(t.contextId) && !members.has(`${t.contextId}/${t.agentId}`)) chats.set(t.chatId, { chatId: t.chatId, organizationId: t.contextId, agentId: t.agentId })
  }
  return [...chats.values()].sort((a, b) => a.chatId.localeCompare(b.chatId))
}
const byId = items => [...items].sort((a, b) => a.id.localeCompare(b.id))
const comparable = directory => ({ organizations: byId(directory.organizations), agents: byId(directory.agents), memberships: byId(directory.memberships), groups: byId(directory.groups), cursor: directory.cursor })
const position = cursor => Number(cursor.slice(cursor.lastIndexOf(':') + 1))
const byThread = threads => [...threads].sort((a, b) => a.threadId.localeCompare(b.threadId))

test('the owner reads organizations, agents, memberships and groups from the directory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer'), editor = await ctx.agent('Editor')
  const writerInStudio = await ctx.member(studio, writer), editorInStudio = await ctx.member(studio, editor)
  const writerInOrg = await ctx.member(ctx.organizationId, writer)
  const vip = await ctx.group(studio, 'VIP', 0, [writerInStudio])
  const marketing = await ctx.group(studio, 'Marketing', 1, [editorInStudio, writerInStudio])
  const request = await ctx.serve(ctx.actor)

  const response = await request('GET', '/v1/directory')
  assert.equal(response.status, 200)
  const directory = directorySnapshot.parse(response.data)
  assert.deepEqual(directory.organizations.map(o => [o.id, o.name, o.description, o.lifecycle, o.revision]), [
    [ctx.organizationId, 'Org', '', 'active', 1], [studio, 'Studio', '', 'active', 1]])
  assert.deepEqual(directory.agents.map(a => [a.id, a.name, a.lifecycle, a.admin, a.revision, a.deletedAt]), [
    [editor, 'Editor', 'active', false, 1, null], [ctx.rootAgentId, 'Root', 'active', true, 1, null], [writer, 'Writer', 'active', false, 1, null]])
  const rootInOrg = (await ctx.db.query('SELECT id FROM kipster.agent_memberships WHERE agent_id=$1', [ctx.rootAgentId])).rows[0].id
  assert.deepEqual(directory.memberships.map(m => [m.organizationId, m.agentId, m.id]).sort(), [
    [ctx.organizationId, ctx.rootAgentId, rootInOrg], [ctx.organizationId, writer, writerInOrg], [studio, editor, editorInStudio], [studio, writer, writerInStudio]].sort())
  assert.equal(new Set(directory.memberships.map(m => m.id)).size, 4)
  assert.deepEqual(directory.groups.map(g => [g.id, g.organizationId, g.name, g.position, g.appearances]), [
    [vip, studio, 'VIP', 0, [{ membershipId: writerInStudio, agentId: writer }]],
    [marketing, studio, 'Marketing', 1, [{ membershipId: editorInStudio, agentId: editor }, { membershipId: writerInStudio, agentId: writer }]]])
  const app = await request('GET', '/v1/app/snapshot')
  assert.equal(directory.cursor, app.data.cursor)
})

test('an agent that appears in several groups opens one direct chat', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer')
  const membership = await ctx.member(studio, writer)
  await ctx.group(studio, 'VIP', 0, [membership])
  await ctx.group(studio, 'Marketing', 1, [membership])
  const request = await ctx.serve(ctx.actor)
  const directory = directorySnapshot.parse((await request('GET', '/v1/directory')).data)
  const appearances = directory.groups.flatMap(g => g.appearances)
  assert.equal(appearances.length, 2)
  assert.deepEqual(new Set(appearances.map(a => a.membershipId)), new Set([membership]))

  const context = { kind: 'organization', organizationId: studio }
  const opened = await Promise.all(appearances.map(a => request('POST', '/v1/direct-chats', { version: 1, context, agentId: a.agentId })))
  assert.deepEqual(opened.map(r => r.status), [200, 200])
  assert.equal(opened[0].data.chatId, opened[1].data.chatId)
  assert.equal(Number((await ctx.db.query('SELECT count(*) AS n FROM kipster.direct_chats WHERE context_id=$1 AND agent_id=$2', [studio, writer])).rows[0].n), 1)
})

test('lifecycle states and tombstones are represented in the directory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const archived = await ctx.agent('Archivist'), deleted = await ctx.agent('Old Helper')
  await ctx.agent('Half Created', false)
  const winding = await ctx.organization('Winding Down'), gone = await ctx.organization('Gone')
  const archivedMembership = await ctx.member(ctx.organizationId, archived)
  const windingMembership = await ctx.member(winding, archived)
  await ctx.group(winding, 'Leaving', 0, [windingMembership])
  await ctx.member(gone, archived)
  await ctx.group(gone, 'Team', 0, [])
  await ctx.db.query(`UPDATE kipster.agents SET lifecycle='archived', revision=revision+1 WHERE id=$1`, [archived])
  await ctx.db.query(`UPDATE kipster.agents SET lifecycle='deleted', deleted_at=now(), revision=revision+1 WHERE id=$1`, [deleted])
  await ctx.db.query(`UPDATE kipster.organizations SET lifecycle='deleting', revision=revision+1 WHERE id=$1`, [winding])
  await ctx.db.query(`UPDATE kipster.organizations SET lifecycle='deleted', deleted_at=now(), revision=revision+1 WHERE id=$1`, [gone])

  const directory = directorySnapshot.parse(await readDirectory(ctx.db, ctx.actor))
  const agent = id => directory.agents.find(a => a.id === id)
  assert.deepEqual([agent(archived).lifecycle, agent(archived).revision, agent(archived).deletedAt], ['archived', 2, null])
  assert.deepEqual([agent(deleted).name, agent(deleted).lifecycle], ['Old Helper', 'deleted'])
  assert.ok(Date.parse(agent(deleted).deletedAt) > 0)
  assert.equal(directory.agents.some(a => a.name === 'Half Created'), false)
  assert.deepEqual(directory.organizations.map(o => [o.name, o.lifecycle]), [['Org', 'active'], ['Winding Down', 'deleting']])
  // Memberships and groups are listed only for active organizations.
  assert.deepEqual(directory.memberships.filter(m => m.agentId === archived).map(m => m.id), [archivedMembership])
  assert.deepEqual(directory.groups, [])
  await assert.rejects(ctx.db.query(`UPDATE kipster.agents SET lifecycle='deleted' WHERE id=$1`, [archived]), /agents_deleted_at/)

  // New memberships need an active, provisioned agent and organization.
  const other = await ctx.organization('Other')
  for (const agentId of [archived, deleted, (await ctx.db.query(`SELECT id FROM kipster.agents WHERE display_name='Half Created'`)).rows[0].id]) {
    await assert.rejects(addMembership(ctx.db, ctx.actor, randomUUID(), other, agentId), /Agent not found/)
  }
  await assert.rejects(addMembership(ctx.db, ctx.actor, randomUUID(), winding, await ctx.agent('Newcomer')), /Organization not found/)
  assert.equal(Number((await ctx.db.query('SELECT count(*) AS n FROM kipster.agent_memberships WHERE organization_id=$1', [other])).rows[0].n), 0)
})

test('clients derive former-member chats from thread summaries and memberships', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer'), editor = await ctx.agent('Editor')
  const first = await ctx.member(studio, writer)
  await ctx.member(studio, editor)
  await ctx.group(studio, 'VIP', 0, [first])
  const context = { kind: 'organization', organizationId: studio }
  const { chatId } = await resolveDirectChat(ctx.db, ctx.actor, context, writer)
  await ctx.say(context, chatId, 'Draft the launch note')
  await resolveDirectChat(ctx.db, ctx.actor, context, editor)
  const directory = await readDirectory(ctx.db, ctx.actor)
  const app = await snapshot(ctx.db, ctx.appScope)
  assert.deepEqual(formerMemberChats(directory, app.threads), [])

  // Remove both memberships as a writer does: lock the rows, publish the removals, then delete.
  await ctx.db.transaction(async c => {
    const rows = (await c.query('SELECT id FROM kipster.agent_memberships WHERE organization_id=$1 ORDER BY id FOR UPDATE', [studio])).rows
    await c.query('SELECT 1 FROM kipster.group_appearances WHERE organization_id=$1 FOR UPDATE', [studio])
    for (const row of rows) await publishDirectoryRemoval(c, ctx.installationId, 'membership', row.id)
    await c.query('DELETE FROM kipster.agent_memberships WHERE organization_id=$1', [studio])
  })
  const events = (await readEvents(ctx.db, ctx.appScope, directory.cursor)).events.map(event => textEvent.parse(event))
  assert.deepEqual(events.map(e => e.type), ['membership-removed', 'membership-removed'])
  const merged = merge(directory, events), threads = mergeThreads(app.threads, events)
  const fresh = await readDirectory(ctx.db, ctx.actor), freshApp = await snapshot(ctx.db, ctx.appScope)
  assert.deepEqual(comparable(merged), comparable(fresh))
  // Only the chat with history is listed: a chat without threads has no summary.
  const former = [{ chatId, organizationId: studio, agentId: writer }]
  assert.deepEqual(formerMemberChats(merged, threads), former)
  assert.deepEqual(formerMemberChats(fresh, freshApp.threads), former)
  assert.deepEqual(fresh.groups[0].appearances, [])
  assert.equal(fresh.agents.find(a => a.id === writer).lifecycle, 'active')

  const second = await ctx.member(studio, writer)
  assert.notEqual(second, first)
  const returned = merge(fresh, (await readEvents(ctx.db, ctx.appScope, fresh.cursor)).events.map(event => textEvent.parse(event)))
  assert.deepEqual(comparable(returned), comparable(await readDirectory(ctx.db, ctx.actor)))
  assert.deepEqual(formerMemberChats(returned, threads), [])
  assert.deepEqual(returned.groups[0].appearances, [])
  assert.deepEqual(await resolveDirectChat(ctx.db, ctx.actor, context, writer), { chatId })
})

test('a client that loads the directory and the app snapshot follows the stream from the older cursor', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer'), editor = await ctx.agent('Editor')
  await ctx.member(studio, writer)
  const context = { kind: 'organization', organizationId: studio }
  const { chatId } = await resolveDirectChat(ctx.db, ctx.actor, context, writer)
  await ctx.say(context, chatId, 'First')
  const directory = await readDirectory(ctx.db, ctx.actor)
  await ctx.member(studio, editor)
  await ctx.say(context, chatId, 'Second')
  const app = await snapshot(ctx.db, ctx.appScope)
  assert.ok(position(directory.cursor) < position(app.cursor))
  await ctx.member(ctx.organizationId, editor)
  await ctx.say(context, chatId, 'Third')

  const older = position(directory.cursor) <= position(app.cursor) ? directory.cursor : app.cursor
  const events = (await readEvents(ctx.db, ctx.appScope, older)).events.map(event => textEvent.parse(event))
  const fresh = await readDirectory(ctx.db, ctx.actor)
  assert.deepEqual(comparable(merge(directory, events)), comparable(fresh))
  assert.deepEqual(byThread(mergeThreads(app.threads, events)), byThread((await snapshot(ctx.db, ctx.appScope)).threads))
  // Following from the newer app cursor alone misses the membership added between the two reads.
  const late = (await readEvents(ctx.db, ctx.appScope, app.cursor)).events.map(event => textEvent.parse(event))
  assert.notDeepEqual(byId(merge(directory, late).memberships), byId(fresh.memberships))
})

test('only the installation owner can read the directory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const stranger = { installationId: ctx.installationId, personId: randomUUID() }
  const response = await (await ctx.serve(stranger))('GET', '/v1/directory')
  assert.equal(response.status, 403)
  assert.equal(response.data.code, 'forbidden')
  await assert.rejects(readDirectory(ctx.db, stranger), /Owner access denied/)
  await assert.rejects(readDirectory(ctx.db, { installationId: randomUUID(), personId: ctx.ownerId }), /Owner access denied/)
})

test('directory events carry full records and converge with a fresh directory', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer'), editor = await ctx.agent('Editor')
  const editorInStudio = await ctx.member(studio, editor)
  const before = await readDirectory(ctx.db, ctx.actor)
  const change = work => ctx.db.transaction(work)

  const writerInStudio = await ctx.member(studio, writer)
  await change(async c => {
    await c.query(`UPDATE kipster.agents SET display_name='Copywriter', description='Writes launch copy', revision=revision+1 WHERE id=$1`, [writer])
    await publishDirectoryChange(c, ctx.installationId, 'agent', writer)
  })
  const vip = randomUUID(), temporary = randomUUID()
  await change(async c => {
    await c.query('INSERT INTO kipster.groups(id,organization_id,name,position) VALUES ($1,$2,$3,0),($4,$2,$5,1)', [vip, studio, 'VIP', temporary, 'Temporary'])
    await c.query('INSERT INTO kipster.group_appearances(group_id,membership_id,organization_id,position) VALUES ($1,$2,$3,0),($1,$4,$3,1)', [vip, writerInStudio, studio, editorInStudio])
    await publishDirectoryChange(c, ctx.installationId, 'group', vip)
    await publishDirectoryChange(c, ctx.installationId, 'group', temporary)
  })
  await change(async c => {
    await c.query('SELECT 1 FROM kipster.groups WHERE id=$1 FOR UPDATE', [temporary])
    await c.query('SELECT 1 FROM kipster.group_appearances WHERE membership_id=$1 FOR UPDATE', [editorInStudio])
    await c.query('UPDATE kipster.groups SET revision=revision+1 WHERE id=$1', [vip])
    await publishDirectoryRemoval(c, ctx.installationId, 'group', temporary)
    await c.query('DELETE FROM kipster.groups WHERE id=$1', [temporary])
    await publishDirectoryRemoval(c, ctx.installationId, 'membership', editorInStudio)
    await c.query('DELETE FROM kipster.agent_memberships WHERE id=$1', [editorInStudio])
    await publishDirectoryChange(c, ctx.installationId, 'group', vip)
  })
  await change(async c => {
    await c.query(`UPDATE kipster.organizations SET display_name='Studio North', revision=revision+1 WHERE id=$1`, [studio])
    await publishDirectoryChange(c, ctx.installationId, 'organization', studio)
    await publishDirectoryChange(c, ctx.installationId, 'agent', await ctx.agent('Unready', false))
  })
  const doomed = await ctx.organization('Doomed')
  await ctx.member(doomed, editor)
  await change(async c => {
    await c.query('SELECT 1 FROM kipster.organizations WHERE id=$1 FOR UPDATE', [doomed])
    await publishDirectoryRemoval(c, ctx.installationId, 'organization', doomed)
    await c.query(`UPDATE kipster.organizations SET lifecycle='deleted', deleted_at=now(), revision=revision+1 WHERE id=$1`, [doomed])
    // A resource that is not listed publishes no removal.
    await publishDirectoryRemoval(c, ctx.installationId, 'organization', doomed)
  })

  const events = (await readEvents(ctx.db, ctx.appScope, before.cursor)).events.map(event => textEvent.parse(event))
  assert.deepEqual(events.map(e => e.type), ['membership-changed', 'agent-changed', 'group-changed', 'group-changed', 'group-removed', 'membership-removed', 'group-changed', 'organization-changed', 'membership-changed', 'organization-removed'])
  const renamed = events[1]
  assert.deepEqual([renamed.resourceId, renamed.revision, renamed.data.name, renamed.data.description, renamed.data.lifecycle], [writer, 2, 'Copywriter', 'Writes launch copy', 'active'])
  assert.deepEqual(events[6].data.appearances, [{ membershipId: writerInStudio, agentId: writer }])
  assert.deepEqual(events[5].data, { id: editorInStudio, organizationId: studio, agentId: editor })
  // A removal carries the revision after the record's last one.
  assert.deepEqual([events[4].data, events[4].revision, events[5].revision, events[9].data, events[9].revision], [{ id: temporary, organizationId: studio }, 2, 2, { id: doomed }, 2])

  const fresh = await readDirectory(ctx.db, ctx.actor)
  assert.deepEqual(comparable(merge(before, events)), comparable(fresh))
  assert.equal(fresh.organizations.find(o => o.id === studio).name, 'Studio North')
  assert.equal(fresh.organizations.some(o => o.id === doomed), false)
})

test('a directory read and its cursor stay consistent with a concurrent write', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer')
  const writerDb = new Postgres(ctx.url, 1)
  ctx.closers.push(() => writerDb.close())
  let inserted, release
  const insertedSignal = new Promise(resolve => { inserted = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const write = writerDb.transaction(async c => {
    const { id } = (await c.query('INSERT INTO kipster.agent_memberships(organization_id,agent_id) VALUES ($1,$2) RETURNING id', [studio, writer])).rows[0]
    await publishDirectoryChange(c, ctx.installationId, 'membership', id)
    inserted()
    await gate
    return id
  })
  await insertedSignal
  const during = await readDirectory(ctx.db, ctx.actor)
  release()
  const membershipId = await write

  assert.equal(during.memberships.some(m => m.id === membershipId), false)
  const events = (await readEvents(ctx.db, ctx.appScope, during.cursor)).events.map(event => textEvent.parse(event))
  assert.deepEqual(events.map(e => [e.type, e.resourceId]), [['membership-changed', membershipId]])
  assert.deepEqual(comparable(merge(during, events)), comparable(await readDirectory(ctx.db, ctx.actor)))
})

test('thread summaries carry their chat context', { skip: noDatabase }, async t => {
  const ctx = await setup(t)
  const studio = await ctx.organization('Studio')
  const writer = await ctx.agent('Writer')
  await ctx.member(studio, writer)
  const installation = { kind: 'installation', installationId: ctx.installationId }
  const organization = { kind: 'organization', organizationId: studio }
  const before = (await snapshot(ctx.db, ctx.appScope)).cursor
  const adminChat = (await resolveDirectChat(ctx.db, ctx.actor, installation, ctx.rootAgentId)).chatId
  const studioChat = (await resolveDirectChat(ctx.db, ctx.actor, organization, writer)).chatId
  const adminThread = (await ctx.say(installation, adminChat, 'Create a studio')).threadId
  const studioThread = (await ctx.say(organization, studioChat, 'Draft the launch note')).threadId

  const app = appSnapshot.parse(await snapshot(ctx.db, ctx.appScope))
  const context = summary => [summary.chatId, summary.contextKind, summary.contextId, summary.agentId]
  assert.deepEqual(context(app.threads.find(s => s.threadId === adminThread)), [adminChat, 'installation', ctx.installationId, ctx.rootAgentId])
  assert.deepEqual(context(app.threads.find(s => s.threadId === studioThread)), [studioChat, 'organization', studio, writer])
  const summaries = (await readEvents(ctx.db, ctx.appScope, before)).events.map(event => textEvent.parse(event)).filter(e => e.type === 'thread-summary')
  assert.ok(summaries.length >= 2)
  for (const event of summaries) assert.deepEqual(context(event.data), context(app.threads.find(s => s.threadId === event.resourceId)))
})
