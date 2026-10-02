/** The demo's rich doc: a plan Atlas wrote, the owner commented on, and Atlas revised. */
export const planImage = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d6de"/><stop offset="1" stop-color="#b9a3c9"/></linearGradient>
<linearGradient id="peak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8d7fa8"/><stop offset="1" stop-color="#5f5577"/></linearGradient>
</defs>
<rect width="960" height="540" fill="url(#sky)"/>
<path d="M0 420 L170 250 L280 340 L420 190 L560 330 L700 220 L960 410 L960 540 L0 540 Z" fill="url(#peak)" opacity="0.75"/>
<g fill="#fff" fill-opacity="0.62" stroke="#fff" stroke-opacity="0.9">
<rect x="24" y="24" width="190" height="492" rx="22"/>
<rect x="230" y="24" width="330" height="140" rx="20"/>
<rect x="230" y="178" width="330" height="110" rx="20"/>
<rect x="576" y="24" width="360" height="492" rx="22"/>
</g>
<g fill="#c4386a">
<rect x="600" y="56" width="140" height="10" rx="5" opacity="0.8"/>
<rect x="600" y="210" width="312" height="34" rx="10" opacity="0.25"/>
<rect x="600" y="252" width="312" height="34" rx="10" opacity="0.15"/>
<rect x="600" y="294" width="312" height="34" rx="10" opacity="0.15"/>
<rect x="680" y="452" width="232" height="40" rx="20"/>
</g>
<g fill="#2a1620" opacity="0.22">
<rect x="600" y="84" width="300" height="18" rx="6"/>
<rect x="600" y="120" width="280" height="8" rx="4"/>
<rect x="600" y="138" width="250" height="8" rx="4"/>
<rect x="254" y="56" width="200" height="10" rx="5"/>
<rect x="254" y="80" width="270" height="8" rx="4"/>
<rect x="44" y="140" width="120" height="10" rx="5"/>
<rect x="44" y="176" width="140" height="10" rx="5"/>
<rect x="44" y="212" width="110" height="10" rx="5"/>
</g>
</svg>`
export const planFile = `# Rich docs plan

