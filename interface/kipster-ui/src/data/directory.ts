import type {
  DirectoryAgent as CoreAgent,
  DirectoryGroup,
  DirectoryMembership,
  DirectoryOrganization as CoreOrganization,
} from '@kipster/core/protocol'
import { check, list, record } from './response.ts'
export type {
  DirectoryGroup,
  DirectoryMembership,
} from '@kipster/core/protocol'
import type { Agent } from '../features/chat/model.js'
import type { Summary } from './text.js'
import type { WorkspaceData } from '../features/chat/model.js'

export type DirectoryOrganization = Omit<CoreOrganization, 'lifecycle'> & {
  lifecycle: string
}
export type DirectoryAgent = Omit<CoreAgent, 'lifecycle'> & {
  lifecycle: string
}
/** The owner's directory, keyed by ID, as of `cursor` plus every event applied since. */
export type Directory = {
  cursor: string
  organizations: Record<string, DirectoryOrganization>
  agents: Record<string, DirectoryAgent>
  memberships: Record<string, DirectoryMembership>
  groups: Record<string, DirectoryGroup>
}
export type DirectoryEvent =
  | { type: 'organization-changed'; data: DirectoryOrganization }
  | { type: 'agent-changed'; data: DirectoryAgent }
  | { type: 'membership-changed'; data: DirectoryMembership }
  | { type: 'group-changed'; data: DirectoryGroup }
  | { type: 'organization-removed'; data: { id: string } }
  | {
      type: 'membership-removed'
      data: { id: string; organizationId: string; agentId: string }
    }
  | { type: 'group-removed'; data: { id: string; organizationId: string } }
export type DirectoryEventType = DirectoryEvent['type']
export const directoryEventTypes: ReadonlySet<string> =
  new Set<DirectoryEventType>([
    'organization-changed',
    'agent-changed',
    'membership-changed',
    'group-changed',
    'organization-removed',
    'membership-removed',
    'group-removed',
  ])

export function parseOrganization(value: unknown): DirectoryOrganization {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.description === 'string' &&
      typeof value.lifecycle === 'string' &&
      typeof value.revision === 'number' &&
      typeof value.createdAt === 'string',
  )
  return value as DirectoryOrganization
}
export function parseAgent(value: unknown): DirectoryAgent {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.name === 'string' &&
      typeof value.description === 'string' &&
      typeof value.lifecycle === 'string' &&
      typeof value.admin === 'boolean' &&
      typeof value.revision === 'number',
  )
  return value as DirectoryAgent
}
export function parseMembership(value: unknown): DirectoryMembership {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.organizationId === 'string' &&
      typeof value.agentId === 'string' &&
      typeof value.revision === 'number' &&
      typeof value.createdAt === 'string',
  )
  return value as DirectoryMembership
}
export function parseGroup(value: unknown): DirectoryGroup {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.organizationId === 'string' &&
      typeof value.name === 'string' &&
      typeof value.position === 'number' &&
      typeof value.revision === 'number',
  )
  return {
    ...value,
    appearances: list(value.appearances, (appearance) => {
      check(record(appearance) && typeof appearance.membershipId === 'string')
      return appearance as DirectoryGroup['appearances'][number]
    }),
  } as DirectoryGroup
}
function keyed<T extends { id: string }>(
  value: unknown,
  parse: (item: unknown) => T,
): Record<string, T> {
  return Object.fromEntries(list(value, parse).map((item) => [item.id, item]))
}

/** Reads the fields used by navigation; versions and additional fields pass through. */
export function parseDirectory(value: unknown): Directory {
  check(record(value) && typeof value.cursor === 'string')
  return {
    cursor: value.cursor,
    organizations: keyed(value.organizations, parseOrganization),
    agents: keyed(value.agents, parseAgent),
    memberships: keyed(value.memberships, parseMembership),
    groups: keyed(value.groups, parseGroup),
  }
}

export function parseDirectoryEvent(
  type: DirectoryEventType,
  data: unknown,
): DirectoryEvent {
  switch (type) {
    case 'organization-changed':
      return { type, data: parseOrganization(data) }
    case 'agent-changed':
      return { type, data: parseAgent(data) }
    case 'membership-changed':
      return { type, data: parseMembership(data) }
    case 'group-changed':
      return { type, data: parseGroup(data) }
    case 'organization-removed':
    case 'membership-removed':
    case 'group-removed':
      check(record(data) && typeof data.id === 'string')
      return { type, data } as DirectoryEvent
  }
}

