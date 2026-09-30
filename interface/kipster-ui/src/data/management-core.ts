import type { Directory } from './directory.js'
import { check, record } from './response.ts'
import {
  CommandError,
  type CommandResult,
  type WorkspaceCommand,
  type WorkspaceManagement,
  type WorkspaceOperation,
} from './management.js'

export type CoreRequest = {
  method: 'POST' | 'PUT' | 'DELETE'
  path: string
  body: Record<string, unknown>
}

const segment = encodeURIComponent
const rejected = (message: string, code: string) =>
  new CommandError(message, 'rejected', code)

/**
 * Moves one ID a step up or down. At an end the order is sent unchanged: a retry of a move
 * that already applied must still reach Core to receive its recorded result.
 */
function moved(ids: string[], id: string, direction: 'up' | 'down') {
  const index = ids.indexOf(id)
  const other = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || other < 0 || other >= ids.length) return ids
  const next = [...ids]
  ;[next[index], next[other]] = [next[other]!, next[index]!]
  return next
}

/**
 * Translates a management operation into Core's administration route. Orders list every
 * current item, so a move is resolved against the directory as it is now.
 */
export function coreRequest(
  operation: WorkspaceOperation,
  operationId: string,
  directory: Directory | null,
): CoreRequest {
  const base = { version: 1, operationId }
  const describe = (fields: { name?: string; description?: string }) => ({
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.description !== undefined
      ? { description: fields.description }
      : {}),
  })
  switch (operation.type) {
    case 'organization.create':
    case 'agent.create':
    case 'organization.update':
      if ('instructions' in operation.fields && operation.fields.instructions)
        throw rejected(
          'Organization instructions are edited in Settings.',
          'invalid',
        )
  }
  switch (operation.type) {
    case 'organization.create':
      return {
        method: 'POST',
        path: '/v1/organizations',
        body: { ...base, ...describe(operation.fields) },
      }
    case 'organization.update':
      return {
        method: 'PUT',
        path: `/v1/organizations/${segment(operation.organizationId)}`,
        body: { ...base, ...describe(operation.fields) },
      }
    case 'agent.create':
      return {
        method: 'POST',
        path: '/v1/agents',
        body: {
          ...base,
          ...describe(operation.fields),
          ...(operation.organizationId
            ? { organizationId: operation.organizationId }
            : {}),
        },
      }
    case 'membership.add':
      return {
        method: 'POST',
        path: `/v1/organizations/${segment(operation.organizationId)}/memberships`,
        body: { ...base, agentId: operation.agentId },
      }
    case 'membership.remove':
      return {
        method: 'DELETE',
        path: `/v1/memberships/${segment(operation.membershipId)}`,
        body: base,
      }
    case 'group.create':
      return {
        method: 'POST',
        path: `/v1/organizations/${segment(operation.organizationId)}/groups`,
        body: { ...base, name: operation.name },
      }
    case 'group.rename':
      return {
        method: 'PUT',
        path: `/v1/groups/${segment(operation.groupId)}`,
        body: { ...base, name: operation.name },
      }
    case 'group.delete':
      return {
        method: 'DELETE',
        path: `/v1/groups/${segment(operation.groupId)}`,
        body: base,
      }
    case 'group.move': {
      const groupIds = Object.values(directory?.groups ?? {})
        .filter((g) => g.organizationId === operation.organizationId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((g) => g.id)
      return {
        method: 'PUT',
        path: `/v1/organizations/${segment(operation.organizationId)}/groups/order`,
        body: {
          ...base,
          groupIds: moved(groupIds, operation.groupId, operation.direction),
        },
      }
    }
    case 'appearance.add':
      return {
        method: 'POST',
        path: `/v1/groups/${segment(operation.groupId)}/appearances`,
        body: { ...base, membershipId: operation.membershipId },
      }
    case 'appearance.remove':
      return {
        method: 'DELETE',
        path: `/v1/groups/${segment(operation.groupId)}/appearances/${segment(operation.membershipId)}`,
        body: base,
      }
    case 'appearance.move': {
      const membershipIds = (
        directory?.groups[operation.groupId]?.appearances ?? []
      ).map((a) => a.membershipId)
      return {
        method: 'PUT',
        path: `/v1/groups/${segment(operation.groupId)}/appearances/order`,
        body: {
          ...base,
          membershipIds: moved(
            membershipIds,
            operation.membershipId,
            operation.direction,
          ),
        },
      }
    }
  }
}