1. Block format and Markdown dialect in Core
2. Revisions and turn-taking
3. Kip tools
4. Doc card, side pane and full view
`

type Ids = {
  imageId: string
  fileId: string
  agentId: string
  callerId: string
}
const scopeText =
  'Docs live in the workspace where they were created. Docs Kip writes in its own chat stay at the root level, and only Kip sees those by default. Every image in a doc is stored as a file in the same place.'
const scopeRevised = `${scopeText} Kip, as the root kip, can open every doc; workspace kips see a root doc only when Kip shares it.`

function blocks(ids: Ids, revised: boolean) {
  return [
    {
      id: 'tldr',
      type: 'callout',
      tone: 'note',
      text: '**TL;DR.** Kips write rich docs instead of long messages. You answer, edit and comment in one sitting, then press **Submit**. Atlas revises and hands it back as a new revision.',
    },
    { id: 'flow-title', type: 'heading', level: 2, text: 'How a doc moves' },
    {
      id: 'flow',
      type: 'list',
      ordered: true,
      items: [
        {
          id: 'flow-1',
          text: 'Atlas writes the doc and shares it in your thread.',
        },
        {
          id: 'flow-2',
          text: 'You read, answer questions, tick items, edit and comment.',
        },
        {
          id: 'flow-3',
          text: 'You press **Submit**. Everything goes to Atlas in one batch.',
        },
        {
          id: 'flow-4',
          text: 'Atlas revises, replies to each comment and publishes a new revision.',
        },
      ],
    },
    {
      id: 'where',
      type: 'image',
      artifactId: ids.imageId,
      caption: 'Where it opens: the side pane, next to the feed.',
    },
    {
      id: 'open-in',
      type: 'question',
      prompt: 'Where should a rich doc open by default?',
      help: 'You can always expand it to full view.',
      multiple: false,
      other: true,
      answer: null,
      options: [
        {
          id: 'side',
          label: 'Side by side with the chat',
          hint: 'Keep talking to Atlas while you read',
        },
        {
          id: 'full',
          label: 'Full view',
          hint: 'Distraction free, chat one click away',
        },
        {
          id: 'inline',
          label: 'Inside the message',
          hint: 'Best for short docs',
        },
      ],
    },
    { id: 'scope-title', type: 'heading', level: 2, text: 'Scope for phase 1' },
    {
      id: 'scope',
      type: 'checklist',
      items: [
        {
          id: 'scope-1',
          text: 'Block format and Markdown parser in Core',
          done: true,
        },
        { id: 'scope-2', text: 'Revisions and turn-taking', done: true },
        {
          id: 'scope-3',
          text: 'Kip tools: create, read, edit and delete',
          done: false,
        },
        {
          id: 'scope-4',
          text: 'Doc card in chat and the side pane',
          done: false,
        },
        { id: 'scope-5', text: 'Fake Core support for the demo', done: false },
      ],
    },
    {
      id: 'scope-text',
      type: 'paragraph',
      text: revised ? scopeRevised : scopeText,
    },
    ...(revised
      ? [
          {
            id: 'blocks-table',
            type: 'table',
            header: ['Block', 'Phase', 'Notes'],
            rows: [
              ['Rich text', '1', 'Headings, lists, tables, code'],
              ['Question', '1', 'Single, several and “Something else”'],
              ['Checklist', '1', 'State saved in the doc'],
              ['Image and files', '1', 'Stored as artifacts'],
              ['Embed', 'Later', 'Sandboxed HTML and URLs'],
            ],
          },
        ]
      : []),
    {
      id: 'first-blocks',
      type: 'question',
      prompt: 'Which blocks should ship first?',
      help: 'Pick as many as you like.',
      multiple: true,
      other: true,
      answer: null,
      options: [
        { id: 'questions', label: 'Questions', hint: '' },
        { id: 'checklists', label: 'Checklists', hint: '' },
        { id: 'images', label: 'Images and files', hint: '' },
        { id: 'tables', label: 'Tables', hint: '' },
      ],
    },
    {
      id: 'dialect-title',
      type: 'heading',
      level: 3,
      text: 'What Atlas writes',
    },
    {
      id: 'dialect',
      type: 'code',
      language: 'markdown',
      code: '```question\nprompt: Where should a rich doc open?\noptions:\n- Side by side with the chat\n- Full view\nother: true\n```\n\n- [ ] Add the doc card to chat\n![Thread pane](artifact:7f3c2a)',
    },
    ...(revised
      ? [
          {
            id: 'why-turns',
            type: 'toggle',
            summary: 'Why take turns instead of live co-editing?',
            text: 'Turns give every change a clear author and a clean revision. You never fight Atlas for the cursor, and a failed run can’t leave the doc half edited.',
          },
        ]
      : []),
    {
      id: 'confidence',
      type: 'scale',
      prompt: 'How confident are you in this plan?',
      min: 1,
      max: 5,
      step: 1,
      minLabel: 'Unsure',
      maxLabel: 'Ship it',
      value: null,
    },
    { id: 'rule', type: 'divider' },
    {
      id: 'quote',
      type: 'quote',
      text: 'It’s like a rich talk, where we can embed many types of elements.',
    },
    { id: 'plan-file', type: 'file', artifactId: ids.fileId },
  ]
}

export function planHistory(ids: Ids, start: number) {
  const at = (minutes: number) =>
    new Date(start + minutes * 60_000).toISOString()
  const first = blocks(ids, false)
  const last = blocks(ids, true)
  const title = 'Rich docs: v1 plan'
  const quote = 'only Kip sees those by default'
  const revisions = [
    {
      number: 1,
      authorKind: 'agent' as const,
      authorId: ids.agentId,
      title,
      blocks: first,
      note: 'Created the doc',
      changes: { added: first.map((b) => b.id), updated: [], removed: [] },
      createdAt: at(1),
    },
    {
      number: 2,
      authorKind: 'user' as const,
      authorId: ids.callerId,
      title,
      blocks: first,
      note: 'One question on root docs.',
      changes: { added: [], updated: [], removed: [] },
      createdAt: at(12),
    },
    {
      number: 3,
      authorKind: 'agent' as const,
      authorId: ids.agentId,
      title,
      blocks: last,
      note: 'Resolved 1 comment',
      changes: {
        added: ['blocks-table', 'why-turns'],
        updated: ['scope-text'],
        removed: [],
      },
      createdAt: at(15),
    },
  ]
  const comments = [
    {
      id: 'root-docs',
      number: 1,
      blockId: 'scope-text',
      field: 'text',
      quote,
      start: scopeText.indexOf(quote),
      end: scopeText.indexOf(quote) + quote.length,
      body: 'Should workspace kips ever see root docs?',
      state: 'resolved' as const,
      reply:
        'Good call. Workspace kips won’t see root docs unless Kip shares one. I added that to the text.',
      submittedInRevision: 2,
      resolvedInRevision: 3,
      createdAt: at(12),
    },
  ]
  return { revisions, comments, at }
}
