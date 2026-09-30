/** Organization home rule. A memory learned in an organization conversation surfaces only in that organization;
 * deliberate saves, explicit requests and memories learned outside organizations surface everywhere. */
export function homeSql(alias: string, organizationParam: string): string {
  return `(${alias}.home_organization_id IS NULL OR ${alias}.home_organization_id=${organizationParam}::uuid)`
}

/** Memory rows aliased `alias` that an execution of `agentParam` in organization `organizationParam` (NULL outside
 * organizations) may see: the agent's own memories under the home rule and the organization's published memories. */
export function visibleSql(alias: string, agentParam: string, organizationParam: string): string {
  return `((${alias}.scope='agent' AND ${alias}.owner_id=${agentParam}::uuid AND ${homeSql(alias, organizationParam)}) OR (${alias}.scope='organization' AND ${alias}.owner_id=${organizationParam}::uuid))`
}
