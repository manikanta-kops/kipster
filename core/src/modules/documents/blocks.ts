import { DOCUMENT_LIMITS, documentBlock, type DocumentBlock, type DraftComment } from '../../protocol/documents.js'
import { parseMarkdown, type StoredBlock } from './markdown.js'

const known = new Set(['paragraph', 'heading', 'list', 'checklist', 'quote', 'callout', 'code', 'divider', 'image', 'file', 'table', 'toggle', 'question', 'scale'])
export const isKnown = (block: StoredBlock): block is DocumentBlock => known.has(block.type)
const MAX_ID = 64

/** Throws an `Invalid …` error unless the blocks follow the contract and `DOCUMENT_LIMITS`. */
export function checkBlocks(blocks: readonly StoredBlock[]): void {
  if (blocks.length > DOCUMENT_LIMITS.blocks) throw new Error(`Invalid document: at most ${DOCUMENT_LIMITS.blocks} blocks`)
  const ids = new Set<string>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || !block.id || block.id.length > MAX_ID || typeof block.type !== 'string' || !block.type) throw new Error('Invalid block')
    if (ids.has(block.id)) throw new Error(`Invalid document: block ID ${block.id} is used twice`)
    ids.add(block.id)
    if (!isKnown(block)) continue
    try { documentBlock.parse(block) } catch { throw new Error(`Invalid ${block.type} block ${block.id}`) }
    const unique = (values: readonly { id: string }[], what: string, limit: number) => {
      if (values.length > limit) throw new Error(`Invalid ${block.type} block ${block.id}: at most ${limit} ${what}`)
      const seen = new Set<string>()
      for (const value of values) {
        if (value.id.length > MAX_ID || seen.has(value.id)) throw new Error(`Invalid ${block.type} block ${block.id}: ${what} IDs must be unique`)
        seen.add(value.id)
      }
    }
    if (block.type === 'list' || block.type === 'checklist') unique(block.items, 'items', DOCUMENT_LIMITS.items)
    if (block.type === 'question') {
      unique(block.options, 'options', DOCUMENT_LIMITS.options)
      if (block.answer) {
        const options = new Set(block.options.map(option => option.id))
        if (block.answer.optionIds.some(id => !options.has(id)) || new Set(block.answer.optionIds).size !== block.answer.optionIds.length) throw new Error(`Invalid question block ${block.id}: answers must name its options`)
        if (!block.multiple && block.answer.optionIds.length > 1) throw new Error(`Invalid question block ${block.id}: a single-choice question has one answer`)
        if (!block.other && block.answer.other) throw new Error(`Invalid question block ${block.id}: it does not accept another answer`)
      }
    }
    if (block.type === 'scale') {
      if (block.min >= block.max) throw new Error(`Invalid scale block ${block.id}: min must be below max`)
      if (block.value !== null && (block.value < block.min || block.value > block.max)) throw new Error(`Invalid scale block ${block.id}: value must be between min and max`)
    }
    if (block.type === 'table') {
      if (!block.header.length || block.header.length > DOCUMENT_LIMITS.tableColumns) throw new Error(`Invalid table block ${block.id}: 1 to ${DOCUMENT_LIMITS.tableColumns} columns`)
      if (block.rows.length > DOCUMENT_LIMITS.tableRows) throw new Error(`Invalid table block ${block.id}: at most ${DOCUMENT_LIMITS.tableRows} rows`)
      if (block.rows.some(row => row.length !== block.header.length)) throw new Error(`Invalid table block ${block.id}: every row needs one cell per column`)
    }
  }
  if (Buffer.byteLength(JSON.stringify(blocks)) > DOCUMENT_LIMITS.bytes) throw new Error('Invalid document: too large')
}

export function checkComments(comments: readonly DraftComment[]): void {
  if (comments.length > DOCUMENT_LIMITS.comments) throw new Error(`Invalid comments: at most ${DOCUMENT_LIMITS.comments}`)
  const ids = new Set<string>()
  for (const comment of comments) {
    if (comment.id.length > MAX_ID || ids.has(comment.id)) throw new Error('Invalid comments: IDs must be unique')
    ids.add(comment.id)
  }
}

/** Every block and item ID in the blocks. */
export function usedIds(blocks: readonly StoredBlock[]): Set<string> {
  const ids = new Set<string>()
  for (const block of blocks) {
    ids.add(block.id)
    if (!isKnown(block)) continue
    if (block.type === 'list' || block.type === 'checklist') for (const item of block.items) ids.add(item.id)
    if (block.type === 'question') for (const option of block.options) ids.add(option.id)
  }
  return ids
}

export function artifactIds(blocks: readonly StoredBlock[]): string[] {
  return [...new Set(blocks.flatMap(block => isKnown(block) && (block.type === 'image' || block.type === 'file') ? [block.artifactId] : []))]
}

/** Compares two block lists by block ID. Moving a block is not a change. */
export function changes(before: readonly StoredBlock[], after: readonly StoredBlock[]): { added: string[]; updated: string[]; removed: string[] } {
  const previous = new Map(before.map(block => [block.id, JSON.stringify(block)]))
  const next = new Set(after.map(block => block.id))
  return {
    added: after.filter(block => !previous.has(block.id)).map(block => block.id),
    updated: after.filter(block => previous.has(block.id) && previous.get(block.id) !== JSON.stringify(block)).map(block => block.id),
    removed: before.filter(block => !next.has(block.id)).map(block => block.id),
  }
}

/** The block with its answers, values and checks cleared, to tell content edits from answers. */
export function withoutAnswers(block: StoredBlock): StoredBlock {
  if (!isKnown(block)) return block
  if (block.type === 'question') return { ...block, answer: null }
  if (block.type === 'scale') return { ...block, value: null }
  if (block.type === 'checklist') return { ...block, items: block.items.map(item => ({ ...item, done: false })) }
  return block
}

