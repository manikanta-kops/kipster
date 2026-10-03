import { useLayoutEffect, useRef } from 'react'
import { Icon } from '../../components/Icon'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The doc's composer: what goes with the submission, a note, and Submit. */
export function SubmitDock({
  agentName,
  answered,
  questions,
  comments,
  edits,
  note,
  saveState,
  busy,
  onNote,
  onComments,
  onSubmit,
}: {
  agentName: string
  answered: number
  questions: number
  comments: number
  edits: number
  note: string
  saveState: '' | 'saving' | 'saved' | 'error'
  busy: boolean
  onNote: (note: string) => void
  onComments: () => void
  onSubmit: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`
  }, [note])
  const radius = 8,
    length = 2 * Math.PI * radius
  return (
    <form
      className="doc-dock mat thick lifted"
      aria-label="Submit the doc"
      onSubmit={(event) => {
        event.preventDefault()
        if (!busy) onSubmit()
      }}
    >
      <div className="dock-chips">
        {questions > 0 && (
          <span className={`dock-chip ${answered === questions ? 'done' : ''}`}>
            <svg viewBox="0 0 20 20" aria-hidden="true" className="ring">
              <circle cx="10" cy="10" r={radius} className="ring-track" />
              <circle
                cx="10"
                cy="10"
                r={radius}
                className="ring-fill"
                strokeDasharray={length}
                strokeDashoffset={length * (1 - answered / questions)}
              />
            </svg>
            {answered} of {questions} answered
          </span>
        )}
        <button
          type="button"
          className="dock-chip"
          disabled={!comments}
          aria-label={`${plural(comments, 'comment')}${comments ? ', show next' : ''}`}
          onClick={onComments}
        >
          <Icon name="comment" size={15} />
          {plural(comments, 'comment')}
        </button>
        <span className="dock-chip">
          <Icon name="pencil" size={15} />
          {plural(edits, 'edit')}
        </span>
        <output className={`dock-save ${saveState}`}>
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Draft saved'
              : saveState === 'error'
                ? 'Not saved yet'
                : ''}
        </output>
      </div>
      <div className="dock-input">
        <textarea
          ref={input}
          rows={1}
          aria-label={`Note for ${agentName}`}
          placeholder={`Add a note for ${agentName}…`}
          value={note}
          onChange={(event) => onNote(event.target.value.slice(0, 8000))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button type="submit" className="primary-button" disabled={busy}>
          <Icon name="arrow" size={16} weight="bold" />
          {busy ? 'Submitting…' : 'Submit'}
        </button>
      </div>
    </form>
  )
}
