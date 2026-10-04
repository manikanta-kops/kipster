import type { CoreSettingsClient } from '../../data/core-settings'

/** One query per kip and organization, shared by the kip list and the kip page. */
export const effectiveQuery = (
  client: CoreSettingsClient,
  agentId: string,
  organizationId: string | null,
) => ({
  queryKey: ['core-effective', client.endpoint, agentId, organizationId],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    client.effective(agentId, organizationId, signal),
  retry: false,
})
export const readiness = (status: string) =>
  status === 'ready' ? 'run' : status === 'incompatible' ? 'danger' : 'wait'
