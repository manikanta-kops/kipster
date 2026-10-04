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
/** A permission prompt answered from a saved interaction or a grant, or the cards a person must answer first. */
export type Decision =
  | { kind: 'answered'; behavior: 'allow'; updatedInput: ObjectValue; proposalId?: string }
  | { kind: 'answered'; behavior: 'deny'; message: string }
  | { kind: 'ask'; card: { kind: 'question' | 'approval'; arguments: ObjectValue } }

type Scope = 'conversation' | 'always'
interface Card { prompt: string; grant: { key: string; label: string; scopes: Scope[] } }
const clip = (text: string, length: number): string => text.length > length ? `${text.slice(0, length - 1)}…` : text
const lines = (...values: unknown[]): string => values.filter(value => typeof value === 'string' && value.trim()).join('\n')
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined
const both: Scope[] = ['conversation', 'always']

/** The card for one tool use: a one-line question with plain detail, and the broader grant the person may choose. */
function card(toolName: string, input: ObjectValue, proposal: string): Card {
  const grant = (key: string, label: string, scopes: Scope[] = both) => ({ key: `claude-cli:${key.length > 400 ? `sha256:${createHash('sha256').update(key).digest('hex')}` : key}`, label: clip(label, 200), scopes })
  const command = text(input.command), path = text(input.file_path) ?? text(input.notebook_path), url = text(input.url)
  if (toolName === 'Bash' && command) return { prompt: lines(`Run \`${clip(command, 160)}\`?`, input.description, command.length > 160 ? command : undefined), grant: grant(`Bash:${command}`, `Run ${command}`) }
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(toolName) && path) return { prompt: lines(`Edit ${path.split('/').at(-1)}?`, path), grant: grant(`edit:${path}`, `Edit ${path}`, ['conversation']) }
  if (toolName === 'WebFetch' && url) {
    let host = url
    try { host = new URL(url).hostname } catch { /* An unparsable URL is granted as written. */ }
    return { prompt: lines(`Open ${clip(url, 160)}?`, input.prompt), grant: grant(`WebFetch:${host}`, `Open pages on ${host}`) }
  }
  if (toolName === 'WebSearch') return { prompt: `Search the web for "${clip(String(input.query ?? ''), 160)}"?`, grant: grant('WebSearch', 'Search the web') }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (mcp) return { prompt: `Use ${mcp[2]} from ${mcp[1]}?`, grant: grant(toolName, `${mcp[1]}: ${mcp[2]}`) }
  const summary = command ?? path ?? url
  return { prompt: lines(`Use ${toolName}?`, summary), grant: grant(`${toolName}:${proposal}`, `Use ${toolName}${summary ? ` on ${summary}` : ''}`, ['conversation']) }
}

/**
 * Translates one Claude Code permission prompt. Core saves and resolves the cards: an approval is bound to the exact
 * tool and input, or covered by a grant the person chose, and each AskUserQuestion question becomes a question card
 * whose saved answer is reused.
 */
export function permissionDecision(context: TextExecutionContext, toolName: string, input: ObjectValue): Decision {
  if (toolName === 'AskUserQuestion') return questions(context, input)
  const proposal = canonical({ tool: toolName, input: action(toolName, input) })
  const shown = card(toolName, input, proposal)
  if (context.permissionMode === 'fullAccess' || context.approvalGrants?.includes(shown.grant.key)) return { kind: 'answered', behavior: 'allow', updatedInput: input }
  const proposalId = `claude:${createHash('sha256').update(proposal).digest('hex')}`
  const saved = context.interactions?.findLast(item => item.kind === 'approval' && item.proposalId === proposalId && item.proposal === proposal)
  if (saved) {
    const answer = object(saved.response.answer)
    if (answer.kind === 'approve') return { kind: 'answered', behavior: 'allow', updatedInput: input, proposalId }
    return { kind: 'answered', behavior: 'deny', message: `The person declined this action${typeof answer.comment === 'string' && answer.comment ? `: ${answer.comment}` : ''}. Do not retry it.` }
  }
  return { kind: 'ask', card: { kind: 'approval', arguments: { proposalId, proposal, prompt: clip(shown.prompt, 8000), grant: shown.grant } } }
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