function newer<T extends { id: string; revision: number }>(
  items: Record<string, T>,
  incoming: T,
): Record<string, T> {
  const held = items[incoming.id]
  return held && held.revision > incoming.revision
    ? items
    : { ...items, [incoming.id]: incoming }
}
function without<T>(
  items: Record<string, T>,
  drop: (item: T) => boolean,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(items).filter(([, item]) => !drop(item)),
  )
}
/** Drops the memberships and groups of an organization that is no longer active. */
function dropChildren(directory: Directory, organizationId: string): Directory {
  return {
    ...directory,
    memberships: without(
      directory.memberships,
      (m) => m.organizationId === organizationId,
    ),
    groups: without(
      directory.groups,
      (g) => g.organizationId === organizationId,
    ),
  }
}

/**
 * Applies one application-stream event. A record replaces the one held unless the held
 * revision is newer; a removal always applies, because IDs are never reused. Operation
 * results are receipts and are never merged here.
 */
export function applyDirectoryEvent(
  directory: Directory,
  event: DirectoryEvent,
  cursor: string,
): Directory {
  const next = { ...directory, cursor }
  switch (event.type) {
    case 'organization-changed': {
      const organizations = newer(next.organizations, event.data)
      if (organizations === next.organizations) return next
      const updated = { ...next, organizations }
      return event.data.lifecycle === 'active'
        ? updated
        : dropChildren(updated, event.data.id)
    }
    case 'agent-changed':
      return { ...next, agents: newer(next.agents, event.data) }
    case 'membership-changed':
      return { ...next, memberships: newer(next.memberships, event.data) }
    case 'group-changed':
      return { ...next, groups: newer(next.groups, event.data) }
    case 'organization-removed':
      return dropChildren(
        {
          ...next,
          organizations: without(
            next.organizations,
            (o) => o.id === event.data.id,
          ),
        },
        event.data.id,
      )
    case 'membership-removed':
      return {
        ...next,
        memberships: without(next.memberships, (m) => m.id === event.data.id),
        groups: Object.fromEntries(
          Object.entries(next.groups).map(([key, group]) => [
            key,
            group.appearances.some((a) => a.membershipId === event.data.id)
              ? {
                  ...group,
                  appearances: group.appearances.filter(
                    (a) => a.membershipId !== event.data.id,
                  ),
                }
              : group,
          ]),
        ),
      }
    case 'group-removed':
      return {
        ...next,
        groups: without(next.groups, (g) => g.id === event.data.id),
      }
  }
}

/** A direct chat is identified by its context and agent. */
export type ChatTarget =
  | { kind: 'installation'; installationId: string; agentId: string }
  | { kind: 'organization'; organizationId: string; agentId: string }
export const chatKey = (target: ChatTarget) =>
  JSON.stringify([
    target.kind,
    target.kind === 'installation'
      ? target.installationId
      : target.organizationId,
    target.agentId,
  ])
export const summaryKey = (summary: Summary) =>
  JSON.stringify([summary.contextKind, summary.contextId, summary.agentId])

/**
 * A chat is gone once its agent is being deleted, or its organization leaves `active` or the
 * directory. Core publishes nothing further for it, so its threads and notifications are dropped.
 */
export function chatGone(directory: Directory, summary: Summary): boolean {
  const agent = directory.agents[summary.agentId]
  if (
    agent &&
    (agent.lifecycle === 'deleting' || agent.lifecycle === 'deleted')
  )
    return true
  return (
    summary.contextKind === 'organization' &&
    directory.organizations[summary.contextId]?.lifecycle !== 'active'
  )
}

/** How history names an agent; a deleted agent keeps its last name. */
export function agentLabel(directory: Directory | null, agentId: string) {
  const agent = directory?.agents[agentId]
  if (!agent) return 'Unknown kip'
  return agent.lifecycle === 'deleted' ? `${agent.name} · deleted` : agent.name
}

const activeOrganizations = (directory: Directory) =>
  Object.values(directory.organizations)
    .filter((o) => o.lifecycle === 'active')
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
/** Organization navigation lists active, non-admin agents; the admin chat is installation-wide. */
const navigable = (directory: Directory, agentId: string) => {
  const agent = directory.agents[agentId]
  return !!agent && agent.lifecycle === 'active' && !agent.admin
}

/**
 * Organization chats, known from thread summaries, whose agent has no membership in that
 * active organization. They are read-only and return to the members when the agent is added
 * again. Archived agents are left for the Archive; a deleted agent keeps its last name.
 */
