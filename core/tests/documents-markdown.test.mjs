import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOperations, blockMarkdown, checkBlocks, documentMarkdown, editOperations, parseMarkdown } from '../dist/modules/documents/public.js'

const artifact = '11111111-1111-4111-8111-111111111111'
/** Blocks without generated IDs; answers name option positions. */
const shape = blocks => blocks.map(({ id, ...block }) => {
  void id
  if (block.items) block.items = block.items.map(({ id: itemId, ...item }) => { void itemId; return item })
  if (block.type === 'question') {
    const positions = new Map(block.options.map((option, index) => [option.id, index]))
    block.answer = block.answer && { ...block.answer, optionIds: block.answer.optionIds.map(optionId => positions.get(optionId)) }
    block.options = block.options.map(({ id: optionId, ...option }) => { void optionId; return option })
  }
  return block
})
const roundTrip = blocks => parseMarkdown(documentMarkdown(blocks))

test('every block type survives serializing and parsing', () => {
  const blocks = [
    { id: 'a', type: 'heading', level: 2, text: 'Plan **now**' },
    { id: 'b', type: 'paragraph', text: 'First line with [a link](https://example.com)\nsecond line' },
    { id: 'c', type: 'list', ordered: false, items: [{ id: 'c1', text: 'one' }, { id: 'c2', text: 'two\ncontinued' }] },
    { id: 'd', type: 'list', ordered: true, items: [{ id: 'd1', text: 'first' }, { id: 'd2', text: 'second' }] },
    { id: 'e', type: 'checklist', items: [{ id: 'e1', text: 'open', done: false }, { id: 'e2', text: 'closed', done: true }] },
    { id: 'f', type: 'quote', text: 'quoted\n\nafter a gap' },
    { id: 'g', type: 'callout', tone: 'warning', text: 'Careful' },
    { id: 'g2', type: 'callout', tone: 'success', text: '' },
    { id: 'h', type: 'code', language: 'md', code: 'text with ```fences```\n\n# not a heading' },
    { id: 'i', type: 'divider' },
    { id: 'j', type: 'image', artifactId: artifact, caption: 'A [cat]' },
    { id: 'k', type: 'file', artifactId: artifact },
    { id: 'l', type: 'table', header: ['Name', 'Pipe'], rows: [['a', 'x | y'], ['', 'b']] },
    { id: 'm', type: 'toggle', summary: 'More', text: 'hidden\n---\nstill hidden' },
    { id: 'n', type: 'question', prompt: 'Pick', help: 'Any', multiple: true, other: true, options: [{ id: 'n1', label: 'Red, warm', hint: 'nice' }, { id: 'n2', label: 'Blue', hint: '' }], answer: { optionIds: ['n1', 'n2'], other: 'green' } },
    { id: 'o', type: 'question', prompt: 'Single', help: '', multiple: false, other: false, options: [{ id: 'o1', label: 'Yes', hint: '' }], answer: null },
    { id: 'p', type: 'scale', prompt: 'Sure?', min: 0, max: 10, step: 2, minLabel: 'No', maxLabel: 'Yes', value: 4 },
    { id: 'q', type: 'scale', prompt: 'Unset', min: 1, max: 5, step: 1, minLabel: '', maxLabel: '', value: null },
  ]
  checkBlocks(blocks)
  const parsed = roundTrip(blocks)
  checkBlocks(parsed)
  assert.deepEqual(shape(parsed), shape(blocks))
  assert.equal(new Set(parsed.map(block => block.id)).size, parsed.length)
})

test('text that looks like Markdown structure stays text', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', text: '# not a heading\n- not a list\n1. not ordered\n> not a quote\n| not | a table |\n---\n\\# a backslash\n![x](artifact:abc)\n```' },
    { id: 'b', type: 'list', ordered: false, items: [{ id: 'b1', text: '[x] not a checkbox' }, { id: 'b2', text: 'line\n- not an item' }] },
    { id: 'c', type: 'quote', text: '[!NOTE] not a callout' },
    { id: 'd', type: 'paragraph', text: 'LaTeX \\frac{1}{2} keeps its backslash' },
  ]
  assert.deepEqual(shape(roundTrip(blocks)), shape(blocks))
})

