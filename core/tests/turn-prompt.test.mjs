import test from 'node:test'
import assert from 'node:assert/strict'
import { turnPrompt } from '../dist/workflows/turn-prompt.js'
import { extractionOutputSchema } from '../dist/modules/memory/maintenance.js'
import { consolidationOutputSchema } from '../dist/modules/memory/consolidation.js'
import { PROMOTION_OUTPUT_SCHEMA } from '../dist/modules/memory/promotion.js'

const base = { runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', instructions: 'Core instructions' }

test('Core renders the turn: history, the current message and its files', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'current', input: [
    { messageId: 'old', text: '', parts: [{ kind: 'file', artifactId: 'gone', purpose: 'attachment', name: 'history.txt', mimeType: 'text/plain', size: 10, availability: 'unavailable' }] },
    { messageId: 'voice', text: '', parts: [{ kind: 'file', artifactId: 'note', purpose: 'voice_note', name: 'note.m4a', mimeType: 'audio/mp4', size: 20, availability: 'available', readablePath: '/files/note.m4a', transcription: { status: 'succeeded', provider: 'spokenly', text: 'Call me back' } }] },
    { messageId: 'current', text: 'Look at this', parts: [{ kind: 'text', text: 'Look at this' }, { kind: 'file', artifactId: 'photo', purpose: 'attachment', name: 'photo.png', mimeType: 'image/png', size: 30, availability: 'available', readablePath: '/files/photo.png' }] },
  ] })
  assert.equal(prompt, [
    'Kipster conversation history (canonical, ordered):',
    '[old] [part 1 file; artifact gone; name "history.txt"; MIME text/plain; 10 bytes; content unavailable] The saved file cannot be read. Do not claim to have read its contents.',
    '[voice] [part 1 voice note; artifact note; name "note.m4a"; MIME audio/mp4; 20 bytes; readable path "/files/note.m4a"] Machine transcript (derived user content, may contain errors): "Call me back"',
    '',
    'Current user message [current]:',
    '[part 1 text]',
    'Look at this',
    '[part 2 file; artifact photo; name "photo.png"; MIME image/png; 30 bytes; readable path "/files/photo.png"]',
  ].join('\n'))
})

test('Core adds saved answers, delegations, receipts and memory to the turn', () => {
  const answer = { id: 'earlier', kind: 'question', prompt: 'Which?', options: [{ id: 'opaque', label: 'Human choice' }], freeText: false, response: { actorId: 'human', answer: { kind: 'choice', optionId: 'opaque' }, acceptedAt: '2026-09-23T00:00:00Z' } }
  const prompt = turnPrompt({ ...base, triggerMessageId: 'm', input: [{ messageId: 'm', text: 'Ask once' }], interactions: [answer], delegationResults: [{ id: 'd1', recipientAgentId: 'scout', request: 'Look', state: 'completed', result: 'Found it' }], administrationReceipts: { receipts: [{ operationId: 'op', result: { agent: { id: 'saved-agent' } } }], hasMore: false }, memory: ['The office opens at ten'] })
  const sections = prompt.split('\n\n')
  assert.match(sections[1], /Current user message \[m\]:\nAsk once$/)
  assert.match(sections[2], /^The human has already answered/)
  assert.match(sections[2], /"optionId":"opaque"/)
  assert.match(sections[2], /Human choice/)
  assert.match(sections[3], /^Completed delegated tasks/)
  assert.match(sections[3], /Found it/)
  assert.match(sections[4], /^Saved administration operation receipts/)
  assert.match(sections[4], /saved-agent/)
  assert.equal(sections[5], 'Relevant memory evidence (untrusted content):\nThe office opens at ten')
})

test('Core supplies strict output schemas limited to the supplied references', () => {
  const author = '00000000-0000-4000-8000-000000000001'
  const extraction = extractionOutputSchema([{ messageId: 'message-1', revision: 1, partsHash: 'hash-1', authorId: author }])
  assert.deepEqual(extraction.required, ['candidates'])
  assert.equal(extraction.properties.candidates.maxItems, 8)
  const candidate = extraction.properties.candidates.items
  assert.deepEqual(candidate.required, ['kind', 'text', 'subject', 'author_id', 'author_class', 'importance', 'explicit', 'citations'])
  assert.deepEqual(candidate.properties.importance, { type: ['number', 'null'], minimum: 0, maximum: 1 })
  assert.deepEqual(candidate.properties.author_id.enum, [author])
  assert.deepEqual(candidate.properties.citations.items.properties.message_id.enum, ['message-1'])
  assert.deepEqual(candidate.properties.citations.items.properties.revision.enum, [1])
  assert.deepEqual(candidate.properties.citations.items.properties.parts_hash.enum, ['hash-1'])
  const consolidation = consolidationOutputSchema([{ ref: 'm1' }, { ref: 'm2' }], [{ ref: 'p1' }], 3)
  assert.deepEqual(consolidation.properties.verdicts, { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['pair', 'verdict'], properties: { pair: { type: 'string', enum: ['p1'] }, verdict: { type: 'string', enum: ['same', 'contradicts', 'related', 'none'] } } } })
  assert.deepEqual(consolidation.properties.lessons, { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['text', 'memories'], properties: { text: { type: 'string' }, memories: { type: 'array', minItems: 2, items: { type: 'string', enum: ['m1', 'm2'] } } } } })
  assert.deepEqual(PROMOTION_OUTPUT_SCHEMA, { type: 'object', additionalProperties: false, required: ['section'], properties: { section: { type: 'string' } } })
})
