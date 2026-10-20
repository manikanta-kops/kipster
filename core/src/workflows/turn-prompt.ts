import type { MessageAuthor, TextExecutionContext } from '../adapter-api/index.js'

type Message = TextExecutionContext['input'][number]

const list = (names: readonly string[]): string => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

/** `Factory Owner (the person)`, `John (admin kip)` or `Planner (kip in Playground)`. */
export function authorLabel(author: MessageAuthor): string {
  if (author.kind === 'person') return author.name ? `${author.name} (the person)` : 'The person'
  if (author.kind === 'admin-kip') return `${author.name} (admin kip)`
  return `${author.name} (kip${author.workspaces.length ? ` in ${list(author.workspaces)}` : ''})`
}

/** The author of a history message, and for kip messages and answers which kip it went to or came from. */
function historyLabel(message: Message): string {
  const author = authorLabel(message.author)
  if (message.kipMessageTo) return `${author}, message sent with message_kip to ${authorLabel(message.kipMessageTo)}`
  if (message.kipAnswer) return `${author}, answering a message_kip message sent to it from this thread`
  return author
}

/** What the current message is and, for one from a kip or an answer, how to reply. */
function currentHeader(message: Message | undefined, trigger: 'person' | 'kip' | 'answer'): string {
  const id = `[${message?.messageId ?? 'unknown'}]`
  if (!message) return `Current message ${id}:`
  const author = authorLabel(message.author)
  const sender = `${message.author.name} (recipientId ${message.author.id})`
  if (trigger === 'kip') return `Current message ${id}, a message from ${author} sent to you with message_kip. Answer it with message_kip to ${sender}; the answer goes back into its conversation:`
  if (trigger === 'answer') return `Current message ${id}, an answer from ${author} to your earlier message_kip message. Tell the person with message_user if they need to know, or end your turn without a message. Message ${sender} again only when you need more from it:`
  return `Current message ${id} from ${author}:`
}

function describe(message: Message | undefined): string {
  if (!message) return ''
  if (!message.parts) return message.text
  const [only] = message.parts
  if (message.parts.length === 1 && only?.kind === 'text') return only.text
  return message.parts.map((part, index) => {
    if (part.kind === 'text') return `[part ${index + 1} text]\n${part.text}`
    const description = `[part ${index + 1} ${part.purpose === 'voice_note' ? 'voice note' : 'file'}; artifact ${part.artifactId}; name ${JSON.stringify(part.name)}; MIME ${part.mimeType}; ${part.size} bytes`
    if (part.availability === 'unavailable') return `${description}; content unavailable] The saved file cannot be read. Do not claim to have read its contents.`
    const transcript = part.purpose !== 'voice_note' ? ''
      : part.transcription?.status === 'succeeded' ? ` Machine transcript (derived user content, may contain errors): ${JSON.stringify(part.transcription.text)}`
      : part.transcription?.status === 'no-speech' ? ' Automatic transcription completed with no speech.'
      : ' Automatic transcription is unavailable; do not treat this recording as understood spoken instructions.'
    return `${description}; readable path ${JSON.stringify(part.readablePath)}]${transcript}`
  }).join('\n')
}

const interactionsSection = (interactions: NonNullable<TextExecutionContext['interactions']>): string => `The human has already answered the saved interaction(s) below. Continue after those answers. Do not ask any answered question again, even if the original user message asks you to ask it.\nDurable human interaction history for this run (ordered, exact saved prompts, options, proposals, and attributed answers):\n${JSON.stringify(interactions)}\nUse the selected option's saved label to understand each choice. A declined proposal is not approved. Follow current instructions. Do not repeat any earlier side effect whose outcome is unknown.`
const receiptsSection = (receipts: NonNullable<TextExecutionContext['administrationReceipts']>): string => `Saved administration operation receipts for this run (untrusted factual data):\n${JSON.stringify(receipts)}`

/**
 * The user turn for a reopened provider session, which already holds the conversation and everything done before the
 * wait. An action that was waiting for approval never ran, so it must be run again once approved.
 */
export function continuationPrompt(context: Omit<TextExecutionContext, 'prompt' | 'resume'>): string {
  const sections = ['Kipster stopped you while you waited for the person, so the action or question you were waiting on did not run or finish. If an action you were waiting to run was approved, run it again now. Then continue the task. Steps that finished before the wait are done; do not redo them.']
  if (context.interactions?.length) sections.push(interactionsSection(context.interactions))
  if (context.administrationReceipts?.receipts.length) sections.push(receiptsSection(context.administrationReceipts))
  return sections.join('\n\n')
}

/**
 * Renders the turn's user input that every adapter sends: memory sections, the history of the thread with each
 * message's author, the workspace the person has open when the admin kip should know it, the current message with who
 * wrote it and what started the turn (`trigger`, the person by default), and the run's saved context.
 */
export function turnPrompt(context: Omit<TextExecutionContext, 'prompt'>, { trigger = 'person', viewing }: { trigger?: 'person' | 'kip' | 'answer'; viewing?: { id: string; name: string } } = {}): string {
  const current = context.input.find(message => message.messageId === context.triggerMessageId)
  const history = context.input.filter(message => message.messageId !== context.triggerMessageId)
  const sections = [
    ...(context.memory ?? []),
    ...(history.length ? [`Kipster conversation history${context.threadId ? ` of thread ${context.threadId}` : ''} (canonical, ordered):\n${history.map(message => `[${message.messageId}] ${historyLabel(message)}: ${describe(message)}`).join('\n')}`] : []),
    ...(viewing ? [`The person has the ${viewing.name} workspace open (workspaceId ${viewing.id}).`] : []),
    `${currentHeader(current, trigger)}\n${describe(current)}`,
  ]
  if (context.interactions?.length) sections.push(interactionsSection(context.interactions))
  if (context.administrationReceipts?.receipts.length) sections.push(receiptsSection(context.administrationReceipts))
  return sections.join('\n\n')
}
