import { readFile } from 'node:fs/promises'
import { Postgres } from './platform/postgres/public.js'
import { Jobs } from './platform/jobs/public.js'
import { Home } from './platform/home/public.js'
import type { Bootstrap } from './modules/identity/public.js'
import { bootstrap, finishPendingCreations, type Starter } from './modules/administration/public.js'
import { LearningService, MemoryService, RelationshipService } from './modules/memory/public.js'
import { ArtifactService } from './modules/artifacts/public.js'
import { StructuredDataService } from './modules/structured/public.js'
import { VectorService } from './modules/vectors/public.js'
import { UpdatesService } from './modules/updates/public.js'
import { validateEmbeddingProvider, type EmbeddingProvider } from './embedding/index.js'
import type { TranscriptionProvider } from './transcription/index.js'
export { startTextServer, type TextServer } from './transport/http/text.js'
export { TextDispatcher, textPublicationHost, type MemoryContextPort, type DispatchHooks } from './workflows/text-dispatch.js'
export type { TranscriptionProvider, TranscriptionResult } from './transcription/index.js'
export { AdapterRegistry } from './workflows/adapter-registry.js'

export async function loadMigrations(): Promise<{ version: string; sql: string }[]> {
  const paths = [
    './platform/postgres/migrations/001_platform.sql',
    './modules/identity/migrations/002_identity.sql',
    './modules/work/migrations/003_work.sql',
    './modules/conversations/migrations/004_conversations.sql',
    './modules/work/migrations/005_work_coordination.sql',
    './modules/synchronization/migrations/006_synchronization.sql',
    './modules/artifacts/migrations/007_artifacts.sql',
    './modules/voice/migrations/008_voice.sql',
    './modules/structured/migrations/009_structured.sql',
    './modules/vectors/migrations/010_vectors.sql',
    './modules/memory/migrations/011_memory.sql',
    './modules/settings/migrations/012_settings.sql',
    './modules/administration/migrations/013_administration.sql',
    './modules/updates/migrations/014_updates.sql',
    './modules/updates/migrations/015_update_pickup.sql',
    './modules/settings/migrations/016_interface_preferences.sql',
    './modules/administration/migrations/017_update_approvals.sql',
    './modules/synchronization/migrations/018_notification_inbox.sql',
    './modules/documents/migrations/019_documents.sql',
    './modules/settings/migrations/020_permission_mode.sql',
    './modules/administration/migrations/021_permission_approvals.sql',
  ]
  return Promise.all(paths.map(async path => ({ version: path.slice(path.lastIndexOf('/') + 1), sql: await readFile(new URL(path, import.meta.url), 'utf8') })))
}

export interface Runtime { db: Postgres; jobs: Jobs; home: Home; bootstrap: Bootstrap; artifacts: ArtifactService; structured?: StructuredDataService; memory?: MemoryService; relationships?: RelationshipService; vectors?: VectorService; transcription?: TranscriptionProvider; learning: LearningService; updates: UpdatesService; clock: () => Date; close(): Promise<void> }
export async function openRuntime(config: { connectionString: string; taskDataConnectionString?: string; home: string; names: { owner: string; organization: string; rootAgent: string }; starter?: Starter; executionLimit?: number; embedding?: EmbeddingProvider; transcription?: TranscriptionProvider; updates?: { channelUrl?: string; coreVersion?: string; managed?: boolean }; onError?: (error: Error) => void | Promise<void>; clock?: () => Date }): Promise<Runtime> {
  if (config.embedding) validateEmbeddingProvider(config.embedding)
  if (config.transcription && config.transcription.contractMajor !== 1) throw new Error('Invalid transcription provider contract')
  // Background failures (idle connection loss, job queue errors) are retried internally; observer failures are ignored.
  const observe = (error: Error): void => { void Promise.resolve().then(() => config.onError?.(error)).catch(() => undefined) }
  const db = new Postgres(config.connectionString, undefined, undefined, observe)
  const jobs = new Jobs(config.connectionString, observe)
  const home = new Home(config.home)
  let structured: StructuredDataService | undefined
  let updates: UpdatesService | undefined
  try {
    await db.migrate(await loadMigrations())
    const ids = await bootstrap(db, home, config.names, config.starter)
    for (const failure of await finishPendingCreations(db, home, ids.installationId)) observe(failure)
    const artifacts = new ArtifactService(db,home)
    await artifacts.initialize()
    if (config.taskDataConnectionString) {
      structured = new StructuredDataService(config.connectionString, config.taskDataConnectionString, observe)
      await structured.initialize()
    }
    const memory = config.embedding ? new MemoryService(db, ids.installationId, config.embedding) : undefined
    await memory?.configure()
    const vectors = memory ? new VectorService(db,ids.installationId,memory) : undefined
    const relationships = memory ? new RelationshipService(db,ids.installationId) : undefined
    if (config.executionLimit !== undefined) {
      if (!Number.isSafeInteger(config.executionLimit) || config.executionLimit < 1 || config.executionLimit > 1000) throw new Error('Invalid execution limit')
      await db.query('INSERT INTO kipster.execution_permits(installation_id,ceiling) VALUES ($1,$2) ON CONFLICT (installation_id) DO UPDATE SET ceiling=EXCLUDED.ceiling', [ids.installationId, config.executionLimit])
    }
    const clock = config.clock ?? (() => new Date())
    const coreVersion = config.updates?.coreVersion ?? (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
    updates = new UpdatesService(db, ids.installationId, home.root, coreVersion, { ...config.updates, clock, onError: observe })
    await updates.initialize()
    const updateService = updates
    await jobs.start()
    memory?.startIndexing()
    vectors?.startIndexing()
    artifacts.startRecovery()
    const learning = new LearningService(db, jobs, ids.installationId, !!memory)
    return { db, jobs, home, bootstrap: ids, artifacts, ...(structured ? {structured} : {}), ...(memory && vectors && relationships ? {memory,vectors,relationships} : {}), ...(config.transcription ? {transcription:config.transcription} : {}), learning, updates: updateService, clock, async close() { try { await updateService.close();await artifacts.stopRecovery();await memory?.stopIndexing();await vectors?.stopIndexing();await config.transcription?.close() } finally { try { await jobs.stop() } finally { await structured?.close(); await db.close() } } } }
  } catch (error) {
    const cleanup: unknown[] = []
    try { await updates?.close() } catch (failure) { cleanup.push(failure) }
    try { await jobs.stop() } catch (failure) { cleanup.push(failure) }
    try { await structured?.close() } catch (failure) { cleanup.push(failure) }
    try { await db.close() } catch (failure) { cleanup.push(failure) }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], 'Runtime startup and cleanup failed', { cause: error })
    throw error
  }
}
