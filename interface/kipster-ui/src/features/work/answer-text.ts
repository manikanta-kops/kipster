import { record } from '../../data/response'
import type { Interaction } from '../../data/work'
export function answerText(answer: unknown, interaction?: Interaction): string {
  if (!record(answer))
    return typeof answer === 'string' ? answer : 'Recorded response'
  const kind =
    typeof answer.kind === 'string' ? answer.kind : 'Recorded response'
  if (kind === 'choice' && typeof answer.optionId === 'string')
    return `${interaction?.options.find((o) => o.id === answer.optionId)?.label ?? answer.optionId}${typeof answer.text === 'string' && answer.text ? ` — ${answer.text}` : ''}`
  if (kind === 'text' && typeof answer.text === 'string') return answer.text
  if (kind === 'dismiss') return 'Dismissed without an answer'
  if (kind === 'approve' || kind === 'decline') {
    const action = interaction?.grant?.label
    const said =
      kind === 'decline'
        ? 'Declined'
        : answer.scope === 'always' && action
          ? `Always allowed ${action}`
          : answer.scope === 'conversation' && action
            ? `Allowed ${action} in this conversation`
            : 'Approved'
    return `${said}${typeof answer.comment === 'string' && answer.comment ? ` — ${answer.comment}` : ''}`
  }
  return kind
}
