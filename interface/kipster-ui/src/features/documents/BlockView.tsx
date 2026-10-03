import {
  Fragment,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { isKnown, type AnyBlock, type Block } from '../../data/documents'
import { Icon } from '../../components/Icon'
import { answered, newId } from './blocks'
import { toHtml } from './inline'
import { DocFile, DocImage } from './DocMedia'
import type { DocumentClient } from '../../data/documents'

export type FieldOptions = {
  as?: 'div' | 'h2' | 'h3' | 'h4' | 'li' | 'th' | 'td' | 'span' | 'figcaption'
  className?: string
  placeholder?: string
  label?: string
  multiline?: boolean
}
export type Editor = {
  documentId: string
  client: DocumentClient
  editable: boolean
  /** The kip has the doc: answers are shown as sent. */
  locked: boolean
  field: (block: Block, field: string, options?: FieldOptions) => ReactNode
  update: (id: string, change: (block: Block) => Block) => void
  upload: (id: string, file: File) => void
  uploading: ReadonlySet<string>
  zoom: (url: string) => void
}
type Of<T extends Block['type']> = Extract<Block, { type: T }>
const letter = (index: number) => String.fromCharCode(65 + index)
const inlineHtml = (text: string) => ({ __html: toHtml(text) })

export function BlockBody({
  block,
  editor,
}: {
  block: AnyBlock
  editor: Editor
}) {
  if (!isKnown(block))
    return (
      <div className="doc-card unknown-block">
        <Icon name="doc" size={18} />
        <span>
          <b>This block needs a newer version of Kipster</b>
          <small>It stays in the doc unchanged.</small>
        </span>
      </div>
    )
  const field = editor.field
  switch (block.type) {
    case 'paragraph':
      return field(block, 'text', {
        className: 'doc-text',
        placeholder: 'Type “/” for blocks',
        label: 'Text',
        multiline: true,
      })
    case 'heading':
      return field(block, 'text', {
        as: block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4',
        className: `doc-heading level-${block.level}`,
        placeholder: 'Heading',
        label: 'Heading',
      })
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul'
      return (
        <List className="doc-list">
          {block.items.map((item) => (
            <Fragment key={item.id}>
              {field(block, `item:${item.id}`, {
                as: 'li',
                placeholder: 'List item',
                label: 'List item',
              })}
            </Fragment>
          ))}
        </List>
      )
    }
    case 'checklist':
      return <Checklist block={block} editor={editor} />
    case 'quote':
      return field(block, 'text', {
        className: 'doc-quote',
        placeholder: 'Quote',
        label: 'Quote',
        multiline: true,
      })
    case 'callout':
      return <Callout block={block} editor={editor} />
    case 'code':
      return <Code block={block} editor={editor} />
    case 'divider':
      return <hr className="doc-divider" />
    case 'image':
      return (
        <figure className="doc-figure">
          {block.artifactId ? (
            <DocImage
              client={editor.client}
              documentId={editor.documentId}
              artifactId={block.artifactId}
              onZoom={editor.zoom}
            />
          ) : (
            <Upload block={block} editor={editor} accept="image/*" />
          )}
          {(block.caption || editor.editable) &&
            block.artifactId &&
            field(block, 'caption', {
              as: 'figcaption',
              placeholder: 'Add a caption',
              label: 'Caption',
            })}
        </figure>
      )
    case 'file':
      return block.artifactId ? (
        <DocFile
          client={editor.client}
          documentId={editor.documentId}
          artifactId={block.artifactId}
        />
      ) : (
        <Upload block={block} editor={editor} />
      )
    case 'table':
      return <Table block={block} editor={editor} />
    case 'toggle':
      return <Toggle block={block} editor={editor} />
    case 'question':
      return <Question block={block} editor={editor} />
    case 'scale':
      return <Scale block={block} editor={editor} />
  }
}

