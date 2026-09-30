/** Client-side management commands translated to the Core protocol. */
export type Metadata = {
  name: string
  description: string
}
export type WorkspaceOperation =
  | { type: 'organization.create'; fields: Metadata }
  | {
      type: 'organization.update'
      organizationId: string
      fields: Partial<Metadata>
    }
  /** `organizationId` also adds the new agent there, in the same operation. */
  | { type: 'agent.create'; fields: Metadata; organizationId?: string }
  | { type: 'membership.add'; organizationId: string; agentId: string }
  | { type: 'membership.remove'; organizationId: string; membershipId: string }
  | { type: 'group.create'; organizationId: string; name: string }
  | {
      type: 'group.rename'
      organizationId: string
      groupId: string
      name: string
    }
  | { type: 'group.delete'; organizationId: string; groupId: string }
  | {
      type: 'group.move'
      organizationId: string
      groupId: string
      direction: 'up' | 'down'
    }
  | {
      type: 'appearance.add' | 'appearance.remove'
      organizationId: string
      groupId: string
      membershipId: string
    }
  | {
      type: 'appearance.move'
      organizationId: string
      groupId: string
      membershipId: string
      direction: 'up' | 'down'
    }
export interface CommandScope {
  installationId: string
  callerId: string
}
export interface WorkspaceCommand extends CommandScope {
  commandId: string
  operation: WorkspaceOperation
}
export interface CommandResult extends CommandScope {
  commandId: string
  status: 'acknowledged'
  resourceId?: string
  /** The command ID was recorded earlier; this is the first result, not a new change. */
  alreadyApplied?: boolean
}
export interface WorkspaceManagement {
  execute(
    command: WorkspaceCommand,
    signal: AbortSignal,
  ): Promise<CommandResult>
}
export class CommandError extends Error {
  readonly outcome: 'rejected' | 'unknown'
  readonly code: string
  readonly requestId?: string
  constructor(
    message: string,
    outcome: 'rejected' | 'unknown',
    code: string,
    requestId?: string,
  ) {
    super(message)
    this.outcome = outcome
    this.code = code
    this.requestId = requestId
  }
}
