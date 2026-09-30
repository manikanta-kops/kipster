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
    let releaseTranscription
    const transcriptionGate = new Promise((resolve) => {
      releaseTranscription = resolve
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
          handle.release({
            kind: 'text',
            attemptId: context.attemptId,
            messageId: randomUUID(),
            text: voice
              ? `Fixture received voice_note; original ${voice.availability}; transcription ${voice.transcription.status}; caption ${text}`
              : text === '__large_reply__'
                ? 'Large reply '.repeat(30000)
                : `Fixture reply: ${text}`,
            final: true,
          })
          handle.release({
            kind: 'ended',
            attemptId: context.attemptId,
            confirmed: true,
          })
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
            name: 'fixture-transcription-gate',
            configureServer(server) {
              server.middlewares.use(
                '/__test-transcription/release',
                (_request, response) => {
                  releaseTranscription()
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
