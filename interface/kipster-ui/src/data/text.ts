import type {
  AcceptedReceipt,
  AppSnapshot,
  CallerScope,
  MessagePart,
  TextEvent,
  ThreadSnapshot,
} from '@kipster/core/protocol'
import { check, incompatible, list, record, TextHttpError } from './response.ts'
import { readEvents } from './sse.ts'
import { isProtocolRange, type ProtocolRange } from './compatibility.ts'
export { TextHttpError } from './response.ts'
import type {
  ConversationClient,
  Receipt,
  Submission,
} from './conversations.js'
import {
  directoryEventTypes,
  parseDirectory,
  parseDirectoryEvent,
  type Directory,
  type DirectoryEvent,
  type DirectoryEventType,
} from './directory.ts'

export type Scope = CallerScope
export type Bootstrap = Scope & {
  organizationId: string
  rootAgentId: string
  coreVersion: string
  protocol: ProtocolRange
  capabilities?: { voiceRecording: boolean; notificationActions?: boolean }
}
export type Summary = {
  -readonly [
    K in keyof Omit<AppSnapshot['threads'][number], 'contextKind'>
  ]: Omit<AppSnapshot['threads'][number], 'contextKind'>[K]
} & {
  contextKind: string
}
export type InteractionState = string
export type Notice = {
  -readonly [
    K in keyof Omit<
      AppSnapshot['notifications'][number],
      'kind' | 'interactionState'
    >
  ]: Omit<AppSnapshot['notifications'][number], 'kind' | 'interactionState'>[K]
} & { kind: string; interactionState?: InteractionState }
type CorePreparation = NonNullable<
  ThreadSnapshot['messages'][number]['preparation']
>[number]
type Preparation = {
  -readonly [K in keyof CorePreparation]: CorePreparation[K]
}
type CoreMessage = Omit<
  ThreadSnapshot['messages'][number],
  'parts' | 'preparation'
>
export type TextMessage = {
  -readonly [K in keyof CoreMessage]: CoreMessage[K]
} & {
  preparation?: (Omit<Preparation, 'status'> & { status: string })[]
  parts: (
    | Extract<MessagePart, { kind: 'text' | 'removed' }>
    | (Omit<Extract<MessagePart, { kind: 'file' }>, 'purpose'> & {
        purpose: string
      })
    | { kind: 'unknown'; originalKind: string }
  )[]
}
type CoreWork = Omit<ThreadSnapshot['work'][number], 'state' | 'cancelDelivery'>
export type TextWork = { -readonly [K in keyof CoreWork]: CoreWork[K] } & {
  state: string
  cancelDelivery: string
}
type CoreInteraction = ThreadSnapshot['interactions'][number]
type InteractionFields = Omit<
  CoreInteraction,
  'version' | 'kind' | 'state' | 'response'
>
export type TextInteraction = {
  -readonly [K in keyof InteractionFields]: InteractionFields[K]
} & {
  version: number
  kind: string
  state: InteractionState
  response?: Omit<NonNullable<CoreInteraction['response']>, 'answer'> & {
    answer: unknown
  }
}
type CoreDelegation = Omit<ThreadSnapshot['delegations'][number], 'state'>
export type TextDelegation = {
  -readonly [K in keyof CoreDelegation]: CoreDelegation[K]
} & {
  state: string
}
export type AppPage = Omit<
  AppSnapshot,
  'version' | 'threads' | 'notifications'
> & {
  version: number
  threads: Summary[]
  notifications: Notice[]
}
export type ThreadPage = Omit<
  ThreadSnapshot,
  'version' | 'messages' | 'work' | 'interactions' | 'delegations'
> & {
  version: number
  messages: TextMessage[]
  work: TextWork[]
  interactions: TextInteraction[]
  delegations: TextDelegation[]
}
export type NotificationRemoved = Extract<
  TextEvent,
  { type: 'notification-removed' }
>['data']
export type ThreadRemoved = Extract<
  TextEvent,
  { type: 'thread-removed' }
