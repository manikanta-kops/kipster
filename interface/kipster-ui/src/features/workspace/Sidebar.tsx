import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { OrganizationSwitcher } from './OrganizationSwitcher'
import { KipHome } from './KipHome'
import { Icon } from '../../components/Icon'
import { Avatar } from '../chat/Message'
import type { Agent, AgentGroup, Membership } from '../chat/model'
import type { WorkspaceSnapshot } from '../../data/directory'
import { groupHue } from '../../app/appearance'
import type { LiveState } from '../status/live-state'

interface Props {
  id?: string
  utilities: ReactNode
  data: WorkspaceSnapshot
  organizationId: string | null
  selectedAgentId: string | null
  selectedTarget: 'organization' | 'installation'
  collapsed: boolean
  /** Rendered as an overlay drawer on narrow screens. */
  drawer?: boolean
  segment: string
  waiting: ReadonlySet<string>
  /** What Kip, the root admin, is doing across its chat. */
  kipState: LiveState
  /** Agents removed from this organization whose chats stay readable. */
  formerMembers?: Agent[]
  onOrganization: (id: string) => void
  onToggle: () => void
  onAgent: (id: string, target: 'organization' | 'installation') => void
  onSegment: (segment: string) => void
  connectionStatus: 'ready' | 'reconnecting' | 'unavailable' | 'offline'
  reconnect: () => void
}

interface Folder {
  id: string
  name: string
  color: string
  members: Membership[]
  former?: boolean
}

