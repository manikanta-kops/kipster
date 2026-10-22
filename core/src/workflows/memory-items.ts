import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Postgres, SqlClient } from '../platform/postgres/public.js'
import type { IdentityFiles } from '../platform/home/public.js'
import { claimOperation, completeOperation, operationKey, type Operation } from '../modules/administration/public.js'
import { authorizeAdministration, type AdminAuthority, type AdminCaller } from '../modules/identity/public.js'
import { LessonService, MemoryService, rebuildLearned, type Lesson, type Memory, type MemoryEdit } from '../modules/memory/public.js'

/** The memory or lesson was replaced or ended; only a current one can be edited. Mapped to 409 `conflict`. */
export class MemoryEndedError extends Error {
  constructor(kind: 'Memory' | 'Lesson') { super(`${kind} was replaced or ended; only a current one can be edited`) }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const checkId = (id: string, kind: 'Memory' | 'Lesson'): string => {
  if (!uuid.test(id)) throw new Error(`${kind} not found`)
  return id
}

export interface PageRequest { ended?: boolean | undefined; limit?: number | undefined; cursor?: string | null | undefined }

async function read<T>(db: Postgres, actor: AdminCaller, work: (client: SqlClient) => Promise<T>): Promise<T> {
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    return work(client)
  })
}

/**
 * The memories of every organization and the installation, for the owner or the admin agent. Memories come newest
 * first, current ones only unless `ended`; `cursor` is the `nextCursor` of the previous page.
 */
export async function listMemories(db: Postgres, actor: AdminCaller, request: PageRequest = {}): Promise<{ memories: Memory[]; nextCursor: string | null }> {
  if (request.cursor && !uuid.test(request.cursor)) throw new Error('Invalid memory cursor')
  return read(db, actor, client => new MemoryService(db, actor.installationId).list({ scope: 'all', ended: request.ended === true, ...(request.limit !== undefined ? { limit: request.limit } : {}), cursor: request.cursor ?? null }, client))
}

export async function readMemory(db: Postgres, actor: AdminCaller, id: string): Promise<Memory> {
  checkId(id, 'Memory')
  return read(db, actor, async client => {
    const found = await new MemoryService(db, actor.installationId).get(id, client)
    if (!found) throw new Error('Memory not found')
    return found
  })
}

/** Lessons of one kip, or of every kip, newest first, current ones only unless `ended`. */
export async function listLessons(db: Postgres, actor: AdminCaller, request: PageRequest & { agentId?: string | null | undefined } = {}): Promise<{ lessons: Lesson[]; nextCursor: string | null }> {
  if (request.cursor && !uuid.test(request.cursor)) throw new Error('Invalid lesson cursor')
  if (request.agentId && !uuid.test(request.agentId)) throw new Error('Agent not found')
  return read(db, actor, client => new LessonService(db, actor.installationId).list({ agentId: request.agentId ?? null, ended: request.ended === true, ...(request.limit !== undefined ? { limit: request.limit } : {}), cursor: request.cursor ?? null }, client))
}

export async function readLesson(db: Postgres, actor: AdminCaller, id: string): Promise<Lesson> {
  checkId(id, 'Lesson')
  return read(db, actor, async client => {
    const found = await new LessonService(db, actor.installationId).get(id, client)
    if (!found) throw new Error('Lesson not found')
    return found
  })
}

/** JSON with sorted keys, so the same edit always has the same digest. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)

type Kind = 'memory.update' | 'memory.delete' | 'lesson.update' | 'lesson.delete'
/**
 * Claims the caller's operation ID for a memory or lesson action in the caller's transaction, or returns the operation
 * already recorded under it. The receipt keeps the item's ID and a digest of the request, never its text, so a deleted
 * item leaves no copy of what it said.
 */
async function claim(client: SqlClient, actor: AdminCaller, authority: AdminAuthority, operationId: string | undefined, kind: Kind, id: string, request: Record<string, unknown>): Promise<{ operation: Operation; claimed: boolean } | null> {
  if (operationId === undefined) return null
  return claimOperation(client, operationKey(actor, authority, operationId), kind, { kind: kind.startsWith('memory') ? 'memory' : 'lesson', id }, { digest: createHash('sha256').update(canonical(request)).digest('hex') })
}

/**
 * Changes the type, subject, statement or details of a current memory and marks it confirmed: the person, or the admin
 * kip for them, stated it. Changed content is embedded again by the next nightly run. Saving the memory's current
 * values changes nothing. With an `operationId`, a repeat of the same edit changes nothing again and returns the memory
 * as it is now.
 */
