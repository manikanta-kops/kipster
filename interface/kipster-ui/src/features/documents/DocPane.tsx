import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Icon } from '../../components/Icon'
import {
  inspectorArrive,
  inspectorAway,
  inspectorExit,
  quickFade,
} from '../../app/motion'
import { Avatar } from '../chat/Message'
import { formatTime, type ChatContext } from '../chat/model'
import { WorkspaceContext } from '../../data/workspace-context'
import { digest } from '../../data/media'
import { TextHttpError } from '../../data/response'
import {
  isKnown,
  type AnyBlock,
  type Block,
  type Detail,
  type Draft,
  type Revision,
} from '../../data/documents'
import { InlineField } from './InlineField'
import { BlockBody, type Editor, type FieldOptions } from './BlockView'
import {
  answered,
  asks,
  editCount,
  filterChoices,
  getField,
  newId,
  setField,
  withoutAnswer,
  type BlockChoice,
} from './blocks'
import {
  caretAt,
  offsetIn,
  placeCaret,
  plainOf,
  plainText,
  splitAtCaret,
  toMarkdown,
  type FieldMark,
} from './inline'
import {
  CommentCard,
  InsertMenu,
  MenuList,
  NewComment,
  RevisionMenu,
  SelectionPill,
  type ShownComment,
} from './DocMenus'
import { SubmitDock } from './SubmitDock'
import {
  localFiles,
  useDocumentGone,
  useDocumentsContext,
  useDocumentSummary,
} from './store'

type Working = {
  title: string
  blocks: AnyBlock[]
  comments: Draft[]
  note: string
}
type Popover =
  | { kind: 'pill'; range: Range; field: HTMLElement }
  | {
      kind: 'new-comment'
      rect: DOMRect
      anchor: Omit<Draft, 'id' | 'body'>
    }
  | { kind: 'comment'; id: string }
  | {
      kind: 'insert'
      anchor: Element
      after: string | null
      replace?: string
      slash: boolean
      query: string
      hot: number
    }
  | { kind: 'block'; anchor: Element; id: string }
  | { kind: 'revisions'; anchor: Element }
type Focus = { blockId: string; field: string; at: 'start' | 'end' | number }

const textual = new Set(['paragraph', 'heading', 'quote', 'callout'])
const firstField = (block: Block) =>
  block.type === 'list' || block.type === 'checklist'
    ? `item:${block.items[0]?.id}`
    : block.type === 'toggle'
      ? 'summary'
      : block.type === 'question' || block.type === 'scale'
        ? 'prompt'
        : block.type === 'table'
          ? 'cell:-1:0'
          : textual.has(block.type)
            ? 'text'
            : ''
const copyOf = (detail: Detail): Working =>
  detail.draft
    ? {
        title: detail.draft.title,
        blocks: detail.draft.blocks,
        comments: detail.draft.comments,
        note: detail.draft.note,
      }
    : {
        title: detail.current.title,
        blocks: detail.current.blocks,
        comments: [],
        note: '',
      }
/** A copy with fresh IDs, so a duplicated block and its items stay unique. */
function duplicate(block: AnyBlock): AnyBlock {
  const copy = structuredClone(block) as AnyBlock & {
    items?: { id: string }[]
    options?: { id: string }[]
  }
  copy.id = newId()
  copy.items?.forEach((item) => (item.id = newId()))
  copy.options?.forEach((option) => (option.id = newId()))
  return copy
}
const blockActions = [
  ['up', 'Move up', 'arrow'],
  ['down', 'Move down', 'down'],
  ['duplicate', 'Duplicate', 'copy'],
  ['delete', 'Delete', 'trash'],
] as const
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.'