export const unanswered = (blocks: readonly StoredBlock[]): number =>
  blocks.filter(block => isKnown(block) && ((block.type === 'question' && block.answer === null) || (block.type === 'scale' && block.value === null))).length

/** A replacement keeps the old block's ID, and its item and option IDs by position. */
function keepIds(old: StoredBlock, next: DocumentBlock): DocumentBlock {
  const kept = { ...next, id: old.id } as DocumentBlock
  if (!isKnown(old) || old.type !== kept.type) return kept
  if ((kept.type === 'list' || kept.type === 'checklist') && (old.type === 'list' || old.type === 'checklist')) {
    const items = kept.items.map((item, index) => ({ ...item, id: old.items[index]?.id ?? item.id }))
    return { ...kept, items } as DocumentBlock
  }
  if (kept.type === 'question' && old.type === 'question') {
    const renamed = new Map(kept.options.map((option, index) => [option.id, old.options[index]?.id ?? option.id]))
    return { ...kept, options: kept.options.map(option => ({ ...option, id: renamed.get(option.id)! })), answer: kept.answer ? { ...kept.answer, optionIds: kept.answer.optionIds.map(id => renamed.get(id)!) } : null }
  }
  return kept
}

export interface WorkingCopy { title: string; blocks: StoredBlock[]; resolutions: { commentId: string; reply: string | null }[] }
export type EditOperation =
  | { op: 'replace'; blockId: string; markdown: string }
  | { op: 'insert'; afterBlockId: string | null; markdown: string }
  | { op: 'delete'; blockId: string }
  | { op: 'move'; blockId: string; afterBlockId: string | null }
  | { op: 'title'; title: string }
  | { op: 'resolve'; commentId: string; reply?: string }

const shapes: Record<string, Record<string, 'string' | 'position' | 'optional'>> = {
  replace: { blockId: 'string', markdown: 'string' },
  insert: { afterBlockId: 'position', markdown: 'string' },
  delete: { blockId: 'string' },
  move: { blockId: 'string', afterBlockId: 'position' },
  title: { title: 'string' },
  resolve: { commentId: 'string', reply: 'optional' },
}
/** Validates tool operations exactly. A missing or null `afterBlockId` means the start of the doc. */
export function editOperations(value: unknown): EditOperation[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Invalid operations: supply 1 to 100')
  return value.map((entry, index) => {
    const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null
    const shape = row && typeof row.op === 'string' && Object.hasOwn(shapes, row.op) ? shapes[row.op]! : null
    if (!row || !shape) throw new Error(`Invalid operation ${index}: op must be one of ${Object.keys(shapes).join(', ')}`)
    for (const key of Object.keys(row)) if (key !== 'op' && !Object.hasOwn(shape, key)) throw new Error(`Invalid operation ${index}: unknown field ${key}`)
    for (const [key, kind] of Object.entries(shape)) {
      const field = row[key]
      const valid = kind === 'string' ? typeof field === 'string' : kind === 'position' ? field == null || typeof field === 'string' : field === undefined || typeof field === 'string'
      if (!valid) throw new Error(`Invalid operation ${index}: ${key} must be a string`)
    }
    return (Object.hasOwn(shape, 'afterBlockId') ? { ...row, afterBlockId: row.afterBlockId ?? null } : row) as unknown as EditOperation
  })
}

/** Applies operations in order to a copy; throws without changing `copy` when one fails. */
export function applyOperations(copy: WorkingCopy, operations: readonly EditOperation[], openComments: ReadonlySet<string>): WorkingCopy {
  const blocks = [...copy.blocks]
  const resolutions = [...copy.resolutions]
  let title = copy.title
  const used = usedIds(blocks)
  const at = (blockId: string): number => {
    const index = blocks.findIndex(block => block.id === blockId)
    if (index < 0) throw new Error(`Invalid operation: block ${blockId} not found`)
    return index
  }
  const after = (blockId: string | null): number => blockId === null ? 0 : at(blockId) + 1
  for (const operation of operations) {
    if (operation.op === 'replace') {
      const index = at(operation.blockId)
      const parsed = parseMarkdown(operation.markdown, used)
      blocks.splice(index, 1, ...(parsed.length === 1 ? [keepIds(blocks[index]!, parsed[0]!)] : parsed))
    } else if (operation.op === 'insert') {
      blocks.splice(after(operation.afterBlockId), 0, ...parseMarkdown(operation.markdown, used))
    } else if (operation.op === 'delete') {
      blocks.splice(at(operation.blockId), 1)
    } else if (operation.op === 'move') {
      if (operation.blockId === operation.afterBlockId) throw new Error('Invalid operation: a block cannot move after itself')
      const [moved] = blocks.splice(at(operation.blockId), 1)
      blocks.splice(after(operation.afterBlockId), 0, moved!)
    } else if (operation.op === 'title') {
      const next = operation.title.trim()
      if (!next || next.length > DOCUMENT_LIMITS.titleLength) throw new Error(`Invalid title: 1 to ${DOCUMENT_LIMITS.titleLength} characters`)
      title = next
    } else {
      if (!openComments.has(operation.commentId)) throw new Error(`Invalid operation: comment ${operation.commentId} is not open`)
      if (operation.reply !== undefined && operation.reply.length > 4000) throw new Error('Invalid reply: at most 4000 characters')
      const reply = operation.reply?.trim() ? operation.reply.trim() : null
      const existing = resolutions.findIndex(entry => entry.commentId === operation.commentId)
      if (existing >= 0) resolutions.splice(existing, 1)
      resolutions.push({ commentId: operation.commentId, reply })
    }
  }
  return { title, blocks, resolutions }
}