export async function editMemory(db: Postgres, actor: AdminCaller, id: string, edit: Omit<MemoryEdit, 'confirmed'>, operationId?: string): Promise<{ memory: Memory; alreadyApplied: boolean }> {
  checkId(id, 'Memory')
  const fields = Object.fromEntries((['type', 'subject', 'statement', 'details'] as const).flatMap(key => edit[key] === undefined ? [] : [[key, edit[key]]])) as Omit<MemoryEdit, 'confirmed'>
  if (!Object.keys(fields).length) throw new Error('Invalid memory edit: nothing to change')
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const service = new MemoryService(db, actor.installationId)
    const receipt = await claim(client, actor, authority, operationId, 'memory.update', id, fields)
    const found = await service.get(id, client)
    if (!found) throw new Error('Memory not found')
    if (receipt && !receipt.claimed) return { memory: found, alreadyApplied: true }
    if (found.validTo) throw new MemoryEndedError('Memory')
    const same = found.confirmed && (fields.type === undefined || fields.type.trim().toLowerCase() === found.type)
      && (fields.subject === undefined || fields.subject.trim() === found.subject) && (fields.statement === undefined || fields.statement.trim() === found.statement)
      && (fields.details === undefined || isDeepStrictEqual(fields.details, found.details))
    if (!same && !await service.update(id, { ...fields, confirmed: true }, [], client)) {
      if (await service.get(id, client)) throw new MemoryEndedError('Memory')
      throw new Error('Memory not found')
    }
    if (receipt) await completeOperation(client, receipt.operation.id, { memoryId: id })
    return { memory: same ? found : (await service.get(id, client))!, alreadyApplied: false }
  })
}

/**
 * Deletes a memory with its sources and embedding; the messages it was learned from stay. A memory it replaced keeps its
 * end. With an `operationId`, a repeat returns the first outcome.
 */
export async function deleteMemory(db: Postgres, actor: AdminCaller, id: string, operationId?: string): Promise<{ memoryId: string; deleted: boolean; alreadyApplied: boolean }> {
  checkId(id, 'Memory')
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const receipt = await claim(client, actor, authority, operationId, 'memory.delete', id, {})
    if (receipt && !receipt.claimed) return { ...receipt.operation.result as { memoryId: string; deleted: boolean }, alreadyApplied: true }
    const result = { memoryId: id, deleted: await new MemoryService(db, actor.installationId).delete([id], client) > 0 }
    if (receipt) await completeOperation(client, receipt.operation.id, result)
    return { ...result, alreadyApplied: false }
  })
}

/**
 * Rewords a current lesson. Its confirmations stay; it is embedded again by the next nightly run. The kip's Learned
 * section is written again right after. With an `operationId`, a repeat changes nothing again and returns the lesson as
 * it is now.
 */
export async function editLesson(db: Postgres, identity: IdentityFiles, actor: AdminCaller, id: string, statement: string, operationId?: string): Promise<{ lesson: Lesson; alreadyApplied: boolean }> {
  checkId(id, 'Lesson')
  const result = await db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const service = new LessonService(db, actor.installationId)
    const receipt = await claim(client, actor, authority, operationId, 'lesson.update', id, { statement })
    const found = await service.get(id, client)
    if (!found) throw new Error('Lesson not found')
    if (receipt && !receipt.claimed) return { lesson: found, alreadyApplied: true }
    if (found.validTo) throw new MemoryEndedError('Lesson')
    if (statement.trim() !== found.statement && !await service.edit(id, statement, client)) throw new MemoryEndedError('Lesson')
    if (receipt) await completeOperation(client, receipt.operation.id, { lessonId: id })
    return { lesson: (await service.get(id, client))!, alreadyApplied: false }
  })
  if (!result.alreadyApplied) await rebuildLearned(db, identity, actor.installationId, result.lesson.agentId).catch(() => undefined)
  return result
}

/**
 * Deletes a lesson with its sources and embedding; the messages it was learned from stay. The kip's Learned section is
 * written again right after. With an `operationId`, a repeat returns the first outcome.
 */
export async function deleteLesson(db: Postgres, identity: IdentityFiles, actor: AdminCaller, id: string, operationId?: string): Promise<{ lessonId: string; deleted: boolean; alreadyApplied: boolean }> {
  checkId(id, 'Lesson')
  const result = await db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const receipt = await claim(client, actor, authority, operationId, 'lesson.delete', id, {})
    if (receipt && !receipt.claimed) return { ...receipt.operation.result as { lessonId: string; deleted: boolean }, alreadyApplied: true, agents: [] as string[] }
    const agents = await new LessonService(db, actor.installationId).delete([id], client)
    const outcome = { lessonId: id, deleted: agents.length > 0 }
    if (receipt) await completeOperation(client, receipt.operation.id, outcome)
    return { ...outcome, alreadyApplied: false, agents }
  })
  for (const agentId of result.agents) await rebuildLearned(db, identity, actor.installationId, agentId).catch(() => undefined)
  const { agents: _, ...answer } = result
  return answer
}
