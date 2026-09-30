import type { CallerScope } from './conversations.js'
import type { WorkTarget } from './work.js'
export interface InboxNotification {
  id: string
  revision: number
  recipientId: string
  target: WorkTarget
  resourceId: string
  kind: string
  title: string
  /** Where it happened, when the caller already knows its name. */
  context?: string
  /** The current state of its question or approval. */
  detail?: string
  createdAt: string
  read: boolean
}
export interface ReadOperation {
  operationId: string
  target: CallerScope
  action: 'read'
  notificationId: string
}
export type ControlOperation = ReadOperation
export type ControlReceipt =
  | { operationId: string; status: 'unknown' }
  | {
      operationId: string
      target: CallerScope
      operation: ControlOperation
      status: 'accepted' | 'rejected'
      message: string
    }
export interface ControlClient {
  command(
    operation: ControlOperation,
    signal: AbortSignal,
  ): Promise<ControlReceipt>
  receipt(
    operation: ControlOperation,
    signal: AbortSignal,
  ): Promise<ControlReceipt>
}
export function sameScope(a: CallerScope, b: CallerScope) {
  return a?.installationId === b.installationId && a?.callerId === b.callerId
}
/** Semantic identity is independent of JSON property order. */
export function sameControlIdentity(
  a: ControlOperation | undefined,
  b: ControlOperation,
) {
  if (
    !a ||
    a.operationId !== b.operationId ||
    !sameScope(a.target, b.target) ||
    a.action !== b.action
  )
    return false
  return a.notificationId === b.notificationId
}
