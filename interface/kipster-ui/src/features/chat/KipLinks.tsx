import { Icon } from '../../components/Icon'
import { Avatar } from './Message'
import { kipName, listNames } from './kip-names'
import type { Thread, WorkspaceData } from './model'

export function KipFace({
  data,
  agentId,
}: {
  data: WorkspaceData
  agentId: string
}) {
  const actor = data.actorsById[agentId]
  return (
    <Avatar
      name={kipName(data, agentId)}
      color={actor?.kind === 'agent' ? actor.color : undefined}
      kip={data.agentRoles.some((role) => role.agentId === agentId)}
    />
  )
}

/** Under a thread's title: where a linked thread comes from, and the kips this thread messaged. */
export function LinkChips({
  thread,
  data,
  openThread,
}: {
  thread: Thread
  data: WorkspaceData
  openThread: (threadId: string) => void
}) {
  const from = thread.linkedFrom
  // The thread a linked thread answers to is already named by its From chip.
  const links = (thread.links ?? []).filter(
    (link) => link.threadId !== from?.threadId,
  )
  if (!from && !links.length) return null
  return (
    <nav className="kip-links" aria-label="Linked threads">
      {from && (
        <button
          className="kip-link-chip"
          onClick={() => openThread(from.threadId)}
        >
          <KipFace data={data} agentId={from.agentId} />
          <span className="kip-link-label">
            From {kipName(data, from.agentId)} · {from.title}
          </span>
          <Icon name="arrowRight" size={12} />
        </button>
      )}
      {links.map((link) => (
        <button
          key={link.threadId}
          className="kip-link-chip"
          onClick={() => openThread(link.threadId)}
        >
          <KipFace data={data} agentId={link.agentId} />
          <span className="kip-link-label">
            Linked: {kipName(data, link.agentId)}’s thread
          </span>
          <Icon name="arrowRight" size={12} />
        </button>
      ))}
    </nav>
  )
}

/** The start of a linked thread: who opened it, and where the answers go. */
export function LinkedBanner({
  thread,
  data,
  recipient,
}: {
  thread: Thread
  data: WorkspaceData
  /** The kip whose chat holds this thread. */
  recipient: string
}) {
  const from = thread.linkedFrom
  if (!from) return null
  return (
    <p className="kip-banner">
      <KipFace data={data} agentId={from.agentId} />
      <span className="kip-banner-text">
        <strong>{kipName(data, from.agentId)}</strong> started this thread from
        “{from.title}”. {recipient}’s answers go back there.
      </span>
    </p>
  )
}

/** The end of a thread whose kip waits for answers and has no turn running. */
export function WaitingLine({
  waitingFor,
  kip,
}: {
  waitingFor: string[]
  kip: string
}) {
  if (!waitingFor.length) return null
  return (
    <p className="kip-waiting">
      <i aria-hidden="true" />
      Waiting for {listNames(waitingFor)}. {kip}’s turn has ended; the answer
      will wake it.
    </p>
  )
}
