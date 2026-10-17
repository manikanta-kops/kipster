import test from 'node:test'
import assert from 'node:assert/strict'
import { turnPrompt } from '../dist/workflows/turn-prompt.js'

const base = { runId: 'run', attemptId: 'attempt', organizationId: null, agentId: 'agent', instructions: 'Core instructions' }
const owner = { kind: 'person', id: 'owner', name: 'Factory Owner' }

test('Core renders the turn: history, the current message and its files', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'current', input: [
    { messageId: 'old', text: '', author: owner, parts: [{ kind: 'file', artifactId: 'gone', purpose: 'attachment', name: 'history.txt', mimeType: 'text/plain', size: 10, availability: 'unavailable' }] },
    { messageId: 'voice', text: '', author: owner, parts: [{ kind: 'file', artifactId: 'note', purpose: 'voice_note', name: 'note.m4a', mimeType: 'audio/mp4', size: 20, availability: 'available', readablePath: '/files/note.m4a', transcription: { status: 'succeeded', provider: 'spokenly', text: 'Call me back' } }] },
    { messageId: 'current', text: 'Look at this', author: owner, parts: [{ kind: 'text', text: 'Look at this' }, { kind: 'file', artifactId: 'photo', purpose: 'attachment', name: 'photo.png', mimeType: 'image/png', size: 30, availability: 'available', readablePath: '/files/photo.png' }] },
  ] })
  assert.equal(prompt, [
    'Kipster conversation history (canonical, ordered):',
    '[old] Factory Owner (the person): [part 1 file; artifact gone; name "history.txt"; MIME text/plain; 10 bytes; content unavailable] The saved file cannot be read. Do not claim to have read its contents.',
    '[voice] Factory Owner (the person): [part 1 voice note; artifact note; name "note.m4a"; MIME audio/mp4; 20 bytes; readable path "/files/note.m4a"] Machine transcript (derived user content, may contain errors): "Call me back"',
    '',
    'Current message [current] from Factory Owner (the person):',
    '[part 1 text]',
    'Look at this',
    '[part 2 file; artifact photo; name "photo.png"; MIME image/png; 30 bytes; readable path "/files/photo.png"]',
  ].join('\n'))
})

test('Core adds saved answers and receipts to the turn', () => {
  const answer = { id: 'earlier', kind: 'question', prompt: 'Which?', options: [{ id: 'opaque', label: 'Human choice' }], freeText: false, response: { actorId: 'human', answer: { kind: 'choice', optionId: 'opaque' }, acceptedAt: '2026-09-23T00:00:00Z' } }
  const prompt = turnPrompt({ ...base, triggerMessageId: 'm', input: [{ messageId: 'm', text: 'Ask once', author: owner }], interactions: [answer], administrationReceipts: { receipts: [{ operationId: 'op', result: { agent: { id: 'saved-agent' } } }], hasMore: false } })
  const sections = prompt.split('\n\n')
  assert.equal(sections[0], 'Current message [m] from Factory Owner (the person):\nAsk once', 'a first message has no history section')
  assert.match(sections[1], /^The human has already answered/)
  assert.match(sections[1], /"optionId":"opaque"/)
  assert.match(sections[1], /Human choice/)
  assert.match(sections[2], /^Saved administration operation receipts/)
  assert.match(sections[2], /saved-agent/)
  assert.equal(sections.length, 3)
})

test('Core leaves out empty administration receipts', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'm', input: [{ messageId: 'm', text: 'Hi', author: owner, parts: [{ kind: 'text', text: 'Hi' }] }], administrationReceipts: { receipts: [], hasMore: false } })
  assert.equal(prompt, 'Current message [m] from Factory Owner (the person):\nHi')
})

test('Core places memory sections before the history, which names its thread', () => {
  const prompt = turnPrompt({ ...base, threadId: 'thread-1', memory: ['Memory search is unavailable this turn.', '2 threads since last night are not searchable yet.'], triggerMessageId: 'm', input: [{ messageId: 'p', text: 'Earlier', author: owner, parts: [{ kind: 'text', text: 'Earlier' }] }, { messageId: 'm', text: 'Hi', author: owner }] })
  assert.equal(prompt, [
    'Memory search is unavailable this turn.',
    '',
    '2 threads since last night are not searchable yet.',
    '',
    'Kipster conversation history of thread thread-1 (canonical, ordered):',
    '[p] Factory Owner (the person): Earlier',
    '',
    'Current message [m] from Factory Owner (the person):',
    'Hi',
  ].join('\n'))
})

