import { randomInt } from 'node:crypto'
import type { DocumentBlock } from '../../protocol/documents.js'

/** A stored block: one Core understands, or a newer type kept unchanged. */
export type StoredBlock = DocumentBlock | { id: string; type: string; [field: string]: unknown }

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
/** A short random ID that is not in `used`; the new ID is added to it. */
export function shortId(used: Set<string>): string {
  for (;;) {
    let id = ''
    for (let index = 0; index < 8; index++) id += alphabet[randomInt(alphabet.length)]
    if (!used.has(id)) { used.add(id); return id }
  }
}

export class MarkdownError extends Error {
  constructor(message: string) { super(`Invalid markdown: ${message}`) }
}

const fenceOpen = /^\s*(`{3,}|~{3,})\s*([^`\s]*)\s*$/
const heading = /^(#{1,6})\s+(.*)$/
const divider = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const image = /^!\[((?:\\.|[^\]\\])*)\]\(artifact:([^\s)]+)\)\s*$/
const file = /^\[((?:\\.|[^\]\\])*)\]\(artifact:([^\s)]+)\)\s*$/
const checkItem = /^\s*[-*+]\s+\[( |x|X)\](?:\s(.*))?$/
const bulletItem = /^\s*[-*+]\s+(.*)$/
const orderedItem = /^\s*\d+[.)]\s+(.*)$/
const tableSeparator = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const escapable = '\\\\#\\-*+>`|!\\[_~0-9='
const escaped = new RegExp(`^(\\s*)\\\\([${escapable}])`)
const needsEscape = new RegExp(`^\\s*\\\\[${escapable}]`)

/** Whether a line on its own would start a block other than a paragraph. */
function startsBlock(line: string): boolean {
  return fenceOpen.test(line) || heading.test(line) || divider.test(line) || image.test(line) || file.test(line) ||
    checkItem.test(line) || bulletItem.test(line) || orderedItem.test(line) || /^\s*>/.test(line) || /^\s*\|/.test(line)
}
const unescapeLine = (line: string): string => line.replace(escaped, '$1$2')
const escapeLine = (line: string): string => startsBlock(line) || needsEscape.test(line) ? line.replace(/^(\s*)/, '$1\\') : line
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ')

type ItemKind = 'bullet' | 'ordered' | 'check'
function item(line: string): { kind: ItemKind; text: string; done: boolean } | null {
  const check = checkItem.exec(line)
  if (check) return { kind: 'check', text: unescapeLine(check[2] ?? ''), done: check[1] !== ' ' }
  const bullet = bulletItem.exec(line)
  if (bullet) return { kind: 'bullet', text: unescapeLine(bullet[1]!), done: false }
  const ordered = orderedItem.exec(line)
  if (ordered) return { kind: 'ordered', text: unescapeLine(ordered[1]!), done: false }
  return null
}

function tableCells(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'))
}

/** `key: value` lines of a fenced block; keys are case-insensitive. */
function fields(lines: readonly string[]): { key: string; value: string; line: string }[] {
  return lines.map(line => {
    const match = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s?(.*)$/.exec(line)
    return { key: match ? match[1]!.toLowerCase().replace(/\s+/g, ' ') : '', value: match ? match[2]!.trim() : line.trim(), line }
  })
}
function flag(value: string, name: string): boolean {
  if (/^(true|yes)$/i.test(value)) return true
  if (/^(false|no)$/i.test(value)) return false
  throw new MarkdownError(`${name} must be true or false`)
}
function number(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new MarkdownError(`${name} must be a whole number`)
  return Number(value)
}

function question(lines: readonly string[], id: () => string): DocumentBlock {
  let prompt = '', help = '', multiple = false, other = false, otherAnswer = ''
  const options: { id: string; label: string; hint: string }[] = []
  const answers: string[] = []
  let inOptions = false
  for (const entry of fields(lines)) {
    if (!entry.line.trim()) continue
    const option = /^\s*[-*+]\s+(.*)$/.exec(entry.line)
    if (inOptions && option) {
      const [label, ...hint] = option[1]!.split(/(?<!\\)\|/)
      options.push({ id: id(), label: label!.trim().replaceAll('\\|', '|'), hint: hint.join('|').trim().replaceAll('\\|', '|') })
      continue
    }
    inOptions = false
    if (entry.key === 'prompt') prompt = entry.value
    else if (entry.key === 'help') help = entry.value
    else if (entry.key === 'multiple') multiple = flag(entry.value, 'multiple')
    else if (entry.key === 'other') other = flag(entry.value, 'other')
    else if (entry.key === 'options') inOptions = true
    else if (entry.key === 'answer') { if (entry.value) answers.push(entry.value) }
    else if (entry.key === 'other answer') otherAnswer = entry.value
    else throw new MarkdownError(`unknown question line "${entry.line.trim()}"`)
  }
  if (!prompt) throw new MarkdownError('a question needs a prompt line')
  const optionIds: string[] = []
  for (const answer of answers) {
    const exact = options.find(option => option.label === answer)
    const labels = exact ? [answer] : answer.split(',').map(label => label.trim()).filter(Boolean)
    for (const label of labels) {
      const found = options.find(option => option.label === label)
      if (!found) throw new MarkdownError(`answer "${label}" is not one of the options`)
      if (!optionIds.includes(found.id)) optionIds.push(found.id)
    }
  }
  if (!multiple && optionIds.length > 1) throw new MarkdownError('a single-choice question has one answer; set multiple: true')
  if (otherAnswer && !other) throw new MarkdownError('"other answer" needs other: true')
  return { id: id(), type: 'question', prompt, help, multiple, other, options, answer: optionIds.length || otherAnswer ? { optionIds, other: otherAnswer } : null }
}

