// One disposable database cluster owns every real-Core browser and lifecycle check.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { Postgres } from '../../../core/dist/platform/postgres/public.js'
import {
  openRuntime,
  startTextServer,
  TextDispatcher,
  textPublicationHost,
} from '../../../core/dist/runtime.js'
import { fixtureAdapter } from '../../../core/tests/.build/tests/fixtures/deterministic-adapter.js'
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(ui, '../..')
const run = (file, args = [], env = {}) =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(root, file), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done() : reject(Error(`${file} exited ${code}`)),
    )
  })
// A message with the marker makes the fixture kip write this doc; the doc's submission makes it revise.
const docMarker = 'write a rich doc'
const docSubmission =
  /The user submitted rich doc .* \(doc ID ([0-9a-f-]+), revision \d+\)/
const docMarkdown = [
  '# Trip plan',
  '',
  'We fly out in May.',
  '',
  '- [ ] Book flights',
  '- [ ] Reserve a hotel',
  '',
  '```question',
  'prompt: Where should we go?',
  'other: true',
  'options:',
  '- Oslo | Fjords and design',
  '- Lisbon | Sun and tiles',
  '```',
  '',
  '```scale',
  'prompt: How flexible are the dates?',
  'min: 1',
  'max: 5',
  'step: 1',
  'minLabel: Fixed',
  'maxLabel: Open',
  '```',
].join('\n')
async function writeDoc(handle) {
  await handle.callTool('fixture-doc-create', 'documents_create', {
    title: 'Trip plan',
    markdown: docMarkdown,
  })
  return 'Fixture wrote a rich doc.'
}
async function reviseDoc(handle, documentId, gate) {
  const doc = await handle.callTool('fixture-doc-read', 'documents_read', {
    documentId,
  })
  const heading = doc.blocks.find((block) => block.markdown.startsWith('# '))
  await handle.callTool('fixture-doc-edit', 'documents_edit', {
    documentId,
    operations: [
      { op: 'replace', blockId: heading.id, markdown: '# Trip plan, revised' },
      {
        op: 'insert',
        afterBlockId: heading.id,
        markdown: 'The kip added this after your submission.',
      },
      ...doc.openComments.map((comment) => ({
        op: 'resolve',
        commentId: comment.id,
        reply: `Addressed: ${comment.body}`,
      })),
    ],
  })
  await gate
  return 'Fixture revised the doc.'
}
if (!process.env.KIPSTER_TEST_DATABASE_URL) {
  await run('core/scripts/with-test-database.mjs', [
    process.execPath,
    fileURLToPath(import.meta.url),
  ])
} else {
  for (const browser of ['chrome', 'webkit']) {
    const home = await mkdtemp(join(tmpdir(), 'kipster-ui-suite-'))
    const admin = new Postgres(process.env.KIPSTER_TEST_DATABASE_URL)
    const database = `kipster_ui_${randomUUID().replaceAll('-', '')}`
    await admin.query(`CREATE DATABASE "${database}"`)
    const url = new URL(process.env.KIPSTER_TEST_DATABASE_URL)
    url.pathname = '/' + database
    let runtime, dispatcher, core, vite
    let releaseTranscription, releaseRevision
    const transcriptionGate = new Promise((resolve) => {
      releaseTranscription = resolve
    })
    // Holds the kip's doc revision open until the browser has seen the doc locked.
    const revisionGate = new Promise((resolve) => {
      releaseRevision = resolve
    })
    try {
      const provider = {
        id: 'fixture-transcription',
        contractMajor: 1,
        inputTypes: ['audio/*'],
        async readiness() {
          return { ready: true }
        },
        async transcribe() {
          await transcriptionGate
          return {
            status: 'unavailable',
            reason: 'provider-error',
            provider: this.id,
          }
        },
        async close() {},
      }
      runtime = await openRuntime({
        connectionString: url.href,
        home,
        names: { owner: 'Owner', organization: 'Garden', rootAgent: 'Root' },
        transcription: provider,
      })
      await runtime.memory?.stopIndexing()
      const inner = fixtureAdapter({
        now: () => new Date().toISOString(),
        invokeTool: (r) => textPublicationHost(dispatcher).invokeTool(r),
      })
      dispatcher = new TextDispatcher(runtime, {
        ...inner,
        async execute(context) {
          const handle = await inner.execute(context)
          const parts = context.input.at(-1).parts
          const text = parts
            .filter((p) => p.kind === 'text')
            .map((p) => p.text)
            .join('')
          const voice = parts.find((p) => p.purpose === 'voice_note')
          const reply = (message) => {
            handle.release({
              kind: 'text',
              attemptId: context.attemptId,
              messageId: randomUUID(),
              text: message,
              final: true,
            })
            handle.release({
              kind: 'ended',
              attemptId: context.attemptId,
              confirmed: true,
            })
          }
          const submitted = docSubmission.exec(text)
          if (submitted || text.includes(docMarker)) {
            // Rich docs: the kip writes a doc, or revises one the user submitted.
            ;(submitted
              ? reviseDoc(handle, submitted[1], revisionGate)
              : writeDoc(handle)
            ).then(reply, (error) => reply(`Fixture doc error: ${error}`))
            return handle
          }
          reply(
            voice
              ? `Fixture received voice_note; original ${voice.availability}; transcription ${voice.transcription.status}; caption ${text}`
              : text === '__large_reply__'
                ? 'Large reply '.repeat(30000)
                : `Fixture reply: ${text}`,
          )
          return handle
        },
      })
      await dispatcher.start()
      core = await startTextServer(
        runtime,
        {
          installationId: runtime.bootstrap.installationId,
          personId: runtime.bootstrap.ownerId,
        },
        {
          host: '127.0.0.1',
          port: 0,
          dispatcher,
          allowedOrigins: ['http://127.0.0.1:4197'],
        },
      )
      for (const path of [
        `organizations/${runtime.bootstrap.organizationId}`,
        `agents/${runtime.bootstrap.rootAgentId}`,
      ]) {
        const response = await fetch(`${core.url}/v1/${path}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            operationId: randomUUID(),
            settings: {
              adapterId: { set: inner.id },
              modelId: { set: 'fixture-model' },
            },
          }),
        })
        if (!response.ok) throw Error(await response.text())
      }
      vite = await createServer({
        root: ui,
        plugins: [
          {
            name: 'fixture-gates',
            configureServer(server) {
              server.middlewares.use(
                '/__test-transcription/release',
                (_request, response) => {
                  releaseTranscription()
                  response.end('released')
                },
              )
              server.middlewares.use(
                '/__test-documents/release',
                (_request, response) => {
                  releaseRevision()
                  response.end('released')
                },
              )
            },
          },
        ],
        server: {
          host: '127.0.0.1',
          port: 4197,
          strictPort: true,
          watch: null,
        },
      })
      await vite.listen()
      await run(
        join(
          dirname(
            createRequire(join(ui, 'package.json')).resolve(
              '@playwright/test/package.json',
            ),
          ),
          'cli.js',
        ),
        [
          'test',
          '-c',
          join(ui, 'playwright.real-core.config.ts'),
          '--project',
          browser,
        ],
        { KIPSTER_TEST_CORE_URL: core.url },
      )
    } finally {
      releaseTranscription()
      releaseRevision()
      await vite?.close()
      await core?.close()
      await dispatcher?.close()
      await runtime?.close()
      await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
      await admin.close()
      await rm(home, { recursive: true, force: true })
    }
  }
  await run('interface/kipster-ui/tests/real-core-lifecycle.mjs')
  await run('interface/kipster-ui/tests/lifecycle-startup.mjs')
  await run('interface/kipster-ui/tests/publication-recovery.mjs')
}