export function Sidebar({
  id,
  utilities,
  data,
  organizationId,
  selectedAgentId,
  selectedTarget,
  collapsed,
  drawer = false,
  segment,
  waiting,
  kipState,
  formerMembers = [],
  onOrganization,
  onToggle,
  onAgent,
  onSegment,
  connectionStatus,
  reconnect,
}: Props) {
  const aside = useRef<HTMLElement>(null)
  const [flyout, setFlyout] = useState<{
    id: string
    anchor: HTMLButtonElement
  } | null>(null)
  const tooltip = useTooltip(aside, collapsed)
  const memberships = data.memberships.filter(
    (m) =>
      m.organizationId === organizationId &&
      data.actorsById[m.actorId]?.kind === 'agent',
  )
  const groups = data.groups.filter(
    (group) => group.organizationId === organizationId,
  )
  const folders: Folder[] = groups.map((group, index) => ({
    id: group.id,
    name: group.name,
    color: groupHue(index),
    members: membersOf(data, group, memberships),
  }))
  const assigned = new Set(
    data.groupAssignments
      .filter((a) => groups.some((g) => g.id === a.groupId))
      .map((a) => a.membershipId),
  )
  const ungrouped = memberships.filter((m) => !assigned.has(m.id))
  if (ungrouped.length)
    folders.push({
      id: '',
      name: 'Ungrouped',
      color: 'var(--label-3)',
      members: ungrouped,
    })
  const former: Folder | undefined = formerMembers.length
    ? {
        id: 'former',
        name: 'Former members',
        color: 'var(--label-3)',
        former: true,
        members: formerMembers.map((agent) => ({
          id: `former:${agent.id}`,
          organizationId: organizationId ?? '',
          actorId: agent.id,
        })),
      }
    : undefined
  const stacks = former ? [...folders, former] : folders
  const duplicateName = (agent: Agent) =>
    memberships.filter((m) => data.actorsById[m.actorId]?.name === agent.name)
      .length > 1
  const isSelected = (agentId: string, admin: boolean) =>
    selectedAgentId === agentId &&
    selectedTarget === (admin ? 'installation' : 'organization')

  function agentButton(agent: Agent, admin = false, formerMember = false) {
    const selected = isSelected(agent.id, admin)
    const duplicate = duplicateName(agent)
    const label = duplicate ? `${agent.name} (${agent.id})` : agent.name
    return (
      <button
        key={agent.id}
        className={`agent-button gloss ${admin ? 'admin-button' : ''} ${formerMember ? 'former' : ''} ${selected ? 'selected' : ''}`}
        aria-label={formerMember ? `${label}, former member` : label}
        aria-current={selected ? 'page' : undefined}
        data-tip={admin ? label : undefined}
        onClick={() => {
          setFlyout(null)
          onAgent(agent.id, admin ? 'installation' : 'organization')
        }}
      >
        <span className="avatar-slot">
          <Avatar name={agent.name} color={agent.color} kip={admin} />
          {waiting.has(agent.id) && (
            <span className="presence wait" aria-hidden="true" />
          )}
        </span>
        <span className="agent-info sidebar-label">
          <span className="agent-name">
            {agent.name}
            {duplicate && <small>{agent.id}</small>}
          </span>
          {formerMember ? (
            <span className="agent-line">Read only</span>
          ) : (
            !admin &&
            agent.description && (
              <span className="agent-line">{agent.description}</span>
            )
          )}
        </span>
      </button>
    )
  }
  const agentsOf = (folder: Folder) =>
    folder.members.map((m) => data.actorsById[m.actorId] as Agent)
  const folderWaits = (folder: Folder) =>
    folder.members.some((m) => waiting.has(m.actorId))
  const activeFolder =
    segment === 'all' ? undefined : folders.find((f) => f.id === segment)
  const openFolder = flyout && stacks.find((f) => f.id === flyout.id)

  return (
    <>
      <aside
        ref={aside}
        id={id}
        className={`sidebar ${drawer ? 'drawer' : ''}`}
        aria-label="Workspace"
      >
        <div className="sidebar-top" data-tauri-drag-region>
          <button
            className="icon-button collapse-button"
            aria-label={
              drawer
                ? 'Close sidebar'
                : collapsed
                  ? 'Expand sidebar'
                  : 'Collapse sidebar'
            }
            aria-expanded={drawer ? true : !collapsed}
            data-tip="Expand sidebar"
            onClick={onToggle}
          >
            <Icon name={drawer ? 'close' : 'panel'} />
          </button>
        </div>
        <nav aria-label="Kips" className="side-list">
          <div className="installation-agents">
            {data.agentRoles.map((role, index) => {
              const agent = data.actorsById[role.agentId] as Agent
              return index === 0 ? (
                <KipHome
                  key={agent.id}
                  agent={agent}
                  state={kipState}
                  selected={isSelected(agent.id, true)}
                  collapsed={collapsed}
                  onOpen={() => {
                    setFlyout(null)
                    onAgent(agent.id, 'installation')
                  }}
                />
              ) : (
                agentButton(agent, true)
              )
            })}
          </div>
          {collapsed ? (
            <div className="stacks">
              {stacks.map((folder) => (
                <GroupStack
                  key={folder.id || 'ungrouped'}
                  folder={
                    folder.former ? { ...folder, name: 'Former' } : folder
                  }
                  agents={agentsOf(folder)}
                  holds={folder.members.some((m) =>
                    isSelected(m.actorId, false),
                  )}
                  waits={folderWaits(folder)}
                  open={flyout?.id === folder.id}
                  onOpen={(anchor) =>
                    setFlyout((current) =>
                      current?.id === folder.id
                        ? null
                        : { id: folder.id, anchor },
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <>
              {groups.length > 0 && (
                <Segments
                  folders={folders.filter((f) => f.id)}
                  segment={activeFolder ? segment : 'all'}
                  waits={folderWaits}
                  onSegment={onSegment}
                />
              )}
              <div
                className="agent-list"
                role={groups.length ? 'tabpanel' : undefined}
                aria-labelledby={
                  groups.length
                    ? `segment-${activeFolder ? segment : 'all'}`
                    : undefined
                }
              >
                {activeFolder ? (
                  activeFolder.members.length ? (
                    agentsOf(activeFolder).map((agent) => agentButton(agent))
                  ) : (
                    <p className="sidebar-empty">No kips in this group.</p>
                  )
                ) : (
                  stacks.map((folder) => (
                    <section
                      className="agent-group"
                      aria-label={folder.name}
                      key={folder.id || 'ungrouped'}
                      style={{ '--fc': folder.color } as CSSProperties}
                    >
                      <h2 className="group-heading">
                        <span className="fdot" aria-hidden="true" />
                        {folder.name}
                      </h2>
                      {folder.members.length ? (
                        agentsOf(folder).map((agent) =>
                          agentButton(agent, false, folder.former),
                        )
                      ) : (
                        <p className="sidebar-empty">No kips in this group.</p>
                      )}
                    </section>
                  ))
                )}
                {!memberships.length && !former && (
                  <p className="sidebar-empty">
                    {organizationId
                      ? 'No kips here yet.'
                      : 'No organization selected.'}
                  </p>
                )}
              </div>
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          {utilities}
          <OrganizationSwitcher
            data={data}
            organizationId={organizationId}
            onOrganization={onOrganization}
          />
          {connectionStatus !== 'ready' && (
            <div
              className={`workspace-connection ${connectionStatus}`}
              data-tip={
                connectionStatus === 'reconnecting'
                  ? 'Refreshing workspace…'
                  : connectionStatus === 'offline'
                    ? 'Offline'
                    : 'Workspace unavailable'
              }
            >
              <span className="connection-indicator" aria-hidden="true" />
              <output className="sidebar-label">
                {connectionStatus === 'reconnecting'
                  ? 'Refreshing workspace…'
                  : connectionStatus === 'offline'
                    ? 'Offline. Showing the last loaded workspace.'
                    : 'Showing the last loaded workspace. Try refreshing.'}
              </output>
              <button
                className="icon-button"
                aria-label="Refresh workspace"
                data-tip="Refresh workspace"
                onClick={reconnect}
                disabled={connectionStatus === 'reconnecting'}
              >
                <Icon name="refresh" size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>
      <AnimatePresence>
        {collapsed && openFolder && flyout && (
          <GroupFlyout
            key={flyout.id}
            folder={openFolder}
            anchor={flyout.anchor}
            onClose={(restoreFocus) => {
              setFlyout(null)
              if (restoreFocus) flyout.anchor.focus()
            }}
          >
            {agentsOf(openFolder).map((agent) =>
              agentButton(agent, false, openFolder.former),
            )}
          </GroupFlyout>
        )}
      </AnimatePresence>
      {tooltip}
    </>
  )
}

function membersOf(
  data: WorkspaceSnapshot,
  group: AgentGroup,
  memberships: Membership[],
) {
  return data.groupAssignments
    .filter((a) => a.groupId === group.id)
    .flatMap((a) => {
      const member = memberships.find((m) => m.id === a.membershipId)
      return member ? [member] : []
    })
}

function Segments({
  folders,
  segment,
  waits,
  onSegment,
}: {
  folders: Folder[]
  segment: string
  waits: (folder: Folder) => boolean
  onSegment: (segment: string) => void
}) {
  const ids = ['all', ...folders.map((f) => f.id)]
  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const index = ids.indexOf(segment)
    const next =
      event.key === 'ArrowRight'
        ? ids[(index + 1) % ids.length]
        : event.key === 'ArrowLeft'
          ? ids[(index - 1 + ids.length) % ids.length]
          : event.key === 'Home'
            ? ids[0]
            : event.key === 'End'
              ? ids[ids.length - 1]
              : null
    if (!next) return
    event.preventDefault()
    onSegment(next)
    requestAnimationFrame(() =>
      document.getElementById(`segment-${next}`)?.focus(),
    )
  }
  const tab = (id: string, label: string, folder?: Folder) => (
    <button
      key={id}
      id={`segment-${id}`}
      role="tab"
      aria-selected={segment === id}
      aria-describedby={
        folder && waits(folder) ? 'segment-wait-note' : undefined
      }
      tabIndex={segment === id ? 0 : -1}
      style={folder ? ({ '--fc': folder.color } as CSSProperties) : undefined}
      onClick={() => onSegment(id)}
      onKeyDown={onKeyDown}
    >
      {folder && <span className="fdot" aria-hidden="true" />}
      {label}
      {folder && waits(folder) && (
        <span className="segment-wait" aria-hidden="true" />
      )}
    </button>
  )
  return (
    <div className="segments sidebar-label" role="tablist" aria-label="Groups">
      {tab('all', 'All')}
      {folders.map((folder) => tab(folder.id, folder.name, folder))}
      <span id="segment-wait-note" hidden>
        A kip in this group needs you
      </span>
    </div>
  )
}

function GroupStack({
  folder,
  agents,
  holds,
  waits,
  open,
  onOpen,
}: {
  folder: Folder
  agents: Agent[]
  holds: boolean
  waits: boolean
  open: boolean
  onOpen: (anchor: HTMLButtonElement) => void
}) {
  const pile = Array.from(new Map(agents.map((a) => [a.id, a])).values())
  return (
    <button
      className={`group-stack ${holds ? 'holds' : ''}`}
      style={{ '--fc': folder.color } as CSSProperties}
      aria-label={`${folder.name}, ${agents.length} ${agents.length === 1 ? 'kip' : 'kips'}${waits ? ', needs you' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-stack={folder.id || 'ungrouped'}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className="stack-pile" aria-hidden="true">
        {pile.slice(0, 3).map((agent, index) => (
          <span key={agent.id} style={{ '--i': index } as CSSProperties}>
            <Avatar name={agent.name} color={agent.color} />
          </span>
        ))}
        {!pile.length && <Icon name="folder" />}
      </span>
      <span className="stack-label" aria-hidden="true">
        {folder.name}
      </span>
      {waits && <span className="stack-wait" aria-hidden="true" />}
    </button>
  )
}

function GroupFlyout({
  folder,
  anchor,
  onClose,
  children,
}: {
  folder: Folder
  anchor: HTMLButtonElement
  onClose: (restoreFocus: boolean) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const reduceMotion = useReducedMotion()
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useLayoutEffect(() => {
    const place = () => {
      const box = anchor.getBoundingClientRect()
      const height = ref.current?.offsetHeight ?? 0
      setPosition({
        left: box.right + 12,
        top: Math.max(
          12,
          Math.min(window.innerHeight - height - 12, box.top - 8),
        ),
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor])
  useEffect(() => {
    const panel = ref.current
    const target =
      panel?.querySelector<HTMLElement>('[aria-current="page"]') ??
      panel?.querySelector<HTMLElement>('button')
    target?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target as Node
      if (!panel?.contains(node) && !anchor.contains(node)) close.current(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [anchor])
  function onKeyDown(event: ReactKeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close.current(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('button') ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
            items.length
    event.preventDefault()
    items[next]?.focus()
  }
  return createPortal(
    <motion.dialog
      ref={ref}
      open
      aria-label={`${folder.name} kips`}
      className="flyout mat thick lifted"
      style={{ ...position, '--fc': folder.color } as CSSProperties}
      initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96 }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next && !ref.current?.contains(next) && !anchor.contains(next))
          close.current(false)
      }}
    >
      <h2>
        <span className="fdot" aria-hidden="true" />
        {folder.name}
      </h2>
      <div className="flyout-list">{children}</div>
    </motion.dialog>,
    document.body,
  )
}

/** Styled labels for icon-only controls while the sidebar is collapsed. */
function useTooltip(scope: RefObject<HTMLElement | null>, enabled: boolean) {
  const [tip, setTip] = useState<{
    text: string
    left: number
    top: number
  } | null>(null)
  useEffect(() => {
    const root = scope.current
    if (!root || !enabled) return
    const show = (event: Event) => {
      const element = (event.target as Element).closest?.<HTMLElement>(
        '[data-tip]',
      )
      if (!element || !root.contains(element)) return setTip(null)
      const box = element.getBoundingClientRect()
      setTip({
        text: element.dataset.tip ?? '',
        left: box.right + 10,
        top: box.top + box.height / 2,
      })
    }
    const hide = () => setTip(null)
    root.addEventListener('pointerover', show)
    root.addEventListener('focusin', show)
    root.addEventListener('pointerleave', hide)
    root.addEventListener('focusout', hide)
    root.addEventListener('click', hide)
    return () => {
      setTip(null)
      root.removeEventListener('pointerover', show)
      root.removeEventListener('focusin', show)
      root.removeEventListener('pointerleave', hide)
      root.removeEventListener('focusout', hide)
      root.removeEventListener('click', hide)
    }
  }, [scope, enabled])
  return enabled && tip
    ? createPortal(
        <div
          className="tip mat thick"
          aria-hidden="true"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.text}
        </div>,
        document.body,
      )
    : null
}