const john = { kind: 'admin-kip', id: 'john', name: 'John' }
const planner = { kind: 'kip', id: 'planner', name: 'Planner', workspaces: ['Playground'] }
const text = (messageId, author, value, extra = {}) => ({ messageId, text: value, author, ...extra, parts: [{ kind: 'text', text: value }] })

test('Core labels every history message with its author', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'now', input: [
    text('a', owner, 'Ask Planner'),
    text('b', john, 'On it'),
    text('c', planner, 'Hello'),
    text('d', { ...planner, id: 'writer', name: 'Writer', workspaces: ['Playground', 'Research'] }, 'Two places'),
    text('e', { ...planner, id: 'scout', name: 'Scout', workspaces: ['Playground', 'Research', 'Studio'] }, 'Three places'),
    text('f', { ...planner, id: 'gone', name: 'Gone', workspaces: [] }, 'No workspace'),
    text('g', { kind: 'person', id: 'nameless', name: '' }, 'No name'),
    text('now', owner, 'Thanks'),
  ] })
  assert.equal(prompt, [
    'Kipster conversation history (canonical, ordered):',
    '[a] Factory Owner (the person): Ask Planner',
    '[b] John (admin kip): On it',
    '[c] Planner (kip in Playground): Hello',
    '[d] Writer (kip in Playground and Research): Two places',
    '[e] Scout (kip in Playground, Research and Studio): Three places',
    '[f] Gone (kip): No workspace',
    '[g] The person: No name',
    '',
    'Current message [now] from Factory Owner (the person):',
    'Thanks',
  ].join('\n'))
})

test('Core says which kip a sent message went to and which kip an answer came from', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'now', input: [
    text('ask', owner, 'Ask Planner for the date'),
    text('sent', john, 'Which date?', { kipMessageTo: planner }),
    text('answer', planner, 'March 3.', { kipAnswer: true }),
    text('now', owner, 'Thanks'),
  ] })
  assert.match(prompt, /^\[sent\] John \(admin kip\), message sent with message_kip to Planner \(kip in Playground\): Which date\?$/m)
  assert.match(prompt, /^\[answer\] Planner \(kip in Playground\), answering a message_kip message sent to it from this thread: March 3\.$/m)
})

test('the current message says who wrote it and, from a kip, where the reply goes', () => {
  const sections = (trigger, author) => turnPrompt({ ...base, triggerMessageId: 'now', input: [text('now', author, 'Body')] }, trigger ? { trigger } : {}).split('\n')
  assert.deepEqual(sections(undefined, owner), ['Current message [now] from Factory Owner (the person):', 'Body'], 'a person started the turn by default')
  assert.deepEqual(sections('person', john), ['Current message [now] from John (admin kip):', 'Body'])
  assert.deepEqual(sections('person', planner), ['Current message [now] from Planner (kip in Playground):', 'Body'])
  assert.deepEqual(sections('kip', john), ['Current message [now], a message from John (admin kip) sent to you with message_kip. Your final reply is your answer and goes back to John automatically:', 'Body'])
  assert.deepEqual(sections('kip', planner), ['Current message [now], a message from Planner (kip in Playground) sent to you with message_kip. Your final reply is your answer and goes back to Planner automatically:', 'Body'])
  assert.deepEqual(sections('answer', planner), ['Current message [now], an answer from Planner (kip in Playground) to your earlier message_kip message. Reply to the person in this thread, not to Planner, and never send anything back on your own; to talk back, send a new message_kip. If the answer needs nothing more, end your turn with an empty reply:', 'Body'])
  assert.match(sections('answer', john)[0], /^Current message \[now\], an answer from John \(admin kip\) to your earlier message_kip message\. Reply to the person in this thread, not to John,/)
})

test('the current message keeps the person\'s label in a linked thread', () => {
  const prompt = turnPrompt({ ...base, triggerMessageId: 'now', input: [text('in', john, 'Book a flight'), text('now', owner, 'Use the morning one')] }, { trigger: 'person' })
  assert.equal(prompt, ['Kipster conversation history (canonical, ordered):', '[in] John (admin kip): Book a flight', '', 'Current message [now] from Factory Owner (the person):', 'Use the morning one'].join('\n'))
})
