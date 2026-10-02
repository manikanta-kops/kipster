import { array, boolean, boundedInteger, clockTime, integer, literal, nonempty, nullable, object, optional, string, union, utcTimestamp, type Infer, type Schema } from './schema.js'
import { directoryAgent, directoryGroup, directoryMembership, directoryOrganization, groupRemoved, membershipRemoved, organizationRemoved, settingsRecord, adaptersChange } from './admin.js'
import { updateStatus } from './updates.js'

export const WIRE_MAJOR = 1
const id = nonempty() // Opaque: consumers must not decode identity or scope from its spelling.
export const context = union(
  object({ kind: literal('installation'), installationId: id }),
  object({ kind: literal('organization'), organizationId: id }),
)
export type Context = Infer<typeof context>
export const callerScope = object({ installationId: id, callerId: id })
export type CallerScope = Infer<typeof callerScope>
export const textPart = object({ kind: literal('text'), text: nonempty() })
export const filePart = object({ kind: literal('file'), artifactId: id, purpose: union(literal('attachment'),literal('voice_note')) })
export type TextPart = Infer<typeof textPart> | Infer<typeof filePart>
/** A file that was removed with its owner, such as a permanently deleted agent. Messages never submit it. */
export const removedPart = object({ kind: literal('removed'), artifactId: id })
const messagePart = union(textPart, filePart, removedPart)
export type MessagePart = Infer<typeof messagePart>
const partList = array(union(textPart, filePart))
const parts: Schema<Infer<typeof partList>> = { describe: () => ({ ...partList.describe(), min: 1, max: 32 }), parse(value: unknown, path = '$') {
  const parsed = partList.parse(value, path)
  if (parsed.length < 1 || parsed.length > 32 || parsed.filter(item=>item.kind==='file').length > 10) throw new TypeError(`Invalid wire value at ${path}`)
  return parsed
} }
const target = object({ context, chatId: id })
export const rootSubmission = object({ version: literal(1), submissionId: id, scope: callerScope, target, mode: literal('root'), parts })
export const replySubmission = object({ version: literal(1), submissionId: id, scope: callerScope, target, mode: literal('reply'), threadId: id, parts })
export const textSubmission = union(rootSubmission, replySubmission)
export type TextSubmission = Infer<typeof textSubmission>
export const directChatRequest = object({ version: literal(1), context, agentId: id })
export type DirectChatRequest = Infer<typeof directChatRequest>
export const directChatResult = object({ version: literal(1), chatId: id }, false)

export const acceptedReceipt = object({ version: literal(1), status: literal('accepted'), submissionId: id, chatId: id, threadId: id, messageId: id, runId: id, alreadyAccepted: boolean() }, false)
export type AcceptedReceipt = Infer<typeof acceptedReceipt>
export const stableError = object({ version: literal(1), code: union(literal('invalid'), literal('not-found'), literal('forbidden'), literal('conflict'), literal('unavailable'), literal('recovery-needed'), literal('resync-required'), literal('gone'), literal('organization-deleted'), literal('membership-removed'), literal('agent-archived'), literal('update-unmanaged'), literal('update-in-progress'), literal('update-already-installed'), literal('update-backup-required'), literal('update-backup-mismatch'), literal('update-confirmation-required')), message: string(), requestId: id }, false)
export type StableError = Infer<typeof stableError>
export const rejectedReceipt = object({ version: literal(1), status: literal('rejected'), submissionId: id, error: stableError }, false)
export const submissionReceipt = union(acceptedReceipt, rejectedReceipt)
export type SubmissionReceipt = Infer<typeof submissionReceipt>
export const receiptLookup = object({ version: literal(1), scope: callerScope, submissionId: id })
export type ReceiptLookup = Infer<typeof receiptLookup>
export const boundedRead = object({ version: literal(1), scope: callerScope, context, chatId: id, threadId: id, before: nullable(id), limit: boundedInteger(1, 100) })
export type BoundedRead = Infer<typeof boundedRead>
export const parseBoundedRead = (value: unknown): BoundedRead => boundedRead.parse(value)
export const message = object({ id, threadId: id, authorId: id, parts: array(messagePart), revision: integer() }, false)
export const historyPage = object({ version: literal(1), messages: array(message), next: nullable(id) }, false)
export const streamScope = union(object({ kind: literal('application'), installationId: id, callerId: id }), object({ kind: literal('thread'), installationId: id, callerId: id, threadId: id }))
export const workState = union(literal('queued'), literal('preparing'), literal('running'), literal('waiting'), literal('cancellation-requested'), literal('completed'), literal('failed'), literal('cancelled'), literal('recovery-needed'))
export const cancelDelivery = union(literal('none'),literal('requested'),literal('acknowledged'),literal('uncertain'),literal('confirmed-ended'),literal('not-needed'))
export const workSummary = object({ runId: id, attemptId: nullable(id), state: workState, queueHold: boolean(), cancelDelivery, revision: integer() }, false)
export const queueEntry = object({ id, threadId: id, messageId: id, acceptanceOrder: integer(), state: union(literal('preparing'), literal('queued'), literal('held'), literal('consumed'), literal('cancelled')), revision: integer() }, false)
export const snapshot = object({ version: literal(1), scope: streamScope, cursor: id, messages: array(message), work: array(workSummary), queue: array(queueEntry), next: nullable(id) }, false)
export const appThreadSummary = object({ threadId: id, chatId: id, contextKind: union(literal('installation'), literal('organization')), contextId: id, agentId: id, revision: integer(), state: string(), lastMessageId: id, createdAt: utcTimestamp() }, false)
export const interactionState = union(literal('pending'), literal('settled'), literal('cancelled'), literal('superseded'))
/**
 * An interaction notification carries its interaction's current state; each change takes the next revision.
 * `preview` is a short single-line excerpt: the reply, the failure reason or the interaction prompt.
 */