function scale(lines: readonly string[], id: () => string): DocumentBlock {
  let prompt = '', min = 1, max = 5, step = 1, minLabel = '', maxLabel = ''
  let value: number | null = null
  for (const entry of fields(lines)) {
    if (!entry.line.trim()) continue
    if (entry.key === 'prompt') prompt = entry.value
    else if (entry.key === 'min') min = number(entry.value, 'min')
    else if (entry.key === 'max') max = number(entry.value, 'max')
    else if (entry.key === 'step') step = number(entry.value, 'step')
    else if (entry.key === 'minlabel') minLabel = entry.value
    else if (entry.key === 'maxlabel') maxLabel = entry.value
    else if (entry.key === 'value') value = entry.value ? number(entry.value, 'value') : null
    else throw new MarkdownError(`unknown scale line "${entry.line.trim()}"`)
  }
  if (!prompt) throw new MarkdownError('a scale needs a prompt line')
  return { id: id(), type: 'scale', prompt, min, max, step, minLabel, maxLabel, value }
}

function toggle(lines: readonly string[], id: () => string): DocumentBlock {
  const split = lines.findIndex(line => /^\s*-{3,}\s*$/.test(line))
  const header = split < 0 ? lines : lines.slice(0, split)
  const body = split < 0 ? [] : lines.slice(split + 1)
  let summary = ''
  for (const entry of fields(header)) {
    if (!entry.line.trim()) continue
    if (entry.key === 'summary') summary = entry.value
    else if (!summary) summary = entry.line.trim()
    else throw new MarkdownError(`unknown toggle line "${entry.line.trim()}"`)
  }
  return { id: id(), type: 'toggle', summary, text: body.join('\n').replace(/^\n+|\n+$/g, '') }
}

/** Parses the kip Markdown dialect into blocks with new IDs that are not in `used`. */
export function parseMarkdown(markdown: string, used: Set<string> = new Set()): DocumentBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: DocumentBlock[] = []
  const id = () => shortId(used)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) { i++; continue }
    const fence = fenceOpen.exec(line)
    if (fence) {
      const marker = fence[1]!
      const body: string[] = []
      i++
      while (i < lines.length) {
        const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]!)
        if (closing && closing[1]![0] === marker[0] && closing[1]!.length >= marker.length) break
        body.push(lines[i]!)
        i++
      }
      i++
      const info = fence[2]!
      if (info === 'question') blocks.push(question(body, id))
      else if (info === 'scale') blocks.push(scale(body, id))
      else if (info === 'toggle') blocks.push(toggle(body, id))
      else blocks.push({ id: id(), type: 'code', language: info, code: body.join('\n') })
      continue
    }
    const title = heading.exec(line)
    if (title) { blocks.push({ id: id(), type: 'heading', level: Math.min(title[1]!.length, 3), text: title[2]!.trim() }); i++; continue }
    if (divider.test(line)) { blocks.push({ id: id(), type: 'divider' }); i++; continue }
    const picture = image.exec(line)
    if (picture) { blocks.push({ id: id(), type: 'image', artifactId: picture[2]!, caption: picture[1]!.replace(/\\(.)/g, '$1') }); i++; continue }
    if (file.test(line)) { blocks.push({ id: id(), type: 'file', artifactId: file.exec(line)![2]! }); i++; continue }
    const first = item(line)
    if (first) {
      const items: { id: string; text: string; done: boolean }[] = []
      while (i < lines.length && lines[i]!.trim()) {
        const next = item(lines[i]!)
        if (next && next.kind !== first.kind) break
        if (next) items.push({ id: id(), text: next.text, done: next.done })
        else if (/^\s/.test(lines[i]!) && items.length) items.at(-1)!.text += '\n' + unescapeLine(lines[i]!.replace(/^\s{1,4}/, ''))
        else break
        i++
      }
      blocks.push(first.kind === 'check'
        ? { id: id(), type: 'checklist', items }
        : { id: id(), type: 'list', ordered: first.kind === 'ordered', items: items.map(entry => ({ id: entry.id, text: entry.text })) })
      continue
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) { quoted.push(lines[i]!.replace(/^\s*> ?/, '')); i++ }
      const callout = /^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*(.*)$/i.exec(quoted[0]!)
      if (callout) {
        const kind = callout[1]!.toUpperCase()
        const text = [callout[2]!, ...quoted.slice(1)].filter((part, index) => index > 0 || part).join('\n')
        blocks.push({ id: id(), type: 'callout', tone: kind === 'TIP' ? 'success' : kind === 'WARNING' || kind === 'CAUTION' ? 'warning' : 'note', text })
      } else blocks.push({ id: id(), type: 'quote', text: [quoted[0]!.replace(/^\\\[!/, '[!'), ...quoted.slice(1)].join('\n') })
      continue
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && tableSeparator.test(lines[i + 1]!)) {
      const header = tableCells(line)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) { rows.push(tableCells(lines[i]!)); i++ }
      const width = Math.max(header.length, ...rows.map(row => row.length))
      const pad = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => '')]
      blocks.push({ id: id(), type: 'table', header: pad(header), rows: rows.map(pad) })
      continue
    }
    const text: string[] = [unescapeLine(line)]
    i++
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) { text.push(unescapeLine(lines[i]!)); i++ }
    blocks.push({ id: id(), type: 'paragraph', text: text.join('\n') })
  }
  return blocks
}

