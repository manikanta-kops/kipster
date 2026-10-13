import type { EmbeddingServerStatus } from './embedding/supervisor.js'
import type { PluginServerStatus } from './plugins/supervisor.js'

const sensitive = /password|passwd|secret|token|credential|authorization|api.?key|database.?url|taskdata.?url|pguser/i

/** Preserve diagnostic causes without exposing private host/provider configuration. */
export function safeHostError(error: unknown, ...sources: unknown[]): string {
  const secrets = new Set<string>()
  function collect(value: unknown, privateValue = false): void {
    if (typeof value === 'string') {
      if (privateValue && value) secrets.add(value)
      try {
        const url = new URL(value)
        if (url.password) { secrets.add(url.password); secrets.add(decodeURIComponent(url.password)) }
        if (url.username && /^postgres(?:ql)?:$/.test(url.protocol)) secrets.add(decodeURIComponent(url.username))
        for (const [key, secret] of url.searchParams) if (sensitive.test(key) && secret) secrets.add(secret)
      } catch { /* Ordinary configuration strings are not URLs. */ }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) collect(item, privateValue || sensitive.test(key))
    }
  }
  for (const source of sources) collect(source)
  let message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown Core failure'
  message = message.replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"<>]+/gi, '[database URL redacted]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s/@]+:[^\s/@]*@[^\s'"<>]+/gi, '[credential URL redacted]')
    .replace(/\bBearer\s+[^\s'"<>]+/gi, 'Bearer [redacted]')
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) message = message.replaceAll(secret, '[redacted]')
  message = message.replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
  return message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 8192)
}

/** Host diagnostics for the supervised embedding server, from a running host's status. */
export function embeddingServerDiagnostic(status: EmbeddingServerStatus | undefined): { status: 'ok' | 'unavailable' | 'not-probed'; message: string } {
  switch (status?.state) {
    case 'ready': return { status: 'ok', message: `Embedding server (llama-server) is ready on port ${status.port}${status.reused ? ', reusing the Kipster server already running there' : ''}.` }
    case 'starting': return { status: 'not-probed', message: `Embedding server (llama-server) is starting${status.port ? ` on port ${status.port}` : ''}.` }
    case 'restarting': return { status: 'unavailable', message: `Embedding server (llama-server) is restarting, attempt ${status.attempt}: ${status.reason}. Memory search is unavailable meanwhile.` }
    case 'failed': return { status: 'unavailable', message: `Embedding server (llama-server) failed: ${status.reason}. Memory search is unavailable; inspect logs/embedding-server.log.` }
    case 'stopped': return { status: 'not-probed', message: 'Embedding server (llama-server) is stopped.' }
    default: return { status: 'not-probed', message: 'Embedding server (llama-server) is configured; the running host starts it.' }
  }
}

/** Host diagnostics for the supervised plugin server, from a running host's status. */
export function pluginServerDiagnostic(status: PluginServerStatus | undefined): { status: 'ok' | 'unavailable' | 'not-probed'; message: string } {
  switch (status?.state) {
    case 'ready': return { status: 'ok', message: `Plugin server${status.version ? ` ${status.version}` : ''} is ready on port ${status.port}.` }
    case 'starting': return { status: 'not-probed', message: `Plugin server is starting${status.port ? ` on port ${status.port}` : ''}; plugins are off until it is ready.` }
    case 'restarting': return { status: 'unavailable', message: `Plugin server is restarting, attempt ${status.attempt}: ${status.reason}. Plugins are off meanwhile.` }
    case 'failed': return { status: 'unavailable', message: `Plugin server failed: ${status.reason}. Plugins are off; inspect logs/plugins.log.` }
    case 'stopped': return { status: 'not-probed', message: 'Plugin server is stopped; plugins are off.' }
    default: return { status: 'not-probed', message: 'Plugin server is configured; the running host starts it.' }
  }
}
