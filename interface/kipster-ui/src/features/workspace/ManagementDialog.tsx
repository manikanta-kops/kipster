import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '../../components/Icon'
import { groupHue, isAgentHue } from '../../app/appearance'
import type { useManagement } from '../../data/use-management'
import type { Metadata, WorkspaceOperation } from '../../data/management'
import type { WorkspaceSnapshot } from '../../data/directory'
import type { Agent } from '../chat/model'

/** Plain words for what removing a member does to its chat. */
const removalText = (agent: string, organization: string) =>
  `Remove ${agent} from ${organization}? The chat with ${agent} stays readable under Former members, but no new messages can be sent there until ${agent} is added again. ${agent} also leaves this organization’s groups. Work that was already accepted may still finish.`

function actorColor(data: WorkspaceSnapshot, id: string) {
  const actor = data.actorsById[id]
  return actor?.kind === 'agent' ? actor.color : undefined
}
function AgentMark({ name, color }: { name: string; color?: string }) {
  return (
    <span
      className={`avatar ${isAgentHue(color) ? color : 'iris'}`}
      aria-hidden="true"
    >
      {name.charAt(0)}
    </span>
  )
}

function AgentIdentity({
  name,
  id,
  color,
  children,
}: {
  name: string
  id: string
  color?: string
  children?: React.ReactNode
}) {
  return (
    <div className="management-identity">
      <AgentMark name={name} color={color} />
      <div>
        <strong>{name}</strong>
        {id && <small>{id.slice(0, 8)}</small>}
        {children}
      </div>
    </div>
  )
}

type Manager = ReturnType<typeof useManagement>
type FormKind =
  | 'organization-create'
  | 'organization-edit'
  | 'agent-create'
  | 'group-create'
  | null
