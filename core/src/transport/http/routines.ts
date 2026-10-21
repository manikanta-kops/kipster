import type { Runtime } from '../../runtime.js'
import type { TrustedActor } from '../../modules/identity/public.js'
import { changeRoutine, createRoutine, deleteRoutine, listRoutines, readRoutine, routineRuns, runRoutineNow } from '../../modules/routines/public.js'
import { routineCreate, routineRunStart, routineUpdate } from '../../protocol/routines.js'

const route = /^\/v1\/routines\/([0-9a-f-]{36})(?:\/(runs|run))?$/

/** Trusted-owner routine routes. Returns null when the path is not a routine route. */
export async function routineRoute(runtime: Runtime, actor: TrustedActor, method: string, path: string, query: URLSearchParams, body: () => Promise<unknown>): Promise<unknown> {
  const now = () => runtime.clock()
  if (path === '/v1/routines') {
    if (method === 'GET') return { version: 1, routines: await listRoutines(runtime.db, actor, query.get('agentId') ?? undefined) }
    if (method === 'POST') return { version: 1, routine: await createRoutine(runtime.db, actor, routineCreate.parse(await body()), now()) }
    return null
  }
  const match = route.exec(path)
  if (!match) return null
  const [, id, action] = match as unknown as [string, string, string | undefined]
  if (!action) {
    if (method === 'GET') return { version: 1, routine: await readRoutine(runtime.db, actor, id) }
    if (method === 'PATCH') return { version: 1, routine: await changeRoutine(runtime.db, actor, id, routineUpdate.parse(await body()), now()) }
    if (method === 'DELETE') return { version: 1, routineId: id, deleted: await deleteRoutine(runtime.db, actor, id) }
    return null
  }
  if (action === 'runs' && method === 'GET') {
    const limit = Number(query.get('limit') ?? 50)
    return { version: 1, routineId: id, runs: await routineRuns(runtime.db, actor, id, Number.isSafeInteger(limit) ? limit : 50) }
  }
  if (action === 'run' && method === 'POST') {
    const { operationId } = routineRunStart.parse(await body())
    return { version: 1, routineId: id, run: await runRoutineNow(runtime.db, runtime.jobs, actor, id, operationId, now()) }
  }
  return null
}