>['data']
export type WireEvent = Omit<TextEvent, 'version' | 'type' | 'data'> & {
  version: number
  type:
    | 'message-draft'
    | 'message-final'
    | 'work-changed'
    | 'interaction-changed'
    | 'delegation-changed'
    | 'thread-summary'
    | 'notification'
    | 'thread-removed'
    | 'notification-removed'
    | DirectoryEventType
    | 'unsupported'
  data:
    | TextMessage
    | TextWork
    | TextInteraction
    | TextDelegation
    | Summary
    | Notice
    | ThreadRemoved
    | NotificationRemoved
    | DirectoryEvent['data']
    | null
}
const eventTypes = new Set([
  'message-draft',
  'message-final',
  'work-changed',
  'interaction-changed',
  'delegation-changed',
  'thread-summary',
  'notification',
  'thread-removed',
  'notification-removed',
])

/** Core refusals that end a request for good; the client explains them in plain words. */
const refusals: Record<string, string> = {
  gone: 'This conversation is no longer available.',
  'organization-deleted':
    'This organization is being deleted, so it can’t take new messages.',
  'membership-removed':
    'This kip is no longer a member of the organization, so it can’t take new messages.',
  'agent-archived': 'This kip is archived, so it can’t take new messages.',
}
export const isRefusal = (code: string) => Object.hasOwn(refusals, code)
export const refusalMessage = (code: string) =>
  isRefusal(code) ? refusals[code] : 'This request was refused.'
/** A failed response as a coded error; a refusal keeps Core's code with a plain message. */
export async function httpError(response: Response): Promise<TextHttpError> {
  const error: unknown = await response.json().catch(() => null)
  const code =
    record(error) && typeof error.code === 'string'
      ? error.code
      : response.status === 410
        ? 'gone'
        : 'unavailable'
  if (isRefusal(code)) return new TextHttpError(refusalMessage(code), code)
  return new TextHttpError(
    record(error) && typeof error.message === 'string'
      ? error.message
      : `Backend unavailable (HTTP ${response.status}).`,
    code,
  )
}
const sameScope = (a: Scope, b: Scope) =>
  a.installationId === b.installationId && a.callerId === b.callerId
const nullableText = (value: unknown) =>
  value === null || typeof value === 'string'

export function parseSummary(value: unknown): Summary {
  check(
    record(value) &&
      typeof value.threadId === 'string' &&
      typeof value.chatId === 'string' &&
      typeof value.contextKind === 'string' &&
      typeof value.contextId === 'string' &&
      typeof value.agentId === 'string' &&
      typeof value.revision === 'number' &&
      typeof value.state === 'string' &&
      typeof value.createdAt === 'string',
  )
  return value as Summary
}
/** Threads in a context kind this app does not know have no chat to open or target. */
const knownContext = (summary: Summary) =>
  summary.contextKind === 'organization' ||
  summary.contextKind === 'installation'
