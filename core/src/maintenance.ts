import { Postgres } from './platform/postgres/public.js'
import { MaintenanceService } from './modules/memory/public.js'
import type { MaintenanceSourceStatus } from './modules/memory/public.js'

/** Shipped operator access for default-disabled maintenance. Importing this
 * module opens nothing; every function takes a connection string and closes
 * its own short-lived client. Only the running coordinator executes intents.
 * Pass `installationId` when the database holds more than one installation. */
export interface OperatorTarget { connectionString: string; installationId?: string }

async function serviceFor(target: OperatorTarget): Promise<{ db: Postgres; service: MaintenanceService }> {
  const db = new Postgres(target.connectionString)
  try {
    const ids = (await db.query<{ installation_id: string }>(
      'SELECT installation_id FROM kipster.bootstrap ORDER BY installation_id')).rows.map(row => row.installation_id)
    if (!ids.length) throw new Error('Installation is not bootstrapped')
    const installationId = target.installationId ?? (ids.length === 1 ? ids[0]! : undefined)
    if (!installationId) throw new Error('Multiple installations: pass installationId')
    if (!ids.includes(installationId)) throw new Error('Installation not found')
    return { db, service: new MaintenanceService(db, installationId) }
  } catch (error) {
    await db.close()
    throw error
  }
}

/** Side-effect-free source inspection: manifest refs, runs and claims. No message text. */
export async function inspect(options: OperatorTarget & { sourceRunId: string; sourceRevision?: number }): Promise<unknown> {
  const { db, service } = await serviceFor(options)
  try {
    return await service.inspectSource(options.sourceRunId, options.sourceRevision)
  } finally {
    await db.close()
  }
}

/** Side-effect-free bounded source listing. */
export async function list(options: OperatorTarget & { status?: MaintenanceSourceStatus; limit?: number }): Promise<unknown> {
  const { db, service } = await serviceFor(options)
  try {
    return await service.listSources(options.status, options.limit)
  } finally {
    await db.close()
  }
}

/** Side-effect-free run inspection. Staged output appears only as a candidate count and digest. */
export async function inspectRun(options: OperatorTarget & { runId: string }): Promise<unknown> {
  const { db, service } = await serviceFor(options)
  try {
    return await service.inspectRun(options.runId)
  } finally {
    await db.close()
  }
}

/** Side-effect-free pipeline status: source/run/intent counts, scheduler, latest background failure and counter. */
export async function status(options: OperatorTarget): Promise<unknown> {
  const { db, service } = await serviceFor(options)
  try {
    return await service.maintenanceStatus()
  } finally {
    await db.close()
  }
}

/** Append an idempotent action intent. The only write this entry performs. */
export async function requestAction(options: OperatorTarget & {
  opId: string
  action: 'skip-source' | 'requeue-source' | 'cancel' | 'reconcile'
  target: { sourceRunId?: string; sourceRevision?: number; runId?: string }
  reason?: string
}): Promise<unknown> {
  const { db, service } = await serviceFor(options)
  try {
    return await service.requestAction(options.opId, options.action, options.target, options.reason)
  } finally {
    await db.close()
  }
}
