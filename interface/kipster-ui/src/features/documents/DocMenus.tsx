import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar } from '../chat/Message'
import { formatTime } from '../chat/model'
import type { RevisionInfo } from '../../data/documents'
import { blockChoices, filterChoices, type BlockChoice } from './blocks'
import { Floating, type Anchor } from './Floating'
import type { Author } from './store'

const focusOnMount = (element: HTMLElement | null) =>
  element?.focus({ preventScroll: true })
const keepSelection = (event: { preventDefault: () => void }) =>
  event.preventDefault()

/** Bold, italic, link and comment for selected text. */
export function SelectionPill({
  range,
  formatting,
  onClose,
  onComment,
}: {
  range: Range
  formatting: boolean
  onClose: () => void
  onComment: () => void
}) {
  const [link, setLink] = useState(false)
  const [url, setUrl] = useState('https://')
  const restore = () => {
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  const format = (command: string, value?: string) => {
    restore()
    document.execCommand(command, false, value)
  }
  return (
    <Floating
      anchor={() => range.getBoundingClientRect()}
      placement="above"
      align="center"
      onClose={onClose}
      label="Text tools"
      role="toolbar"
      className="sel-pill"
    >
      {link ? (
        <form
          className="pill-link"
          onSubmit={(event) => {
            event.preventDefault()
            if (/^https?:\/\/\S+\.\S+/.test(url.trim())) {
              const field =
                range.startContainer.parentElement?.closest<HTMLElement>(
                  '.doc-field',
                )
              field?.focus({ preventScroll: true })
              format('createLink', url.trim())
            }
            onClose()
          }}
        >
          <input
            ref={focusOnMount}
            aria-label="Link address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="pill-go">
            Link
          </button>
        </form>
      ) : (
        <div className="pill-row" onMouseDownCapture={keepSelection}>
          {formatting && (
            <>
              <button
                type="button"
                aria-label="Bold"
                onClick={() => format('bold')}
              >
                <Icon name="bold" size={16} weight="bold" />
              </button>
              <button
                type="button"
                aria-label="Italic"
                onClick={() => format('italic')}
              >
                <Icon name="italic" size={16} weight="bold" />
              </button>
              <button
                type="button"
                aria-label="Link"
                onClick={() => setLink(true)}
              >
                <Icon name="link" size={16} weight="bold" />
              </button>
              <span className="sep" />
            </>
          )}
          <button type="button" className="pill-comment" onClick={onComment}>
            <Icon name="comment" size={16} weight="fill" />
            Comment
          </button>
        </div>
      )}
    </Floating>
  )
}

export function NewComment({
  anchor,
  agentName,
  onSave,
  onClose,
}: {
  anchor: Anchor
  agentName: string
  onSave: (body: string) => void
  onClose: () => void
}) {
  const [body, setBody] = useState('')
  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label="New comment"
      className="cm-new"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (body.trim()) onSave(body.trim())
        }}
      >
        <textarea
          ref={focusOnMount}
          rows={1}
          aria-label="Comment"
          placeholder={`Add a comment for ${agentName}`}
          value={body}
          onChange={(event) => setBody(event.target.value.slice(0, 4000))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button
          type="submit"
          className="send-button"
          aria-label="Add comment"
          disabled={!body.trim()}
        >
          <Icon name="arrow" size={17} weight="bold" />
        </button>
      </form>
    </Floating>
  )
}

