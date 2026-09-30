/**
 * Refusal codes that clients act on. `gone`: the thread, chat or notification no longer exists, or its
 * agent or organization is being deleted. `organization-deleted`: new work in an organization that is
 * being deleted. `membership-removed`: new work for an agent that is not a member of the organization.
 * `agent-archived`: new work for an archived agent.
 */
export type RefusalCode = 'gone' | 'organization-deleted' | 'membership-removed' | 'agent-archived'

/** A refusal reported with a stable protocol code. */
export class RefusedError extends Error {
  constructor(readonly code: RefusalCode, message: string) {
    super(message)
    this.name = 'RefusedError'
  }
}
