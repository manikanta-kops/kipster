import { useState } from 'react'
import type {
  AvailableAction,
  WorkAction,
  WorkOperation,
  WorkState,
} from '../../data/work'
import { workLabels } from '../../data/work'
import type { WorkspaceData } from '../chat/model'
import { Avatar } from '../chat/Message'
import { Icon } from '../../components/Icon'
import { Markdown } from '../chat/Markdown'
import { InteractionCard } from './InteractionCard'
import type { WorkCommands } from './WorkPanel'
import type { RunWork } from './run-work'

const labels: Partial<Record<WorkAction, string>> = {
  stop: 'Stop work',
  resume: 'Resume follow-ups',
  retry: 'Retry work',
}
const ended = new Set<WorkState>(['completed', 'cancelled', 'failed'])

function headline(
  run: RunWork,
  drafting: boolean,
  name: (id: string) => string,
) {
  const pending = run.interactions.find((i) => i.state === 'pending')
  const asking = run.delegations.find(
    (d) => d.state === 'running' || d.state === 'waiting',
  )
  if (run.state === 'running')
    return asking
      ? `Asking ${name(asking.toAgentId)}`
      : drafting
        ? 'Writing'
        : workLabels.running
  if (run.state === 'waiting' && pending)
    return pending.kind === 'approval'
      ? 'Needs your approval'
      : 'Needs your answer'
  if (run.state === 'waiting' && asking)
    return `Waiting for ${name(asking.toAgentId)}`
  return workLabels[run.state] ?? run.state
}

function tone(run: RunWork) {
  if (run.interactions.some((i) => i.state === 'pending')) return 'wait'
  if (run.state === 'failed' || run.state === 'recovery-needed') return 'danger'
  if (run.state === 'running' || run.state === 'preparing') return 'run'
  if (run.state === 'waiting') return 'wait'
  return 'quiet'
}

const delegationDone: Record<string, string> = {
  completed: 'Asked',
  failed: 'Couldn’t get an answer from',
  cancelled: 'Stopped asking',
  'recovery-needed': 'Needs a check with',
}

/**
 * The work block that closes a kip's reply: what it is doing, its progress
 * notes and steps, questions and approvals waiting on you, and the controls
 * for the run.
 * Finished runs fold to a single line.
 */
