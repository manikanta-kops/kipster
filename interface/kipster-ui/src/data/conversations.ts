import type { CallerScope } from '@kipster/core/protocol'
export type { CallerScope } from '@kipster/core/protocol'
import type { ChatContext, ContentPart } from '../features/chat/model.js'

export interface ConversationTarget extends CallerScope {
  context: ChatContext
  chatId: string
  threadId?: string
}
export interface Submission {
  submissionId: string
  target: ConversationTarget
  parts: ContentPart[]
}
export type Receipt =
  | {
      status: 'accepted'
      submissionId: string
      target: ConversationTarget
      threadId: string
      messageId: string
      alreadyAccepted?: boolean
    }
  | { status: 'rejected'; submissionId: string; code: string; message: string }
  | { status: 'unknown'; submissionId: string }
export interface ConversationClient {
  submit(submission: Submission, signal: AbortSignal): Promise<Receipt>
  receipt(
    scope: CallerScope,
    submissionId: string,
    signal: AbortSignal,
    target?: ConversationTarget,
  ): Promise<Receipt>
}