export type ShownComment = {
  id: string
  number: number
  kind: 'draft' | 'open' | 'resolved'
  quote: string
  body: string
  reply: string | null
}
export function CommentCard({
  anchor,
  comment,
  author,
  editable,
  onChange,
  onDelete,
  onClose,
}: {
  anchor: Anchor
  comment: ShownComment
  author: Author
  editable: boolean
  onChange: (body: string) => void
  onDelete: () => void
  onClose: () => void
}) {
  const draft = comment.kind === 'draft'
  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label={`Comment ${comment.number}`}
      className={`cm-card ${comment.kind}`}
    >
      <div className="cm-card-head">
        <span className={`cm-number ${comment.kind}`}>{comment.number}</span>
        <q>{comment.quote}</q>
        <span
          className={`status-chip ${comment.kind === 'resolved' ? 'ok' : ''}`}
        >
          {draft
            ? 'Not sent'
            : comment.kind === 'open'
              ? `With ${author.name}`
              : 'Resolved'}
        </span>
      </div>
      {draft && editable ? (
        <textarea
          aria-label="Comment"
          value={comment.body}
          rows={2}
          onChange={(event) => onChange(event.target.value.slice(0, 4000))}
        />
      ) : (
        <p className="cm-body">{comment.body}</p>
      )}
      {comment.reply && (
        <div className="cm-reply">
          <Avatar name={author.name} color={author.color} kip={author.kip} />
          <p>{comment.reply}</p>
        </div>
      )}
      {draft && editable && (
        <div className="cm-actions">
          <button type="button" className="danger" onClick={onDelete}>
            <Icon name="trash" size={15} /> Delete
          </button>
          <button type="button" onClick={onClose}>
            Done
          </button>
        </div>
      )}
    </Floating>
  )
}

/** The block picker for the gutter `+` and for `/` in an empty line. */
export function InsertMenu({
  anchor,
  query,
  hot,
  onPick,
  onHot,
  onClose,
}: {
  anchor: Anchor
  query: string
  hot: number
  onPick: (choice: BlockChoice) => void
  onHot: (index: number) => void
  onClose: () => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const choices = filterChoices(query)
  useEffect(() => {
    list.current
      ?.querySelector('[data-hot="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [hot])
  let index = 0
  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label="Insert a block"
      role="menu"
      className="doc-menu"
    >
      <div ref={list} className="menu-scroll">
        {choices.length ? (
          blockChoices.map(({ group }) => {
            const items = choices.filter((c) => c.group === group)
            if (!items.length) return null
            return (
              <div key={group}>
                <p className="menu-h">{group}</p>
                {items.map(({ choice }) => {
                  const mine = index++
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={choice.id}
                      data-hot={mine === hot}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => onHot(mine)}
                      onClick={() => onPick(choice)}
                    >
                      <span className="mi">
                        <Icon
                          name={choiceIcon[choice.id] ?? 'text'}
                          size={18}
                        />
                      </span>
                      <span>
                        <b>{choice.label}</b>
                        <small>{choice.hint}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })
        ) : (
          <p className="menu-empty">No blocks match “{query}”</p>
        )}
      </div>
    </Floating>
  )
}
const choiceIcon: Record<string, Parameters<typeof Icon>[0]['name']> = {
  paragraph: 'text',
  heading: 'heading',
  subheading: 'subheading',
  list: 'list',
  numbered: 'numbered',
  quote: 'quote',
  callout: 'lightbulb',
  toggle: 'caret',
  code: 'code',
  divider: 'divider',
  question: 'question',
  checklist: 'checklist',
  scale: 'slider',
  image: 'image',
  file: 'attach',
  table: 'table',
}

export function MenuList({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: Anchor
  label: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label={label}
      role="menu"
      className="doc-menu small"
    >
      {children}
    </Floating>
  )
}

export function RevisionMenu({
  anchor,
  revisions,
  current,
  viewing,
  name,
  onPick,
  onClose,
}: {
  anchor: Anchor
  revisions: RevisionInfo[]
  current: number
  viewing: number
  name: (info: RevisionInfo) => string
  onPick: (number: number) => void
  onClose: () => void
}) {
  return (
    <Floating
      anchor={anchor}
      onClose={onClose}
      label="Revisions"
      role="menu"
      className="doc-menu revisions"
    >
      <p className="menu-h">Revisions</p>
      <div className="menu-scroll">
        {[...revisions]
          .sort((a, b) => b.number - a.number)
          .map((info) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={info.number === viewing}
              key={info.number}
              onClick={() => onPick(info.number)}
            >
              <span className={`mi ${info.authorKind === 'user' ? 'you' : ''}`}>
                <Icon
                  name={info.authorKind === 'user' ? 'arrow' : 'spark'}
                  size={16}
                />
              </span>
              <span>
                <b>
                  Rev {info.number} · {name(info)}
                  {info.number === current ? ' · latest' : ''}
                </b>
                <small>
                  {info.note ? `${info.note} · ` : ''}
                  {formatTime(info.createdAt)}
                </small>
              </span>
            </button>
          ))}
      </div>
    </Floating>
  )
}
