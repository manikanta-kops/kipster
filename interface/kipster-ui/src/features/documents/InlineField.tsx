import {
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import {
  applyMarks,
  markAnchors,
  toHtml,
  toMarkdown,
  type FieldMark,
} from './inline'

export type Anchors = ReturnType<typeof markAnchors>
const noMarks: FieldMark[] = []

/**
 * One editable piece of text. The DOM is written from Markdown only while the field is not
 * focused, so typing, the caret and undo stay with the browser.
 */
export function InlineField({
  blockId,
  field,
  value,
  editable,
  multiline = false,
  placeholder,
  label,
  marks = noMarks,
  as = 'div',
  className = '',
  onChange,
  onKeyDown,
}: {
  blockId: string
  field: string
  value: string
  editable: boolean
  multiline?: boolean
  placeholder?: string
  label?: string
  marks?: FieldMark[]
  as?:
    | 'div'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'li'
    | 'th'
    | 'td'
    | 'span'
    | 'figcaption'
  className?: string
  onChange?: (markdown: string, anchors: Anchors) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>, element: HTMLElement) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const shown = useRef<string | null>(null)
  const latest = useRef({ value, marks })
  const sync = () => {
    const element = ref.current
    if (!element) return
    const key = JSON.stringify(latest.current)
    if (shown.current === key) return
    element.innerHTML = toHtml(latest.current.value)
    applyMarks(element, latest.current.marks)
    shown.current = key
  }
  useLayoutEffect(() => {
    latest.current = { value, marks }
    if (document.activeElement !== ref.current) sync()
  })
  const Tag = as as 'div'
  return (
    <Tag
      ref={ref as RefObject<HTMLDivElement | null>}
      className={`doc-field ${className}`}
      contentEditable={editable || undefined}
      suppressContentEditableWarning
      role={editable ? 'textbox' : undefined}
      aria-label={editable ? label : undefined}
      aria-multiline={editable ? multiline : undefined}
      spellCheck={editable || undefined}
      data-block={blockId}
      data-field={field}
      data-placeholder={editable ? placeholder : undefined}
      onInput={(event: FormEvent<HTMLElement>) => {
        const element = event.currentTarget
        const markdown = toMarkdown(element, multiline)
        if (!markdown && !element.querySelector('.cm-pin'))
          element.replaceChildren()
        shown.current = null
        onChange?.(markdown, markAnchors(element))
      }}
      onBlur={() => sync()}
      onKeyDown={(event: KeyboardEvent<HTMLElement>) =>
        onKeyDown?.(event, event.currentTarget)
      }
      onPaste={(event: ClipboardEvent<HTMLElement>) => {
        if (!editable) return
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        document.execCommand(
          'insertText',
          false,
          multiline ? text : text.replace(/\s*\n\s*/g, ' '),
        )
      }}
    />
  )
}
