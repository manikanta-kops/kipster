import { checkInteraction, type InteractionInput } from '../modules/work/public.js'
import { MAX_FILES_PER_MESSAGE } from '../modules/artifacts/public.js'

export type Attachment = { path: string } | { artifactId: string } | { documentId: string }
export interface MessageUserInput { text: string; priority: 'silent' | 'normal'; attachments: Attachment[]; element?: InteractionInput }

/** A long answer fits in one message, as a rich doc's Markdown does. */
const MAX_MESSAGE_TEXT_BYTES = 512 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const only = (value: Record<string, unknown>, keys: readonly string[], what: string): void => {
  const extra = Object.keys(value).find(key => !keys.includes(key))
  if (extra !== undefined) throw new Error(`Invalid ${what}: unknown field ${extra}`)
}

/** An ordered attachment list: each item names one source. Rich docs only where `documents` allows them. */
export function attachmentsInput(value: unknown, documents: boolean): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid attachments: a list')
  if (value.length > MAX_FILES_PER_MESSAGE) throw new Error(`Cannot attach more than ${MAX_FILES_PER_MESSAGE} files to one message`)
  const sources = documents ? ['path', 'artifactId', 'documentId'] : ['path', 'artifactId']
  const items = value.map((item): Attachment => {
    if (!record(item)) throw new Error('Invalid attachment: an object')
    only(item, sources, 'attachment')
    const keys = Object.keys(item)
    if (keys.length !== 1) throw new Error(`Invalid attachment: name exactly one of ${sources.join(', ')}`)
    const key = keys[0]!, source = item[key]
    if (typeof source !== 'string' || !source) throw new Error(`Invalid attachment: ${key} must be a non-empty string`)
    if (key !== 'path' && !uuid.test(source)) throw new Error(`Invalid attachment: ${key} must be an ID`)
    return { [key]: source } as Attachment
  })
  const ids = items.flatMap(item => 'path' in item ? [] : [Object.values(item)[0]])
  if (new Set(ids).size !== ids.length) throw new Error('Invalid attachments: an artifact or doc is listed more than once')
  return items
}

function elementInput(value: unknown): InteractionInput {
  if (!record(value)) throw new Error('Invalid element: an object')
  if (value.type === 'choice') {
    only(value, ['type', 'prompt', 'options', 'freeText'], 'choice element')
    const input = { kind: 'question', prompt: value.prompt, options: value.options ?? [], freeText: value.freeText ?? false } as InteractionInput
    checkInteraction(input)
    return input
  }
  if (value.type === 'approval') {
    only(value, ['type', 'prompt', 'proposalId', 'proposal'], 'approval element')
    const input = { kind: 'approval', prompt: value.prompt, proposalId: value.proposalId, proposal: value.proposal } as InteractionInput
    checkInteraction(input)
    return input
  }
  throw new Error('Invalid element: type is choice or approval')
}

/** `message_user` arguments. A message needs text, an attachment or an element; priority defaults to normal. */
export function messageUserInput(args: Record<string, unknown>): MessageUserInput {
  only(args, ['text', 'priority', 'attachments', 'element'], 'message_user arguments')
  if (args.text !== undefined && typeof args.text !== 'string') throw new Error('Invalid text: a string')
  const text = typeof args.text === 'string' && args.text.trim() ? args.text : ''
  if (Buffer.byteLength(text) > MAX_MESSAGE_TEXT_BYTES) throw new Error('Invalid text: at most 512 KiB')
  if (args.priority !== undefined && args.priority !== 'silent' && args.priority !== 'normal') throw new Error('Invalid priority: silent or normal')
  const attachments = attachmentsInput(args.attachments, true)
  const element = args.element === undefined ? undefined : elementInput(args.element)
  if (!text && !attachments.length && !element) throw new Error('A message needs text, an attachment or an element')
  return { text, priority: args.priority === 'silent' ? 'silent' : 'normal', attachments, ...(element ? { element } : {}) }
}
