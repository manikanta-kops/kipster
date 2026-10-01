import { useId, useRef, useState } from 'react'
import type { Answer, Interaction, WorkOperation } from '../../data/work'
import type { WorkspaceData } from '../chat/model'
import { answerText } from './answer-text'
import { Icon } from '../../components/Icon'
export function InteractionCard({
  interaction: item,
  data,
  blocked,
  send,
}: {
  interaction: Interaction
  data: WorkspaceData
  blocked: boolean
  send: (op: WorkOperation) => Promise<void>
}) {
  const [choice, setChoice] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const heading = useId()
  const result = useRef<HTMLOutputElement>(null)
  const knownKind = item.kind === 'question' || item.kind === 'approval'
  const ended = ['settled', 'cancelled', 'superseded'].includes(item.state)
  const disabled = item.state !== 'pending' || blocked || pending
  async function respond(answer: Answer) {
    setError('')
    setPending(true)
    try {
      await send({
        operationId: crypto.randomUUID(),
        target: item.target,
        action: 'respond',
        runId: item.runId,
        attemptId: item.attemptId,
        interactionId: item.id,
        interactionVersion: item.version,
        proposalId: item.proposalId,
        answer,
      })
      requestAnimationFrame(() => result.current?.focus())
    } catch {
      setError(
        'Your response could not be saved. Your input is still here; try again.',
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <section
      id={`resource-${item.id}`}
      tabIndex={-1}
      className={`interaction-card ${item.kind} ${item.state}`}
      aria-labelledby={heading}
    >
      <p className="interaction-eyebrow">
        <Icon
          name={item.state === 'pending' ? 'hand' : ended ? 'check' : 'info'}
          size={15}
          weight={ended ? 'bold' : 'regular'}
        />
        {data.actorsById[item.sourceAgentId]?.name ?? 'Kip'} ·{' '}
        {item.kind === 'approval'
          ? 'Approval requested'
          : item.kind === 'question'
            ? 'Question'
            : item.kind}
        {item.delegationId ? ' · Consulting kip' : ''}
      </p>
      <h3 id={heading}>{item.prompt}</h3>
      {item.kind === 'approval' && item.proposal && (
        <p className="interaction-proposal">{item.proposal}</p>
      )}
      {!knownKind && item.options.length > 0 && (
        <ul>
          {item.options.map((option) => (
            <li key={option.id}>{option.label}</li>
          ))}
        </ul>
      )}
      {item.state === 'pending' && knownKind ? (
        <>
          {item.kind === 'question' && item.options.length > 0 && (
            <fieldset disabled={disabled}>
              <legend>Choose an option</legend>
              {item.options.map((o, index) => (
                <label className="interaction-option" key={o.id}>
                  <input
                    type="radio"
                    name={heading}
                    value={o.id}
                    checked={choice === o.id}
                    onChange={() => setChoice(o.id)}
                    onKeyDown={(event) => {
                      const picked = item.options[Number(event.key) - 1]
                      if (
                        !picked ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.altKey
                      )
                        return
                      event.preventDefault()
                      setChoice(picked.id)
                      event.currentTarget
                        .closest('fieldset')
                        ?.querySelectorAll('input')
                        [Number(event.key) - 1]?.focus()
                    }}
                  />
                  {index < 9 && <kbd aria-hidden="true">{index + 1}</kbd>}
                  <span>{o.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          {(item.freeText || item.kind === 'approval') && (
            <label className="interaction-text">
              {item.kind === 'approval'
                ? 'Comment (optional)'
                : 'Your answer or additional detail'}
              <textarea
                value={text}
                disabled={disabled}
                onChange={(e) => setText(e.target.value)}
                rows={2}
              />
            </label>
          )}
          <div className="work-actions interaction-actions">
            {item.kind === 'approval' ? (
              <>
                <button
                  tabIndex={0}
                  className="primary-button"
                  disabled={disabled}
                  onClick={() =>
                    void respond({ kind: 'approve', comment: text })
                  }
                >
                  Approve
                </button>
                <button
                  tabIndex={0}
                  disabled={disabled}
                  onClick={() =>
                    void respond({ kind: 'decline', comment: text })
                  }
                >
                  Decline
                </button>
              </>
            ) : (
              <>
                <button
                  tabIndex={0}
                  className="primary-button"
                  disabled={disabled || (!choice && !text.trim())}
                  onClick={() =>
                    void respond(
                      choice
                        ? {
                            kind: 'choice',
                            optionId: choice,
                            ...(item.freeText && text.trim() ? { text } : {}),
                          }
                        : { kind: 'text', text },
                    )
                  }
                >
                  Send answer
                </button>
                <button
                  tabIndex={0}
                  disabled={disabled}
                  onClick={() => void respond({ kind: 'dismiss' })}
                >
                  Dismiss question
                </button>
              </>
            )}
          </div>
          {blocked && (
            <output ref={result} tabIndex={-1} className="interaction-note">
              Response outcome is being reconciled. See work command recovery.
            </output>
          )}
        </>
      ) : (
        <div className="interaction-result">
          <output ref={result} tabIndex={-1}>
            {item.state === 'settled'
              ? 'Recorded response'
              : item.state === 'cancelled'
                ? 'Question or approval cancelled'
                : item.state === 'superseded'
                  ? 'Superseded by a newer request'
                  : item.state === 'pending'
                    ? 'This version of Kipster can’t answer this request.'
                    : `Status: ${item.state}`}
          </output>
          {item.response && (
            <blockquote>
              <strong>
                {data.actorsById[item.response.actorId]?.name ?? 'Respondent'}
              </strong>
              <p>{answerText(item.response.answer, item)}</p>
            </blockquote>
          )}
        </div>
      )}
      {item.continuation === 'recovery-needed' && (
        <output className="interaction-note">
          Response saved. Continuation needs recovery; no new work is authorized
          by this card.
        </output>
      )}
      {item.reason && <p className="work-explanation">{item.reason}</p>}
      {error && (
        <p role="alert" className="work-error">
          {error}
        </p>
      )}
    </section>
  )
}
