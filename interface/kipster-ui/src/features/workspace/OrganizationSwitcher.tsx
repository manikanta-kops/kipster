import { Icon } from '../../components/Icon'
import type { WorkspaceSnapshot } from '../../data/directory'

export function OrganizationSwitcher({
  data,
  organizationId,
  elsewhere = false,
  onOrganization,
}: {
  data: WorkspaceSnapshot
  organizationId: string | null
  /** Another organization has something that needs the person. */
  elsewhere?: boolean
  onOrganization: (id: string) => void
}) {
  const organization = data.organizations.find(
    (org) => org.id === organizationId,
  )
  return (
    <div
      className="profile-picker"
      data-tip={organization?.name ?? 'No organization'}
    >
      <Icon name="organization" className="organization-icon" />
      <div className="profile-context sidebar-label">
        <strong>{organization?.name ?? 'No organization'}</strong>
      </div>
      {elsewhere && (
        <span className="elsewhere-mark" aria-hidden="true">
          <span id="organization-elsewhere" hidden>
            Another organization needs you
          </span>
        </span>
      )}
      <Icon name="chevron" className="profile-caret sidebar-label" />
      <select
        aria-label="Organization"
        aria-describedby={elsewhere ? 'organization-elsewhere' : undefined}
        value={organizationId ?? ''}
        onChange={(event) => onOrganization(event.target.value)}
        disabled={!data.organizations.length}
      >
        {!data.organizations.length && (
          <option value="">No organizations</option>
        )}
        {data.organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
            {data.organizations.filter((o) => o.name === org.name).length > 1
              ? ` (${org.id})`
              : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