export function parseNotice(value: unknown): Notice {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.threadId === 'string' &&
      typeof value.runId === 'string' &&
      typeof value.kind === 'string' &&
      typeof value.read === 'boolean' &&
      typeof value.revision === 'number' &&
      typeof value.createdAt === 'string' &&
      (value.interactionId === undefined ||
        typeof value.interactionId === 'string') &&
      (value.interactionState === undefined ||
        typeof value.interactionState === 'string') &&
      (value.preview === undefined || typeof value.preview === 'string'),
  )
  return value as Notice
}
export function parseMessage(value: unknown): TextMessage {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.threadId === 'string' &&
      typeof value.authorId === 'string' &&
      typeof value.position === 'number' &&
      typeof value.revision === 'number' &&
      typeof value.final === 'boolean',
  )
  const parts = list(value.parts, (part): TextMessage['parts'][number] => {
    check(record(part) && typeof part.kind === 'string')
    if (part.kind === 'text') {
      check(typeof part.text === 'string')
      return part as Extract<MessagePart, { kind: 'text' }>
    }
    if (part.kind === 'file' || part.kind === 'removed') {
      check(typeof part.artifactId === 'string')
      if (part.kind === 'file') check(typeof part.purpose === 'string')
      return part as Extract<
        TextMessage['parts'][number],
        { kind: 'file' | 'removed' }
      >
    }
    return { kind: 'unknown', originalKind: part.kind }
  })
  const preparation =
    value.preparation === undefined
      ? undefined
      : list(value.preparation, (p) => {
          check(
            record(p) &&
              typeof p.id === 'string' &&
              typeof p.partIndex === 'number' &&
              typeof p.status === 'string' &&
              typeof p.provider === 'string' &&
              (p.transcript === undefined ||
                typeof p.transcript === 'string') &&
              (p.error === undefined || typeof p.error === 'string'),
          )
          return p as NonNullable<TextMessage['preparation']>[number]
        })
  return {
    ...value,
    parts,
    ...(preparation === undefined ? {} : { preparation }),
  } as TextMessage
}
export function parseWork(value: unknown): TextWork {
  check(
    record(value) &&
      typeof value.runId === 'string' &&
      nullableText(value.attemptId) &&
      typeof value.state === 'string' &&
      typeof value.queueHold === 'boolean' &&
      typeof value.revision === 'number' &&
      typeof value.queuePosition === 'number' &&
      typeof value.messageId === 'string' &&
      nullableText(value.failure),
  )
  return value as TextWork
}
export function parseInteraction(value: unknown): TextInteraction {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      typeof value.runId === 'string' &&
      typeof value.attemptId === 'string' &&
      typeof value.kind === 'string' &&
      typeof value.prompt === 'string' &&
      typeof value.freeText === 'boolean' &&
      typeof value.state === 'string' &&
      typeof value.revision === 'number' &&
      (value.sourceAgentId === undefined ||
        typeof value.sourceAgentId === 'string') &&
      (value.proposalId === undefined ||
        typeof value.proposalId === 'string') &&
      (value.proposal === undefined || typeof value.proposal === 'string') &&
      (value.response === undefined ||
        (record(value.response) && typeof value.response.actorId === 'string')),
  )
  return {
    ...value,
    options: list(value.options, (option) => {
      check(
        record(option) &&
          typeof option.id === 'string' &&
          typeof option.label === 'string',
      )
      return option as TextInteraction['options'][number]
    }),
  } as TextInteraction
}
export function parseDelegation(value: unknown): TextDelegation {
  check(
    record(value) &&
      typeof value.id === 'string' &&
      nullableText(value.parentRunId) &&
      nullableText(value.childRunId) &&
      typeof value.senderAgentId === 'string' &&
      typeof value.recipientAgentId === 'string' &&
      typeof value.depth === 'number' &&
      typeof value.ordinal === 'number' &&
      typeof value.request === 'string' &&
      typeof value.state === 'string' &&
      typeof value.revision === 'number',
  )
  return value as TextDelegation
}
export function parseAppPage(value: unknown): AppPage {
  check(
    record(value) &&
      typeof value.cursor === 'string' &&
      (value.next === null ||
        (record(value.next) &&
          nullableText(value.next.afterThreadId) &&
          nullableText(value.next.afterNotificationId))),
  )
  return {
    ...value,
    threads: list(value.threads, parseSummary).filter(knownContext),
    notifications: list(value.notifications, parseNotice),
  } as AppPage
}
export function parseThreadPage(value: unknown): ThreadPage {
  check(
    record(value) &&
      typeof value.cursor === 'string' &&
      (value.next === null ||
        (record(value.next) &&
          (value.next.afterMessagePosition === null ||
            typeof value.next.afterMessagePosition === 'number') &&
          (value.next.afterWorkPosition === null ||
            typeof value.next.afterWorkPosition === 'number'))),
  )
  return {
    ...value,
    messages: list(value.messages, parseMessage),
    work: list(value.work, parseWork),
    interactions: list(value.interactions, parseInteraction),
    delegations: list(value.delegations, parseDelegation),
  } as ThreadPage
}
export function parseWireEvent(
  value: unknown,
  scope: Scope,
  threadId: string | null,
): WireEvent {
  check(
    record(value) &&
      record(value.scope) &&
      typeof value.cursor === 'string' &&
      typeof value.type === 'string',
  )
  const skipped = { ...value, type: 'unsupported', data: null } as WireEvent
  if (
    !sameScope(value.scope as Scope, scope) ||
    value.scope.kind !== (threadId === null ? 'application' : 'thread') ||
    (threadId !== null && value.scope.threadId !== threadId)
  )
    return skipped
  const type = value.type
  if (type === 'resync-required')
    throw new TextHttpError('Live history needs refreshing.', 'resync-required')
  if (!eventTypes.has(type) && !directoryEventTypes.has(type)) return skipped
  let data: WireEvent['data']
  if (
    threadId !== null &&
    (type === 'message-draft' || type === 'message-final')
  )
    data = parseMessage(value.data)
  else if (threadId !== null && type === 'work-changed')
    data = parseWork(value.data)
  else if (threadId !== null && type === 'interaction-changed')
    data = parseInteraction(value.data)
  else if (threadId !== null && type === 'delegation-changed')
    data = parseDelegation(value.data)
  else if (threadId === null && type === 'thread-summary') {
    const summary = parseSummary(value.data)
    if (!knownContext(summary)) return skipped
    data = summary
  } else if (threadId === null && type === 'notification')
    data = parseNotice(value.data)
  else if (threadId === null && type === 'notification-removed') {
    check(record(value.data) && typeof value.data.id === 'string')
    data = value.data as NotificationRemoved
  } else if (threadId === null && type === 'thread-removed') {
    check(record(value.data) && typeof value.data.threadId === 'string')
    data = value.data as ThreadRemoved
  } else if (threadId === null && directoryEventTypes.has(type))
    data = parseDirectoryEvent(type as DirectoryEventType, value.data).data
  else return skipped
  return { ...value, data } as WireEvent
}