export function formerMemberChats(
  directory: Directory,
  summaries: Record<string, Summary>,
) {
  const members = new Set(
    Object.values(directory.memberships).map((m) =>
      JSON.stringify([m.organizationId, m.agentId]),
    ),
  )
  const chats = new Map<
    string,
    { organizationId: string; agentId: string; chatId: string }
  >()
  for (const s of Object.values(summaries)) {
    const agent = directory.agents[s.agentId]
    if (
      s.contextKind !== 'organization' ||
      directory.organizations[s.contextId]?.lifecycle !== 'active' ||
      members.has(JSON.stringify([s.contextId, s.agentId])) ||
      !agent ||
      agent.admin ||
      !['active', 'deleted'].includes(agent.lifecycle)
    )
      continue
    chats.set(s.chatId, {
      organizationId: s.contextId,
      agentId: s.agentId,
      chatId: s.chatId,
    })
  }
  return [...chats.values()]
}

/** The navigation projection the sidebar renders. */
export function workspaceView(
  directory: Directory,
  installationId: string,
  callerId: string,
  color: (agentId: string) => string,
): WorkspaceSnapshot {
  const organizations = activeOrganizations(directory)
  const listed = new Set(organizations.map((o) => o.id))
  const memberships = Object.values(directory.memberships)
    .filter(
      (m) => listed.has(m.organizationId) && navigable(directory, m.agentId),
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  const shown = new Set(memberships.map((m) => m.id))
  const groups = Object.values(directory.groups)
    .filter((g) => listed.has(g.organizationId))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  const agents: Agent[] = Object.values(directory.agents).map((agent) => ({
    id: agent.id,
    kind: 'agent',
    name: agentLabel(directory, agent.id),
    description: agent.description,
    color: color(agent.id),
  }))
  return {
    installationId,
    currentHumanId: callerId,
    actorsById: Object.fromEntries([
      [callerId, { id: callerId, kind: 'human', name: 'You' }],
      ...agents.map((agent) => [agent.id, agent]),
    ]),
    agentRoles: Object.values(directory.agents)
      .filter((agent) => agent.admin && agent.lifecycle === 'active')
      .map((agent) => ({ agentId: agent.id, role: 'root-admin' as const })),
    organizations: organizations.map(({ id, name, description }) => ({
      id,
      name,
      description,
    })),
    memberships: memberships.map((m) => ({
      id: m.id,
      organizationId: m.organizationId,
      actorId: m.agentId,
    })),
    groups: groups.map(({ id, organizationId, name }) => ({
      id,
      organizationId,
      name,
    })),
    groupAssignments: groups.flatMap((g) =>
      g.appearances
        .filter((a) => shown.has(a.membershipId))
        .map((a) => ({ groupId: g.id, membershipId: a.membershipId })),
    ),
  }
}

/** The part of the saved navigation that names the open chat. */
export type Selection = {
  organizationId: string | null
  agentId: string | null
  target: 'organization' | 'installation'
  segment: string
}
/**
 * Resolves a saved selection against the current directory. An organization that is no longer
 * listed falls back to the first one; an agent no longer listed there, to the first member; and
 * an organization without members, to the admin chat.
 */
export function resolveSelection<T extends Selection>(
  view: WorkspaceSnapshot,
  former: { organizationId: string; agentId: string }[],
  saved: T,
): T {
  const organizationId = view.organizations.some(
    (o) => o.id === saved.organizationId,
  )
    ? saved.organizationId
    : (view.organizations[0]?.id ?? null)
  const members = view.memberships
    .filter((m) => m.organizationId === organizationId)
    .map((m) => m.actorId)
  const listed =
    saved.target === 'organization' &&
    (members.includes(saved.agentId ?? '') ||
      former.some(
        (f) =>
          f.organizationId === organizationId && f.agentId === saved.agentId,
      ))
  const agentId =
    saved.target === 'organization'
      ? listed
        ? saved.agentId
        : (members[0] ?? null)
      : null
  return {
    ...saved,
    organizationId,
    agentId: agentId ?? view.agentRoles[0]?.agentId ?? null,
    target: agentId ? 'organization' : 'installation',
    segment: view.groups.some(
      (g) => g.id === saved.segment && g.organizationId === organizationId,
    )
      ? saved.segment
      : 'all',
  }
}

/** UI-side discovery projection. This is not a published Core wire contract. */
export type WorkspaceSnapshot = Pick<
  WorkspaceData,
  | 'installationId'
  | 'currentHumanId'
  | 'actorsById'
  | 'agentRoles'
  | 'organizations'
  | 'memberships'
  | 'groups'
  | 'groupAssignments'
>