export function ManagementDialog({
  data,
  organizationId,
  agents,
  management: m,
  onClose,
}: {
  data: WorkspaceSnapshot
  organizationId: string | null
  agents: Agent[]
  management: Manager
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState('organization')
  const [form, setForm] = useState<FormKind>(null)
  const [fields, setFields] = useState<Metadata>({
    name: '',
    description: '',
  })
  const [original, setOriginal] = useState<Metadata>(fields)
  const [addMembership, setAddMembership] = useState(!!organizationId)
  const [confirmation, setConfirmation] = useState<{
    operation: WorkspaceOperation
    title: string
    text: string
  } | null>(null)
  const [rename, setRename] = useState<{ id: string; name: string } | null>(
    null,
  )
  const [search, setSearch] = useState('')
  const organization = data.organizations.find((o) => o.id === organizationId)
  const members = data.memberships.filter(
    (member) =>
      member.organizationId === organizationId &&
      data.actorsById[member.actorId]?.kind === 'agent',
  )
  const groups = data.groups.filter((g) => g.organizationId === organizationId)
  const blocked = !m.ready || m.busy || !!m.pending || !m.available
  const everyone = agents
  const matches = everyone?.filter((a) =>
    `${a.name} ${a.id}`.toLowerCase().includes(search.toLowerCase()),
  )
  const unaffiliated = everyone?.filter(
    (agent) => !data.memberships.some((member) => member.actorId === agent.id),
  )
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current
    element?.showModal()
    element?.focus()
    return () => {
      element?.close()
      previous?.focus()
    }
  }, [])
  function openForm(kind: FormKind) {
    const value =
      kind === 'organization-edit' && organization
        ? {
            name: organization.name,
            description: organization.description ?? '',
          }
        : { name: '', description: '' }
    setFields(value)
    setOriginal(value)
    setForm(kind)
  }
  async function saveForm() {
    let operation: WorkspaceOperation
    if (form === 'organization-create')
      operation = { type: 'organization.create', fields }
    else if (form === 'agent-create')
      operation = {
        type: 'agent.create',
        fields,
        ...(addMembership && organizationId ? { organizationId } : {}),
      }
    else if (form === 'group-create' && organizationId)
      operation = { type: 'group.create', organizationId, name: fields.name }
    else if (form === 'organization-edit' && organizationId)
      operation = {
        type: 'organization.update',
        organizationId,
        fields: Object.fromEntries(
          Object.entries(fields).filter(
            ([key, value]) => value !== original[key as keyof Metadata],
          ),
        ),
      }
    else return
    const acknowledged = await m.submit(
      operation,
      form === 'agent-create'
        ? 'Kip'
        : form === 'group-create'
          ? 'Group'
          : 'Organization',
    )
    if (acknowledged) setForm(null)
  }
  const distinguish = (id: string) => {
    const known = new Map(
      [...Object.values(data.actorsById), ...(everyone ?? [])].map((actor) => [
        actor.id,
        actor,
      ]),
    )
    const actor = known.get(id)
    return [...known.values()].filter((other) => other.name === actor?.name)
      .length > 1
      ? id
      : ''
  }
  const command = (operation: WorkspaceOperation, label: string) => {
    void m.submit(operation, label)
  }
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="management-dialog"
      aria-labelledby="management-title"
      onCancel={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation()
        if (event.key === 'Tab') {
          const controls = Array.from(
            dialog.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ),
          ).filter((el) => el.getClientRects().length)
          event.preventDefault()
          const current = controls.indexOf(
            document.activeElement as HTMLElement,
          )
          const next =
            current < 0
              ? event.shiftKey
                ? controls.length - 1
                : 0
              : (current + (event.shiftKey ? -1 : 1) + controls.length) %
                controls.length
          ;(controls[next] ?? dialog.current)?.focus()
        }
      }}
    >
      <div className="management-shell">
        <header className="management-header">
          <span className="admin-glyph" aria-hidden="true">
            <Icon name="organization" weight="fill" />
          </span>
          <div className="management-heading">
            <p className="management-eyebrow">Workspace</p>
            <h2 id="management-title">
              {organization?.name ?? 'Installation'}
            </h2>
            <small>{organization?.name ?? 'Your workspace'}</small>
          </div>
          <button
            className="icon-button"
            aria-label="Close management"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <fieldset className="management-tabs" aria-label="Management sections">
          {['organization', 'agents', 'groups'].map((value) => (
            <button
              key={value}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value)
                setForm(null)
                setConfirmation(null)
                setRename(null)
              }}
            >
              {value === 'organization'
                ? 'Organization'
                : value === 'agents'
                  ? 'Kips'
                  : 'Groups'}
            </button>
          ))}
        </fieldset>
        <div className="management-body">
          {!m.available && (
            <output className="management-callout">
              Workspace management is unavailable on this connection. A Core
              management integration has not been configured.
            </output>
          )}
          {m.error && (
            <p role="alert" className="management-alert">
              {m.error}
            </p>
          )}
          {m.notice && (
            <output className="management-notice">
              <Icon name="check" />
              {m.notice}
            </output>
          )}
          {m.pending && (
            <section
              className="management-recovery"
              aria-label="Request recovery"
              data-state={m.busy ? 'busy' : m.pending.state}
            >
              <strong>
                {m.busy
                  ? 'Waiting for acknowledgement…'
                  : m.pending.state === 'rejected'
                    ? 'Request rejected'
                    : 'Outcome unresolved'}
              </strong>
              <p>{m.pending.message}</p>
              <small>Request {m.pending.command.commandId}</small>
              {'organizationId' in m.pending.command.operation && (
                <small>
                  Target organization:{' '}
                  {m.pending.command.operation.organizationId}
                </small>
              )}
              <div className="management-actions">
                {m.pending.state === 'unknown' && (
                  <button
                    className="secondary-button"
                    disabled={m.busy}
                    onClick={() => void m.check()}
                  >
                    Retry
                  </button>
                )}
                {m.pending.state === 'rejected' && (
                  <button
                    className="secondary-button"
                    disabled={m.busy}
                    onClick={() => void m.dismissRejected()}
                  >
                    Return to editing
                  </button>
                )}
              </div>
            </section>
          )}
          {confirmation ? (
            <section className="management-confirm" aria-live="polite">
              <h3>{confirmation.title}</h3>
              <p>{confirmation.text}</p>
              <div className="management-actions">
                <button
                  className="secondary-button"
                  onClick={() => setConfirmation(null)}
                >
                  Back
                </button>
                <button
                  className="primary-button danger"
                  disabled={blocked}
                  onClick={async () => {
                    if (
                      await m.submit(confirmation.operation, confirmation.title)
                    )
                      setConfirmation(null)
                  }}
                >
                  Confirm {confirmation.title.toLowerCase()}
                </button>
              </div>
            </section>
          ) : form ? (
            <form
              className="management-form"
              onSubmit={(event) => {
                event.preventDefault()
                void saveForm()
              }}
            >
              <h3>
                {form === 'organization-create'
                  ? 'Create organization'
                  : form === 'organization-edit'
                    ? 'Edit organization'
                    : form === 'agent-create'
                      ? 'Create a new global kip'
                      : 'Create visual group'}
              </h3>
              {form === 'agent-create' && (
                <p className="management-help">
                  One identity and one continuous brain across organizations. A
                  name is enough to begin.
                </p>
              )}
              <label>
                Name
                <input
                  autoFocus
                  required
                  maxLength={200}
                  disabled={m.busy || !!m.pending}
                  value={fields.name}
                  onChange={(e) =>
                    setFields({ ...fields, name: e.target.value })
                  }
                />
              </label>
              {form !== 'group-create' && (
                <>
                  <label>
                    Description <span>Optional</span>
                    <textarea
                      rows={2}
                      maxLength={2000}
                      disabled={m.busy || !!m.pending}
                      value={fields.description}
                      onChange={(e) =>
                        setFields({ ...fields, description: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {form === 'agent-create' && organization && (
                <label className="management-checkbox">
                  <input
                    type="checkbox"
                    disabled={m.busy || !!m.pending}
                    checked={addMembership}
                    onChange={(e) => setAddMembership(e.target.checked)}
                  />
                  Add to {organization.name}
                </label>
              )}
              {(form === 'agent-create' || form === 'organization-create') && (
                <p className="management-help">
                  Choose the adapter, model and instructions in Settings.
                </p>
              )}
              <div className="management-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setForm(null)}
                >
                  Back
                </button>
                <button
                  className="primary-button"
                  disabled={blocked || !fields.name.trim()}
                >
                  {m.busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : tab === 'organization' ? (
            <>
              <div className="management-section-heading">
                <h3>Shared context</h3>
                {organization && (
                  <button
                    className="secondary-button"
                    disabled={blocked}
                    onClick={() => openForm('organization-edit')}
                  >
                    Edit organization
                  </button>
                )}
              </div>
              {organization ? (
                <>
                  <p>
                    {organization.description ||
                      'Add a description to explain what this organization is for.'}
                  </p>
                  <h4>Organization instructions</h4>
                  <p className="management-help">
                    Organization instructions are edited in Settings.
                  </p>
                </>
              ) : (
                <p>
                  No organization selected. Create one to begin organizing your
                  agents.
                </p>
              )}
              <div className="management-divider" />
              <button
                className="secondary-button"
                disabled={blocked}
                onClick={() => openForm('organization-create')}
              >
                <Icon name="organization" />
                Create organization
              </button>
            </>
          ) : tab === 'agents' ? (
            <>
              <div className="management-section-heading">
                <div>
                  <h3>Kips in this organization</h3>
                  <p>Membership connects a global identity.</p>
                </div>
                <button
                  className="secondary-button"
                  disabled={blocked}
                  onClick={() => openForm('agent-create')}
                >
                  <Icon name="plus" />
                  Create new kip
                </button>
              </div>
              {!members.length && (
                <p className="management-help">No kip memberships here yet.</p>
              )}
              {members.length > 0 && (
                <div className="management-list">
                  {members.map((member) => (
                    <div className="management-row" key={member.id}>
                      <AgentIdentity
                        name={data.actorsById[member.actorId].name}
                        id={distinguish(member.actorId)}
                        color={actorColor(data, member.actorId)}
                      />
                      <button
                        className="text-button danger"
                        disabled={blocked}
                        onClick={() =>
                          setConfirmation({
                            operation: {
                              type: 'membership.remove',
                              organizationId: organizationId!,
                              membershipId: member.id,
                            },
                            title: 'Remove membership',
                            text: removalText(
                              data.actorsById[member.actorId].name,
                              organization?.name ?? '',
                            ),
                          })
                        }
                      >
                        Remove membership
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {!!unaffiliated?.length && (
                <>
                  <div className="management-divider" />
                  <h3>Not in any organization</h3>
                  <p className="management-help">
                    These kips keep their memory and chats. Add one to an
                    organization below.
                  </p>
                  <ul
                    className="management-list"
                    aria-label="Kips not in any organization"
                  >
                    {unaffiliated.map((agent) => (
                      <li className="management-row" key={agent.id}>
                        <AgentIdentity
                          name={agent.name}
                          id={distinguish(agent.id)}
                          color={agent.color}
                        >
                          {agent.description && <p>{agent.description}</p>}
                        </AgentIdentity>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="management-divider" />
              <h3>Add an existing kip</h3>
              <p className="management-help">
                Use the same identity and brain. IDs distinguish kips with the
                same name.
              </p>
              <label>
                Find a global kip
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name or stable ID"
                />
              </label>
              {!!matches?.length && (
                <div className="management-list">
                  {matches.map((agent) => {
                    const enrolled = members.some(
                      (member) => member.actorId === agent.id,
                    )
                    const contexts = data.memberships
                      .filter((member) => member.actorId === agent.id)
                      .map(
                        (member) =>
                          data.organizations.find(
                            (o) => o.id === member.organizationId,
                          )?.name,
                      )
                      .filter(Boolean)
                    return (
                      <div className="management-row" key={agent.id}>
                        <AgentIdentity
                          name={agent.name}
                          id={distinguish(agent.id)}
                          color={agent.color}
                        >
                          {agent.description && <p>{agent.description}</p>}
                          <small>
                            {contexts.join(' · ') ||
                              'No organization memberships'}
                          </small>
                        </AgentIdentity>
                        <button
                          className="secondary-button"
                          aria-label={`Add ${agent.name}${distinguish(agent.id) ? ` (${agent.id.slice(0, 8)})` : ''}`}
                          disabled={blocked || enrolled || !organization}
                          onClick={() =>
                            command(
                              {
                                type: 'membership.add',
                                organizationId: organizationId!,
                                agentId: agent.id,
                              },
                              'Membership',
                            )
                          }
                        >
                          {enrolled ? 'Already added' : 'Add existing'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {matches && !matches.length && (
                <p className="management-help">No kips match this search.</p>
              )}
            </>
          ) : (
            <>
              <div className="management-section-heading">
                <div>
                  <h3>Groups</h3>
                  <p>
                    Organize kips into groups. A kip can be in more than one
                    group.
                  </p>
                </div>
                <button
                  className="secondary-button"
                  disabled={blocked || !organization}
                  onClick={() => openForm('group-create')}
                >
                  <Icon name="folder" />
                  Create group
                </button>
              </div>
              {!groups.length && (
                <p className="management-help">
                  No visual groups yet. Members appear ungrouped.
                </p>
              )}
              {groups.map((group, index) => {
                const appearances = data.groupAssignments.filter(
                  (a) => a.groupId === group.id,
                )
                return (
                  <section
                    className="management-group"
                    aria-label={`Manage ${group.name}`}
                    key={group.id}
                    style={{ '--fc': groupHue(index) } as CSSProperties}
                  >
                    <div className="management-group-heading">
                      <h4>
                        <Icon name="folder" weight="fill" />
                        {group.name}
                      </h4>
                      <div className="order-actions">
                        <button
                          className="icon-button"
                          aria-label={`Move ${group.name} up`}
                          disabled={blocked || index === 0}
                          onClick={() =>
                            command(
                              {
                                type: 'group.move',
                                organizationId: organizationId!,
                                groupId: group.id,
                                direction: 'up',
                              },
                              'Group order',
                            )
                          }
                        >
                          <Icon name="arrow" size={14} />
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Move ${group.name} down`}
                          disabled={blocked || index === groups.length - 1}
                          onClick={() =>
                            command(
                              {
                                type: 'group.move',
                                organizationId: organizationId!,
                                groupId: group.id,
                                direction: 'down',
                              },
                              'Group order',
                            )
                          }
                        >
                          <Icon
                            name="arrow"
                            size={14}
                            style={{ transform: 'rotate(180deg)' }}
                          />
                        </button>
                        <button
                          className="text-button"
                          disabled={blocked}
                          onClick={() =>
                            setRename({ id: group.id, name: group.name })
                          }
                        >
                          Rename
                        </button>
                        <button
                          className="text-button danger"
                          disabled={blocked}
                          onClick={() =>
                            setConfirmation({
                              operation: {
                                type: 'group.delete',
                                organizationId: organizationId!,
                                groupId: group.id,
                              },
                              title: 'Delete group',
                              text: `Delete ${group.name}? Kips and their conversations stay. Kips in no other group move to Ungrouped.`,
                            })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    {rename?.id === group.id && (
                      <form
                        className="rename-form"
                        onSubmit={async (e) => {
                          e.preventDefault()
                          if (
                            await m.submit(
                              {
                                type: 'group.rename',
                                organizationId: organizationId!,
                                groupId: group.id,
                                name: rename.name,
                              },
                              'Group name',
                            )
                          )
                            setRename(null)
                        }}
                      >
                        <label>
                          Group name
                          <input
                            autoFocus
                            required
                            maxLength={200}
                            value={rename.name}
                            onChange={(e) =>
                              setRename({ ...rename, name: e.target.value })
                            }
                          />
                        </label>
                        <button
                          className="secondary-button"
                          disabled={blocked || !rename.name.trim()}
                        >
                          Save name
                        </button>
                      </form>
                    )}
                    {appearances.map((appearance, position) => {
                      const member = members.find(
                        (member) => member.id === appearance.membershipId,
                      )
                      if (!member) return null
                      const agent = data.actorsById[member.actorId]
                      return (
                        <div className="management-row" key={member.id}>
                          <AgentIdentity
                            name={agent.name}
                            id={distinguish(agent.id)}
                            color={actorColor(data, agent.id)}
                          />
                          <div className="order-actions">
                            <button
                              className="icon-button"
                              aria-label={`Move ${agent.name} up in ${group.name}`}
                              disabled={blocked || position === 0}
                              onClick={() =>
                                command(
                                  {
                                    type: 'appearance.move',
                                    organizationId: organizationId!,
                                    groupId: group.id,
                                    membershipId: member.id,
                                    direction: 'up',
                                  },
                                  'Appearance order',
                                )
                              }
                            >
                              <Icon name="arrow" size={14} />
                            </button>
                            <button
                              className="icon-button"
                              aria-label={`Move ${agent.name} down in ${group.name}`}
                              disabled={
                                blocked || position === appearances.length - 1
                              }
                              onClick={() =>
                                command(
                                  {
                                    type: 'appearance.move',
                                    organizationId: organizationId!,
                                    groupId: group.id,
                                    membershipId: member.id,
                                    direction: 'down',
                                  },
                                  'Appearance order',
                                )
                              }
                            >
                              <Icon
                                name="arrow"
                                size={14}
                                style={{ transform: 'rotate(180deg)' }}
                              />
                            </button>
                            <button
                              className="text-button danger"
                              disabled={blocked}
                              onClick={() =>
                                command(
                                  {
                                    type: 'appearance.remove',
                                    organizationId: organizationId!,
                                    groupId: group.id,
                                    membershipId: member.id,
                                  },
                                  'Appearance removal',
                                )
                              }
                            >
                              Remove from group
                            </button>
                          </div>
                        </div>
                      )
                    })}
                    <label className="management-add">
                      Add kip to group
                      <select
                        aria-label={`Add kip to ${group.name}`}
                        value=""
                        disabled={blocked}
                        onChange={(e) => {
                          if (e.target.value)
                            command(
                              {
                                type: 'appearance.add',
                                organizationId: organizationId!,
                                groupId: group.id,
                                membershipId: e.target.value,
                              },
                              'Appearance',
                            )
                        }}
                      >
                        <option value="">Choose a member…</option>
                        {members
                          .filter(
                            (member) =>
                              !appearances.some(
                                (a) => a.membershipId === member.id,
                              ),
                          )
                          .map((member) => (
                            <option key={member.id} value={member.id}>
                              {data.actorsById[member.actorId].name} (
                              {member.actorId})
                            </option>
                          ))}
                      </select>
                    </label>
                  </section>
                )
              })}
            </>
          )}
        </div>
        <footer className="management-footer">
          Changes target the organization shown above.
        </footer>
      </div>
    </dialog>
  )
}
