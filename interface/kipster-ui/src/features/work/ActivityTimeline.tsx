import type { WorkRecords, WorkState } from '../../data/work'
import { workLabels } from '../../data/work'
import { formatTime, type WorkspaceData } from '../chat/model'
import { Avatar } from '../chat/Message'
import { Icon } from '../../components/Icon'

/** Groups work states by how a step reads at a glance. */
function tone(state: WorkState) {
  if (state === 'completed') return 'done'
  if (state === 'running' || state === 'preparing') return 'active'
  if (['waiting', 'held', 'cancellation-requested', 'queued'].includes(state))
    return 'paused'
  if (state === 'failed' || state === 'recovery-needed') return 'failed'
  return 'idle'
}

export function ActivityTimeline({
  work,
  threadId,
  data,
}: {
  work: WorkRecords
  threadId: string
  data: WorkspaceData
}) {
  const entries = work.activity
    .filter((a) => a.target.threadId === threadId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  const delegations = work.delegations.filter(
    (a) => a.target.threadId === threadId,
  )
  if (!entries.length && !delegations.length) return null
  const name = (id: string) => data.actorsById[id]?.name ?? 'Kip'
  const color = (id: string) => {
    const actor = data.actorsById[id]
    return actor?.kind === 'agent' ? actor.color : undefined
  }
  const current = work.workflows.find((w) => w.target.threadId === threadId)
  const running = current ? tone(current.state) === 'active' : false
  const finished = current?.state === 'completed'
  const updates = entries.length + delegations.length
  /**
   * Entries keep the state they were logged with. Only the newest entry of
   * running work is still in progress; earlier progress entries are history.
   */
  const entryTone = (state: WorkState, newest: boolean) => {
    const logged = tone(state)
    if (logged !== 'active') return logged
    return newest && running ? 'active' : 'done'
  }
  return (
    <details className="work-activity" open>
      <summary>
        {(running || finished) && (
          <span
            className={`work-ring ${running ? 'running' : ''}`}
            aria-hidden="true"
          />
        )}
        <span className="work-activity-title">Work so far</span>
        <span className="work-activity-sum">
          {updates} {updates === 1 ? 'update' : 'updates'}
        </span>
        <Icon name="chevron" size={14} className="work-activity-chevron" />
      </summary>
      <ol>
        {entries.map((a, index) => {
          const stepTone = entryTone(a.state, index === entries.length - 1)
          return (
            <li key={a.id} className={`work-step ${stepTone}`}>
              <span className="step-dot" aria-hidden="true">
                {stepTone === 'done' && <Icon name="check" weight="bold" />}
              </span>
              <div>
                <span>{a.text}</span>
                <small>
                  {name(a.actorId)}
                  {stepTone === tone(a.state) &&
                    ` · ${workLabels[a.state] ?? a.state}`}
                </small>
              </div>
              <time dateTime={a.createdAt}>{formatTime(a.createdAt)}</time>
            </li>
          )
        })}
        {delegations.map((d) => (
          <li
            className={`work-step delegation-summary ${tone(d.state)}`}
            key={d.id}
          >
            <span className="step-dot" aria-hidden="true">
              {d.state === 'completed' && <Icon name="check" weight="bold" />}
            </span>
            <div>
              <span className="handoff">
                <Avatar name={name(d.toAgentId)} color={color(d.toAgentId)} />
                {name(d.fromAgentId)} is consulting {name(d.toAgentId)}
              </span>
              <small>{workLabels[d.state] ?? d.state}</small>
            </div>
            {d.createdAt && (
              <time dateTime={d.createdAt}>{formatTime(d.createdAt)}</time>
            )}
          </li>
        ))}
      </ol>
    </details>
  )
}