export function DocPane({
  id,
  expanded,
  onExpand,
  onClose,
  onThread,
  closeButton,
}: {
  id: string
  expanded: boolean
  onExpand: () => void
  onClose: () => void
  onThread: (threadId: string) => void
  closeButton?: RefObject<HTMLButtonElement | null>
}) {
  const docs = useDocumentsContext()!
  const media = useContext(WorkspaceContext)?.media
  const client = docs.store.client
  const summary = useDocumentSummary(docs.store, id)
  const reduceMotion = useReducedMotion()
  const page = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadError, setLoadError] = useState('')
  const [working, setWorking] = useState<Working | null>(null)
  const [viewing, setViewing] = useState<Revision | null>(null)
  const [showChanges, setShowChanges] = useState(true)
  const [popover, setPopover] = useState<Popover | null>(null)
  const [zoom, setZoom] = useState('')
  const [notice, setNotice] = useState('')
  const [saveState, setSaveState] = useState<'' | 'saving' | 'saved' | 'error'>(
    '',
  )
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<ReadonlySet<string>>(new Set())
  const [drag, setDrag] = useState<{
    id: string
    over?: { id: string; after: boolean }
  } | null>(null)
  const [missing, setMissing] = useState(false)
  const gone = useDocumentGone(docs.store, id) || missing
  const latest = useRef<Working | null>(null)
  const detailRef = useRef<Detail | null>(null)
  const version = useRef(0)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const saving = useRef<Promise<void> | null>(null)
  const focus = useRef<Focus | null>(null)
  const nextComment = useRef(-1)

  const apply = useCallback((next: Detail) => {
    detailRef.current = next
    const copy = copyOf(next)
    latest.current = copy
    version.current = next.draft?.draftVersion ?? 0
    dirty.current = false
    clearTimeout(timer.current)
    setDetail(next)
    setWorking(copy)
    setViewing(null)
  }, [])
  const load = useCallback(
    async (signal?: AbortSignal) => apply(await client.detail(id, signal)),
    [client, id, apply],
  )
  useEffect(() => {
    const abort = new AbortController()
    // Loading sets state only after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(abort.signal).catch((error) => {
      if (abort.signal.aborted) return
      if (
        error instanceof TextHttpError &&
        ['gone', 'not-found'].includes(error.code)
      )
        setMissing(true)
      else setLoadError(message(error))
    })
    return () => abort.abort()
  }, [load])

  const author = docs.author(detail?.document.agentId ?? summary?.agentId ?? '')
  // A published revision or a change of turn replaces what is on screen.
  useEffect(() => {
    const shown = detailRef.current
    if (!summary || !shown) return
    if (
      summary.currentRevision === shown.current.number &&
      summary.turn === shown.document.turn
    )
      return
    void client.detail(id).then(
      (next) => {
        const published =
          next.current.number > shown.current.number &&
          next.current.authorKind === 'agent'
        apply(next)
        if (published) {
          setShowChanges(true)
          setNotice(`${author.name} published revision ${next.current.number}.`)
        }
      },
      () => undefined,
    )
  }, [summary, client, id, apply, author.name])
  useEffect(() => {
    if (!notice) return
    const timeout = setTimeout(() => setNotice(''), 6000)
    return () => clearTimeout(timeout)
  }, [notice])

  const editable =
    !!detail && detail.document.turn === 'user' && !viewing && !gone
  const locked = detail?.document.turn === 'agent'

  const save = useCallback(
    async function save(): Promise<void> {
      if (saving.current) {
        await saving.current
        return dirty.current ? save() : undefined
      }
      const copy = latest.current,
        shown = detailRef.current
      if (!dirty.current || !copy || !shown) return
      clearTimeout(timer.current)
      dirty.current = false
      setSaveState('saving')
      saving.current = (async () => {
        try {
          version.current = await client.saveDraft(id, {
            baseRevision: shown.current.number,
            expectedDraftVersion: version.current,
            title: copy.title.trim() || shown.current.title || 'Untitled',
            blocks: copy.blocks.filter(
              (b) =>
                !(
                  isKnown(b) &&
                  (b.type === 'image' || b.type === 'file') &&
                  !b.artifactId
                ),
            ),
            comments: copy.comments,
            note: copy.note,
          })
          setSaveState('saved')
        } catch (error) {
          if (error instanceof TextHttpError && error.code === 'conflict') {
            setSaveState('')
            await load().catch(() => undefined)
            setNotice(
              'This doc changed while you were editing, so the latest version is shown.',
            )
          } else {
            dirty.current = true
            setSaveState('error')
            timer.current = setTimeout(() => void save(), 4000)
          }
        }
      })()
      await saving.current
      saving.current = null
    },
    [client, id, load],
  )
  useEffect(
    () => () => {
      if (dirty.current) void save()
    },
    [save],
  )

  const change = (update: (copy: Working) => Working) => {
    if (!latest.current || !editable) return
    const next = update(latest.current)
    const ids = new Set(next.blocks.map((b) => b.id))
    next.comments = next.comments.filter((c) => ids.has(c.blockId))
    latest.current = next
    setWorking(next)
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(), 800)
  }
  const changeBlocks = (update: (blocks: AnyBlock[]) => AnyBlock[]) =>
    change((copy) => ({ ...copy, blocks: update(copy.blocks) }))
  const updateBlock = (blockId: string, update: (block: Block) => Block) =>
    changeBlocks((blocks) =>
      blocks.map((b) => (b.id === blockId && isKnown(b) ? update(b) : b)),
    )

  useLayoutEffect(() => {
    const target = focus.current
    if (!target || !page.current) return
    focus.current = null
    const element = page.current.querySelector<HTMLElement>(
      `[data-block="${CSS.escape(target.blockId)}"][data-field="${CSS.escape(target.field)}"]`,
    )
    if (!element) return
    placeCaret(element, target.at)
    element.scrollIntoView({ block: 'nearest' })
  })
  const editableFields = () =>
    Array.from(
      page.current?.querySelectorAll<HTMLElement>(
        '.doc-field[contenteditable="true"]',
      ) ?? [],
    )
  const moveFocus = (from: HTMLElement, step: -1 | 1) => {
    const fields = editableFields()
    const next = fields[fields.indexOf(from) + step]
    if (next) placeCaret(next, step < 0 ? 'end' : 'start')
    return !!next
  }

  const shownBlocks = viewing?.blocks ?? working?.blocks ?? []
  const comments = ((): (ShownComment & {
    blockId: string
    field: string
    start: number
    end: number
  })[] => {
    if (!detail || !working || viewing) return []
    const submitted = detail.comments
      .filter(
        (c) =>
          c.state === 'open' || c.resolvedInRevision === detail.current.number,
      )
      .map((c) => ({
        ...c,
        kind: c.state === 'open' ? ('open' as const) : ('resolved' as const),
      }))
    const first = Math.max(0, ...detail.comments.map((c) => c.number)) + 1
    return [
      ...submitted,
      ...working.comments.map((c, index) => ({
        ...c,
        number: first + index,
        kind: 'draft' as const,
        reply: null,
      })),
    ]
  })()
  const marks = (() => {
    const map = new Map<string, FieldMark[]>()
    const pending =
      popover?.kind === 'new-comment'
        ? [
            {
              ...popover.anchor,
              id: 'pending',
              kind: 'draft' as const,
              number: Math.max(0, ...comments.map((c) => c.number)) + 1,
            },
          ]
        : []
    for (const comment of [...comments, ...pending]) {
      const block = shownBlocks.find((b) => b.id === comment.blockId)
      const text =
        block && isKnown(block) ? getField(block, comment.field) : undefined
      if (text === undefined) continue
      const plain = plainText(text)
      let { start, end } = comment
      if (plain.slice(start, end) !== comment.quote) {
        const found = comment.quote ? plain.indexOf(comment.quote) : -1
        start = found < 0 ? plain.length : found
        end = found < 0 ? plain.length : found + comment.quote.length
      }
      const key = `${comment.blockId}\u0000${comment.field}`
      map.set(key, [
        ...(map.get(key) ?? []),
        {
          id: comment.id,
          number: comment.number,
          kind: comment.kind,
          start,
          end,
        },
      ])
    }
    return map
  })()

  const insert = (
    choice: BlockChoice,
    after: string | null,
    replace?: string,
  ) => {
    const block = choice.make()
    changeBlocks((blocks) => {
      if (replace) return blocks.map((b) => (b.id === replace ? block : b))
      const index =
        after === null ? -1 : blocks.findIndex((b) => b.id === after)
      return [...blocks.slice(0, index + 1), block, ...blocks.slice(index + 1)]
    })
    const field = firstField(block)
    if (field) focus.current = { blockId: block.id, field, at: 'start' }
    setPopover(null)
  }

  function onFieldKey(
    event: KeyboardEvent<HTMLElement>,
    element: HTMLElement,
    block: Block,
    name: string,
    multiline: boolean,
  ) {
    if (event.nativeEvent.isComposing) return
    if (popover?.kind === 'insert' && popover.slash) {
      const count = filterChoices(popover.query).length
      const key = event.key
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault()
        setPopover({
          ...popover,
          hot:
            (popover.hot + (key === 'ArrowDown' ? 1 : -1) + count) %
            Math.max(count, 1),
        })
      } else if (key === 'Enter') {
        event.preventDefault()
        const choice = filterChoices(popover.query)[popover.hot]?.choice
        if (choice) insert(choice, popover.after, popover.replace)
      } else if (key === 'Backspace') {
        event.preventDefault()
        if (popover.query)
          setPopover({ ...popover, query: popover.query.slice(0, -1), hot: 0 })
        else setPopover(null)
      } else if (key.length === 1 && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setPopover({ ...popover, query: popover.query + key, hot: 0 })
      }
      return
    }
    const index = shownBlocks.findIndex((b) => b.id === block.id)
    const isText = textual.has(block.type) && name === 'text'
    const item = name.startsWith('item:') ? name.slice(5) : null
    if (event.key === 'Escape') {
      event.stopPropagation()
      element.blur()
      return
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      const selection = getSelection()
      if (selection?.rangeCount && !selection.isCollapsed && block.id) {
        event.preventDefault()
        setPopover({
          kind: 'pill',
          range: selection.getRangeAt(0).cloneRange(),
          field: element,
        })
      }
      return
    }
    if (event.key === '/' && block.type === 'paragraph' && !plainOf(element)) {
      event.preventDefault()
      setPopover({
        kind: 'insert',
        anchor: element,
        after: block.id,
        replace: block.id,
        slash: true,
        query: '',
        hot: 0,
      })
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (isText) {
        const after = splitAtCaret(element, true)
        const before = toMarkdown(element, true)
        const next: Block = { id: newId(), type: 'paragraph', text: after }
        changeBlocks((blocks) =>
          blocks.flatMap((b) =>
            b.id === block.id && isKnown(b)
              ? [setField(b, 'text', before), next]
              : [b],
          ),
        )
        focus.current = { blockId: next.id, field: 'text', at: 'start' }
      } else if (
        item &&
        (block.type === 'list' || block.type === 'checklist')
      ) {
        const at = block.items.findIndex((i) => i.id === item)
        if (!plainOf(element) && at === block.items.length - 1) {
          const next: Block = { id: newId(), type: 'paragraph', text: '' }
          const rest = block.items.filter((i) => i.id !== item)
          changeBlocks((blocks) =>
            blocks.flatMap((b) =>
              b.id !== block.id
                ? [b]
                : rest.length
                  ? [{ ...block, items: rest } as Block, next]
                  : [next],
            ),
          )
          focus.current = { blockId: next.id, field: 'text', at: 'start' }
          return
        }
        const after = splitAtCaret(element, false)
        const before = toMarkdown(element, false)
        const added = { id: newId(), text: after, done: false }
        const items = block.items.flatMap((i) =>
          i.id === item
            ? [
                { ...i, text: before },
                block.type === 'list' ? { id: added.id, text: after } : added,
              ]
            : [i],
        )
        updateBlock(block.id, () => ({ ...block, items }) as Block)
        focus.current = {
          blockId: block.id,
          field: `item:${added.id}`,
          at: 'start',
        }
      }
      return
    }
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault()
      return
    }
    if (event.key === 'Backspace' && caretAt(element, 'start')) {
      const previous = shownBlocks[index - 1]
      if (isText && block.type === 'paragraph') {
        const text = toMarkdown(element, true)
        if (!text) {
          event.preventDefault()
          if (!moveFocus(element, -1) && shownBlocks.length === 1) return
          changeBlocks((blocks) => blocks.filter((b) => b.id !== block.id))
        } else if (
          previous &&
          isKnown(previous) &&
          textual.has(previous.type)
        ) {
          event.preventDefault()
          const joinAt = plainText((previous as { text: string }).text).length
          changeBlocks((blocks) =>
            blocks.flatMap((b) =>
              b.id === block.id
                ? []
                : b.id === previous.id && isKnown(b)
                  ? [
                      setField(
                        b,
                        'text',
                        (previous as { text: string }).text + text,
                      ),
                    ]
                  : [b],
            ),
          )
          focus.current = { blockId: previous.id, field: 'text', at: joinAt }
        }
      } else if (isText) {
        event.preventDefault()
        updateBlock(block.id, () => ({
          id: block.id,
          type: 'paragraph',
          text: toMarkdown(element, true),
        }))
        focus.current = { blockId: block.id, field: 'text', at: 'start' }
      } else if (
        item &&
        (block.type === 'list' || block.type === 'checklist')
      ) {
        const at = block.items.findIndex((i) => i.id === item)
        const text = toMarkdown(element, false)
        if (at > 0) {
          event.preventDefault()
          const prior = block.items[at - 1]
          const joinAt = plainText(prior.text).length
          updateBlock(
            block.id,
            () =>
              ({
                ...block,
                items: block.items.flatMap((i) =>
                  i.id === item
                    ? []
                    : i.id === prior.id
                      ? [{ ...i, text: i.text + text }]
                      : [i],
                ),
              }) as Block,
          )
          focus.current = {
            blockId: block.id,
            field: `item:${prior.id}`,
            at: joinAt,
          }
        } else if (!text) {
          event.preventDefault()
          const rest = block.items.slice(1)
          const next: Block = { id: newId(), type: 'paragraph', text: '' }
          changeBlocks((blocks) =>
            blocks.flatMap((b) =>
              b.id !== block.id
                ? [b]
                : rest.length
                  ? [next, { ...block, items: rest } as Block]
                  : [next],
            ),
          )
          focus.current = { blockId: next.id, field: 'text', at: 'start' }
        }
      }
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    if (event.key === 'ArrowUp' && caretAt(element, 'start')) {
      if (moveFocus(element, -1)) event.preventDefault()
    } else if (event.key === 'ArrowDown' && caretAt(element, 'end')) {
      if (moveFocus(element, 1)) event.preventDefault()
    }
  }

  const field = (block: Block, name: string, options: FieldOptions = {}) => (
    <InlineField
      key={`${block.id}:${name}`}
      blockId={block.id}
      field={name}
      value={getField(block, name) ?? ''}
      editable={editable}
      multiline={options.multiline}
      placeholder={options.placeholder}
      label={options.label}
      as={options.as}
      className={options.className}
      marks={marks.get(`${block.id}\u0000${name}`)}
      onChange={(markdown, anchors) =>
        change((copy) => ({
          ...copy,
          blocks: copy.blocks.map((b) =>
            b.id === block.id && isKnown(b) ? setField(b, name, markdown) : b,
          ),
          comments: copy.comments.map((c) =>
            anchors[c.id] ? { ...c, ...anchors[c.id] } : c,
          ),
        }))
      }
      onKeyDown={(event, element) =>
        onFieldKey(event, element, block, name, !!options.multiline)
      }
    />
  )
  const upload = async (blockId: string, file: File) => {
    const doc = detailRef.current?.document
    if (!media || !doc) return
    setUploading((old) => new Set(old).add(blockId))
    try {
      const receipt = await media.upload(
        {
          uploadId: crypto.randomUUID(),
          target: {
            installationId: docs.scope.installationId,
            callerId: docs.scope.callerId,
            context: doc.context as ChatContext,
            chatId: doc.chatId,
            threadId: doc.threadId,
          },
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          sha256: await digest(file),
          purpose: 'attachment',
        },
        file,
        new AbortController().signal,
        () => undefined,
      )
      if (receipt.status !== 'accepted') throw new Error('Upload not confirmed')
      localFiles.set(receipt.artifact.id, {
        url: URL.createObjectURL(file),
        name: file.name,
        size: file.size,
      })
      updateBlock(
        blockId,
        (b) => ({ ...b, artifactId: receipt.artifact.id }) as Block,
      )
    } catch {
      setNotice('The file could not be uploaded. Try again.')
    } finally {
      setUploading((old) => {
        const next = new Set(old)
        next.delete(blockId)
        return next
      })
    }
  }
  const editor: Editor = {
    documentId: id,
    client,
    editable,
    locked: !!locked,
    field,
    update: updateBlock,
    upload: (blockId, file) => void upload(blockId, file),
    uploading,
    zoom: setZoom,
  }

  // Selected text in a block offers formatting and a comment.
  useEffect(() => {
    const root = page.current
    if (!root || !editable) return
    let frame = 0
    const check = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const selection = getSelection()
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null
        const of = (node: Node) =>
          (node instanceof Element
            ? node
            : node.parentElement
          )?.closest<HTMLElement>('.doc-field')
        const field = range && of(range.startContainer)
        if (
          !range ||
          range.collapsed ||
          !field ||
          field !== of(range.endContainer) ||
          !root.contains(field) ||
          !field.dataset.block ||
          !selection!.toString().trim()
        )
          return setPopover((p) => (p?.kind === 'pill' ? null : p))
        setPopover({ kind: 'pill', range: range.cloneRange(), field })
      })
    }
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.shiftKey || event.key === 'Shift') check()
    }
    root.addEventListener('pointerup', check)
    root.addEventListener('keyup', keys)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('pointerup', check)
      root.removeEventListener('keyup', keys)
    }
  }, [editable, detail])

  // Comment markers live inside field HTML, so one listener opens them all.
  useEffect(() => {
    const root = page.current
    if (!root) return
    const onClick = (event: MouseEvent) => {
      const mark = (event.target as HTMLElement).closest<HTMLElement>(
        '.cm-pin, mark[data-comment]',
      )
      const id = mark?.dataset.comment
      if (!id || id === 'pending') return
      if (mark.tagName === 'MARK' && !getSelection()?.isCollapsed) return
      setPopover({ kind: 'comment', id })
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [detail])

  const startComment = (range: Range, element: HTMLElement) => {
    const text = plainOf(element)
    let start = offsetIn(element, range.startContainer, range.startOffset)
    let end = offsetIn(element, range.endContainer, range.endOffset)
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (start >= end) return setPopover(null)
    const rect = range.getBoundingClientRect()
    getSelection()?.removeAllRanges()
    setPopover({
      kind: 'new-comment',
      rect,
      anchor: {
        blockId: element.dataset.block!,
        field: element.dataset.field!,
        start,
        end,
        quote: text.slice(start, end),
      },
    })
  }
  const pinAnchor = (commentId: string) => () =>
    page.current
      ?.querySelector(`.cm-pin[data-comment="${CSS.escape(commentId)}"]`)
      ?.getBoundingClientRect() ?? null
  const showNextComment = () => {
    const pins = Array.from(
      page.current?.querySelectorAll<HTMLElement>('.cm-pin') ?? [],
    )
    if (!pins.length) return
    nextComment.current = (nextComment.current + 1) % pins.length
    const pin = pins[nextComment.current]
    pin.scrollIntoView({
      block: 'center',
      behavior: reduceMotion ? 'auto' : 'smooth',
    })
    const commentId = pin.dataset.comment!
    page.current
      ?.querySelectorAll(`[data-comment="${CSS.escape(commentId)}"]`)
      .forEach((element) => {
        element.classList.remove('flash')
        void (element as HTMLElement).offsetWidth
        element.classList.add('flash')
      })
    setPopover({ kind: 'comment', id: commentId })
  }

  const submit = async () => {
    setBusy(true)
    try {
      if (!version.current) dirty.current = true
      await save()
      if (dirty.current)
        throw new Error('Your changes could not be saved, so nothing was sent.')
      await client.submit(id, version.current, crypto.randomUUID())
      setPopover(null)
      await load()
    } catch (error) {
      if (error instanceof TextHttpError && error.code === 'conflict')
        await load().catch(() => undefined)
      setNotice(message(error))
    } finally {
      setBusy(false)
    }
  }
  const takeBack = async () => {
    setBusy(true)
    try {
      await client.takeBack(id)
      await load()
      setNotice(`You took the doc back. ${author.name} stopped revising.`)
    } catch (error) {
      setNotice(message(error))
    } finally {
      setBusy(false)
    }
  }
  const view = async (number: number) => {
    setPopover(null)
    if (!detail || number === detail.current.number) return setViewing(null)
    try {
      setViewing(await client.revision(id, number))
    } catch (error) {
      setNotice(message(error))
    }
  }

  const onDragOver = (event: DragEvent<HTMLElement>, blockId: string) => {
    if (!drag || drag.id === blockId) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > rect.top + rect.height / 2
    if (drag.over?.id !== blockId || drag.over.after !== after)
      setDrag({ ...drag, over: { id: blockId, after } })
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    const over = drag?.over
    if (drag && over)
      changeBlocks((blocks) => {
        const moving = blocks.find((b) => b.id === drag.id)
        if (!moving) return blocks
        const rest = blocks.filter((b) => b.id !== drag.id)
        const at =
          rest.findIndex((b) => b.id === over.id) + (over.after ? 1 : 0)
        return [...rest.slice(0, at), moving, ...rest.slice(at)]
      })
    setDrag(null)
  }
  const moveBlock = (blockId: string, step: -1 | 1) =>
    changeBlocks((blocks) => {
      const at = blocks.findIndex((b) => b.id === blockId)
      const to = at + step
      if (at < 0 || to < 0 || to >= blocks.length) return blocks
      const next = [...blocks]
      ;[next[at], next[to]] = [next[to], next[at]]
      return next
    })

  const blockAction = (
    action: (typeof blockActions)[number][0],
    id: string,
  ) => {
    setPopover(null)
    if (action === 'up' || action === 'down')
      return moveBlock(id, action === 'up' ? -1 : 1)
    changeBlocks((blocks) =>
      blocks.flatMap((b) =>
        b.id !== id ? [b] : action === 'duplicate' ? [b, duplicate(b)] : [],
      ),
    )
  }

  const revision = viewing ?? detail?.current
  const changes = revision?.changes
  const hasChanges =
    !!changes && changes.added.length + changes.updated.length > 0
  const baseJson = new Map(
    detail?.current.blocks.map((b) => [b.id, withoutAnswer(b)]),
  )
  const questions = working ? asks(working.blocks) : []
  const authorName = (kind: string, authorId: string) =>
    kind === 'user'
      ? authorId === docs.scope.callerId
        ? 'You'
        : 'Owner'
      : docs.author(authorId).name
  const shownComment =
    popover?.kind === 'comment'
      ? comments.find((c) => c.id === popover.id)
      : undefined

  return (
    <motion.section
      initial={reduceMotion ? { opacity: 0 } : inspectorAway}
      animate={{ opacity: 1, x: 0, rotateY: 0 }}
      exit={
        reduceMotion
          ? { opacity: 0, transition: quickFade }
          : { ...inspectorAway, transition: inspectorExit }
      }
      transition={inspectorArrive}
      style={{ originX: 1, originY: 0.5 }}
      className="thread-pane doc-pane"
      aria-label={`Rich doc: ${detail?.current.title ?? summary?.title ?? ''}`}
    >
      <header className="pane-header">
        <span className="doc-mini" aria-hidden="true">
          <Icon name="doc" size={18} />
        </span>
        <div className="pane-title">
          <p className="thread-eyebrow">
            {expanded ? `${author.name} / Rich doc` : 'Rich doc'}
          </p>
          <h2>
            {working?.title ||
              detail?.current.title ||
              summary?.title ||
              'Rich doc'}
          </h2>
        </div>
        <div className="header-actions">
          {detail && (
            <button
              className="icon-button"
              aria-label="Open the doc’s thread"
              title="Open the doc’s thread"
              onClick={() => onThread(detail.document.threadId)}
            >
              <Icon name="chat" />
            </button>
          )}
          <button
            className="icon-button expand-thread"
            aria-label={expanded ? 'Restore split view' : 'Expand doc'}
            onClick={onExpand}
          >
            <Icon name={expanded ? 'shrink' : 'expand'} />
          </button>
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="Close doc"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      {gone ? (
        <div className="doc-state">
          <Icon name="doc" size={28} />
          <p>This rich doc is no longer available.</p>
        </div>
      ) : !detail || !working ? (
        <div className="doc-state" aria-busy={!loadError}>
          {loadError ? (
            <>
              <p role="alert">{loadError}</p>
              <button
                className="secondary-button"
                onClick={() => {
                  setLoadError('')
                  load().catch((error) => setLoadError(message(error)))
                }}
              >
                Try again
              </button>
            </>
          ) : (
            <p>Opening rich doc…</p>
          )}
        </div>
      ) : (
        <div
          className={`doc ${editable ? '' : 'read-only'} ${locked ? 'locked' : ''} ${showChanges ? '' : 'hide-changes'}`}
        >
          {locked ? (
            <div className="doc-banner revising" aria-live="polite">
              <Avatar
                name={author.name}
                color={author.color}
                kip={author.kip}
              />
              <span className="banner-text">
                <b>{author.name} is revising</b>
                <small>
                  The doc is read only until {author.name} hands it back.
                </small>
              </span>
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() => void takeBack()}
              >
                <Icon name="undo" size={15} />
                Take back
              </button>
              <span className="sweep" aria-hidden="true" />
            </div>
          ) : viewing ? (
            <div className="doc-banner viewing" aria-live="polite">
              <Icon name="history" size={18} />
              <span className="banner-text">
                Viewing <b>revision {viewing.number}</b> by{' '}
                {authorName(viewing.authorKind, viewing.authorId)}. Read only.
              </span>
              <button className="ghost-button" onClick={() => setViewing(null)}>
                Back to latest
              </button>
            </div>
          ) : null}
          <AnimatePresence>
            {notice && (
              <motion.output
                className="doc-notice mat thick lifted"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              >
                {notice}
              </motion.output>
            )}
          </AnimatePresence>
          <div className="doc-scroll">
            <div ref={page} className="doc-page">
              <div className="doc-meta">
                <Avatar
                  name={author.name}
                  color={author.color}
                  kip={author.kip}
                />
                <span>{author.name}</span>
                <span aria-hidden="true">·</span>
                <button
                  className="rev-pill"
                  aria-label={`Revision ${revision!.number}, show revisions`}
                  onClick={(event) =>
                    setPopover({
                      kind: 'revisions',
                      anchor: event.currentTarget,
                    })
                  }
                >
                  <Icon name="history" size={13} />
                  Rev {revision!.number}
                  <Icon name="chevron" size={12} />
                </button>
                <span>Updated {formatTime(detail.document.updatedAt)}</span>
                {hasChanges && (
                  <button
                    className={`rev-pill ${showChanges ? 'on' : ''}`}
                    aria-pressed={showChanges}
                    onClick={() => setShowChanges(!showChanges)}
                  >
                    <Icon name="eye" size={13} />
                    {showChanges ? 'Showing changes' : 'Show changes'}
                  </button>
                )}
              </div>
              <InlineField
                blockId=""
                field="title"
                as="h1"
                className="doc-title"
                value={viewing?.title ?? working.title}
                editable={editable}
                placeholder="Untitled"
                label="Title"
                onChange={(title) => change((copy) => ({ ...copy, title }))}
                onKeyDown={(event, element) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    moveFocus(element, 1)
                  }
                }}
              />
              <div
                className="blocks"
                onDrop={onDrop}
                onDragOver={(e) => drag && e.preventDefault()}
              >
                {shownBlocks.map((block) => {
                  const fresh = changes?.added.includes(block.id)
                    ? 'New'
                    : changes?.updated.includes(block.id)
                      ? 'Updated'
                      : ''
                  const edited =
                    !viewing &&
                    !fresh &&
                    baseJson.get(block.id) !== withoutAnswer(block)
                  const over = drag?.over?.id === block.id ? drag.over : null
                  return (
                    <div
                      key={block.id}
                      data-block-id={block.id}
                      className={`blk blk-${block.type} ${fresh ? 'fresh' : ''} ${edited ? 'edited' : ''} ${drag?.id === block.id ? 'dragging' : ''} ${over ? (over.after ? 'drop-after' : 'drop-before') : ''}`}
                      onDragOver={(event) => onDragOver(event, block.id)}
                    >
                      {editable && (
                        <div className="gutter">
                          <button
                            type="button"
                            aria-label="Add a block below"
                            onClick={(event) =>
                              setPopover({
                                kind: 'insert',
                                anchor: event.currentTarget,
                                after: block.id,
                                slash: false,
                                query: '',
                                hot: -1,
                              })
                            }
                          >
                            <Icon name="plus" size={16} />
                          </button>
                          <button
                            type="button"
                            draggable
                            aria-label="Block options, or drag to move"
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', block.id)
                              const element =
                                event.currentTarget.closest('.blk')
                              if (element)
                                event.dataTransfer.setDragImage(element, 24, 16)
                              setDrag({ id: block.id })
                            }}
                            onDragEnd={() => setDrag(null)}
                            onClick={(event) =>
                              setPopover({
                                kind: 'block',
                                anchor: event.currentTarget,
                                id: block.id,
                              })
                            }
                          >
                            <Icon name="drag" size={16} weight="bold" />
                          </button>
                        </div>
                      )}
                      {fresh && (
                        <span className="fresh-tag">
                          <Icon name="spark" size={11} weight="fill" />
                          {fresh} in rev {revision!.number}
                        </span>
                      )}
                      <BlockBody block={block} editor={editor} />
                    </div>
                  )
                })}
                {editable && (
                  <button
                    type="button"
                    className="doc-add"
                    onClick={(event) =>
                      setPopover({
                        kind: 'insert',
                        anchor: event.currentTarget,
                        after: shownBlocks.at(-1)?.id ?? null,
                        slash: false,
                        query: '',
                        hot: -1,
                      })
                    }
                  >
                    <Icon name="plus" size={15} />
                    Add a block
                  </button>
                )}
              </div>
            </div>
          </div>
          {editable && (
            <SubmitDock
              agentName={author.name}
              answered={questions.filter(answered).length}
              questions={questions.length}
              comments={working.comments.length}
              edits={editCount(detail.current, working)}
              note={working.note}
              saveState={saveState}
              busy={busy}
              onNote={(note) => change((copy) => ({ ...copy, note }))}
              onComments={showNextComment}
              onSubmit={() => void submit()}
            />
          )}
        </div>
      )}
      {popover?.kind === 'pill' && (
        <SelectionPill
          range={popover.range}
          formatting={popover.field.isContentEditable}
          onClose={() => setPopover(null)}
          onComment={() => startComment(popover.range, popover.field)}
        />
      )}
      {popover?.kind === 'new-comment' && (
        <NewComment
          anchor={() => popover.rect}
          agentName={author.name}
          onClose={() => setPopover(null)}
          onSave={(body) => {
            change((copy) => ({
              ...copy,
              comments: [
                ...copy.comments,
                { ...popover.anchor, id: newId(), body },
              ],
            }))
            setPopover(null)
          }}
        />
      )}
      {shownComment && (
        <CommentCard
          anchor={pinAnchor(shownComment.id)}
          comment={shownComment}
          author={author}
          editable={editable}
          onClose={() => setPopover(null)}
          onChange={(body) =>
            change((copy) => ({
              ...copy,
              comments: copy.comments.map((c) =>
                c.id === shownComment.id ? { ...c, body } : c,
              ),
            }))
          }
          onDelete={() => {
            change((copy) => ({
              ...copy,
              comments: copy.comments.filter((c) => c.id !== shownComment.id),
            }))
            setPopover(null)
          }}
        />
      )}
      {popover?.kind === 'insert' && (
        <InsertMenu
          anchor={popover.anchor}
          query={popover.query}
          hot={popover.hot}
          onHot={(hot) => setPopover({ ...popover, hot })}
          onPick={(choice) => insert(choice, popover.after, popover.replace)}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.kind === 'block' && (
        <MenuList
          anchor={popover.anchor}
          label="Block options"
          onClose={() => setPopover(null)}
        >
          {blockActions.map(([action, label, icon]) => (
            <button
              type="button"
              role="menuitem"
              key={action}
              className={action === 'delete' ? 'danger' : ''}
              onClick={() => blockAction(action, popover.id)}
            >
              <Icon name={icon} size={16} />
              {label}
            </button>
          ))}
        </MenuList>
      )}
      {popover?.kind === 'revisions' && detail && (
        <RevisionMenu
          anchor={popover.anchor}
          revisions={detail.revisions}
          current={detail.current.number}
          viewing={revision!.number}
          name={(info) => authorName(info.authorKind, info.authorId)}
          onPick={(number) => void view(number)}
          onClose={() => setPopover(null)}
        />
      )}
      {zoom && <Lightbox url={zoom} onClose={() => setZoom('')} />}
    </motion.section>
  )
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <motion.button
      type="button"
      className="doc-lightbox"
      aria-label="Close image"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={quickFade}
    >
      <motion.img
        src={url}
        alt=""
        initial={{ scale: 0.94 }}
        animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 320, damping: 30 }}
      />
    </motion.button>,
    document.body,
  )
}
