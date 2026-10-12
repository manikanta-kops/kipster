import type { EmbeddingProvider } from '@kipster/core/embedding'

export const dimensions = 768
const loopback = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** Reads the first error message llama-server reports, bounded for logs. */
async function failure(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } }
    if (typeof body.error?.message === 'string') return `: ${body.error.message.slice(0, 300)}`
  } catch { /* A body that is not llama-server JSON adds nothing useful. */ }
  return ''
}

export function createEmbeddingProvider(options: unknown): EmbeddingProvider {
  const value = options as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint !== 'string') throw new Error('Invalid llama-server endpoint')
  let endpoint: URL
  try { endpoint = new URL(value.endpoint) } catch { throw new Error('Invalid llama-server endpoint') }
  if (endpoint.protocol !== 'http:' || !loopback.has(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid llama-server endpoint: use a loopback http:// address')
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('Invalid embedding model')
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || !value.apiKey)) throw new Error('Invalid llama-server API key')
  if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1 || Number(value.timeoutMs) > 600000)) throw new Error('Invalid embedding timeout')
  const model = value.model, apiKey = value.apiKey as string | undefined, timeoutMs = (value.timeoutMs as number | undefined) ?? 60000
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/v1/embeddings'
  return {
    id: 'llama-cpp', model, contractMajor: 1,
    async embed(text, signal) {
      signal.throwIfAborted()
      const timeout = AbortSignal.timeout(timeoutMs)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST', signal: AbortSignal.any([signal, timeout]),
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: text, encoding_format: 'float' }),
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason
        if (timeout.aborted) throw new Error(`llama-server did not answer within ${timeoutMs} ms`)
        throw new Error(`llama-server is unreachable at ${endpoint.origin}`, { cause: error })
      }
      if (response.status === 401) throw new Error('llama-server rejected the API key')
      if (!response.ok) throw new Error(`llama-server embedding request failed (HTTP ${response.status})${await failure(response)}`)
      let body: { data?: { embedding?: unknown }[] }
      try { body = await response.json() as typeof body }
      catch (error) {
        if (signal.aborted) throw signal.reason
        throw new Error('llama-server returned an invalid embedding response', { cause: error })
      }
      const vector = body.data?.[0]?.embedding
      if (!Array.isArray(vector)) throw new Error('llama-server returned no embedding')
      if (vector.length !== dimensions) throw new Error(`llama-server returned ${vector.length} dimensions; expected ${dimensions}`)
      // Core validates vector values at the provider boundary.
      return vector as readonly number[]
    },
  }
}
