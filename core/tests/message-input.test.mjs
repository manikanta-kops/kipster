import test from 'node:test'
import assert from 'node:assert/strict'
import { attachmentsInput, messageUserInput } from '../dist/workflows/message-input.js'

const id = '0b6f1c2e-6a49-4c3e-9b55-2f4b4f0f7a10', other = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5'

test('message_user needs text, an attachment or an element, and defaults to normal priority', () => {
  assert.deepEqual(messageUserInput({ text: 'Done' }), { text: 'Done', priority: 'normal', attachments: [] })
  assert.equal(messageUserInput({ text: 'Later', priority: 'silent' }).priority, 'silent')
  assert.deepEqual(messageUserInput({ priority: 'normal', attachments: [{ artifactId: id }] }), { text: '', priority: 'normal', attachments: [{ artifactId: id }] })
  for (const args of [{}, { priority: 'normal' }, { text: '   ', priority: 'normal' }]) assert.throws(() => messageUserInput(args), /needs text, an attachment or an element/)
  assert.throws(() => messageUserInput({ text: 'Hi', priority: 'urgent' }), /priority: silent or normal/)
  assert.throws(() => messageUserInput({ text: 'Hi', files: ['a.pdf'] }), /unknown field files/)
  assert.equal(messageUserInput({ text: 'x'.repeat(512 * 1024) }).text.length, 512 * 1024)
  assert.throws(() => messageUserInput({ text: 'x'.repeat(512 * 1024 + 1) }), /at most 512 KiB/)
})

test('attachments keep their order, name one source each and list an artifact or doc once', () => {
  const ordered = [{ path: 'one.pdf' }, { documentId: id }, { artifactId: other }, { path: '/tmp/two.pdf' }]
  assert.deepEqual(messageUserInput({ priority: 'normal', attachments: ordered }).attachments, ordered)
  assert.throws(() => attachmentsInput([{ path: 'a', artifactId: id }], true), /exactly one of path, artifactId, documentId/)
  assert.throws(() => attachmentsInput([{}], true), /exactly one/)
  assert.throws(() => attachmentsInput([{ artifactId: 'not-an-id' }], true), /artifactId must be an ID/)
  assert.throws(() => attachmentsInput([{ path: '' }], true), /path must be a non-empty string/)
  assert.throws(() => attachmentsInput([{ documentId: id }, { documentId: id }], true), /listed more than once/)
  assert.throws(() => attachmentsInput(Array.from({ length: 11 }, (_, index) => ({ path: `${index}.txt` })), true), /more than 10 files/)
  // A kip sends another kip files only.
  assert.throws(() => attachmentsInput([{ documentId: id }], false), /unknown field documentId/)
  assert.deepEqual(attachmentsInput(undefined, false), [])
})

test('elements become the question or approval interaction they show', () => {
  const choice = messageUserInput({ priority: 'normal', element: { type: 'choice', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] } })
  assert.deepEqual(choice.element, { kind: 'question', prompt: 'Which?', options: [{ id: 'a', label: 'A' }], freeText: false })
  assert.deepEqual(messageUserInput({ priority: 'normal', element: { type: 'choice', prompt: 'Why?', freeText: true } }).element, { kind: 'question', prompt: 'Why?', options: [], freeText: true })
  const approval = messageUserInput({ text: 'Ready to send.', priority: 'normal', element: { type: 'approval', prompt: 'Send it?', proposalId: 'send-1', proposal: 'Email the report to Ana.' } })
  assert.deepEqual(approval.element, { kind: 'approval', prompt: 'Send it?', proposalId: 'send-1', proposal: 'Email the report to Ana.' })
  assert.throws(() => messageUserInput({ priority: 'normal', element: { type: 'choice', prompt: 'Which?' } }), /Question needs a choice or free text/)
  assert.throws(() => messageUserInput({ priority: 'normal', element: { type: 'approval', prompt: 'Send?' } }), /Invalid approval proposal/)
  assert.throws(() => messageUserInput({ priority: 'normal', element: { type: 'choice', prompt: 'Which?', freeText: true, proposal: 'x' } }), /unknown field proposal/)
  assert.throws(() => messageUserInput({ priority: 'normal', element: { type: 'scale', prompt: 'How much?' } }), /type is choice or approval/)
})
