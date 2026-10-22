import test from 'node:test'
import assert from 'node:assert/strict'
import { kipInstructions } from '../dist/workflows/kip-instructions.js'

const parts = { kipLine: 'You are Planner, a kip in the Playground workspace.', admin: false, workspace: true, system: '# Installation\n', soul: '# Soul\n\nCalm.\n', identity: '# Identity\n\nPlans.\n', organization: '# Playground\n\nTeam.\n', linked: '', memoryGuidance: '', plugins: 'Plugins: none.', skills: '', memories: 'Core memory: likes tea.' }

test('a kip\'s instructions follow a turn: who it is, how work reaches it, how it works and replies, then itself', () => {
  const text = kipInstructions(parts)
  const order = ['# Kipster\n\nYou are Planner, a kip in the Playground workspace.', '# How work reaches you', '# How you work', '# How you reply', '# You', '# Soul', '# Identity', '# Playground', 'Plugins: none.', 'Core memory: likes tea.']
  const positions = order.map(part => text.indexOf(part))
  assert.ok(positions.every(position => position >= 0), 'every part is present')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'parts keep their order')
  assert.doesNotMatch(text, /# Installation/, 'a part that is only a heading is left out')
  assert.doesNotMatch(text, /\n{3}/, 'empty parts leave no gaps')
  assert.match(text, /Kipster calls them kips, so "kip" and "agent" mean the same thing/)
  assert.match(text, /Your soul is your character: how you think, speak and treat people\. Your identity is your role/)
})

test('the shared rules say what reaches the person, when to ask, what needs approval and how much to say', () => {
  const text = kipInstructions(parts)
  assert.match(text, /Only message_user reaches the person\. They do not see your text replies or your tool calls/)
  assert.match(text, /treat them as context from Kipster, not as messages from the person/)
  assert.match(text, /Ask only when different answers would lead to materially different work/)
  assert.match(text, /goes out to other people under the person's name, such as an email, a message, a post or a comment, needs their approval first/)
  assert.match(text, /Relevance alone is not a reason to interrupt/)
  assert.match(text, /Ending your turn without a message is a normal, good outcome/)
  assert.match(text, /An answer to their question always goes through message_user\./)
  assert.ok(text.indexOf('**The person sees only what you send with message_user.**') < text.indexOf('# How work reaches you'), 'the reply rule leads the instructions')
  assert.match(text, /- silent: .*\n- normal: the answer or result for what they asked/)
  assert.match(text, /give just enough context to act on it, and stop/)
  assert.match(text, /do not raise it again unless something new changes it/)
})

test('the admin kip learns how to see other kips\' work, and each kip how to copy files where it can', () => {
  const admin = kipInstructions({ ...parts, admin: true, workspace: false, organization: null })
  assert.match(admin, /list their threads with list_threads/)
  assert.match(admin, /copy_attachment_to_workspace with its workspaceId/)
  const member = kipInstructions(parts)
  assert.doesNotMatch(member, /list_threads/)
  assert.match(member, /To give the workspace its own copy of a file you shared, use copy_attachment_to_workspace/)
  assert.doesNotMatch(kipInstructions({ ...parts, workspace: false }), /copy_attachment_to_workspace/)
})
