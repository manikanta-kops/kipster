// Run through core/scripts/with-test-database.mjs; all state is disposable.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { webkit, expect } from '@playwright/test'
import { Postgres } from '../../../core/dist/platform/postgres/public.js'
import {
  openRuntime,
  startTextServer,
  TextDispatcher,
  textPublicationHost,
} from '../../../core/dist/runtime.js'
import { retainLast } from '../../../core/dist/modules/synchronization/public.js'
import { fixtureAdapter } from '../../../core/tests/.build/tests/fixtures/deterministic-adapter.js'
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(ui, 'test-results', 'real-core-lifecycle')
await mkdir(output, { recursive: true })
const home = await mkdtemp(join(tmpdir(), 'kipster-ui-real-'))
const admin = new Postgres(process.env.KIPSTER_TEST_DATABASE_URL)
const database = `kipster_ui_${randomUUID().replaceAll('-', '')}`
await admin.query(`CREATE DATABASE "${database}"`)
const db = new URL(process.env.KIPSTER_TEST_DATABASE_URL)
db.pathname = '/' + database
let runtime, dispatcher, server, vite, viteExit, browser
const executions = []
async function until(read, predicate = Boolean) {
  for (let i = 0; i < 300; i++) {
    const v = await read()
    if (predicate(v)) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw Error('Timed out waiting for fixture state')
}
try {
  runtime = await openRuntime({
    connectionString: db.href,
    home,
    names: { owner: 'Owner', organization: 'Garden', rootAgent: 'Root' },
    executionLimit: 6,
    embedding: {
      id: 'fixture-embedding',
      contractMajor: 1,
      model: 'fixture',
      async embed() {
        return [0, 0, 1]
      },
    },
  })
  await runtime.memory.stopIndexing()
  const { installationId, ownerId, organizationId, rootAgentId } =
    runtime.bootstrap
  const actor = { installationId, personId: ownerId }
  const inner = fixtureAdapter({
    now: () => new Date().toISOString(),
    invokeTool: (r) => textPublicationHost(dispatcher).invokeTool(r),
  })
  dispatcher = new TextDispatcher(runtime, {
    ...inner,
    async execute(context) {
      const handle = await inner.execute(context)
      executions.push({ context, handle })
      return handle
    },
  })
  await dispatcher.start()
  server = await startTextServer(runtime, actor, {
    host: '127.0.0.1',
    port: 0,
    dispatcher,
    allowedOrigins: ['http://127.0.0.1:4198'],
  })
  const call = async (method, path, body) => {
    const r = await fetch(server.url + path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    })
    const data = await r.json()
    assert.ok(r.ok, `${path}: ${JSON.stringify(data)}`)
    return data
  }
  const op = () => ({ version: 1, operationId: randomUUID() })
  const settings = {
    adapterId: { set: 'deterministic-fixture' },
    modelId: { set: 'fixture-model' },
  }
  await call('PUT', `/v1/organizations/${organizationId}/settings`, {
    ...op(),
    settings,
  })
  await call('PUT', `/v1/agents/${rootAgentId}/settings`, { ...op(), settings })
  const agent = (
    await call('POST', '/v1/agents', { ...op(), name: 'Scout', organizationId })
  ).agent
  const second = (
    await call('POST', '/v1/organizations', { ...op(), name: 'Orchard' })
  ).organization
  const context = { kind: 'organization', organizationId }
  const chatId = (
    await call('POST', '/v1/direct-chats', {
      version: 1,
      context,
      agentId: agent.id,
    })
  ).chatId
  const saved = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Inspect the garden' }],
  })
  let execution = await until(() =>
    executions.find((e) => e.context.runId === saved.runId),
  )
  const tool = (name, args) =>
    execution.handle.callTool(randomUUID(), name, args)
  const written = await tool('artifacts_write', {
    name: 'garden.txt',
    content: 'Retained garden report',
  })
  const file = (await tool('artifacts_publish', { outputId: written.outputId }))
    .artifact
  await tool('conversation_publish', {
    text: 'Garden report',
    artifactIds: [file.id],
  })
  const published = (
    await tool('artifacts_copy_to_organization', { artifactId: file.id })
  ).artifact
  const copySource = (
    await tool('artifacts_publish', {
      outputId: (
        await tool('artifacts_write', {
          name: 'copy-only.txt',
          content: 'Retained garden report',
        })
      ).outputId,
    })
  ).artifact
  await tool('conversation_publish', {
    text: 'Copy this report too',
    artifactIds: [copySource.id],
  })
  vite = spawn(
    process.execPath,
    [
      join(
        dirname(
          createRequire(join(ui, 'package.json')).resolve('vite/package.json'),
        ),
        'bin/vite.js',
      ),
      '--host',
      '127.0.0.1',
      '--port',
      '4198',
      '--strictPort',
    ],
    {
      cwd: ui,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  // Observe exit immediately: startup failure can precede teardown.
  viteExit = new Promise((resolve) => {
    vite.once('exit', resolve)
    vite.once('error', resolve)
  })
  vite.stdout.on('data', (b) => process.stdout.write(b))
  vite.stderr.on('data', (b) => process.stderr.write(b))
  await until(async () => {
    if (vite.exitCode !== null || vite.signalCode !== null)
      throw new Error('Vite exited before the lifecycle fixture was ready.')
    try {
      return (await fetch('http://127.0.0.1:4198')).ok
    } catch {
      return false
    }
  })
  browser = await webkit.launch()
  const a = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    }),
    b = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  for (const context of [a, b])
    await context.addInitScript(
      (url) => localStorage.setItem('kipster-backend-url', url),
      server.url,
    )
  await b.addInitScript(() => {
    for (const method of ['add', 'put']) {
      const original = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (...args) {
        try {
          const request = original.apply(this, args)
          request.addEventListener('error', () =>
            console.error(
              'STORAGE DIAGNOSTIC',
              this.name,
              method,
              request.error?.name,
              request.error?.message,
            ),
          )
          return request
        } catch (error) {
          console.error(
            'STORAGE DIAGNOSTIC',
            this.name,
            method,
            error.name,
            error.message,
          )
          throw error
        }
      }
    }
  })
  const A = await a.newPage(),
    B = await b.newPage()
  for (const page of [A, B]) {
    page.setDefaultTimeout(15000)
    page.on('console', (message) => {
      if (message.text().includes('STORAGE DIAGNOSTIC'))
        console.log(message.text())
    })
    page.on('pageerror', (e) => console.error('PAGE ERROR', e))
    await page.goto('http://127.0.0.1:4198')
    await expect(
      page.getByText('Inspect the garden', { exact: true }),
    ).toBeVisible()
  }
  const question = await dispatcher.askToolInteraction(
    execution.context.attemptId,
    'ui-question',
    {
      kind: 'question',
      prompt: 'Choose a garden color',
      options: [
        { id: 'blue', label: 'Blue' },
        { id: 'red', label: 'Red' },
      ],
      freeText: false,
    },
  )
  execution.handle.release({
    kind: 'ended',
    attemptId: execution.context.attemptId,
    confirmed: true,
  })
  await A.getByRole('combobox', { name: 'Organization' }).selectOption(
    second.id,
  )
  await A.getByRole('button', { name: /Notifications, 1 unread/ }).click()
  await expect(
    A.getByRole('heading', { name: /Scout needs your answer/ }),
  ).toBeVisible()
  await A.getByRole('button', { name: 'Mark read', exact: true }).click()
  await expect(
    B.getByRole('button', { name: /Notifications, 0 unread/ }),
  ).toBeVisible()
  await A.getByRole('button', {
    name: 'Open original context',
    exact: true,
  }).click()
  await expect(
    A.getByRole('heading', { name: 'Choose a garden color' }),
  ).toBeVisible()
  await expect(A.getByRole('combobox', { name: 'Organization' })).toHaveValue(
    organizationId,
  )
  console.log(
    'PASS: inbox read converges without resolving; organization routing follows the card',
  )
  await B.getByRole('button', { name: /^Open thread:/ }).press('Enter')
  await expect(
    B.getByRole('button', { name: 'Stop work', exact: true }),
  ).toBeVisible()
  await expect(
    B.getByRole('heading', { name: 'Choose a garden color' }),
  ).toBeVisible()
  await retainLast(
    runtime.db,
    {
      kind: 'thread',
      installationId,
      callerId: ownerId,
      threadId: saved.threadId,
    },
    0,
  )
  await retainLast(
    runtime.db,
    { kind: 'application', installationId, callerId: ownerId },
    0,
  )
  await B.reload()
  await expect(
    B.getByRole('heading', { name: 'Choose a garden color' }),
  ).toBeVisible()
  console.log(
    'PASS: pending interaction and read state restore after replay retention and reload',
  )

  let answerBody
  await B.route(
    '**/v1/work/interactions/answer',
    async (route) => {
      answerBody = route.request().postDataJSON()
      await route.fetch()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await B.getByRole('radio', { name: 'Blue', exact: true }).check()
  await B.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(A.getByText('Recorded response', { exact: true })).toBeVisible()
  await expect(B.getByText('Recorded response', { exact: true })).toBeVisible()
  assert.equal(answerBody.interactionId, question.interactionId)
  assert.equal(answerBody.attemptId, execution.context.attemptId)
  assert.equal(answerBody.runId, saved.runId)
  await expect(B.getByText(/Response outcome is being reconciled/)).toHaveCount(
    0,
    { timeout: 15000 },
  )
  execution = await until(() =>
    executions.find(
      (e) =>
        e.context.runId === saved.runId &&
        e.context.attemptId !== execution.context.attemptId,
    ),
  )
  console.log(
    'PASS: answer IDs are exact; lost acknowledgement recovers; both cards settle',
  )

  await B.getByRole('textbox', { name: 'Reply in this thread' }).fill(
    'Queued follow-up to cancel',
  )
  await B.getByRole('form', { name: 'Reply in this thread' })
    .getByRole('button', { name: 'Send message' })
    .click()
  await expect(
    B.getByRole('region', { name: 'Accepted follow-ups' }),
  ).toContainText('Queued follow-up to cancel')
  await expect(
    B.getByRole('button', { name: 'Steer current attempt' }),
  ).toBeDisabled()
  await B.getByRole('button', { name: 'Cancel queued item' }).click()
  await expect(
    B.getByText('Queued follow-up cancelled', { exact: true }),
  ).toBeVisible()
  console.log(
    'PASS: queued work is shared, cancellable, and steering honestly reports unsupported',
  )
  await B.getByRole('textbox', { name: 'Reply in this thread' }).fill(
    'Keep this draft after deletion',
  )
  await B.getByRole('form', { name: 'Start a new thread', exact: true })
    .locator('input[type=file]')
    .setInputFiles({
      name: 'rejected.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Original rejected attachment bytes'),
    })
  await expect(
    B.getByRole('form', { name: 'Start a new thread', exact: true }).locator(
      '.pending-media.ready',
    ),
  ).toContainText('rejected.txt')
  await B.getByRole('form', { name: 'Reply in this thread', exact: true })
    .locator('input[type=file]')
    .setInputFiles({
      name: 'unsent.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Original unsent attachment bytes'),
    })
  await expect(
    B.getByRole('form', { name: 'Reply in this thread', exact: true }).locator(
      '.pending-media.ready',
    ),
  ).toContainText('unsent.txt')
  let releaseSend
  let sendArrived
  const gate = new Promise((resolve) => {
    releaseSend = resolve
  })
  const arrived = new Promise((resolve) => {
    sendArrived = resolve
  })
  await B.route(
    '**/v1/text/submissions',
    async (route) => {
      sendArrived()
      await gate
      await route.continue()
    },
    { times: 1 },
  )
  await B.getByRole('textbox', {
    name: 'Start a new thread',
    exact: true,
  }).fill('Retain this rejected outbox entry')
  await B.getByRole('form', { name: 'Start a new thread', exact: true })
    .getByRole('button', { name: 'Send message' })
    .click()
  await arrived
  await A.getByRole('button', { name: 'Settings', exact: true }).click()
  await A.getByRole('button', {
    name: 'Archive & deletion',
    exact: true,
  }).click()
  await A.getByRole('button', { name: 'Delete Scout', exact: true }).click()
  await A.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await expect(B.getByText(/Scout is archived/).first()).toBeVisible()
  await expect(
    B.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toHaveCount(0)
  await B.screenshot({
    path: join(output, 'archived-wide-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  console.log('PASS: two-client archive makes the typing client read only')
  releaseSend()
  await expect(
    B.getByText('New thread · Not accepted', { exact: true }),
  ).toBeVisible()

  execution.handle.release({
    kind: 'text',
    attemptId: execution.context.attemptId,
    messageId: 'late-archive-output',
    text: 'FORBIDDEN LATE OUTPUT',
    final: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  await expect(
    B.getByText('FORBIDDEN LATE OUTPUT', { exact: true }),
  ).toHaveCount(0)
  assert.ok(
    !(
      await call('GET', `/v1/threads/${saved.threadId}/snapshot`)
    ).messages.some((m) =>
      m.parts.some((p) => p.text === 'FORBIDDEN LATE OUTPUT'),
    ),
  )
  // Provider termination remains uncertain until explicitly confirmed by the fixture.
  execution.handle.release({
    kind: 'ended',
    attemptId: execution.context.attemptId,
  })
  await A.getByRole('button', { name: 'Restore Scout', exact: true }).click()
  await A.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await expect(
    B.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toHaveValue('Keep this draft after deletion')
  console.log('PASS: restore preserves the unsent draft')
  const uncertainRun = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Wait for provider termination' }],
  })
  const uncertainExecution = await until(() =>
    executions.find((e) => e.context.runId === uncertainRun.runId),
  )

  await A.getByRole('button', { name: 'Delete Scout', exact: true }).click()
  await A.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await A.getByRole('button', {
    name: 'Delete Scout permanently',
    exact: true,
  }).click()
  await expect(
    A.getByRole('button', { name: 'Confirm permanent deletion' }),
  ).toBeDisabled()
  await A.getByRole('textbox', { name: 'Type name to confirm' }).fill('Scout')
  await A.getByRole('checkbox', {
    name: 'Copy files shared in organization chats into their organizations',
  }).check()
  await A.screenshot({
    path: join(output, 'delete-confirm-wide-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  let deleteBody
  await A.route(
    '**/v1/agents/' + agent.id,
    async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue()
      deleteBody = route.request().postDataJSON()
      await route.fetch()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await A.getByRole('button', { name: 'Confirm permanent deletion' }).click()
  await expect(
    B.getByText(/This conversation is no longer available. Saved drafts/),
  ).toBeVisible()
  await expect(
    A.getByText(
      'Cleanup will continue when Core confirms the outstanding work has ended.',
    ),
  ).toBeVisible({ timeout: 15000 })
  await A.screenshot({
    path: join(output, 'waiting-provider.png'),
    fullPage: true,
    animations: 'disabled',
  })
  // Keep two real deletions waiting to measure the panel's steady polling cadence.
  const peer = (
    await call('POST', '/v1/agents', {
      ...op(),
      name: 'Polling peer',
      organizationId,
    })
  ).agent
  const peerChat = await call('POST', '/v1/direct-chats', {
    version: 1,
    context,
    agentId: peer.id,
  })
  const peerRun = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId: peerChat.chatId },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Hold for polling verification' }],
  })
  const peerExecution = await until(() =>
    executions.find((e) => e.context.runId === peerRun.runId),
  )
  await A.getByRole('button', {
    name: 'Delete Polling peer',
    exact: true,
  }).click()
  await A.getByRole('button', { name: 'Confirm archive', exact: true }).click()
  await A.getByRole('button', {
    name: 'Delete Polling peer permanently',
    exact: true,
  }).click()
  await A.getByRole('textbox', { name: 'Type name to confirm' }).fill(
    'Polling peer',
  )
  await A.getByRole('button', { name: 'Confirm permanent deletion' }).click()
  await expect(
    A.getByText('Polling peer · delete · waiting', { exact: true }),
  ).toBeVisible()
  await expect(
    A.getByText('Scout · delete · waiting', { exact: true }),
  ).toBeVisible()
  const polls = []
  const capturePoll = (request) => {
    if (request.method() === 'GET' && request.url().includes('/v1/operations/'))
      polls.push({ id: request.url().split('/').at(-1), at: Date.now() })
  }
  A.on('request', capturePoll)
  await A.waitForTimeout(4700)
  const operationIds = [...new Set(polls.map((p) => p.id))]
  assert.equal(operationIds.length, 2, 'both waiting requests must be polled')
  for (const id of operationIds) {
    const timestamps = polls.filter((p) => p.id === id).map((p) => p.at)
    assert.ok(
      timestamps.length >= 2 && timestamps.length <= 4,
      JSON.stringify(polls),
    )
    for (let i = 1; i < timestamps.length; i++)
      assert.ok(
        timestamps[i] - timestamps[i - 1] >= 1400,
        JSON.stringify(polls),
      )
  }
  console.log('Polling observations:', JSON.stringify(polls))
  await A.getByRole('button', { name: 'Close archive & deletion' }).click()
  const closedCount = polls.length
  await A.waitForTimeout(1800)
  assert.equal(polls.length, closedCount, 'closing cancels scheduled polling')
  await A.getByRole('button', {
    name: 'Archive & deletion',
    exact: true,
  }).click()
  await until(() => polls.length > closedCount)
  peerExecution.handle.release({
    kind: 'ended',
    attemptId: peerExecution.context.attemptId,
    confirmed: true,
  })
  await expect(
    A.getByText('Polling peer · delete · succeeded', { exact: true }),
  ).toBeVisible({ timeout: 15000 })
  await expect(
    A.getByText('Scout · delete · waiting', { exact: true }),
  ).toBeVisible()
  uncertainExecution.handle.release({
    kind: 'ended',
    attemptId: uncertainExecution.context.attemptId,
    confirmed: true,
  })
  await until(
    () => call('GET', `/v1/operations/${deleteBody.operationId}`),
    (s) => s.state === 'succeeded',
  )
  console.log(
    'PASS: uncertain provider termination stays visibly waiting until confirmed',
  )
  await expect(
    A.getByText('Scout · delete · succeeded', { exact: true }),
  ).toBeVisible({ timeout: 15000 })
  A.off('request', capturePoll)
  console.log(
    'PASS: two waiting operations poll at bounded intervals, closing cancels polling, reopening resumes and both complete',
  )
  await B.emulateMedia({ colorScheme: 'dark' })
  await B.setViewportSize({ width: 390, height: 844 })
  await B.reload()
  await B.getByRole('button', { name: 'Show sidebar', exact: true }).click()
  await B.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(B.getByText(/Saved drafts on this device/)).toHaveCount(0)
  const persisted = await B.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('kipster-conversations')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const tx = db.transaction(['media', 'outbox'], 'readonly')
    const all = (store) =>
      new Promise((resolve, reject) => {
        const request = tx.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const [media, outbox] = await Promise.all([all('media'), all('outbox')])
    db.close()
    return media.map((m) => ({
      name: m.intent.name,
      association: m.association,
      binary: m.bytes instanceof ArrayBuffer,
      text: new TextDecoder().decode(m.bytes),
      rejected: outbox.some(
        (e) =>
          e.state === 'rejected' &&
          e.submission.parts.some(
            (p) => p.type === 'file' && p.artifactId === m.receipt?.artifact.id,
          ),
      ),
    }))
  })
  assert.deepEqual(
    persisted.sort((a, b) => a.name.localeCompare(b.name)),
    [
      {
        name: 'rejected.txt',
        association: 'submitted',
        binary: true,
        text: 'Original rejected attachment bytes',
        rejected: true,
      },
      {
        name: 'unsent.txt',
        association: 'draft',
        binary: true,
        text: 'Original unsent attachment bytes',
        rejected: false,
      },
    ],
  )
  console.log('PERSISTED ATTACHMENTS', JSON.stringify(persisted))
  console.log(
    'PASS: genuine selected files persist through archive/delete/reload as unsent and rejected associations',
  )
  await B.getByRole('button', {
    name: 'Archive & deletion',
    exact: true,
  }).click()
  await expect(
    B.getByRole('button', { name: 'Close archive & deletion' }),
  ).toBeInViewport()
  const closeColor = await B.getByRole('button', {
    name: 'Close archive & deletion',
  }).evaluate((e) => getComputedStyle(e).color)
  assert.notEqual(closeColor, 'rgb(42, 22, 32)')
  await B.screenshot({
    path: join(output, 'archive-fresh-narrow-dark.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await B.getByRole('button', { name: 'Close archive & deletion' }).click()
  await B.getByRole('button', { name: 'Close settings' }).click()
  await B.locator('#workspace-sidebar .collapse-button').click()
  console.log(
    'PASS: recovery fits after resize and fresh narrow load; mobile navigation and archive close are usable',
  )

  await expect(
    B.getByText('Retain this rejected outbox entry', { exact: false }),
  ).toBeVisible()
  await expect(
    B.getByText('New thread · Not accepted', { exact: true }),
  ).toBeVisible()
  console.log(
    'PASS: a send rejected by cross-device archive remains recoverable after deletion and reload',
  )
  console.log(
    'PASS: permanent deletion clears selection; draft survives reload',
  )
  await A.getByRole('button', { name: 'Delete Orchard', exact: true }).click()
  await A.getByRole('textbox', { name: 'Type name to confirm' }).fill('Orchard')
  await A.getByRole('button', { name: 'Confirm permanent deletion' }).click()
  await until(
    () => call('GET', '/v1/directory'),
    (d) => !d.organizations.some((o) => o.id === second.id),
  )
  assert.equal(deleteBody.copyFilesToOrganizations, true)
  const repeated = await call('DELETE', '/v1/agents/' + agent.id, deleteBody)
  assert.equal(repeated.alreadyApplied, true)
  assert.equal(
    (await call('GET', '/v1/directory')).agents.find((a) => a.id === agent.id)
      ?.lifecycle,
    'deleted',
  )
  const rootChat = (
    await call('POST', '/v1/direct-chats', {
      version: 1,
      context,
      agentId: rootAgentId,
    })
  ).chatId
  const mediaTarget = {
    installationId,
    callerId: ownerId,
    context,
    chatId: rootChat,
  }
  const copies = (
    await runtime.db.query(
      "SELECT id FROM kipster.artifacts WHERE owner_kind='organization' AND author_id=$1",
      [agent.id],
    )
  ).rows
  assert.ok(copies.some((c) => c.id === published.id))
  assert.ok(copies.some((c) => c.id !== published.id))
  for (const retained of copies) {
    const response = await B.request.get(
      server.url +
        `/conversations/media/artifacts/${retained.id}/content?target=${encodeURIComponent(JSON.stringify(mediaTarget))}`,
    )
    assert.equal(response.status(), 200)
    assert.equal(await response.text(), 'Retained garden report')
  }
  console.log(
    'PASS: lost delete acknowledgement is idempotent; published and copied bytes remain downloadable via browser context',
  )
  console.log('PASS: typed-name organization deletion')
  await A.screenshot({
    path: join(output, 'operations-wide-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await A.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await A.screenshot({
    path: join(output, 'archive-wide-dark.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await A.setViewportSize({ width: 390, height: 844 })
  await A.screenshot({
    path: join(output, 'archive-narrow-dark.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await A.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await A.screenshot({
    path: join(output, 'archive-narrow-light.png'),
    fullPage: true,
    animations: 'disabled',
  })

  await A.getByRole('button', { name: 'Close archive & deletion' }).click()
  await A.getByRole('button', { name: 'Close settings' }).click()
  await A.setViewportSize({ width: 1440, height: 900 })
  const maple = (
    await call('POST', '/v1/agents', { ...op(), name: 'Maple', organizationId })
  ).agent
  const adminContext = { kind: 'installation', installationId }
  const adminChat = (
    await call('POST', '/v1/direct-chats', {
      version: 1,
      context: adminContext,
      agentId: rootAgentId,
    })
  ).chatId
  const adminRun = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context: adminContext, chatId: adminChat },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Archive Maple with approval' }],
  })
  const adminExecution = await until(() =>
    executions.find((e) => e.context.runId === adminRun.runId),
  )
  await adminExecution.handle.callTool(randomUUID(), 'admin_call', {
    operation: 'agents.archive',
    arguments: { agentId: maple.id },
  })
  const adminCard = (
    await call('GET', `/v1/threads/${adminRun.threadId}/snapshot`)
  ).interactions[0]
  await A.getByRole('button', { name: 'Root', exact: true }).click()
  await A.getByRole('button', { name: /^Open thread:/ }).press('Enter')
  await expect(A.locator('.interaction-proposal')).toContainText(maple.id)
  await expect(A.locator('.interaction-proposal')).toContainText('Maple')
  await A.screenshot({
    path: join(output, 'core-approval-wide-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  let approvalBody
  await A.route(
    '**/v1/work/interactions/answer',
    async (route) => {
      approvalBody = route.request().postDataJSON()
      await route.continue()
    },
    { times: 1 },
  )
  await A.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(A.getByText('Recorded response', { exact: true })).toBeVisible()
  assert.equal(approvalBody.proposalId, adminCard.proposalId)
  assert.equal(approvalBody.interactionId, adminCard.id)
  assert.equal(approvalBody.runId, adminCard.runId)
  assert.equal(approvalBody.attemptId, adminCard.attemptId)
  await until(
    () => call('GET', '/v1/directory'),
    (d) => d.agents.find((a) => a.id === maple.id)?.lifecycle === 'archived',
  )
  console.log(
    'PASS: Core-authored approval shows exact name/ID and submits all bound IDs',
  )

  const runner = (
    await call('POST', '/v1/agents', {
      ...op(),
      name: 'Runner',
      organizationId,
    })
  ).agent
  const runnerChat = (
    await call('POST', '/v1/direct-chats', {
      version: 1,
      context,
      agentId: runner.id,
    })
  ).chatId
  const first = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId: runnerChat },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Exercise work controls' }],
  })
  let running = await until(() =>
    executions.find((e) => e.context.runId === first.runId),
  )
  const follow = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId: runnerChat },
    threadId: first.threadId,
    mode: 'reply',
    parts: [{ kind: 'text', text: 'Continue after stop' }],
  })
  await A.getByRole('button', { name: 'Runner', exact: true }).click()
  await A.getByRole('button', { name: /^Open thread:/ }).press('Enter')
  console.log('CONTROL: stopping running work')
  await A.getByRole('region', { name: /^Thread: Exercise work controls/ })
    .getByRole('button', { name: 'Stop work', exact: true })
    .click()
  await until(
    () => call('GET', `/v1/threads/${first.threadId}/snapshot`),
    (s) => s.work.find((w) => w.runId === first.runId)?.queueHold,
  )
  running.handle.release({
    kind: 'ended',
    attemptId: running.context.attemptId,
    confirmed: true,
  })
  await A.getByRole('button', {
    name: 'Resume follow-ups',
    exact: true,
  }).click()
  running = await until(() =>
    executions.find((e) => e.context.runId === follow.runId),
  )
  running.handle.release({
    kind: 'failed',
    attemptId: running.context.attemptId,
    confirmedEnded: true,
    message: 'Fixture failure',
  })
  console.log('CONTROL: retrying failed work')
  await A.getByRole('button', { name: 'Retry work', exact: true }).click()
  const retried = await until(() =>
    executions.find(
      (e) =>
        e.context.runId === follow.runId &&
        e.context.attemptId !== running.context.attemptId,
    ),
  )
  retried.handle.release({
    kind: 'text',
    attemptId: retried.context.attemptId,
    messageId: 'retry-result',
    text: 'Retry completed',
    final: true,
  })
  retried.handle.release({
    kind: 'ended',
    attemptId: retried.context.attemptId,
    confirmed: true,
  })
  await expect(A.getByText('Retry completed', { exact: true })).toBeVisible()
  console.log(
    'PASS: real Core Stop holds FIFO, Resume releases it, and Retry creates a new attempt',
  )

  const helper = (
    await call('POST', '/v1/agents', {
      ...op(),
      name: 'Helper',
      organizationId,
    })
  ).agent
  const parent = await call('POST', '/v1/text/submissions', {
    version: 1,
    submissionId: randomUUID(),
    scope: { installationId, callerId: ownerId },
    target: { context, chatId: runnerChat },
    mode: 'root',
    parts: [{ kind: 'text', text: 'Delegate a color decision' }],
  })
  const parentExecution = await until(() =>
    executions.find((e) => e.context.runId === parent.runId),
  )
  const delegation = await parentExecution.handle.callTool(
    randomUUID(),
    'agents_delegate',
    { recipientId: helper.id, request: 'Ask the owner which color to use' },
  )
  parentExecution.handle.release({
    kind: 'ended',
    attemptId: parentExecution.context.attemptId,
    confirmed: true,
  })
  const child = await until(() =>
    executions.find((e) => e.context.runId === delegation.childRunId),
  )
  const childCard = await dispatcher.askToolInteraction(
    child.context.attemptId,
    'child-question',
    {
      kind: 'question',
      prompt: 'Which delegated color?',
      options: [{ id: 'green', label: 'Green' }],
      freeText: false,
    },
  )
  child.handle.release({
    kind: 'ended',
    attemptId: child.context.attemptId,
    confirmed: true,
  })
  await A.getByRole('button', { name: /^Notifications,/ }).click()
  await A.locator('.inbox-list li')
    .filter({ hasText: /Delegate a color decision|Which delegated color/ })
    .getByRole('button', { name: 'Open original context' })
    .click()
  await expect(
    A.getByRole('heading', { name: 'Which delegated color?' }),
  ).toBeVisible()
  await expect(A.locator('.interaction-eyebrow')).toContainText('Helper')
  await expect(A.locator('.work-block')).toContainText('Helper')
  let childAnswer
  await A.route(
    '**/v1/work/interactions/answer',
    async (route) => {
      childAnswer = route.request().postDataJSON()
      await route.continue()
    },
    { times: 1 },
  )
  await A.getByRole('radio', { name: 'Green', exact: true }).check()
  await A.screenshot({
    path: join(output, 'child-question-wide-light.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await A.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(A.getByText('Recorded response', { exact: true })).toBeVisible()
  assert.equal(childAnswer.interactionId, childCard.interactionId)
  assert.equal(childAnswer.runId, delegation.childRunId)
  assert.equal(childAnswer.attemptId, child.context.attemptId)
  console.log(
    'PASS: delegated child question is attributed to Helper and answers its exact child run/attempt',
  )
} finally {
  await browser?.close()
  if (vite) {
    if (vite.exitCode === null && vite.signalCode === null) vite.kill('SIGTERM')
    await viteExit
  }
  await server?.close()
  await dispatcher?.close()
  await runtime?.close()
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
  await admin.close()
  await rm(home, { recursive: true, force: true })
}