export function WorkBlock({
  run,
  drafting,
  data,
  commands,
  threadId,
  notes,
  folding,
  fold,
}: {
  run: RunWork
  /** What the kip wrote while working, oldest first. */
  notes: { id: string; text: string }[]
  drafting: boolean
  data: WorkspaceData
  commands: WorkCommands
  threadId: string
  /** The person's own choice; until they make one, live work is open and settled work is folded. */
  folding?: boolean
  fold: (open: boolean) => void
}) {
  const settled =
    ended.has(run.state) &&
    !run.held &&
    !run.interactions.some((i) => i.state === 'pending')
  const open = folding ?? !settled
  const [error, setError] = useState('')
  const name = (id: string) => data.actorsById[id]?.name ?? 'a kip'
  const color = (id: string) => {
    const actor = data.actorsById[id]
    return actor?.kind === 'agent' ? actor.color : undefined
  }
  const unresolved = commands.entries.filter(
    (e) =>
      e.operation.target.threadId === threadId &&
      !['accepted', 'rejected'].includes(e.state),
  )
  const flow = run.current
  const controls: AvailableAction[] =
    flow?.actions.filter((a) => a.allowed && a.action in labels) ?? []
  const asks = [...run.interactions].sort((a, b) => a.id.localeCompare(b.id))
  const steps =
    notes.length +
    asks.filter((i) => i.state !== 'pending').length +
    run.delegations.length
  const why =
    (run.state === 'failed' || run.state === 'recovery-needed') && run.failure
  const word = headline(run, drafting, name)
  async function send(action: WorkAction) {
    if (!flow) return
    setError('')
    try {
      await commands.send({
        operationId: crypto.randomUUID(),
        target: flow.target,
        action,
        runId: flow.runId,
        attemptId: flow.attemptId,
      } satisfies WorkOperation)
    } catch {
      setError('Command could not be saved. Nothing was dispatched; try again.')
    }
  }
  return (
    <section
      className={`work-block ${tone(run)} ${open ? 'open' : 'folded'}`}
      aria-label={flow ? 'Thread work' : 'Earlier work'}
    >
      <div className="work-block-head">
        <button
          className="work-block-title"
          aria-expanded={open}
          onClick={() => fold(!open)}
        >
          <span className="work-block-mark" aria-hidden="true" />
          <span className="work-block-word">{word}</span>
          {(steps > 0 || (run.held && run.state !== 'held')) && (
            <span className="work-block-sum">
              {run.held && run.state !== 'held' ? 'Follow-ups held' : ''}
              {run.held && run.state !== 'held' && steps > 0 ? ' · ' : ''}
              {steps > 0 ? `${steps} ${steps === 1 ? 'step' : 'steps'}` : ''}
            </span>
          )}
          <Icon name="chevron" size={12} className="work-block-caret" />
        </button>
        {controls.length > 0 && (
          <span className="work-block-actions">
            {controls.map((a) => (
              <button
                key={a.action}
                className="work-block-action"
                aria-label={labels[a.action]}
                title={a.reason || undefined}
                aria-describedby={
                  a.reason && flow ? `${flow.id}-${a.action}-reason` : undefined
                }
                disabled={unresolved.length > 0}
                onClick={() => void send(a.action)}
              >
                <Icon
                  name={
                    a.action === 'stop'
                      ? 'stop'
                      : a.action === 'retry'
                        ? 'refresh'
                        : 'play'
                  }
                  size={12}
                  weight="fill"
                />
                {a.action === 'stop'
                  ? 'Stop'
                  : a.action === 'retry'
                    ? 'Retry'
                    : 'Resume follow-ups'}
              </button>
            ))}
          </span>
        )}
      </div>
      {flow?.actions
        .filter((a) => a.reason)
        .map((a) => (
          <span
            id={`${flow.id}-${a.action}-reason`}
            className="sr-only"
            key={a.action}
          >
            {a.reason}
          </span>
        ))}
      {((open && (why || run.delegations.length > 0 || notes.length > 0)) ||
        asks.length > 0) && (
        <div className="work-block-body">
          {open && why && <p className="work-explanation">{why}</p>}
          {open &&
            notes.map((note, index) => (
              <div
                key={note.id}
                className={`work-step progress-note${run.state === 'running' && index === notes.length - 1 ? ' live' : ''}`}
              >
                <span className="step-mark" aria-hidden="true" />
                <Markdown text={note.text} className="step-text" />
              </div>
            ))}
          {open &&
            run.delegations.map((d) => {
              const running = d.state === 'running' || d.state === 'waiting'
              return (
                <div
                  key={d.id}
                  className={`work-step ${running ? 'live' : d.state === 'completed' ? 'done' : d.state === 'queued' ? 'idle' : 'failed'}`}
                >
                  <span className="step-mark" aria-hidden="true">
                    {d.state === 'completed' && (
                      <Icon name="check" size={12} weight="bold" />
                    )}
                  </span>
                  <span className="step-text">
                    <span className="handoff">
                      <Avatar
                        name={name(d.toAgentId)}
                        color={color(d.toAgentId)}
                      />
                      {running
                        ? `Asking ${name(d.toAgentId)}`
                        : d.state === 'queued'
                          ? `Will ask ${name(d.toAgentId)}`
                          : `${delegationDone[d.state] ?? d.state} ${name(d.toAgentId)}`}
                    </span>
                    {d.request?.summary && <small>{d.request.summary}</small>}
                  </span>
                </div>
              )
            })}
          {asks.map((i) => (
            // One stable slot per card, so answering keeps keyboard focus.
            <div
              key={i.id}
              className={
                i.state === 'pending' ? 'work-ask' : 'work-step answered'
              }
              hidden={i.state !== 'pending' && !open}
            >
              <InteractionCard
                interaction={i}
                data={data}
                blocked={unresolved.some(
                  (e) => e.operation.interactionId === i.id,
                )}
                send={commands.send}
              />
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="work-error">
          {error}
        </p>
      )}
    </section>
  )
}
