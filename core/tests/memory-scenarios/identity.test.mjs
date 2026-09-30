import test from 'node:test'
import assert from 'node:assert/strict'
import { noDatabase } from '../support/database.mjs'
import { story } from './story.mjs'

// Identity: strong global knowledge is written into the Learned section of identity.md while the agent sleeps.
// Text written by people, in identity.md or any other identity file, is never changed by learning.

const BEGIN = '<!-- kipster:learned:begin -->'
const END = '<!-- kipster:learned:end -->'
const OWNER = '# Kip\nA careful assistant for the Northwind team.\n\n'
const withSection = (section, head = OWNER) => `${head}${BEGIN}\n${section ? `${section}\n` : ''}${END}\n`

/** The owner saves identity.md, as the owner's identity routes do. */
async function ownerWrites(s, content) {
  const current = await s.runtime.home.identity.read(s.agent, 'identity.md')
  await s.runtime.home.identity.write(s.agent, 'identity.md', content, current.sha256, 'owner')
}
const backups = async s => Promise.all((await s.runtime.home.identity.listBackups(s.agent, 'identity.md'))
  .map(async backup => ({ id: backup.id, content: (await s.runtime.home.identity.readBackup(s.agent, 'identity.md', backup.id)).content })))

test('a working preference confirmed in two conversations enters the Learned section and leaves once unused', { skip: noDatabase }, async t => {
  const s = await story(t)
  await ownerWrites(s, withSection(''))
  const soul = await s.identity.read('soul.md')
  const agents = await s.identity.read('AGENTS.md')
  const untouched = async () => {
    assert.equal(await s.identity.read('soul.md'), soul)
    assert.equal(await s.identity.read('AGENTS.md'), agents)
    assert.ok((await s.identity.read()).startsWith(`${OWNER}${BEGIN}\n`), 'the owner\'s text is unchanged')
  }
  const preference = 'The owner reviews pull requests before lunch'

  await s.home.chat('I review pull requests before lunch, so send them in the morning.', { learn: [{ text: preference, subject: 'work style', importance: 1 }] })
  assert.equal((await s.night()).promotion, undefined, 'one conversation is not enough')
  await untouched()

  await s.home.chat('Morning is best for reviews, as I said.', { learn: [{ text: preference, subject: 'work style', importance: 1 }] })
  const section = '- Reviews pull requests before lunch'
  const promoted = await s.night({ promotion: section })
  assert.deepEqual([promoted.promotion.memories.map(item => item.text), promoted.promotion.section], [[preference], ''])
  assert.deepEqual(promoted.report.promotion, { memories: 1, added: 1, removed: 0, bytes: Buffer.byteLength(section) })
  assert.equal(await s.identity.read(), withSection(section))
  await untouched()

  // Every later conversation starts with the section, in any organization.
  const next = await s.northwind.chat('Anything to review today?')
  assert.ok(next.instructions.includes(`${BEGIN}\n${section}\n${END}`))
  assert.equal((await s.night()).promotion, undefined, 'nothing changed, so the model is not asked')

  // Left unused for ten busy days, the preference drops below keep strength and leaves the section.
  await s.work(10)
  const faded = await s.night({ promotion: '' })
  assert.deepEqual([faded.promotion.memories, faded.promotion.section], [[], `${section}\n`])
  assert.deepEqual(faded.report.promotion, { memories: 0, added: 0, removed: 1, bytes: 0 })
  assert.equal(await s.identity.read(), withSection(''))
  await untouched()
  assert.deepEqual(await s.modelCalls(), { extract: 3, identity: 2 })
})

test('an owner edit made while the agent sleeps wins, five backups remain, and a restore brings back the exact file', { skip: noDatabase }, async t => {
  const s = await story(t)
  for (let version = 1; version <= 6; version++) await ownerWrites(s, withSection('', `${OWNER}Version ${version}.\n`))
  const preference = 'The owner wants release notes in plain language'
  await s.home.chat('Write release notes in plain language, please.', { learn: [{ text: preference, subject: 'writing', importance: 1 }] })
  await s.home.chat('Plain language for the release notes again, thanks.', { learn: [{ text: preference, subject: 'writing', importance: 1 }] })

  // The owner saves identity.md while the model is writing the section: the owner's edit wins.
  await s.bedtime()
  await s.tick()
  const request = await s.request()
  assert.equal(request.task, 'identity')
  const edited = withSection('', `${OWNER}Version 7, edited during the night.\n`)
  await ownerWrites(s, edited)
  assert.equal(await s.respond(request, { promotion: '- Plain-language release notes' }), 'failed')
  await s.tick()
  assert.equal(await s.identity.read(), edited)
  assert.deepEqual((await s.lastSleep()).report, { promotion: { failure: 'identity.md changed' } })
  assert.equal((await backups(s)).length, 5)

  // The next night writes the section on top of the edit.
  const retried = await s.night({ promotion: '- Plain-language release notes' })
  assert.equal(retried.report.promotion.added, 1)
  const promoted = withSection('- Plain-language release notes', `${OWNER}Version 7, edited during the night.\n`)
  assert.equal(await s.identity.read(), promoted)
  const kept = await backups(s)
  assert.deepEqual([kept.length, kept[0].content], [5, edited])

  // The owner restores the version from before the promotion: it comes back byte for byte, and the promoted file
  // becomes the newest backup. The next sleep, with nothing new to promote, leaves the restored file alone.
  const current = await s.runtime.home.identity.read(s.agent, 'identity.md')
  await s.runtime.home.identity.restore(s.agent, 'identity.md', kept[0].id, current.sha256)
  assert.equal(await s.identity.read(), edited)
  const afterRestore = await backups(s)
  assert.deepEqual([afterRestore.length, afterRestore[0].content], [5, promoted])
  assert.equal((await s.night()).promotion, undefined)
  assert.equal(await s.identity.read(), edited)
})