export class TextClient {
  readonly endpoint: string
  constructor(endpoint: string) {
    const url = new URL(
      endpoint,
      typeof window === 'undefined' ? undefined : window.location.href,
    )
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Backend URL must use HTTP or HTTPS.')
    this.endpoint = url.href.replace(/\/$/, '')
  }
  private async request<T>(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    redirect: RequestRedirect = 'follow',
  ): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      cache: 'no-store',
      redirect,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw await httpError(response)
    return response.json().catch(() => incompatible()) as Promise<T>
  }
  async bootstrap(
    signal: AbortSignal,
    redirect: RequestRedirect = 'follow',
  ): Promise<Bootstrap> {
    const data = await this.request<unknown>(
      '/v1/bootstrap',
      signal,
      undefined,
      redirect,
    )
    check(
      record(data) &&
        [
          data.installationId,
          data.callerId,
          data.organizationId,
          data.rootAgentId,
        ].every((id) => typeof id === 'string') &&
        typeof data.coreVersion === 'string' &&
        data.coreVersion !== '' &&
        isProtocolRange(data.protocol) &&
        (data.capabilities === undefined ||
          (record(data.capabilities) &&
            typeof data.capabilities.voiceRecording === 'boolean' &&
            ['undefined', 'boolean'].includes(
              typeof data.capabilities.notificationActions,
            ))),
    )
    return data as Bootstrap
  }
  async directory(signal: AbortSignal): Promise<Directory> {
    const data = await this.request<unknown>('/v1/directory', signal)
    try {
      return parseDirectory(data)
    } catch {
      return incompatible()
    }
  }
  /** Opens, or returns, the caller's one direct chat with the agent in the context. */
  async directChat(
    context:
      | { kind: 'installation'; installationId: string }
      | { kind: 'organization'; organizationId: string },
    agentId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const data = await this.request<unknown>('/v1/direct-chats', signal, {
      version: 1,
      context,
      agentId,
    })
    check(record(data) && typeof data.chatId === 'string')
    return data.chatId
  }
  private async paginate<T extends { cursor: string; next: object | null }>(
    path: string,
    signal: AbortSignal,
    check: (page: unknown) => T,
  ): Promise<T[]> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pages: T[] = []
      let next: object | null = null
      let cursor: string | null = null
      try {
        do {
          const params = new URLSearchParams()
          if (next) {
            params.set('at', cursor!)
            for (const [key, value] of Object.entries(next))
              if (value !== null) params.set(key, String(value))
          }
          const page = check(
            await this.request<unknown>(
              `${path}${params.size ? `?${params}` : ''}`,
              signal,
            ),
          )
          if (cursor !== null && page.cursor !== cursor)
            throw new TextHttpError(
              'Snapshot changed during paging.',
              'resync-required',
            )
          cursor = page.cursor
          pages.push(page)
          if (page.next && JSON.stringify(page.next) === JSON.stringify(next))
            break
          next = page.next
        } while (next && !signal.aborted)
        if (signal.aborted) throw signal.reason
        return pages
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof TextHttpError) ||
          error.code !== 'resync-required' ||
          attempt === 4
        )
          throw error
      }
    }
    throw new Error('Snapshot changed too often.')
  }
  async appSnapshot(
    signal: AbortSignal,
  ): Promise<{ cursor: string; threads: Summary[]; notifications: Notice[] }> {
    const pages = await this.paginate<AppPage>(
      '/v1/app/snapshot',
      signal,
      parseAppPage,
    )
    return {
      cursor: pages[0].cursor,
      threads: pages.flatMap((p) => p.threads),
      notifications: pages.flatMap((p) => p.notifications),
    }
  }
  /**
   * Reads the directory, then the application snapshot. The directory's cursor is then the
   * older of the two, so following the application stream from it applies every change either
   * read missed; replayed changes the newer snapshot already holds merge by revision.
   */
  async workspaceSnapshot(signal: AbortSignal): Promise<{
    cursor: string
    directory: Directory
    threads: Summary[]
    notifications: Notice[]
  }> {
    const directory = await this.directory(signal)
    const app = await this.appSnapshot(signal)
    return { ...app, directory, cursor: directory.cursor }
  }
  async threadSnapshot(
    threadId: string,
    signal: AbortSignal,
  ): Promise<{
    cursor: string
    messages: TextMessage[]
    work: TextWork[]
    interactions: TextInteraction[]
    delegations: TextDelegation[]
  }> {
    const pages = await this.paginate<ThreadPage>(
      `/v1/threads/${encodeURIComponent(threadId)}/snapshot`,
      signal,
      parseThreadPage,
    )
    return {
      cursor: pages[0].cursor,
      messages: pages.flatMap((p) => p.messages),
      work: pages.flatMap((p) => p.work),
      interactions: pages.flatMap((p) => p.interactions),
      delegations: pages.flatMap((p) => p.delegations),
    }
  }
  async events(
    path: string,
    scope: Scope,
    threadId: string | null,
    cursor: string,
    signal: AbortSignal,
    apply: (event: WireEvent) => void,
    observer?: { connected(): void; event(value: unknown): void },
  ): Promise<void> {
    const response = await fetch(
      `${this.endpoint}${path}?after=${encodeURIComponent(cursor)}`,
      { signal, cache: 'no-store', headers: { Accept: 'text/event-stream' } },
    )
    if (response.status === 409)
      throw new TextHttpError(
        'Live history needs refreshing.',
        'resync-required',
      )
    if (response.status === 410) throw await httpError(response)
    if (!response.ok || !response.body)
      throw new TextHttpError('Live connection unavailable.', 'unavailable')
    observer?.connected()
    return readEvents(response, signal, (type, raw) => {
      // Transport control frames have no resource envelope; unknown ones are ignored.
      if (record(raw) && !record(raw.scope)) {
        if (type === 'resync-required')
          throw new TextHttpError(
            'Live history needs refreshing.',
            'resync-required',
          )
        if (type === 'gone')
          throw new TextHttpError(refusalMessage('gone'), 'gone')
        return
      }
      const event = parseWireEvent(raw, scope, threadId)
      observer?.event(raw)
      apply(event)
    })
  }

  async submit(submission: Submission, signal: AbortSignal): Promise<Receipt> {
    const target = submission.target
    if (
      !submission.parts.length ||
      submission.parts.some((p) =>
        p.type === 'text'
          ? !p.text.trim()
          : p.type === 'file'
            ? !p.artifactId ||
              !['attachment', 'voice_note'].includes(p.purpose ?? 'attachment')
            : true,
      )
    )
      throw new TextHttpError(
        'Message contains an unavailable part.',
        'invalid',
      )
    let saved: unknown
    try {
      saved = await this.request('/v1/text/submissions', signal, {
        version: 1,
        submissionId: submission.submissionId,
        scope: {
          installationId: target.installationId,
          callerId: target.callerId,
        },
        target: { context: target.context, chatId: target.chatId },
        mode: target.threadId ? 'reply' : 'root',
        ...(target.threadId ? { threadId: target.threadId } : {}),
        parts: submission.parts.map((p) => {
          if (p.type === 'text') return { kind: 'text', text: p.text }
          if (p.type === 'file')
            return {
              kind: 'file',
              artifactId: p.artifactId,
              purpose: p.purpose ?? 'attachment',
            }
          throw new TextHttpError(
            'Message contains an unavailable part.',
            'invalid',
          )
        }),
      })
    } catch (error) {
      // A refusal is final: the message was not accepted and will not be.
      if (error instanceof TextHttpError && isRefusal(error.code))
        return {
          status: 'rejected',
          submissionId: submission.submissionId,
          code: error.code,
          message: error.message,
        }
      throw error
    }
    return this.mapReceipt(saved, submission.submissionId, target)
  }
  async receipt(
    _scope: Scope,
    id: string,
    signal: AbortSignal,
    target?: Submission['target'],
  ): Promise<Receipt> {
    try {
      const saved = await this.request<unknown>(
        `/v1/text/receipts/${encodeURIComponent(id)}`,
        signal,
      )
      if (!target)
        throw new Error(
          'Original send target is required for receipt reconciliation.',
        )
      return this.mapReceipt(saved, id, target)
    } catch (error) {
      if (error instanceof TextHttpError && error.code === 'not-found')
        return { status: 'unknown', submissionId: id }
      throw error
    }
  }
  private mapReceipt(
    saved: unknown,
    id: string,
    target: Submission['target'],
  ): Receipt {
    if (
      !record(saved) ||
      saved.status !== 'accepted' ||
      saved.submissionId !== id ||
      saved.chatId !== target.chatId ||
      typeof saved.threadId !== 'string' ||
      typeof saved.messageId !== 'string' ||
      typeof saved.alreadyAccepted !== 'boolean' ||
      (target.threadId && saved.threadId !== target.threadId)
    )
      throw new Error('Receipt does not match the original send.')
    const receipt = saved as AcceptedReceipt
    return {
      status: 'accepted',
      submissionId: id,
      target,
      threadId: receipt.threadId,
      messageId: receipt.messageId,
      alreadyAccepted: receipt.alreadyAccepted,
    }
  }
  /** Marks a notification read. Reading never answers its question; a repeated read changes nothing. */
  async markRead(notificationId: string, signal: AbortSignal): Promise<void> {
    await this.request(
      `/v1/notifications/${encodeURIComponent(notificationId)}/read`,
      signal,
      { version: 1 },
    )
  }
  conversationAdapter(): ConversationClient {
    return {
      submit: (submission, signal) => this.submit(submission, signal),
      receipt: (scope, id, signal, target) =>
        this.receipt(scope, id, signal, target),
    }
  }
}