const resourceId = (value: unknown) => {
  check(record(value) && typeof value.id === 'string')
  return value.id
}

/** Operation confirmations name resources; directory state comes from snapshots and events. */
export function parseCoreResult(
  operation: WorkspaceOperation,
  value: unknown,
): { resourceId: string; alreadyApplied: boolean } {
  try {
    check(record(value) && typeof value.alreadyApplied === 'boolean')
    const alreadyApplied = value.alreadyApplied
    switch (operation.type) {
      case 'organization.create':
      case 'organization.update':
        return { resourceId: resourceId(value.organization), alreadyApplied }
      case 'agent.create':
        return { resourceId: resourceId(value.agent), alreadyApplied }
      case 'membership.add':
        return { resourceId: resourceId(value.membership), alreadyApplied }
      case 'membership.remove':
      case 'group.delete':
        return { resourceId: resourceId(value.removed), alreadyApplied }
      case 'group.move':
        return { resourceId: operation.organizationId, alreadyApplied }
      case 'group.create':
      case 'group.rename':
      case 'appearance.add':
      case 'appearance.remove':
      case 'appearance.move':
        return { resourceId: resourceId(value.group), alreadyApplied }
    }
  } catch {
    throw new CommandError(
      'The confirmation could not be read. Retry to check the outcome; it cannot apply twice.',
      'unknown',
      'invalid-result',
    )
  }
}

const refusals: Record<string, string> = {
  conflict:
    'This changed on another device. Review the latest version and try again.',
  'not-found': 'This no longer exists. It may have been removed elsewhere.',
  forbidden: 'Only the owner can change the workspace.',
  invalid: 'This change was not accepted. Check the details and try again.',
}

/**
 * Management over Core's administration routes. The command ID is Core's operation ID, so
 * sending the same command again after a lost acknowledgement returns the recorded result
 * instead of applying twice. `directory` resolves moves against the current order.
 */
export function createCoreManagement(
  endpoint: string,
  directory: () => Directory | null,
): WorkspaceManagement {
  return {
    async execute(command: WorkspaceCommand, signal): Promise<CommandResult> {
      const request = coreRequest(
        command.operation,
        command.commandId,
        directory(),
      )
      let response: Response
      let body: unknown
      try {
        response = await fetch(endpoint + request.path, {
          method: request.method,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request.body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          cache: 'no-store',
        })
        body = await response.json()
      } catch {
        throw new CommandError(
          'No confirmation arrived, so the outcome is unknown. Retry sends the same request; it cannot apply twice.',
          'unknown',
          'transport',
        )
      }
      if (!response.ok) {
        const code =
          body && typeof body === 'object' && 'code' in body
            ? String(body.code)
            : ''
        const requestId =
          body && typeof body === 'object' && 'requestId' in body
            ? String(body.requestId)
            : undefined
        if (response.status >= 400 && response.status < 500 && refusals[code])
          throw new CommandError(refusals[code], 'rejected', code, requestId)
        throw new CommandError(
          'The server could not confirm the outcome. Retry sends the same request; it cannot apply twice.',
          'unknown',
          code || 'unavailable',
          requestId,
        )
      }
      const { resourceId, alreadyApplied } = parseCoreResult(
        command.operation,
        body,
      )
      return {
        installationId: command.installationId,
        callerId: command.callerId,
        commandId: command.commandId,
        status: 'acknowledged',
        resourceId,
        alreadyApplied,
      }
    },
  }
}
