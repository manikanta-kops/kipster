import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createAdapter } from '../dist/index.js'

// Forgetting provider state removes the recorded session files and maintenance records of the given
// threads and leaves every other file alone.

async function files(root) {
  const found = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else found.push(relative(root, path))
    }
  }
  await walk(root)
  return found.sort()
}

test('forgetProviderState removes the maintenance records of the named threads only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-forget-'))
  const data = join(directory, 'data')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const adapter = createAdapter({ dataDirectory: data, now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })

  // A missing data directory has nothing to forget.
  await adapter.forgetProviderState({ threadIds: ['019a0000-0000-7000-8000-00000000000a'] })

  const gone = '019a0000-0000-7000-8000-00000000000a'
  const kept = '019a0000-0000-7000-8000-00000000000b'
  await mkdir(join(data, 'maintenance', 'processes'), { recursive: true })
  for (const id of [gone, kept]) await writeFile(join(data, 'maintenance', 'processes', `${id}.json`), '{}\n')

  await adapter.forgetProviderState({ threadIds: [gone, '../escape', ''] })
  assert.deepEqual(await files(data), [`maintenance/processes/${kept}.json`])

  // Repeating is safe.
  await adapter.forgetProviderState({ threadIds: [gone] })
  assert.equal((await files(data)).length, 1)
})

test('forgetProviderState never follows a linked maintenance directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-codex-forget-parent-'))
  const data = join(directory, 'data'), outside = join(directory, 'outside')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const id = '019a0000-0000-7000-8000-00000000000a'
  await mkdir(join(outside, 'processes'), { recursive: true })
  await writeFile(join(outside, 'processes', `${id}.json`), 'outside')
  await mkdir(data)
  await symlink(outside, join(data, 'maintenance'))
  const adapter = createAdapter({ dataDirectory: data, now: () => new Date().toISOString(), async invokeTool() { throw new Error('Unexpected tool') } })
  await adapter.forgetProviderState({ threadIds: [id] })
  assert.deepEqual(await files(outside), [`processes/${id}.json`])
})

test('shared cleanup follows recorded ownership even after configured home changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'kipster-shared-cleanup-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const data = join(directory, 'state'), home = join(directory, 'old-user'), other = join(directory, 'new-user')
  for (const path of [join(data, 'conversation-sessions'), join(home, 'sessions'), join(other, 'sessions')]) await mkdir(path, { recursive: true })
  const id = 'kipster-thread', personal = 'personal-thread'
  for (const base of [home, other]) for (const tid of [id, personal]) await writeFile(join(base, 'sessions', `rollout-${tid}.jsonl`), 'session')
  await writeFile(join(data, 'conversation-sessions', `${id}.json`), JSON.stringify({ threadId: id, home }))
  const adapter = createAdapter({ dataDirectory: data, now: () => '', async invokeTool() {} }, { codexHome: other })
  await adapter.forgetProviderState({ threadIds: [id, personal] })
  assert.deepEqual(await readdir(join(home, 'sessions')), ['rollout-personal-thread.jsonl'])
  assert.deepEqual((await readdir(join(other, 'sessions'))).sort(), ['rollout-kipster-thread.jsonl', 'rollout-personal-thread.jsonl'])
  await adapter.forgetProviderState({ threadIds: [id] })
  await adapter.close()
})
