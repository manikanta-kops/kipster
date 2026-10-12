import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import { validateEmbeddingProvider, validateEmbeddingVector, type EmbeddingProvider } from '../../embedding/index.js'

export interface StoredEmbeddingProfile { provider: string; model: string }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
export const sameProfile = (a: StoredEmbeddingProfile, b: StoredEmbeddingProfile) => a.provider === b.provider && a.model === b.model
export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`
}
export async function boundedEmbed(embedder: EmbeddingProvider, text: string, timeoutMs: number): Promise<readonly number[]> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const values = await Promise.race([
      embedder.embed(text, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Embedding provider timed out')) }, timeoutMs) }),
    ])
    validateEmbeddingVector(values)
    return values
  } finally { if (timer) clearTimeout(timer) }
}

/** The installation's embedding profile. Vector collections are indexed with it; a changed provider or model starts a
 * new generation and queues every vector record for re-embedding. */
export class EmbeddingProfile {
  private profile: StoredEmbeddingProfile
  private embedder: EmbeddingProvider
  private readonly rebuilt = new Set<() => void>()
  constructor(readonly db: Postgres, readonly installationId: string, provider: EmbeddingProvider) {
    validateEmbeddingProvider(provider)
    this.profile = { provider: provider.id, model: provider.model }
    this.embedder = provider
  }
  embeddingConfig(): { profile: StoredEmbeddingProfile; embedder: EmbeddingProvider } {
    return { profile: { ...this.profile }, embedder: this.embedder }
  }
  /** Calls `listener` after each activated rebuild. */
  onRebuild(listener: () => void): void { this.rebuilt.add(listener) }
  private async rebuild(client: SqlClient, generation: number, target: StoredEmbeddingProfile): Promise<number> {
    await client.query('INSERT INTO kipster.embedding_generations(installation_id,generation,provider,model) VALUES ($1,$2,$3,$4)', [this.installationId, generation, target.provider, target.model])
    const vectors = await client.query(`INSERT INTO kipster.vector_index_intents(record_id,source_revision,source_hash,generation,provider,model,status)
      SELECT r.id,r.revision,r.source_hash,$2,$3,$4,'pending' FROM kipster.vector_records r
      JOIN kipster.vector_collections c ON c.id=r.collection_id WHERE c.installation_id=$1`, [this.installationId, generation, target.provider, target.model])
    await client.query('UPDATE kipster.embedding_profiles SET provider=$2,model=$3,generation=$4,dimension=NULL WHERE installation_id=$1', [this.installationId, target.provider, target.model, generation])
    return vectors.rowCount ?? 0
  }
  async configure(): Promise<void> {
    const change = await this.db.transaction(async client => {
      const prior = (await client.query<StoredEmbeddingProfile & { generation: string }>('SELECT provider,model,generation FROM kipster.embedding_profiles WHERE installation_id=$1 FOR UPDATE', [this.installationId])).rows[0]
      if (prior && !sameProfile(prior, this.profile)) {
        const count = await this.rebuild(client, Number(prior.generation) + 1, this.profile)
        return { prior, count }
      }
      if (!prior) {
        await client.query('INSERT INTO kipster.embedding_profiles(installation_id,provider,model) VALUES ($1,$2,$3)', [this.installationId, this.profile.provider, this.profile.model])
        await client.query('INSERT INTO kipster.embedding_generations(installation_id,generation,provider,model) VALUES ($1,1,$2,$3)', [this.installationId, this.profile.provider, this.profile.model])
      }
      return undefined
    })
    if (change) console.log(`Embedding profile ${JSON.stringify([change.prior.provider, change.prior.model])} -> ${JSON.stringify([this.profile.provider, this.profile.model])}: queued ${change.count} records for re-embedding`)
  }
  async activateRebuild(actorId: string, expectedGeneration: number, next: EmbeddingProvider): Promise<number> {
    if (!validId(actorId) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error('Invalid embedding rebuild request')
    validateEmbeddingProvider(next)
    const target = { provider: next.id, model: next.model }
    const generation = await this.db.transaction(async client => {
      const owner = await client.query('SELECT 1 FROM kipster.bootstrap WHERE installation_id=$1 AND owner_id=$2', [this.installationId, actorId])
      if (!owner.rows.length) throw new Error('Embedding rebuild denied')
      const prior = (await client.query<StoredEmbeddingProfile & { generation: string }>('SELECT provider,model,generation FROM kipster.embedding_profiles WHERE installation_id=$1 FOR UPDATE', [this.installationId])).rows[0]
      if (!prior || Number(prior.generation) !== expectedGeneration || !sameProfile(prior, this.profile)) throw new Error('Embedding profile generation conflict')
      if (sameProfile(prior, target)) throw new Error('Embedding profile is unchanged')
      await this.rebuild(client, expectedGeneration + 1, target)
      return expectedGeneration + 1
    })
    this.profile = target
    this.embedder = next
    for (const listener of this.rebuilt) listener()
    return generation
  }
}
