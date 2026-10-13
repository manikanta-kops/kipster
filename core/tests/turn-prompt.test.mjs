import test from 'node:test'
import assert from 'node:assert/strict'
import { turnPrompt } from '../dist/workflows/turn-prompt.js'

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

test('Core adds saved answers, delegations and receipts to the turn', () => {
  const answer = { id: 'earlier', kind: 'question', prompt: 'Which?', options: [{ id: 'opaque', label: 'Human choice' }], freeText: false, response: { actorId: 'human', answer: { kind: 'choice', optionId: 'opaque' }, acceptedAt: '2026-09-23T00:00:00Z' } }
  const prompt = turnPrompt({ ...base, triggerMessageId: 'm', input: [{ messageId: 'm', text: 'Ask once' }], interactions: [answer], delegationResults: [{ id: 'd1', recipientAgentId: 'scout', request: 'Look', state: 'completed', result: 'Found it' }], administrationReceipts: { receipts: [{ operationId: 'op', result: { agent: { id: 'saved-agent' } } }], hasMore: false } })
  const sections = prompt.split('\n\n')
  assert.match(sections[1], /Current user message \[m\]:\nAsk once$/)
  assert.match(sections[2], /^The human has already answered/)
  assert.match(sections[2], /"optionId":"opaque"/)
  assert.match(sections[2], /Human choice/)
  assert.match(sections[3], /^Completed delegated tasks/)
  assert.match(sections[3], /Found it/)
  assert.match(sections[4], /^Saved administration operation receipts/)
  assert.match(sections[4], /saved-agent/)
  assert.equal(sections.length, 5)
})

test('Core places memory sections before the history, which names its thread', () => {
  const prompt = turnPrompt({ ...base, threadId: 'thread-1', memory: ['Memory search is unavailable this turn.', '2 threads since last night are not searchable yet.'], triggerMessageId: 'm', input: [{ messageId: 'm', text: 'Hi' }] })
  assert.equal(prompt, [
    'Memory search is unavailable this turn.',
    '',
    '2 threads since last night are not searchable yet.',
    '',
    'Kipster conversation history of thread thread-1 (canonical, ordered):',
    '',
    '',
    'Current user message [m]:',
    'Hi',
  ].join('\n'))
})