export const notification = object({ id, threadId: id, runId: id, kind: union(literal('completed'), literal('failed'), literal('recovery-needed'),literal('interaction')), interactionId: optional(id), interactionState: optional(interactionState), read: boolean(), revision: integer(), createdAt: utcTimestamp(), preview: optional(string()) }, false)
export const appSnapshot = object({ version: literal(1), scope: object({ kind: literal('application'), installationId: id, callerId: id }), cursor: id, threads: array(appThreadSummary), notifications: array(notification), next: nullable(object({ afterThreadId: nullable(id), afterNotificationId: nullable(id) })) }, false)
export const voicePreparation = object({id,artifactId:id,partIndex:integer(),revision:integer(),status:union(literal('preparing'),literal('succeeded'),literal('no-speech'),literal('unavailable')),provider:string(),transcript:optional(string()),error:optional(string())},false)
export const threadMessage = object({ preparation: optional(array(voicePreparation)), id, threadId: id, authorId: id, parts: array(messagePart), final: boolean(), revision: integer(), position: integer() }, false)
export const threadWork = object({ runId: id, attemptId: nullable(id), state: workState, queueHold: boolean(), cancelDelivery, revision: integer(), queuePosition: integer(), messageId: id, failure: nullable(string()) }, false)
export const interactionAnswer = union(
  object({kind:literal('choice'),optionId:id,text:optional(string())}),
  object({kind:literal('text'),text:nonempty()}),
  object({kind:literal('dismiss')}),
  object({kind:literal('approve'),comment:optional(string())}),
  object({kind:literal('decline'),comment:optional(string())}),
)
export const threadInteraction = object({ id, version:literal(1), runId:id, attemptId:id, kind:union(literal('question'),literal('approval')), proposalId:optional(id), proposal:optional(nonempty()), prompt:string(), options:array(object({id,label:nonempty()})), freeText:boolean(), state:interactionState, revision:integer(), sourceAgentId:optional(id), response:optional(object({operationId:id,actorId:id,answer:interactionAnswer,acceptedAt:utcTimestamp()})) }, false)
/** `parentRunId` and `childRunId` are null once the agent that ran that side was permanently deleted. */
export const threadDelegation = object({id,parentRunId:nullable(id),childRunId:nullable(id),senderAgentId:id,recipientAgentId:id,originThreadId:id,depth:integer(),ordinal:integer(),request:string(),state:union(literal('queued'),literal('running'),literal('waiting'),literal('completed'),literal('failed'),literal('cancelled'),literal('recovery-needed')),failure:optional(string()),revision:integer()},false)
export const threadSnapshot = object({ version: literal(1), scope: object({ kind: literal('thread'), installationId: id, callerId: id, threadId: id }), cursor: id, messages: array(threadMessage), work: array(threadWork), interactions:array(threadInteraction), delegations:array(threadDelegation), next: nullable(object({ afterMessagePosition: nullable(integer()), afterWorkPosition: nullable(integer()) })) }, false)
export type AppSnapshot = Infer<typeof appSnapshot>
export type ThreadSnapshot = Infer<typeof threadSnapshot>
export const controlCommand = object({version:literal(1),operationId:id,context,chatId:id,threadId:id,runId:id,attemptId:optional(nullable(id)),action:union(literal('stop'),literal('resume'),literal('retry'),literal('cancel-queued'),literal('steer'))})
export type ControlCommand = Infer<typeof controlCommand>
export const controlReceipt = union(
  object({version:literal(1),operationId:id,outcome:union(literal('accepted'),literal('unsupported'),literal('uncertain'),literal('failed'),literal('rejected')),reason:string(),runId:id,threadId:id,state:workState},false),
  object({version:literal(1),operationId:id,status:literal('unknown')},false),
)
export const interactionResponseCommand = object({version:literal(1),operationId:id,interactionId:id,threadId:id,runId:id,attemptId:id,proposalId:optional(id),answer:interactionAnswer})
export type InteractionResponseCommand = Infer<typeof interactionResponseCommand>
export const interactionResponseReceipt = union(
  object({version:literal(1),operationId:id,outcome:union(literal('accepted'),literal('rejected')),interaction:threadInteraction},false),
  object({version:literal(1),operationId:id,status:literal('unknown')},false),
)
/** Changes the installation learning switch, the default sleep time, or both. */
export const learningUpdate = object({ version: literal(1), enabled: optional(boolean()), sleepTime: optional(clockTime()) })
export type LearningUpdate = Infer<typeof learningUpdate>
/** Changes an agent's learning switch, its sleep time (null follows the installation default), or both. */
export const agentLearningUpdate = object({ version: literal(1), enabled: optional(boolean()), sleepTime: optional(nullable(clockTime())) })
export type AgentLearningUpdate = Infer<typeof agentLearningUpdate>
const agentLearningFields = { agentId: id, enabled: boolean(), sleepTime: nullable(clockTime()), revision: integer(), effective: boolean() }
export const agentLearning = object(agentLearningFields, false)
export const agentLearningResult = object({ version: literal(1), ...agentLearningFields }, false)
export const learningSettings = object({ version: literal(1), enabled: boolean(), sleepTime: clockTime(), revision: integer(), available: boolean(), agents: array(agentLearning) }, false)
export type LearningSettings = Infer<typeof learningSettings>
export const identityFileName = union(literal('AGENTS.md'), literal('soul.md'), literal('identity.md'))
export const identityWrite = object({ version: literal(1), content: string(), expectedSha256: nonempty() })
export type IdentityWrite = Infer<typeof identityWrite>
export const identityRestore = object({ version: literal(1), expectedSha256: nonempty() })
export type IdentityRestore = Infer<typeof identityRestore>
export const identityFile = object({ version: literal(1), agentId: id, file: identityFileName, content: string(), sha256: nonempty() }, false)
export type IdentityFile = Infer<typeof identityFile>
export const identityBackups = object({ version: literal(1), agentId: id, file: identityFileName, backups: array(object({ id, sha256: nonempty(), size: integer(), createdAt: utcTimestamp() }, false)) }, false)
export type IdentityBackups = Infer<typeof identityBackups>
export const learningChange = object({ target: union(literal('installation'), literal('agent')), enabled: boolean(), sleepTime: nullable(clockTime()) }, false)
/** A thread deleted with its chat, for example when its agent was permanently deleted. */
export const threadRemoved = object({ threadId: id, chatId: id }, false)
const eventBase = { version: literal(1), eventId: id, scope: streamScope, cursor: id, occurredAt: utcTimestamp(), resourceId: id, revision: integer() }
export const textEvent = union(
  object({ ...eventBase, type: literal('message-draft'), data: threadMessage }, false),
  object({ ...eventBase, type: literal('message-final'), data: threadMessage }, false),
  object({ ...eventBase, type: literal('work-changed'), data: threadWork }, false),
  object({ ...eventBase, type: literal('interaction-changed'), data: threadInteraction }, false),
  object({ ...eventBase, type: literal('delegation-changed'), data: threadDelegation }, false),
  object({ ...eventBase, type: literal('thread-summary'), data: appThreadSummary }, false),
  object({ ...eventBase, type: literal('notification'), data: notification }, false),
  object({ ...eventBase, type: literal('notification-removed'), data: object({ id, threadId: id }) }, false),
  object({ ...eventBase, type: literal('learning-changed'), data: learningChange }, false),
  object({ ...eventBase, type: literal('updates-changed'), data: updateStatus }, false),
  object({ ...eventBase, type: literal('organization-changed'), data: directoryOrganization }, false),
  object({ ...eventBase, type: literal('agent-changed'), data: directoryAgent }, false),
  object({ ...eventBase, type: literal('membership-changed'), data: directoryMembership }, false),
  object({ ...eventBase, type: literal('group-changed'), data: directoryGroup }, false),
  object({ ...eventBase, type: literal('organization-removed'), data: organizationRemoved }, false),
  object({ ...eventBase, type: literal('membership-removed'), data: membershipRemoved }, false),
  object({ ...eventBase, type: literal('group-removed'), data: groupRemoved }, false),
  object({ ...eventBase, type: literal('thread-removed'), data: threadRemoved }, false),
  object({ ...eventBase, type: literal('settings-changed'), data: settingsRecord }, false),
  object({ ...eventBase, type: literal('adapters-changed'), data: adaptersChange }, false),
  object({ ...eventBase, type: literal('resync-required') }, false),
)
export type TextEvent = Infer<typeof textEvent>

/** Validation alone is insufficient: caller and context authorization precede receipt lookup. */
export function receiptKey(scope: CallerScope, submissionId: string): string {
  return JSON.stringify([scope.installationId, scope.callerId, submissionId])
}
