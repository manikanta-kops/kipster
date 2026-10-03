import { isKnown, type AnyBlock, type Block } from '../../data/documents'

export const newId = () => crypto.randomUUID().slice(0, 8)

export type BlockChoice = {
  id: string
  label: string
  hint: string
  make: () => Block
}
export const blockChoices: { group: string; items: BlockChoice[] }[] = [
  {
    group: 'Write',
    items: [
      {
        id: 'paragraph',
        label: 'Text',
        hint: 'Plain writing',
        make: () => ({ id: newId(), type: 'paragraph', text: '' }),
      },
      {
        id: 'heading',
        label: 'Heading',
        hint: 'Section title',
        make: () => ({ id: newId(), type: 'heading', level: 2, text: '' }),
      },
      {
        id: 'subheading',
        label: 'Subheading',
        hint: 'Smaller title',
        make: () => ({ id: newId(), type: 'heading', level: 3, text: '' }),
      },
      {
        id: 'list',
        label: 'Bulleted list',
        hint: 'Simple points',
        make: () => ({
          id: newId(),
          type: 'list',
          ordered: false,
          items: [{ id: newId(), text: '' }],
        }),
      },
      {
        id: 'numbered',
        label: 'Numbered list',
        hint: 'Steps in order',
        make: () => ({
          id: newId(),
          type: 'list',
          ordered: true,
          items: [{ id: newId(), text: '' }],
        }),
      },
      {
        id: 'quote',
        label: 'Quote',
        hint: 'Words worth repeating',
        make: () => ({ id: newId(), type: 'quote', text: '' }),
      },
      {
        id: 'callout',
        label: 'Callout',
        hint: 'Make something stand out',
        make: () => ({ id: newId(), type: 'callout', tone: 'note', text: '' }),
      },
      {
        id: 'toggle',
        label: 'Toggle',
        hint: 'Details that open on click',
        make: () => ({ id: newId(), type: 'toggle', summary: '', text: '' }),
      },
      {
        id: 'code',
        label: 'Code',
        hint: 'A snippet',
        make: () => ({ id: newId(), type: 'code', language: '', code: '' }),
      },
      {
        id: 'divider',
        label: 'Divider',
        hint: 'Break between sections',
        make: () => ({ id: newId(), type: 'divider' }),
      },
    ],
  },
  {
    group: 'Ask',
    items: [
      {
        id: 'question',
        label: 'Question',
        hint: 'Options plus your own answer',
        make: () => ({
          id: newId(),
          type: 'question',
          prompt: '',
          help: '',
          multiple: false,
          other: true,
          options: [
            { id: newId(), label: 'First option', hint: '' },
            { id: newId(), label: 'Second option', hint: '' },
          ],
          answer: null,
        }),
      },
      {
        id: 'checklist',
        label: 'Checklist',
        hint: 'Items to tick off',
        make: () => ({
          id: newId(),
          type: 'checklist',
          items: [{ id: newId(), text: '', done: false }],
        }),
      },
      {
        id: 'scale',
        label: 'Scale',
        hint: 'Rate from 1 to 5',
        make: () => ({
          id: newId(),
          type: 'scale',
          prompt: '',
          min: 1,
          max: 5,
          step: 1,
          minLabel: 'Low',
          maxLabel: 'High',
          value: null,
        }),
      },
    ],
  },
  {
    group: 'Media',
    items: [
      {
        id: 'image',
        label: 'Image',
        hint: 'Upload a picture',
        make: () => ({
          id: newId(),
          type: 'image',
          artifactId: '',
          caption: '',
        }),
      },
      {
        id: 'file',
        label: 'File',
        hint: 'Attach a document',
        make: () => ({ id: newId(), type: 'file', artifactId: '' }),
      },
      {
        id: 'table',
        label: 'Table',
        hint: 'Rows and columns',
        make: () => ({
          id: newId(),
          type: 'table',
          header: ['Column', 'Column'],
          rows: [
            ['', ''],
            ['', ''],
          ],
        }),
      },
    ],
  },
]

/** Text a comment can point at, by the field names in the protocol. */
export function getField(block: Block, field: string): string | undefined {
  const [kind, a, b] = field.split(':')
  if (kind === 'item' && (block.type === 'list' || block.type === 'checklist'))
    return block.items.find((i) => i.id === a)?.text
  if (kind === 'option' && block.type === 'question')
    return block.options.find((o) => o.id === a)?.label
  if (kind === 'cell' && block.type === 'table')
    return Number(a) === -1
      ? block.header[Number(b)]
      : block.rows[Number(a)]?.[Number(b)]
  const value = (block as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : undefined
}

export function setField(block: Block, field: string, value: string): Block {
  const [kind, a, b] = field.split(':')
  if (kind === 'item' && (block.type === 'list' || block.type === 'checklist'))
    return {
      ...block,
      items: block.items.map((i) => (i.id === a ? { ...i, text: value } : i)),
    } as Block
  if (kind === 'option' && block.type === 'question')
    return {
      ...block,
      options: block.options.map((o) =>
        o.id === a ? { ...o, label: value } : o,
      ),
    }
  if (kind === 'cell' && block.type === 'table') {
    const row = Number(a),
      column = Number(b)
    if (row === -1)
      return {
        ...block,
        header: block.header.map((h, c) => (c === column ? value : h)),
      }
    return {
      ...block,
      rows: block.rows.map((cells, r) =>
        r === row
          ? cells.map((cell, c) => (c === column ? value : cell))
          : cells,
      ),
    }
  }
  return { ...block, [field]: value } as Block
}

export const asks = (blocks: AnyBlock[]) =>
  blocks.filter(
    (b): b is Extract<Block, { type: 'question' | 'scale' }> =>
      isKnown(b) && (b.type === 'question' || b.type === 'scale'),
  )
export function answered(
  block: Extract<Block, { type: 'question' | 'scale' }>,
) {
  if (block.type === 'scale') return block.value !== null
  return (
    !!block.answer &&
    (block.answer.optionIds.length > 0 || !!block.answer.other.trim())
  )
}

/** A block's content without its answer, to tell edits from answers. */
export const withoutAnswer = (b: AnyBlock) =>
  JSON.stringify(
    isKnown(b) && b.type === 'question'
      ? { ...b, answer: null }
      : isKnown(b) && b.type === 'scale'
        ? { ...b, value: null }
        : b,
  )
const strip = withoutAnswer

/** Blocks the user changed, beyond answering: added, removed or edited. */
export function editCount(
  base: { title: string; blocks: AnyBlock[] },
  next: { title: string; blocks: AnyBlock[] },
) {
  const before = new Map(base.blocks.map((b) => [b.id, strip(b)]))
  const after = new Set(next.blocks.map((b) => b.id))
  let count = base.title === next.title ? 0 : 1
  for (const block of next.blocks)
    if (before.get(block.id) !== strip(block)) count++
  for (const id of before.keys()) if (!after.has(id)) count++
  return count
}

export function filterChoices(query: string) {
  const q = query.trim().toLowerCase()
  return blockChoices.flatMap(({ group, items }) =>
    items
      .filter(
        (c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q),
      )
      .map((choice) => ({ group, choice })),
  )
}