function fenced(info: string, body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map(run => run[0].length))
  const marker = '`'.repeat(longest + 1)
  return `${marker}${info}\n${body}${body ? '\n' : ''}${marker}`
}
const itemLines = (text: string): string => {
  const [first = '', ...rest] = text.split('\n')
  const lead = needsEscape.test(first) || /^\[( |x|X)\]/.test(first) ? `\\${first}` : first
  return [lead, ...rest.map(line => `  ${escapeLine(line)}`)].join('\n')
}
const cell = (text: string): string => oneLine(text).replaceAll('|', '\\|')

/** Serializes one block in the kip Markdown dialect. `names` gives file names by artifact ID. */
export function blockMarkdown(block: StoredBlock, names: ReadonlyMap<string, string> = new Map()): string {
  const known = block as DocumentBlock
  switch (known.type) {
    case 'paragraph': return known.text.split('\n').map(escapeLine).join('\n')
    case 'heading': return `${'#'.repeat(known.level)} ${oneLine(known.text)}`
    case 'list': return known.items.map((entry, index) => `${known.ordered ? `${index + 1}.` : '-'} ${itemLines(entry.text)}`).join('\n')
    case 'checklist': return known.items.map(entry => `- [${entry.done ? 'x' : ' '}] ${itemLines(entry.text)}`).join('\n')
    case 'quote': return known.text.split('\n').map((line, index) => index === 0 && line.startsWith('[!') ? `> \\${line}` : line ? `> ${line}` : '>').join('\n')
    case 'callout': return [`> [!${known.tone === 'success' ? 'TIP' : known.tone === 'warning' ? 'WARNING' : 'NOTE'}]`, ...(known.text ? known.text.split('\n').map(line => line ? `> ${line}` : '>') : [])].join('\n')
    case 'code': return fenced(known.language, known.code)
    case 'divider': return '---'
    case 'image': return `![${oneLine(known.caption).replace(/[\]\\]/g, '\\$&')}](artifact:${known.artifactId})`
    case 'file': return `[${oneLine(names.get(known.artifactId) ?? 'file').replace(/[\]\\]/g, '\\$&')}](artifact:${known.artifactId})`
    case 'table': return [`| ${known.header.map(cell).join(' | ')} |`, `| ${known.header.map(() => '---').join(' | ')} |`, ...known.rows.map(row => `| ${row.map(cell).join(' | ')} |`)].join('\n')
    case 'toggle': return fenced('toggle', [`summary: ${oneLine(known.summary)}`, '---', ...(known.text ? [known.text] : [])].join('\n'))
    case 'question': {
      const labels = known.answer ? known.options.filter(option => known.answer!.optionIds.includes(option.id)).map(option => option.label) : []
      return fenced('question', [
        `prompt: ${oneLine(known.prompt)}`,
        ...(known.help ? [`help: ${oneLine(known.help)}`] : []),
        `multiple: ${known.multiple}`,
        `other: ${known.other}`,
        'options:',
        ...known.options.map(option => `- ${oneLine(option.label).replaceAll('|', '\\|')}${option.hint ? ` | ${oneLine(option.hint).replaceAll('|', '\\|')}` : ''}`),
        ...labels.map(label => `answer: ${oneLine(label)}`),
        ...(known.answer?.other ? [`other answer: ${oneLine(known.answer.other)}`] : []),
      ].join('\n'))
    }
    case 'scale': return fenced('scale', [
      `prompt: ${oneLine(known.prompt)}`, `min: ${known.min}`, `max: ${known.max}`, `step: ${known.step}`,
      ...(known.minLabel ? [`minLabel: ${oneLine(known.minLabel)}`] : []), ...(known.maxLabel ? [`maxLabel: ${oneLine(known.maxLabel)}`] : []),
      ...(known.value !== null ? [`value: ${known.value}`] : []),
    ].join('\n'))
    default: return `<!-- block ${block.id} has type "${block.type}", which only the app can show -->`
  }
}

export function documentMarkdown(blocks: readonly StoredBlock[], names?: ReadonlyMap<string, string>): string {
  return blocks.map(block => blockMarkdown(block, names)).join('\n\n')
}