function StateChip({
  done,
  locked,
  label,
}: {
  done: boolean
  locked: boolean
  label?: string
}) {
  if (done)
    return (
      <span className="status-chip ok">
        <Icon name="check" size={12} weight="bold" />
        {label ?? 'Answered'}
      </span>
    )
  return locked ? null : (
    <span className="status-chip wait">
      <i />
      Needs you
    </span>
  )
}

function Checklist({
  block,
  editor,
}: {
  block: Of<'checklist'>
  editor: Editor
}) {
  const done = block.items.filter((item) => item.done).length
  return (
    <div className="doc-card">
      <div className="card-eyebrow">
        <Icon name="checklist" size={15} />
        Checklist
        <span className="chk-progress">
          <span className="bar">
            <i
              style={{
                width: `${block.items.length ? (done / block.items.length) * 100 : 0}%`,
              }}
            />
          </span>
          {done} of {block.items.length}
        </span>
      </div>
      <div className="chk-list">
        {block.items.map((item) => (
          <div className={`chk ${item.done ? 'done' : ''}`} key={item.id}>
            <label className="chk-box">
              <input
                type="checkbox"
                checked={item.done}
                aria-label={`Done: ${item.text || 'item'}`}
                disabled={!editor.editable}
                onChange={() =>
                  editor.update(block.id, (b) => ({
                    ...(b as Of<'checklist'>),
                    items: (b as Of<'checklist'>).items.map((i) =>
                      i.id === item.id ? { ...i, done: !i.done } : i,
                    ),
                  }))
                }
              />
              <Icon name="check" size={13} weight="bold" />
            </label>
            {editor.field(block, `item:${item.id}`, {
              className: 'chk-text',
              placeholder: 'To do',
              label: 'Checklist item',
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

const tones = ['note', 'success', 'warning'] as const
function Callout({ block, editor }: { block: Of<'callout'>; editor: Editor }) {
  const icon =
    block.tone === 'success'
      ? 'success'
      : block.tone === 'warning'
        ? 'warning'
        : 'lightbulb'
  return (
    <div className={`doc-callout ${block.tone}`}>
      <button
        type="button"
        className="callout-icon"
        aria-label={`Callout style: ${block.tone}`}
        disabled={!editor.editable}
        onClick={() =>
          editor.update(block.id, (b) => ({
            ...(b as Of<'callout'>),
            tone: tones[(tones.indexOf(block.tone) + 1) % tones.length],
          }))
        }
      >
        <Icon name={icon} size={17} weight="bold" />
      </button>
      {editor.field(block, 'text', {
        className: 'callout-text',
        placeholder: 'Something worth noticing',
        label: 'Callout',
        multiline: true,
      })}
    </div>
  )
}

function Code({ block, editor }: { block: Of<'code'>; editor: Editor }) {
  const [copied, setCopied] = useState(false)
  const set = (patch: Partial<Of<'code'>>) =>
    editor.update(block.id, (b) => ({ ...(b as Of<'code'>), ...patch }))
  return (
    <div className="doc-code">
      <div className="code-head">
        {editor.editable ? (
          <input
            aria-label="Code language"
            placeholder="Language"
            value={block.language}
            onChange={(event) => set({ language: event.target.value })}
          />
        ) : (
          <span>{block.language || 'Code'}</span>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(block.code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1400)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {editor.editable ? (
        <textarea
          aria-label="Code"
          spellCheck={false}
          rows={Math.max(2, block.code.split('\n').length)}
          value={block.code}
          placeholder="Write or paste code"
          onChange={(event) => set({ code: event.target.value })}
        />
      ) : (
        <pre>{block.code}</pre>
      )}
    </div>
  )
}

function Upload({
  block,
  editor,
  accept,
}: {
  block: Block
  editor: Editor
  accept?: string
}) {
  const busy = editor.uploading.has(block.id)
  if (!editor.editable)
    return <div className="doc-drop">{accept ? 'No image' : 'No file'}</div>
  return (
    <label className={`doc-drop ${busy ? 'busy' : ''}`}>
      <Icon name={accept ? 'image' : 'attach'} size={24} />
      <b>{busy ? 'Uploading…' : accept ? 'Add an image' : 'Attach a file'}</b>
      <span>Choose a file from your computer</span>
      <input
        type="file"
        accept={accept}
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) editor.upload(block.id, file)
        }}
      />
    </label>
  )
}

function Table({ block, editor }: { block: Of<'table'>; editor: Editor }) {
  const set = (patch: Partial<Of<'table'>>) =>
    editor.update(block.id, (b) => ({ ...(b as Of<'table'>), ...patch }))
  return (
    <div className="doc-table">
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {block.header.map((_, column) => (
                <th key={column}>
                  {editor.field(block, `cell:-1:${column}`, {
                    as: 'span',
                    placeholder: 'Column',
                    label: 'Column heading',
                  })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((_, column) => (
                  <td key={column}>
                    {editor.field(block, `cell:${r}:${column}`, {
                      as: 'span',
                      label: 'Table cell',
                    })}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editor.editable && (
        <div className="tbl-actions">
          <button
            type="button"
            onClick={() =>
              set({ rows: [...block.rows, block.header.map(() => '')] })
            }
          >
            <Icon name="plus" size={14} /> Row
          </button>
          <button
            type="button"
            onClick={() =>
              set({
                header: [...block.header, ''],
                rows: block.rows.map((row) => [...row, '']),
              })
            }
          >
            <Icon name="plus" size={14} /> Column
          </button>
        </div>
      )}
    </div>
  )
}

function Toggle({ block, editor }: { block: Of<'toggle'>; editor: Editor }) {
  const [open, setOpen] = useState(!block.summary)
  return (
    <div className={`doc-toggle ${open ? 'open' : ''}`}>
      {editor.editable ? (
        <div className="toggle-head">
          <button
            type="button"
            className="toggle-caret"
            aria-expanded={open}
            aria-label={open ? 'Hide details' : 'Show details'}
            onClick={() => setOpen(!open)}
          >
            <Icon name="caret" size={14} weight="bold" />
          </button>
          {editor.field(block, 'summary', {
            as: 'span',
            className: 'toggle-summary',
            placeholder: 'Toggle title',
            label: 'Toggle title',
          })}
        </div>
      ) : (
        <button
          type="button"
          className="toggle-head"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="toggle-caret">
            <Icon name="caret" size={14} weight="bold" />
          </span>
          {editor.field(block, 'summary', {
            as: 'span',
            className: 'toggle-summary',
          })}
        </button>
      )}
      {open && (
        <div className="toggle-body">
          {editor.field(block, 'text', {
            placeholder: 'Details',
            label: 'Toggle details',
            multiline: true,
          })}
        </div>
      )}
    </div>
  )
}

function Question({
  block,
  editor,
}: {
  block: Of<'question'>
  editor: Editor
}) {
  const [editing, setEditing] = useState(false)
  const [otherOn, setOtherOn] = useState(!!block.answer?.other)
  const otherInput = useRef<HTMLInputElement>(null)
  const answer = block.answer ?? { optionIds: [], other: '' }
  const otherSelected = block.other && (otherOn || !!answer.other)
  const save = (optionIds: string[], other: string) =>
    editor.update(block.id, (b) => ({
      ...(b as Of<'question'>),
      answer: optionIds.length || other ? { optionIds, other } : null,
    }))
  const pick = (id: string) => {
    if (!editor.editable) return
    const on = answer.optionIds.includes(id)
    if (block.multiple)
      save(
        on
          ? answer.optionIds.filter((x) => x !== id)
          : [...answer.optionIds, id],
        answer.other,
      )
    else {
      setOtherOn(false)
      save(on ? [] : [id], '')
    }
  }
  const pickOther = () => {
    if (!editor.editable) return
    if (otherSelected) {
      setOtherOn(false)
      save(answer.optionIds, '')
      return
    }
    setOtherOn(true)
    if (!block.multiple) save([], answer.other)
    requestAnimationFrame(() => otherInput.current?.focus())
  }
  // Letter keys pick options, as the cards show.
  const letterKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const index = event.key.toUpperCase().charCodeAt(0) - 65
    if (event.key.length !== 1 || index < 0) return
    if (index < block.options.length) pick(block.options[index].id)
    else if (index === block.options.length && block.other) pickOther()
    else return
    event.preventDefault()
  }
  const setOptions = (options: Of<'question'>['options']) =>
    editor.update(block.id, (b) => ({ ...(b as Of<'question'>), options }))
  const multi = block.multiple
  return (
    <div className={`doc-card ask ${answered(block) ? 'answered' : ''}`}>
      <div className="card-eyebrow">
        <Icon name="question" size={15} />
        {multi ? 'Pick any' : 'Question for you'}
        {editor.editable && (
          <button
            type="button"
            className="eyebrow-action"
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Done' : 'Edit options'}
          </button>
        )}
        <StateChip
          done={answered(block)}
          locked={editor.locked}
          label={editor.locked ? 'Sent' : undefined}
        />
      </div>
      {editor.field(block, 'prompt', {
        className: 'q-prompt',
        placeholder: 'Ask something',
        label: 'Question',
      })}
      {(block.help || editor.editable) &&
        editor.field(block, 'help', {
          className: 'q-help',
          placeholder: 'Add a hint',
          label: 'Question hint',
        })}
      {editing ? (
        <div className="q-edit">
          {block.options.map((option, index) => (
            <div className="q-edit-row" key={option.id}>
              <kbd>{letter(index)}</kbd>
              <input
                aria-label={`Option ${letter(index)}`}
                value={option.label}
                placeholder="Option"
                onChange={(event) =>
                  setOptions(
                    block.options.map((o) =>
                      o.id === option.id
                        ? { ...o, label: event.target.value }
                        : o,
                    ),
                  )
                }
              />
              <input
                aria-label={`Hint for option ${letter(index)}`}
                value={option.hint}
                placeholder="Hint (optional)"
                onChange={(event) =>
                  setOptions(
                    block.options.map((o) =>
                      o.id === option.id
                        ? { ...o, hint: event.target.value }
                        : o,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove option ${letter(index)}`}
                onClick={() =>
                  setOptions(block.options.filter((o) => o.id !== option.id))
                }
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
          <div className="q-edit-actions">
            <button
              type="button"
              onClick={() =>
                setOptions([
                  ...block.options,
                  { id: newId(), label: '', hint: '' },
                ])
              }
            >
              <Icon name="plus" size={14} /> Option
            </button>
            <label>
              <input
                type="checkbox"
                checked={block.multiple}
                onChange={(event) =>
                  editor.update(block.id, (b) => ({
                    ...(b as Of<'question'>),
                    multiple: event.target.checked,
                  }))
                }
              />
              Several answers
            </label>
            <label>
              <input
                type="checkbox"
                checked={block.other}
                onChange={(event) =>
                  editor.update(block.id, (b) => ({
                    ...(b as Of<'question'>),
                    other: event.target.checked,
                  }))
                }
              />
              Something else
            </label>
          </div>
        </div>
      ) : (
        <div
          className="q-options"
          role={multi ? 'group' : 'radiogroup'}
          aria-label={block.prompt || 'Options'}
        >
          {block.options.map((option, index) => {
            const on = answer.optionIds.includes(option.id)
            return (
              <button
                type="button"
                key={option.id}
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={`qopt ${multi ? 'multi' : ''} ${on ? 'on' : ''}`}
                disabled={!editor.editable}
                onClick={() => pick(option.id)}
                onKeyDown={letterKey}
              >
                <kbd>
                  {multi && on ? (
                    <Icon name="check" size={13} weight="bold" />
                  ) : (
                    letter(index)
                  )}
                </kbd>
                <span className="qopt-label">
                  <b dangerouslySetInnerHTML={inlineHtml(option.label)} />
                  {option.hint && (
                    <small dangerouslySetInnerHTML={inlineHtml(option.hint)} />
                  )}
                </span>
              </button>
            )
          })}
          {block.other && (
            <div
              className={`qopt qopt-other ${multi ? 'multi' : ''} ${otherSelected ? 'on' : ''} ${editor.editable ? '' : 'disabled'}`}
            >
              <button
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={otherSelected}
                aria-label="Something else"
                className="qopt-key"
                disabled={!editor.editable}
                onClick={pickOther}
                onKeyDown={letterKey}
              >
                <kbd>
                  {multi && otherSelected ? (
                    <Icon name="check" size={13} weight="bold" />
                  ) : (
                    letter(block.options.length)
                  )}
                </kbd>
                <b>Something else</b>
              </button>
              <input
                ref={otherInput}
                aria-label="Your own answer"
                placeholder="Write your own answer…"
                value={answer.other}
                disabled={!editor.editable}
                onFocus={() => {
                  if (!otherSelected) {
                    setOtherOn(true)
                    if (!block.multiple) save([], answer.other)
                  }
                }}
                onChange={(event) =>
                  save(
                    block.multiple ? answer.optionIds : [],
                    event.target.value,
                  )
                }
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Scale({ block, editor }: { block: Of<'scale'>; editor: Editor }) {
  const [dragging, setDragging] = useState(false)
  const { min, step, value } = block
  const max = Math.max(block.max, min + 1)
  const span = max - min
  const middle = Math.min(max, min + Math.round(span / 2 / step) * step)
  const set = (next: number | null) => {
    if (!editor.editable || next === value) return
    editor.update(block.id, (b) => ({ ...(b as Of<'scale'>), value: next }))
  }
  const fraction = ((value ?? middle) - min) / span
  const ticks = span / step <= 10 ? span / step + 1 : 0
  return (
    <div className={`doc-card ask ${value !== null ? 'answered' : ''}`}>
      <div className="card-eyebrow">
        <Icon name="slider" size={15} />
        Quick check
        <StateChip
          done={value !== null}
          locked={editor.locked}
          label={value !== null ? `${value} of ${max}` : undefined}
        />
      </div>
      {editor.field(block, 'prompt', {
        className: 'q-prompt',
        placeholder: 'Ask something',
        label: 'Scale question',
      })}
      <div
        className={`slider ${value === null ? 'empty' : ''} ${dragging ? 'dragging' : ''}`}
        style={{ '--at': fraction } as CSSProperties}
      >
        <div className="slider-track">
          <span className="slider-fill" />
          {Array.from({ length: ticks }, (_, i) => (
            <span
              key={i}
              className={`slider-tick ${value !== null && min + i * step <= value ? 'on' : ''}`}
              style={{ left: `${((i * step) / span) * 100}%` }}
            />
          ))}
          <span className="slider-thumb" aria-hidden="true">
            <span className="slider-bubble">{value ?? '–'}</span>
          </span>
          {/* The native range input takes pointer and keyboard input; the parts above draw it. */}
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value ?? middle}
            aria-label={block.prompt || 'Scale'}
            aria-valuetext={value === null ? 'Not answered' : String(value)}
            disabled={!editor.editable}
            onChange={(event) => set(Number(event.target.value))}
            onPointerDown={() => setDragging(true)}
            onPointerUp={() => {
              setDragging(false)
              if (value === null) set(middle)
            }}
            onPointerCancel={() => setDragging(false)}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' || event.key === 'Delete') {
                event.preventDefault()
                set(null)
              } else if (value === null && event.key.startsWith('Arrow')) {
                event.preventDefault()
                set(middle)
              }
            }}
          />
        </div>
        <div className="slider-ends">
          {editor.field(block, 'minLabel', {
            as: 'span',
            placeholder: 'Low',
            label: 'Low end label',
          })}
          {editor.field(block, 'maxLabel', {
            as: 'span',
            placeholder: 'High',
            label: 'High end label',
          })}
        </div>
      </div>
    </div>
  )
}
