import type { Plugin, Connect } from 'vite'
import { createFakeCore, DEMO_ORIGIN } from '../src/fake-core/index.ts'

/** Test HTTP adapter; all protocol behavior belongs to the embedded handler. */
export function demoServer(): Plugin {
  const sessions = new Map<string, ReturnType<typeof createFakeCore>>()
  const middleware: Connect.NextHandleFunction = async (
    incoming,
    outgoing,
    next,
  ) => {
    const match = incoming.url?.match(/^\/__test-core\/([\w-]+)(\/.*)$/)
    if (!match) return next()
    let core = sessions.get(match[1])
    if (!core) {
      core = createFakeCore({ testControls: true, autoAdvance: false })
      sessions.set(match[1], core)
    }
    const abort = new AbortController()
    outgoing.on('close', () => abort.abort())
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [key, value] of Object.entries(incoming.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const response = await core.handle(
        new Request(DEMO_ORIGIN + match[2], {
          method: incoming.method,
          headers,
          signal: abort.signal,
          body: bytes.length ? bytes : undefined,
        }),
      )
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            outgoing.write(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
      }
      outgoing.end()
    } catch (error) {
      if (!abort.signal.aborted) {
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(
          JSON.stringify({
            version: 1,
            code: 'internal',
            message: String(error),
          }),
        )
      }
    }
  }
  return {
    name: 'test-core-adapter',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
    closeBundle() {
      for (const core of sessions.values()) core.dispose()
      sessions.clear()
    },
  }
}
