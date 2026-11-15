import test from 'node:test'
import assert from 'node:assert/strict'
import { kipInstructions } from '../dist/workflows/kip-instructions.js'

const parts = { kipLine: 'You are Planner, a kip in the Playground workspace.', admin: false, workspace: true, system: '# Installation\n', soul: '# Soul\n\nCalm.\n', identity: '# Identity\n\nPlans.\n', organization: '# Playground\n\nTry things.\n', team: '# Your team\n\n- Writer', linked: '', memoryGuidance: '', plugins: '# Plugins\n\nNone.', skills: '', memories: '# Core memory\n\nLikes tea.' }

test('a kip\'s instructions follow a turn: who it is, how work reaches it, how it works and replies, then itself and its team', () => {
  const text = kipInstructions(parts)
  const order = ['# Kipster\n\nYou are Planner, a kip in the Playground workspace.', '# How work reaches you', '# How you work', '## Find what you need', '## Work with other kips', '# How you reply', '## Rich docs', '# You', '# Soul', '# Identity', '# Playground', '# Your team', '# Plugins', '# Core memory']
  const positions = order.map(part => text.indexOf(part))
  assert.ok(positions.every(position => position >= 0), 'every part is present')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'parts keep their order')
  assert.doesNotMatch(text, /# Installation/, 'a part that is only a heading is left out')
  assert.doesNotMatch(text, /\n{3}/, 'empty parts leave no gaps')
  assert.match(text, /called kips, so "kip" and "agent" mean the same thing/)
  assert.match(text, /Your soul is your character: how you think, speak and treat people\. Your identity is your role/)
})

test('the shared rules say what reaches the person, what each turn is, when to ask and how to reply', () => {
  const text = kipInstructions(parts)
  assert.ok(text.indexOf('**The golden rule: the person sees only what you send with message_user.**') < text.indexOf('# How work reaches you'), 'the golden rule leads the instructions')
  assert.match(text, /A routine is a task set to run on a schedule/)
  assert.match(text, /When the person sends a voice note, you get its transcript: treat it as what they said/)
  assert.match(text, /they come from Kipster, not from the person/)
  assert.match(text, /If they only ask for ideas, advice or a plan, answer that, and wait for them before you carry it out/)
  assert.match(text, /goes out to other people under the person's name, such as an email, a message, a post or a comment, needs their approval first/)
  assert.match(text, /look for it before you ask them or say you do not know/)
  assert.match(text, /For small gaps, pick a sensible option and say which one you picked/)
  assert.match(text, /message it with message_kip without waiting to be told/)
  assert.match(text, /\*\*They asked or gave you a task:\*\* always answer with message_user/)
  assert.match(text, /- \*\*normal\*\* notifies the person[^\n]*\n- \*\*silent\*\* adds the message to the conversation without notifying them/)
  assert.match(text, /write a rich doc with create_rich_doc and attach it to message_user/)
  assert.match(text, /do not raise it again unless something new changes it/)
})

test('the admin kip learns to see every kip\'s work and the Workspaces section, a workspace kip its team', () => {
  const admin = kipInstructions({ ...parts, admin: true, workspace: false, organization: null })
  assert.match(admin, /list_threads shows what every kip is doing or has done/)
  assert.match(admin, /The Workspaces section lists them/)
  assert.match(admin, /copy_attachment_to_workspace with its workspaceId/)
  const member = kipInstructions(parts)
  assert.doesNotMatch(member, /list_threads/)
  assert.match(member, /The Your team section lists the kips you work with/)
  assert.match(member, /To give the workspace its own copy of a file you shared, use copy_attachment_to_workspace/)
  assert.doesNotMatch(kipInstructions({ ...parts, workspace: false }), /copy_attachment_to_workspace/)
})
