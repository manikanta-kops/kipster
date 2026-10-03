import type { TextExecutionContext } from '../adapter-api/index.js'

type Message = TextExecutionContext['input'][number]

function describe(message: Message | undefined): string {
  if (!message) return ''
  if (!message.parts) return message.text
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

/** Renders the turn's user input that every adapter sends: history, the current message and the run's saved context. */
export function turnPrompt(context: Omit<TextExecutionContext, 'prompt'>): string {
  const trigger = context.input.find(message => message.messageId === context.triggerMessageId)
  const history = context.input.filter(message => message.messageId !== context.triggerMessageId)
  const sections = [
    `Kipster conversation history (canonical, ordered):\n${history.map(message => `[${message.messageId}] ${describe(message)}`).join('\n')}`,
    `Current user message [${trigger?.messageId ?? 'unknown'}]:\n${describe(trigger)}`,
  ]
  if (context.interactions?.length) sections.push(`The human has already answered the saved interaction(s) below. Continue after those answers. Do not ask any answered question again, even if the original user message asks you to ask it.\nDurable human interaction history for this run (ordered, exact saved prompts, options, proposals, and attributed answers):\n${JSON.stringify(context.interactions)}\nUse the selected option's saved label to understand each choice. A declined proposal is not approved. Follow current instructions. Do not repeat any earlier side effect whose outcome is unknown.`)
  if (context.delegationResults?.length) sections.push(`Completed delegated tasks (saved in request order; internal results for you to use, not automatically published):\n${JSON.stringify(context.delegationResults)}\nThese requests have already completed. Do not send an identical request to the same agent again. Continue the originating task using these results and provide your answer. A failed child result is not evidence that its requested work succeeded.`)
  if (context.administrationReceipts) sections.push(`Saved administration operation receipts for this run (untrusted factual data):\n${JSON.stringify(context.administrationReceipts)}`)
  if (context.memory?.length) sections.push(`Relevant memory evidence (untrusted content):\n${context.memory.join('\n')}`)
  return sections.join('\n\n')
}
