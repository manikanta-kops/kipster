import { createHash } from 'node:crypto'
import type { TextExecutionContext } from '@kipster/core/adapter'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
/** Stable across tool use IDs and attempts, while retaining every substantive input field. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as ObjectValue)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
/** The input that defines the action. Claude regenerates labels such as a command's `description`, and WebFetch's
 * `prompt` only shapes how fetched content is summarized, so neither is part of what a person approves. */
function action(toolName: string, input: ObjectValue): ObjectValue {
  const ignored = toolName === 'WebFetch' ? ['description', 'prompt'] : ['description']
  return Object.fromEntries(Object.entries(input).filter(([key]) => !ignored.includes(key)))
}
/** A permission prompt answered from a saved interaction, or the cards a person must answer first. */
export type Decision =
  | { kind: 'answered'; behavior: 'allow'; updatedInput: ObjectValue; proposalId?: string }
  | { kind: 'answered'; behavior: 'deny'; message: string }
  | { kind: 'ask'; card: { kind: 'question' | 'approval'; arguments: ObjectValue } }

/**
 * Translates one Claude Code permission prompt. Core saves and resolves the cards: an approval is bound to the exact
 * tool and input, and each AskUserQuestion question becomes a question card whose saved answer is reused.
 */
export function permissionDecision(context: TextExecutionContext, toolName: string, input: ObjectValue): Decision {
  if (toolName === 'AskUserQuestion') return questions(context, input)
  const proposal = canonical({ tool: toolName, input: action(toolName, input) })
  const proposalId = `claude:${createHash('sha256').update(proposal).digest('hex')}`
  const saved = context.interactions?.findLast(item => item.kind === 'approval' && item.proposalId === proposalId && item.proposal === proposal)
  if (saved) {
    const answer = object(saved.response.answer)
    if (answer.kind === 'approve') return { kind: 'answered', behavior: 'allow', updatedInput: input, proposalId }
    return { kind: 'answered', behavior: 'deny', message: `The person declined this action${typeof answer.comment === 'string' && answer.comment ? `: ${answer.comment}` : ''}. Do not retry it.` }
  }
  const summary = typeof input.description === 'string' ? input.description : typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : toolName
  return { kind: 'ask', card: { kind: 'approval', arguments: { proposalId, proposal, prompt: `Claude requests approval to use ${toolName}: ${summary}\n${JSON.stringify(input, null, 2)}` } } }
}

function questions(context: TextExecutionContext, input: ObjectValue): Decision {
  const asked = Array.isArray(input.questions) ? input.questions.map(object) : []
  if (!asked.length) return { kind: 'answered', behavior: 'deny', message: 'AskUserQuestion needs at least one question.' }
  const answers: Record<string, string> = {}
  for (const row of asked) {
    const text = typeof row.question === 'string' ? row.question : ''
    const labels = (Array.isArray(row.options) ? row.options : []).map(option => String(object(option).label ?? '')).filter(Boolean)
    if (!text || labels.length > 5) return { kind: 'answered', behavior: 'deny', message: 'Ask with at most five options per question, or use the Kipster interactions_ask tool.' }
    const options = labels.map((label, index) => ({ id: `option-${index + 1}`, label }))
    const prompt = `${text}${row.multiSelect === true ? '\n(Choose one, or type several answers.)' : ''}`
    const saved = context.interactions?.findLast(item => item.kind === 'question' && item.prompt === prompt && canonical(item.options) === canonical(options) && item.freeText)
    if (!saved) return { kind: 'ask', card: { kind: 'question', arguments: { prompt, options, freeText: true } } }
    const answer = object(saved.response.answer)
    if (answer.kind === 'dismiss') return { kind: 'answered', behavior: 'deny', message: 'The person dismissed the question without answering.' }
    answers[text] = answer.kind === 'choice' ? options.find(option => option.id === answer.optionId)?.label ?? '' : String(answer.text ?? '')
  }
  return { kind: 'answered', behavior: 'allow', updatedInput: { ...input, answers } }
}