test('kip Markdown follows the dialect and reports mistakes', () => {
  const [question] = parseMarkdown('```question\nprompt: Which?\nmultiple: false\noptions:\n- A | first\n- B\nanswer: B\n```')
  assert.deepEqual(shape([question]), [{ type: 'question', prompt: 'Which?', help: '', multiple: false, other: false, options: [{ label: 'A', hint: 'first' }, { label: 'B', hint: '' }], answer: { optionIds: [1], other: '' } }])
  assert.match(blockMarkdown(question), /answer: B/)
  assert.throws(() => parseMarkdown('```question\noptions:\n- A\n```'), /needs a prompt/)
  assert.throws(() => parseMarkdown('```question\nprompt: Q\noptions:\n- A\nanswer: C\n```'), /"C" is not one of the options/)
  assert.throws(() => parseMarkdown('```question\nprompt: Q\noptions:\n- A\n- B\nanswer: A, B\n```'), /single-choice/)
  assert.throws(() => parseMarkdown('```question\nprompt: Q\noptions:\n- A\nother answer: x\n```'), /needs other: true/)
  assert.throws(() => parseMarkdown('```scale\nprompt: S\nmin: low\n```'), /whole number/)
  const [scale] = parseMarkdown('```scale\nprompt: S\n```')
  assert.deepEqual(shape([scale]), [{ type: 'scale', prompt: 'S', min: 1, max: 5, step: 1, minLabel: '', maxLabel: '', value: null }])
  assert.throws(() => checkBlocks(parseMarkdown('```scale\nprompt: S\nmin: 5\nmax: 1\n```')), /min must be below max/)
  assert.deepEqual(parseMarkdown('#### Deep').map(block => [block.type, block.level]), [['heading', 3]])
  assert.deepEqual(parseMarkdown('> [!TIP]\n> Yes').map(block => [block.type, block.tone, block.text]), [['callout', 'success', 'Yes']])
  assert.deepEqual(parseMarkdown('* a\n* b\n\n2. c').map(block => [block.type, block.ordered, block.items.length]), [['list', false, 2], ['list', true, 1]])
  assert.deepEqual(parseMarkdown('| a |\n|---|\n| 1 | 2 |')[0].header, ['a', ''])
})

test('block and item IDs must be unique and within the limits', () => {
  assert.throws(() => checkBlocks([{ id: 'a', type: 'divider' }, { id: 'a', type: 'divider' }]), /used twice/)
  assert.throws(() => checkBlocks([{ id: 'a', type: 'list', ordered: false, items: [{ id: 'x', text: '' }, { id: 'x', text: '' }] }]), /unique/)
  assert.throws(() => checkBlocks([{ id: 'a', type: 'table', header: ['a'], rows: [['1', '2']] }]), /one cell per column/)
  assert.throws(() => checkBlocks([{ id: 'a', type: 'question', prompt: 'Q', help: '', multiple: false, other: false, options: [{ id: 'o', label: 'A', hint: '' }], answer: { optionIds: ['z'], other: '' } }]), /answers must name its options/)
  assert.throws(() => checkBlocks(Array.from({ length: 501 }, (_, index) => ({ id: `b${index}`, type: 'divider' }))), /at most 500 blocks/)
  checkBlocks([{ id: 'a', type: 'embed', url: 'https://example.com' }])
})

test('edit operations apply in order and keep IDs on a one-block replace', () => {
  const base = { title: 'Doc', resolutions: [], blocks: [
    { id: 'a', type: 'heading', level: 1, text: 'Title' },
    { id: 'b', type: 'checklist', items: [{ id: 'b1', text: 'one', done: true }, { id: 'b2', text: 'two', done: false }] },
    { id: 'c', type: 'question', prompt: 'Q', help: '', multiple: false, other: false, options: [{ id: 'c1', label: 'A', hint: '' }, { id: 'c2', label: 'B', hint: '' }], answer: { optionIds: ['c2'], other: '' } },
  ] }
  const next = applyOperations(base, editOperations([
    { op: 'replace', blockId: 'b', markdown: '- [x] one\n- [x] two\n- [ ] three' },
    { op: 'replace', blockId: 'c', markdown: '```question\nprompt: Q?\noptions:\n- A\n- B\nanswer: B\n```' },
    { op: 'insert', afterBlockId: null, markdown: 'Intro\n\n---' },
    { op: 'move', blockId: 'a', afterBlockId: null },
    { op: 'replace', blockId: 'a', markdown: '# One\n\nTwo' },
    { op: 'title', title: ' Renamed ' },
    { op: 'resolve', commentId: 'k1', reply: 'Done' },
  ]), new Set(['k1']))
  assert.equal(next.title, 'Renamed')
  assert.deepEqual(next.resolutions, [{ commentId: 'k1', reply: 'Done' }])
  assert.deepEqual(next.blocks.map(block => block.type), ['heading', 'paragraph', 'paragraph', 'divider', 'checklist', 'question'])
  assert.ok(!next.blocks.some(block => block.id === 'a'), 'a multi-block replace takes new IDs')
  const checklist = next.blocks.find(block => block.type === 'checklist')
  assert.equal(checklist.id, 'b')
  assert.deepEqual(checklist.items.map(item => item.id).slice(0, 2), ['b1', 'b2'])
  const question = next.blocks.find(block => block.type === 'question')
  assert.equal(question.id, 'c')
  assert.deepEqual(question.answer.optionIds, ['c2'])
  assert.equal(new Set(next.blocks.map(block => block.id)).size, next.blocks.length)
  assert.equal(base.blocks.length, 3, 'the input copy is unchanged')
  assert.throws(() => applyOperations(base, editOperations([{ op: 'delete', blockId: 'missing' }]), new Set()), /not found/)
  assert.throws(() => applyOperations(base, editOperations([{ op: 'resolve', commentId: 'k9' }]), new Set()), /not open/)
  assert.throws(() => editOperations([{ op: 'delete', blockId: 'a', markdown: 'x' }]), /unknown field markdown/)
  assert.throws(() => editOperations([{ op: 'insert', markdown: 'x' }]), /afterBlockId must be a string or null/)
  assert.throws(() => editOperations([{ op: 'rewrite' }]), /op must be one of/)
  assert.throws(() => editOperations([]), /1 to 100/)
})
