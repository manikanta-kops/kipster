import type { EmbeddingProvider } from '@kipster/core/embedding'

export function createEmbeddingProvider(options: unknown): EmbeddingProvider {
  const value = options as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint !== 'string') throw new Error('Invalid embedding endpoint')
  let endpoint: URL
  try { endpoint = new URL(value.endpoint) } catch { throw new Error('Invalid embedding endpoint') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid embedding endpoint')
  if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('Invalid embedding model')
  const model = value.model
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.apiKeyEnv))) throw new Error('Invalid embedding API key environment variable')
  const token = typeof value.apiKeyEnv === 'string' ? process.env[value.apiKeyEnv] : undefined
  if (value.apiKeyEnv && !token) throw new Error('Embedding API key is unavailable')
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/api/embed'
  return {
    id: 'ollama', model, contractMajor: 1,
    async embed(text, signal) {
      const response = await fetch(endpoint, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model, input: text, truncate: false }),
      })
      if (!response.ok) throw new Error(`Embedding provider HTTP ${response.status}`)
      const body = await response.json() as { embeddings?: number[][] }
      // Core validates vector shape and values at the provider boundary.
      return body.embeddings?.[0] as readonly number[]
    },
  }
}
