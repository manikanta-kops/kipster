export interface EmbeddingProvider {
  readonly id: string
  readonly model: string
  readonly contractMajor: 1
  embed(text: string, signal: AbortSignal): Promise<readonly number[]>
}

export function validateEmbeddingProvider(value: unknown): asserts value is EmbeddingProvider {
  const provider = value as Partial<EmbeddingProvider> | null
  if (!provider || provider.contractMajor !== 1 || typeof provider.id !== 'string' || !provider.id.trim() || typeof provider.model !== 'string' || !provider.model.trim() || typeof provider.embed !== 'function') throw new Error('Invalid embedding provider contract')
}

export function validateEmbeddingVector(value: unknown): asserts value is readonly number[] {
  if (!Array.isArray(value) || !value.length || value.length > 16000 || Array.from(value).some(item => typeof item !== 'number' || !Number.isFinite(item)) || value.every(item => item === 0)) throw new Error('Embedding provider returned an invalid vector')
}

/** EmbeddingGemma 2 search query, as its model card's SearchQuery prompt formats it. */
export function embeddingQuery(text: string): string {
  return `task: search result | query: ${text}`
}

/** EmbeddingGemma 2 document, such as a thread chunk, card or diary page. Without a title the model card uses `none`. */
export function embeddingDocument(text: string, title?: string): string {
  return `title: ${title?.trim() || 'none'} | text: ${text}`
}
