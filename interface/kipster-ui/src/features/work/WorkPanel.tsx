import { useState } from 'react'
import type {
  AvailableAction,
  Interaction,
  WorkRecords,
  WorkAction,
  WorkOperation,
} from '../../data/work'
import type { WorkspaceData } from '../chat/model'
import { answerText } from './answer-text'
import { InteractionCard } from './InteractionCard'
import { Avatar } from '../chat/Message'
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause'
import type { useWorkCommands } from './use-work-commands'
export type WorkCommands = ReturnType<typeof useWorkCommands>
const labels: Record<WorkAction, string> = {
  stop: 'Stop work',
  resume: 'Resume follow-ups',
  retry: 'Retry work',
  'cancel-queued': 'Cancel queued item',
  steer: 'Steer current attempt',
  respond: 'Respond',
}

/** Why an action is or is not available, announced with its button and shown as its tooltip. */
function ActionReasons({
  id,
  actions,
}: {
  id: string
  actions: AvailableAction[]
}) {
  return actions
    .filter((a) => a.reason)
    .map((a) => (
      <span id={`${id}-${a.action}-reason`} className="sr-only" key={a.action}>
        {a.reason}
      </span>
    ))
}

export function WorkRecovery({
  commands,
  threadId,
  work,
}: {
  commands: WorkCommands
  threadId: string
  work: WorkRecords
}) {
  const entries = commands.entries.filter(
    (e) => e.operation.target.threadId === threadId && e.state !== 'accepted',
  )
  if (!entries.length && !commands.error) return null
  return (
    <section className="work-recovery" aria-label="Work command recovery">
      {commands.error && (
        <p role="alert" className="work-error">
          {commands.error}{' '}
          <button onClick={commands.reload}>Retry loading work recovery</button>
        </p>
      )}
      {entries.map((e) => (
        <div key={e.id} className={`work-recovery-entry ${e.state}`}>
          <strong>
            {labels[e.operation.action]} ·{' '}
            {e.state === 'rejected' ? 'Not accepted' : 'Outcome unconfirmed'}
          </strong>
          {e.operation.answer && (
            <blockquote>
              {answerText(
                e.operation.answer,
                work.interactions.find(
                  (i) => i.id === e.operation.interactionId,
                ),
              )}
            </blockquote>
          )}
          <p>
            {e.receipt && e.receipt.status !== 'unknown'
              ? e.receipt.message
              : 'The original target and request are retained. A missing receipt is not a rejection.'}
          </p>
          {e.state === 'rejected' ? (
            <div className="work-actions">
              <button onClick={() => void commands.dismiss(e)}>Dismiss</button>
            </div>
          ) : (
            <div className="work-actions">
              <button onClick={() => void commands.check(e)}>
                Check command outcome
              </button>
              <button
                disabled={e.state === 'sending'}
                onClick={() => void commands.retry(e)}
              >
                Retry same command
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
export function WorkPanel({
  work,
  interactions,
  threadId,
  data,
  commands,
}: {
  work: WorkRecords
  /** Questions and approvals not shown in any run's work block. */
  interactions: Interaction[]
  threadId: string
  data: WorkspaceData
  commands: WorkCommands
}) {
  const current = work.workflows.find((w) => w.target.threadId === threadId)
  const [error, setError] = useState('')
  const unresolved = commands.entries.filter(
    (e) =>
      e.operation.target.threadId === threadId &&
      !['accepted', 'rejected'].includes(e.state),
  )
  const queue = work.queue
    .filter(
      (q) =>
        q.target.threadId === threadId && ['held', 'queued'].includes(q.state),
    )
    .sort(
      (a, b) =>
        a.acceptanceOrder - b.acceptanceOrder || a.id.localeCompare(b.id),
    )
  async function send(op: WorkOperation) {
    setError('')
    try {
      await commands.send(op)
    } catch {
      setError('Command could not be saved. Nothing was dispatched; try again.')
    }
  }
  return (
    <div className="work-panel">
      {interactions.map((i) => (
        <InteractionCard
          key={i.id}
          interaction={i}
          data={data}
          blocked={unresolved.some((e) => e.operation.interactionId === i.id)}
          send={commands.send}
        />
      ))}
      {queue.length > 0 && (
        <section className="work-queue" aria-label="Accepted follow-ups">
          <h3>
            Accepted follow-ups{' '}
            <span className="queue-count">{queue.length}</span>
          </h3>
          <ol>
            {queue.map((q) => {
              const authorId = data.messagesById[q.messageId]?.authorId
              const author = authorId ? data.actorsById[authorId] : undefined
              return (
                <li key={q.id} className={`queued-message ${q.state}`}>
                  <Avatar
                    name={author?.name ?? 'You'}
                    isSelf={!authorId || authorId === data.currentHumanId}
                    color={author?.kind === 'agent' ? author.color : undefined}
                  />
                  <div className="queued-body">
                    <p className="queued-text">{q.text}</p>
                    <small className="queued-status">
                      <PauseIcon weight="fill" aria-hidden="true" />
                      {q.state === 'held'
                        ? 'Held until released'
                        : q.readiness === 'preparing'
                          ? 'Preparing voice note · keeping queue position'
                          : 'Queued'}
                    </small>
                    <div className="work-actions queue-actions">
                      {q.actions.map((a) => (
                        <button
                          key={a.action}
                          title={a.reason || undefined}
                          aria-describedby={
                            a.reason ? `${q.id}-${a.action}-reason` : undefined
                          }
                          disabled={
                            !a.allowed || unresolved.length > 0 || !current
                          }
                          onClick={() =>
                            current &&
                            void send({
                              operationId: crypto.randomUUID(),
                              target: q.target,
                              action: a.action,
                              runId: current.runId,
                              attemptId: current.attemptId,
                              queueId: q.id,
                            })
                          }
                        >
                          {labels[a.action]}
                        </button>
                      ))}
                    </div>
                    <ActionReasons id={q.id} actions={q.actions} />
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      )}
      {error && (
        <p role="alert" className="work-error">
          {error}
        </p>
      )}
    </div>
  )
}
