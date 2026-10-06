// Entry point ONLY for factory verify-kit/tester instance supervision.
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve, extname, sep, dirname } from 'node:path'
import {
  checkoutHome,
  connectedHTML,
  instanceArguments,
  isolatedEnvironment,
  replaceEnvironment,
} from '../isolation.mjs'

const root = resolve(import.meta.dirname, '../..')
const {
  ports: [port, corePort],
  connectionString,
} = instanceArguments(process.argv.slice(2))
const home = checkoutHome(root, 'instance/home')
await mkdir(home, { recursive: true, mode: 0o700 })
replaceEnvironment(isolatedEnvironment(home))
// Tester preparation may omit check; setup alone only installs dependencies.
// Build every required asset in this disposable checkout, in production mode.
for (const args of [
  ['run', 'build', '-w', 'core'],
  ['exec', '-w', 'core', '--', 'tsc', '-p', 'tsconfig.fixture.json'],
  ['run', 'build', '-w', 'interface/kipster-ui'],
]) {
  const code = await new Promise((done, reject) => {
    const child = spawn(resolve(dirname(process.execPath), 'npm'), args, {
      cwd: root,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/bin:/bin` },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => done(code))
  })
  if (code !== 0)
    throw Error(`Instance asset build failed: npm ${args.join(' ')}`)
}
const origin = `http://127.0.0.1:${port}`
const coreOrigin = `http://127.0.0.1:${corePort}`
// Core's optional update checks may only contact this instance's local catalog.
const fetchOriginal = globalThis.fetch
globalThis.fetch = (input, options) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url,
  )
  if (![origin, coreOrigin].includes(url.origin))
    throw Error('Verification network destination refused')
  return fetchOriginal(input, { ...options, redirect: 'error' })
}
const { openRuntime, startTextServer, TextDispatcher, textPublicationHost } =
  await import('../../core/dist/runtime.js')
const { fixtureAdapter } =
  await import('../../core/tests/.build/tests/fixtures/deterministic-adapter.js')
const { Postgres } = await import('../../core/dist/platform/postgres/public.js')
const database = new Postgres(connectionString)
try {
  const version = (await database.query('SHOW server_version_num')).rows[0]
    .server_version_num
  if (Number(version) < 180000 || Number(version) >= 190000)
    throw Error('Factory verification requires PostgreSQL 18')
  const vector = await database.query(
    "SELECT 1 FROM pg_available_extensions WHERE name='vector'",
  )
  if (!vector.rows.length)
    throw Error('Factory PostgreSQL 18 is missing pgvector')
  const existing = await database.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='kipster' LIMIT 1",
  )
  if (existing.rows.length)
    throw Error('Factory verification requires an empty database')
} finally {
  await database.close()
}

let runtime, dispatcher, core, server
let stopping = false
async function close(code = 0) {
  if (stopping) return
  stopping = true
  try {
    server?.closeAllConnections()
    if (server?.listening)
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      )
    await core?.close()
    await dispatcher?.close()
    await runtime?.close()
  } catch (error) {
    console.error(error)
    code = 1
  }
  process.exit(code)
}
process.once('SIGTERM', () => void close())
process.once('SIGINT', () => void close())
try {
  const transcription = {
    id: 'fixture-transcription',
    contractMajor: 1,
    inputTypes: ['audio/*'],
    async readiness() {
      return { ready: true }
    },
    async transcribe() {
      return {
        status: 'unavailable',
        reason: 'provider-error',
        provider: this.id,
      }
    },
    async close() {},
  }
  runtime = await openRuntime({
    connectionString,
    home,
    names: {
      owner: 'Factory Owner',
      organization: 'Factory Garden',
      rootAgent: 'Kip',
    },
    transcription,
    updates: {
      managed: false,
      channelUrl: `${origin}/__fixture/catalog/`,
    },
    onError: (error) => console.error(error.message),
  })
  const inner = fixtureAdapter({
    now: () => new Date().toISOString(),
    invokeTool: (request) =>
      textPublicationHost(dispatcher).invokeTool(request),
  })
  const failed = new Set()
  dispatcher = new TextDispatcher(runtime, {
    ...inner,
    async execute(context) {
      const handle = await inner.execute(context)
      const text = context.input
        .at(-1)
        .parts.filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('')
      let settled = false
      const ended = () => {
        if (settled) return
        settled = true
        handle.release({
          kind: 'ended',
          attemptId: context.attemptId,
          confirmed: true,
        })
      }
      const reply = (text) => {
        if (settled) return
        handle.release({
          kind: 'text',
          attemptId: context.attemptId,
          messageId: randomUUID(),
          text,
          final: true,
        })
        ended()
      }
      // Confirm owned fixture cancellation; no CLI processes exist to terminate.
      handle.cancel = async () => {
        ended()
        return { acknowledged: true, confirmedEnded: true }
      }
      const task = async () => {
        if (context.continuation) {
          reply(
            `Fixture resumed: ${JSON.stringify(context.continuation.answer ?? context.continuation)}`,
          )
          return
        }
        if (text.startsWith('__hold__')) return
        if (
          text.startsWith('__question__') ||
          text.startsWith('__approval__')
        ) {
          const question = text.startsWith('__question__')
          await dispatcher.askToolInteraction(
            context.attemptId,
            'fixture-interaction',
            question
              ? {
                  kind: 'question',
                  prompt: 'Choose a color',
                  options: [
                    { id: 'blue', label: 'Blue' },
                    { id: 'red', label: 'Red' },
                  ],
                  freeText: false,
                }
              : {
                  kind: 'approval',
                  prompt: 'Approve fixture action?',
                  proposalId: 'fixture-color-blue',
                  proposal:
                    'Set the fixture color to blue; no external action.',
                },
          )
          ended()
          return
        }
        if (text.startsWith('__fail_once__') && !failed.has(context.runId)) {
          failed.add(context.runId)
          settled = true
          handle.release({
            kind: 'failed',
            attemptId: context.attemptId,
            confirmedEnded: true,
            message: 'Fixture controlled failure',
          })
          return
        }
        const submitted =
          /The user submitted rich doc .* \(doc ID ([0-9a-f-]+), revision \d+\)/.exec(
            text,
          )
        if (submitted) {
          const doc = await handle.callTool(
            'fixture-doc-read',
            'documents_read',
            { documentId: submitted[1] },
          )
          const heading = doc.blocks.find((block) =>
            block.markdown.startsWith('# '),
          )
          await handle.callTool('fixture-doc-edit', 'documents_edit', {
            documentId: submitted[1],
            operations: [
              {
                op: 'replace',
                blockId: heading.id,
                markdown: '# Trip plan, revised',
              },
              ...doc.openComments.map((comment) => ({
                op: 'resolve',
                commentId: comment.id,
                reply: `Addressed: ${comment.body}`,
              })),
            ],
          })
          reply('Fixture revised the doc.')
          return
        }
        if (text.includes('write a rich doc')) {
          await handle.callTool('fixture-doc-create', 'documents_create', {
            title: 'Trip plan',
            markdown:
              '# Trip plan\n\nWe fly out in May.\n\n- [ ] Book flights\n- [ ] Reserve a hotel\n\n```question\nprompt: Where should we go?\nother: true\noptions:\n- Oslo | Fjords and design\n- Lisbon | Sun and tiles\n```\n\n```scale\nprompt: How flexible are the dates?\nmin: 1\nmax: 5\nstep: 1\nminLabel: Fixed\nmaxLabel: Open\n```',
          })
          reply('Fixture wrote a rich doc.')
          return
        }
        const voice = context.input
          .at(-1)
          .parts.find((part) => part.purpose === 'voice_note')
        reply(
          voice
            ? `Fixture received voice_note; original ${voice.availability}; transcription ${voice.transcription.status}; caption ${text}`
            : `Fixture reply: ${text}`,
        )
      }
      void task().catch((error) => {
        if (settled) return
        settled = true
        handle.release({
          kind: 'failed',
          attemptId: context.attemptId,
          confirmedEnded: true,
          message: `Fixture error: ${error.message}`,
        })
      })
      return handle
    },
  })
  core = await startTextServer(
    runtime,
    {
      installationId: runtime.bootstrap.installationId,
      personId: runtime.bootstrap.ownerId,
    },
    { host: '127.0.0.1', port: corePort, dispatcher, allowedOrigins: [origin] },
  )
  for (const target of [
    `organizations/${runtime.bootstrap.organizationId}`,
    `agents/${runtime.bootstrap.rootAgentId}`,
  ]) {
    const response = await fetch(`${coreOrigin}/v1/${target}/settings`, {
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
    if (!response.ok) throw Error(`Fixture settings failed: ${response.status}`)
  }
  await dispatcher.start()
  const assets = resolve(root, 'interface/kipster-ui/dist')
  const index = connectedHTML(
    await readFile(resolve(assets, 'index.html'), 'utf8'),
  )
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  }
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin)
      if (
        url.pathname.startsWith('/v1/') ||
        url.pathname.startsWith('/conversations/media/')
      ) {
        const proxy = httpRequest(
          `${coreOrigin}${url.pathname}${url.search}`,
          {
            method: request.method,
            headers: { ...request.headers, host: `127.0.0.1:${corePort}` },
          },
          (upstream) => {
            response.writeHead(upstream.statusCode, upstream.headers)
            upstream.pipe(response)
          },
        )
        proxy.on('error', () => {
          if (!response.headersSent) response.writeHead(502)
          response.end()
        })
        response.once('close', () => proxy.destroy())
        request.pipe(proxy)
        return
      }
      if (url.pathname === '/health') {
        const bootstrap = await fetch(`${coreOrigin}/v1/bootstrap`)
        response.writeHead(bootstrap.ok && !stopping ? 200 : 503, {
          'Content-Type': 'application/json',
        })
        response.end(JSON.stringify({ ready: bootstrap.ok && !stopping }))
        return
      }
      if (/^\/__fixture\/catalog\/(stable|next)\.json$/.test(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ schemaVersion: 1, packages: {} }))
        return
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405)
        response.end()
        return
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
        })
        response.end(request.method === 'HEAD' ? undefined : index)
        return
      }
      const file = resolve(assets, '.' + decodeURIComponent(url.pathname))
      if (!file.startsWith(assets + sep)) {
        response.writeHead(403)
        response.end()
        return
      }
      const bytes = await readFile(file)
      response.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      })
      response.end(request.method === 'HEAD' ? undefined : bytes)
    } catch {
      if (!response.headersSent) response.writeHead(404)
      response.end()
    }
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', done)
  })
  server.on('error', (error) => {
    console.error(error.message)
    void close(1)
  })
  console.log('Isolated real-Core fixture and production UI ready')
} catch (error) {
  console.error(error.message)
  await close(1)
}
