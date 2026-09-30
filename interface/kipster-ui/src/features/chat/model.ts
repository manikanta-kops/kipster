import type { Context, ThreadSnapshot } from '@kipster/core/protocol'

/** Client preview records following the architecture decisions, not final wire schemas. */
export interface Human {
  id: string
  kind: 'human'
  name: string
}
export interface Agent {
  id: string
  kind: 'agent'
  name: string
  description: string
  color: string
  instructions?: string
}
export type Actor = Human | Agent
export interface Organization {
  id: string
  name: string
  description?: string
  instructions?: string
}
export interface Membership {
  id: string
  organizationId: string
  actorId: string
}
export interface AgentGroup {
  id: string
  organizationId: string
  name: string
}
export interface GroupAssignment {
  groupId: string
  membershipId: string
}
export type ChatContext = Context
export interface Chat {
  id: string
  kind: 'direct'
  context: ChatContext
  participantIds: string[]
}
export interface Thread {
  createdAt?: string
  revision?: number
  replyCount?: number
  participantIds?: string[]
  lastMessageAt?: string
  lastReplyAuthor?: string
  id: string
  chatId: string
  rootMessageId: string
  title: string
  /** Ordered references. Message bodies have one home in messagesById. */
  messageIds: string[]
}
/** Local composer metadata, not an uploaded artifact receipt. */
export interface Attachment {
  id: string
  name: string
  size: number
}
export interface Artifact extends Attachment {
  availability: string
  revision?: number
  mimeType?: string
  sha256?: string
  ownership?: {
    kind: string
    id?: string
  }
  provenance?: { kind: string; authorId: string }
}
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'file'; artifactId: string; purpose?: string }
  | { type: 'local-file'; file: Attachment }
  | { type: 'unknown'; originalKind: string }
  | { type: 'removed'; artifactId: string }
export type Preparation = Omit<
  NonNullable<ThreadSnapshot['messages'][number]['preparation']>[number],
  'status'
> & { status: string }
export interface Message {
  timestampKnown?: boolean
  preparation?: Preparation[]
  revision?: number
  status?: 'draft' | 'final'
  submissionId?: string
  id: string
  threadId: string
  authorId: string
  createdAt: string
  parts: ContentPart[]
}
export interface WorkspaceData {
  installationId: string
  currentHumanId: string
  actorsById: Record<string, Actor>
  agentRoles: { agentId: string; role: 'root-admin' }[]
  organizations: Organization[]
  memberships: Membership[]
  groups: AgentGroup[]
  groupAssignments: GroupAssignment[]
  chatsById: Record<string, Chat>
  threadsById: Record<string, Thread>
  messagesById: Record<string, Message>
  artifactsById: Record<string, Artifact>
}

export function findDirectChat(
  data: WorkspaceData,
  humanId: string,
  agentId: string,
  context: ChatContext,
) {
  return Object.values(data.chatsById).find((chat) => {
    const sameContext =
      chat.context.kind === 'organization' && context.kind === 'organization'
        ? chat.context.organizationId === context.organizationId
        : chat.context.kind === 'installation' &&
            context.kind === 'installation'
          ? chat.context.installationId === context.installationId
          : false
    return (
      sameContext &&
      chat.participantIds.length === 2 &&
      chat.participantIds.includes(humanId) &&
      chat.participantIds.includes(agentId)
    )
  })
}

export const rootDraftKey = (chatId: string) => `chat:${chatId}`
export const replyDraftKey = (threadId: string) => `thread:${threadId}`

export function formatTime(timestamp: string) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
export function formatSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
