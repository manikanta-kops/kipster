import { createStore } from 'zustand/vanilla'
import type { WorkspaceSnapshot } from '../../data/directory'

export interface Navigation {
  organizationId: string | null
  agentId: string | null
  target: 'organization' | 'installation'
  collapsed: boolean
  /** Sidebar filter: `all`, or a group id in the selected organization. */
  segment: string
}
export const defaultNavigation: Navigation = {
  organizationId: null,
  agentId: null,
  target: 'organization',
  collapsed: false,
  segment: 'all',
}
export function parseNavigation(value: unknown): Navigation {
  if (!value || typeof value !== 'object') return { ...defaultNavigation }
  const v = value as Partial<Navigation>
  return {
    organizationId:
      typeof v.organizationId === 'string' ? v.organizationId : null,
    agentId: typeof v.agentId === 'string' ? v.agentId : null,
    target: v.target === 'installation' ? 'installation' : 'organization',
    collapsed: v.collapsed === true,
    segment: typeof v.segment === 'string' ? v.segment : 'all',
  }
}
export function resolveNavigation(
  data: WorkspaceSnapshot,
  nav: Navigation,
): Navigation {
  const organizationId = data.organizations.some(
    (o) => o.id === nav.organizationId,
  )
    ? nav.organizationId
    : (data.organizations[0]?.id ?? null)
  const root =
    nav.target === 'installation' &&
    data.agentRoles.some((r) => r.agentId === nav.agentId)
  const members = data.memberships.filter(
    (m) =>
      m.organizationId === organizationId &&
      data.actorsById[m.actorId]?.kind === 'agent',
  )
  const agentId = root
    ? nav.agentId
    : (members.find((m) => m.actorId === nav.agentId)?.actorId ??
      members[0]?.actorId ??
      null)
  return {
    ...nav,
    organizationId,
    agentId,
    target: root ? 'installation' : 'organization',
    segment: data.groups.some(
      (g) => g.id === nav.segment && g.organizationId === organizationId,
    )
      ? nav.segment
      : 'all',
  }
}
export const createNavigationStore = (initial: Navigation) =>
  createStore<Navigation>(() => initial)
