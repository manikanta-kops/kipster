import {
  parseMessage,
  parseNotice,
  parseWork,
  parseInteraction,
  parseDelegation,
} from '../data/text.ts'
import type {
  Notice,
  Summary,
  TextMessage,
  TextWork,
  TextInteraction,
  TextDelegation,
} from '../data/text.ts'
import { createAdministration, DEMO_IDS } from './admin.ts'
import { createFakeMedia } from './media.ts'
import { DEMO_ORIGIN } from './transport.ts'
import {
  body,
  context,
  contextId,
  errorResponse,
  fields,
  json,
  record,
  text,
  WireError,
  type Context,
} from './wire.ts'

export { DEMO_IDS } from './admin.ts'
export { DEMO_ORIGIN, installFakeCoreTransport } from './transport.ts'

type Chat = { id: string; context: Context; agentId: string }
type Scenario = 'question' | 'approval' | 'delegation' | 'failure' | 'complete'
type Thread = {
  summary: Summary
  messages: TextMessage[]
  work: TextWork[]
  interactions: TextInteraction[]
  delegations: TextDelegation[]
  stages: Map<string, number>
  scenarios: Map<string, Scenario>
}
type Event = {
  version: 1
  eventId: string
  scope: object
  cursor: string
  occurredAt: string
  resourceId: string
  revision: number
  type: string
  data: unknown
}
type Log = {
  head: number
  floor: number
  events: Event[]
  listeners: Set<(event: Event | 'resync-required' | 'gone') => void>
}
const active = new Set([
  'queued',
  'preparing',
  'running',
  'waiting',
  'cancellation-requested',
])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const now = () => new Date().toISOString()
const id = (): string => crypto.randomUUID()
const clone = <T>(value: T): T => structuredClone(value)

/** One isolated, disposable Core-shaped data source. It never stores connection preferences. */
export function createFakeCore(
  options: {
    autoAdvance?: boolean
    testControls?: boolean
    tickMs?: number
  } = {},
) {
  const scope = {
    installationId: DEMO_IDS.installation,
    callerId: DEMO_IDS.caller,
  }
  const chats = new Map<string, Chat>()
  const threads = new Map<string, Thread>()
  const notifications = new Map<string, Notice>()
  const receipts = new Map<string, Record<string, unknown>>()
  const controls = new Map<string, Record<string, unknown>>()
  const answers = new Map<string, Record<string, unknown>>()
  const logs = new Map<string, Log>()
  let offline = false
  let disposed = false
  let seed = 100
  const seededId = () =>
    `00000000-0000-4000-8000-${String(seed++).padStart(12, '0')}`
  function log(threadId?: string): Log {
    const key = threadId ?? 'application'
    let value = logs.get(key)
    if (!value) {
      value = { head: 0, floor: 0, events: [], listeners: new Set() }
      logs.set(key, value)
    }
    return value
  }
  const cursor = (threadId?: string, position = log(threadId).head) =>
    threadId
      ? `t:${threadId}:${position}`
      : `a:${scope.installationId}:${position}`
  const streamScope = (threadId?: string) =>
    threadId
      ? { kind: 'thread', ...scope, threadId }
      : { kind: 'application', ...scope }
  function emit(
    type: string,
    data: unknown,
    resourceId: string,
    revision: number,
    threadId?: string,
  ) {
    const journal = log(threadId)
    const event: Event = {
      version: 1,
      eventId: id(),
      scope: streamScope(threadId),
      cursor: cursor(threadId, ++journal.head),
      occurredAt: now(),
      resourceId,
      revision,
      type,
      data: clone(data),
    }
    journal.events.push(event)
    if (journal.events.length > 2000) {
      journal.events.shift()
      journal.floor++
    }
    for (const listener of journal.listeners) listener(event)
  }
  function lifecycle(
    kind: 'agent' | 'organization',
    ownerId: string,
    action: 'archive' | 'restore' | 'delete',
    deletion: { copyFilesToOrganizations?: boolean } = {},
  ) {
    if (action === 'restore') return
    if (action === 'delete') {
      const references = [...threads.values()].flatMap((thread) =>
        thread.summary.contextKind === 'organization'
          ? thread.messages.flatMap((message) =>
              message.parts.flatMap((part) =>
                part.kind === 'file'
                  ? [
                      {
                        artifactId: part.artifactId,
                        organizationId: thread.summary.contextId,
                      },
                    ]
                  : [],
              ),
            )
          : [],
      )
      const cleanup = media.deleteOwner(
        kind,
        ownerId,
        references,
        deletion.copyFilesToOrganizations ?? false,
      )
      for (const thread of threads.values())
        for (const message of thread.messages) {
          let changed = false
          message.parts = message.parts.map((part) => {
            if (
              part.kind !== 'file' ||
              !cleanup.removed.includes(part.artifactId)
            )
              return part
            changed = true
            const copy = cleanup.replacements.find(
              (copy) =>
                copy.artifactId === part.artifactId &&
                thread.summary.contextKind === 'organization' &&
                copy.organizationId === thread.summary.contextId,
            )
            return copy
              ? { ...part, artifactId: copy.replacementId }
              : { kind: 'removed', artifactId: part.artifactId }
          })
          if (changed) {
            message.preparation = message.preparation?.filter(
              (item) => !cleanup.removed.includes(item.artifactId),
            )
            message.revision++
            changeMessage(thread, message)
          }
        }
    }
    for (const [threadId, thread] of threads) {
      const affected =
        kind === 'agent'
          ? thread.summary.agentId === ownerId
          : thread.summary.contextKind === 'organization' &&
            thread.summary.contextId === ownerId
      if (kind === 'agent')
        for (const delegation of thread.delegations) {
          if (
            delegation.recipientAgentId !== ownerId ||
            !active.has(delegation.state)
          )
            continue
          delegation.state = 'cancelled'
          delegation.failure =
            action === 'archive' ? 'Agent was archived' : 'Agent was deleted'
          delegation.revision++
          emit(
            'delegation-changed',
            delegation,
            delegation.id,
            delegation.revision,
            threadId,
          )
          settleInteractions(
            thread,
            'cancelled',
            delegation.childRunId ?? undefined,
          )
          const parent = thread.work.find(
            (run) => run.runId === delegation.parentRunId,
          )
          if (
            parent?.state === 'waiting' &&
            !thread.interactions.some(
              (card) => card.runId === parent.runId && card.state === 'pending',
            )
          ) {
            parent.state = 'running'
            parent.revision++
            changeWork(thread, parent)
          }
        }
      if (!affected) continue
      for (const run of thread.work.filter((run) => active.has(run.state))) {
        run.state = 'cancelled'
        run.queueHold = true
        run.cancelDelivery = 'confirmed-ended'
        run.revision++
        changeWork(thread, run)
      }
      settleInteractions(thread, 'cancelled')
      if (action === 'delete') {
        emit(
          'thread-removed',
          { threadId, chatId: thread.summary.chatId },
          threadId,
          thread.summary.revision + 1,
        )
        for (const notice of notifications.values())
          if (notice.threadId === threadId) {
            notifications.delete(notice.id)
            emit(
              'notification-removed',
              { id: notice.id, threadId },
              notice.id,
              notice.revision + 1,
            )
          }
        for (const listener of log(threadId).listeners) listener('gone')
        threads.delete(threadId)
      }
    }
  }
  let administration = createAdministration({
    emit,
    cursor: () => cursor(),
    onLifecycle: lifecycle,
  })
  const media = createFakeMedia({
    ...scope,
    authorizeTarget(target) {
      authorizeChat(target.chatId, context(target.context))
      if (
        target.threadId &&
        getThread(target.threadId).summary.chatId !== target.chatId
      )
        throw new Error('Thread target mismatch')
    },
  })
  function directory() {
    return administration.directory()
  }
  function authorizeContext(value: Context) {
    if (value.kind === 'installation') {
      if (value.installationId !== scope.installationId)
        throw new WireError(403, 'forbidden', 'Installation access denied')
    } else {
      const org = directory().organizations.find(
        (org) => org.id === value.organizationId,
      )
      if (!org || org.lifecycle !== 'active')
        throw new WireError(
          410,
          'organization-deleted',
          'Organization is deleted',
        )
    }
  }
  function admit(value: Context, agentId: string) {
    authorizeContext(value)
    const state = directory()
    const agent = state.agents.find((agent) => agent.id === agentId)
    if (
      !agent ||
      agent.lifecycle === 'deleted' ||
      agent.lifecycle === 'deleting'
    )
      throw new WireError(410, 'gone', 'Agent is gone')
    if (agent.lifecycle === 'archived')
      throw new WireError(409, 'agent-archived', 'Agent is archived')
    if (
      value.kind === 'installation'
        ? !agent.admin
        : !state.memberships.some(
            (member) =>
              member.organizationId === value.organizationId &&
              member.agentId === agentId,
          )
    )
      throw new WireError(
        403,
        'membership-removed',
        'Agent membership was removed',
      )
  }
  function authorizeChat(chatId: string, target: Context, newWork = false) {
    const chat = chats.get(chatId)
    if (!chat) throw new WireError(410, 'gone', 'Chat is gone')
    if (
      chat.context.kind !== target.kind ||
      contextId(chat.context) !== contextId(target)
    )
      throw new WireError(403, 'forbidden', 'Chat target mismatch')
    const state = directory()
    const agent = state.agents.find((agent) => agent.id === chat.agentId)
    const org =
      target.kind === 'organization'
        ? state.organizations.find((org) => org.id === target.organizationId)
        : undefined
    if (target.kind === 'organization' && (!org || org.lifecycle !== 'active'))
      throw new WireError(
        410,
        newWork ? 'organization-deleted' : 'gone',
        'Organization is deleted',
      )
    if (
      !agent ||
      agent.lifecycle === 'deleted' ||
      agent.lifecycle === 'deleting'
    )
      throw new WireError(410, 'gone', 'Chat is gone')
    authorizeContext(target)
    return chat
  }
  function directChat(target: Context, agentId: string) {
    authorizeContext(target)
    const existing = [...chats.values()].find(
      (chat) =>
        chat.context.kind === target.kind &&
        contextId(chat.context) === contextId(target) &&
        chat.agentId === agentId,
    )
    if (existing) {
      authorizeChat(existing.id, target)
      if (
        target.kind === 'organization' &&
        !directory().memberships.some(
          (member) =>
            member.organizationId === target.organizationId &&
            member.agentId === agentId,
        )
      )
        throw new WireError(
          403,
          'membership-removed',
          'Agent membership was removed',
        )
      return existing
    }
    admit(target, agentId)
    const chat = { id: id(), context: target, agentId }
    chats.set(chat.id, chat)
    return chat
  }
  function getThread(threadId: string) {
    const thread = threads.get(threadId)
    if (!thread) throw new WireError(410, 'gone', 'Thread is gone')
    const chat = chats.get(thread.summary.chatId)!
    authorizeChat(chat.id, chat.context)
    return thread
  }
  function summary(thread: Thread, state?: string) {
    thread.summary.revision++
    if (state) thread.summary.state = state
    thread.summary.lastMessageId = thread.messages.at(-1)!.id
    emit(
      'thread-summary',
      thread.summary,
      thread.summary.threadId,
      thread.summary.revision,
    )
  }
  function changeWork(thread: Thread, work: TextWork) {
    emit(
      'work-changed',
      work,
      work.runId,
      work.revision,
      thread.summary.threadId,
    )
    summary(thread, work.state)
  }
  function changeMessage(thread: Thread, message: TextMessage) {
    emit(
      message.final ? 'message-final' : 'message-draft',
      message,
      message.id,
      message.revision,
      thread.summary.threadId,
    )
    summary(thread)
  }
  function notify(
    thread: Thread,
    work: TextWork,
    kind: Notice['kind'],
    interaction?: TextInteraction,
  ) {
    const notice: Notice = {
      id: id(),
      threadId: thread.summary.threadId,
      runId: work.runId,
      kind,
      read: false,
      revision: 1,
      createdAt: now(),
      ...(interaction
        ? { interactionId: interaction.id, interactionState: interaction.state }
        : {}),
    }
    notifications.set(notice.id, notice)
    emit('notification', notice, notice.id, notice.revision)
  }
  function changeInteraction(thread: Thread, interaction: TextInteraction) {
    emit(
      'interaction-changed',
      interaction,
      interaction.id,
      interaction.revision,
      thread.summary.threadId,
    )
    for (const notice of notifications.values())
      if (notice.interactionId === interaction.id) {
        notice.interactionState = interaction.state
        notice.revision++
        emit('notification', notice, notice.id, notice.revision)
      }
  }
  function settleInteractions(
    thread: Thread,
    state: 'cancelled' | 'superseded',
    runId?: string,
  ) {
    for (const card of thread.interactions)
      if (card.state === 'pending' && (!runId || card.runId === runId)) {
        card.state = state
        card.revision++
        changeInteraction(thread, card)
      }
  }
  function addMessage(
    thread: Thread,
    authorId: string,
    parts: TextMessage['parts'],
    final = true,
    messageId = id(),
  ): TextMessage {
    const message: TextMessage = {
      id: messageId,
      threadId: thread.summary.threadId,
      authorId,
      parts: clone(parts),
      final,
      revision: 1,
      position: thread.messages.length + 1,
    }
    const preparation = parts.flatMap((part, index) =>
      part.kind === 'file' && part.purpose === 'voice_note'
        ? [
            {
              id: `${message.id}:${index}`,
              artifactId: part.artifactId,
              partIndex: index,
              revision: 1,
              status: 'preparing' as const,
              provider: 'demo-transcription',
            },
          ]
        : [],
    )
    if (preparation.length) message.preparation = preparation
    thread.messages.push(message)
    return message
  }
  function addRun(
    thread: Thread,
    message: TextMessage,
    scenario: Scenario,
    runId = id(),
  ): TextWork {
    const run: TextWork = {
      runId,
      messageId: message.id,
      attemptId: null,
      state: 'queued',
      queueHold: false,
      cancelDelivery: 'none',
      revision: 1,
      queuePosition: thread.work.length + 1,
      failure: null,
    }
    thread.work.push(run)
    thread.stages.set(runId, 0)
    thread.scenarios.set(runId, scenario)
    return run
  }
  function newThread(chat: Chat, threadId = id()): Thread {
    const thread: Thread = {
      summary: {
        threadId,
        chatId: chat.id,
        contextKind: chat.context.kind,
        contextId: contextId(chat.context),
        agentId: chat.agentId,
        state: 'queued',
        revision: 1,
        lastMessageId: '',
        createdAt: now(),
      },
      messages: [],
      work: [],
      interactions: [],
      delegations: [],
      stages: new Map(),
      scenarios: new Map(),
    }
    threads.set(threadId, thread)
    return thread
  }
  function ask(thread: Thread, run: TextWork, kind: 'question' | 'approval') {
    const card: TextInteraction = {
      id: id(),
      version: 1,
      runId: run.runId,
      attemptId: run.attemptId!,
      kind,
      prompt:
        kind === 'question'
          ? 'Which direction would you like me to develop?'
          : 'May I publish the reviewed proposal?',
      options:
        kind === 'question'
          ? [
              { id: 'focused', label: 'Keep it focused' },
              { id: 'explore', label: 'Explore alternatives' },
            ]
          : [],
      freeText: kind === 'question',
      state: 'pending',
      revision: 1,
      ...(kind === 'approval'
        ? {
            proposalId: id(),
            proposal: 'Publish the reviewed proposal to the team workspace.',
          }
        : {}),
    }
    thread.interactions.push(card)
    changeInteraction(thread, card)
    notify(thread, run, 'interaction', card)
  }
  function advance(thread: Thread) {
    // FIFO: a held terminal workflow blocks ordinary follow-ups until Resume.
    const run = thread.work.find(
      (run) => active.has(run.state) || run.queueHold,
    )
    if (
      !run ||
      !active.has(run.state) ||
      (run.state === 'waiting' &&
        (thread.interactions.some(
          (card) => card.runId === run.runId && card.state === 'pending',
        ) ||
          !thread.delegations.some(
            (item) =>
              item.parentRunId === run.runId && item.state === 'running',
          )))
    )
      return
    if (run.state === 'cancellation-requested') {
      run.state = 'cancelled'
      run.cancelDelivery = 'confirmed-ended'
      run.revision++
      changeWork(thread, run)
      return
    }
    const stage = thread.stages.get(run.runId) ?? 0
    const scenario = thread.scenarios.get(run.runId) ?? 'question'
    if (stage === 0) {
      run.state = 'running'
      run.attemptId = id()
      run.revision++
      const original = thread.messages.find(
        (message) => message.id === run.messageId,
      )!
      if (original.preparation?.length) {
        for (const preparation of original.preparation) {
          preparation.status = 'succeeded'
          preparation.transcript =
            'Let’s make the next version clear, calm and useful.'
          preparation.revision++
        }
        original.revision++
        changeMessage(thread, original)
      }
      changeWork(thread, run)
    } else if (stage === 1) {
      const message = addMessage(
        thread,
        thread.summary.agentId,
        [{ kind: 'text', text: 'I’m bringing the key findings together' }],
        false,
      )
      changeMessage(thread, message)
    } else if (stage === 2) {
      const draft = thread.messages.findLast((message) => !message.final)
      if (draft) {
        draft.parts = [
          {
            kind: 'text',
            text: 'I’m bringing the key findings together into a practical plan. The next step is to choose a direction.',
          },
        ]
        draft.revision++
        draft.final = true
        changeMessage(thread, draft)
      }
      if (scenario === 'question' || scenario === 'approval') {
        run.state = 'waiting'
        run.revision++
        changeWork(thread, run)
        ask(thread, run, scenario)
      } else if (scenario === 'failure') {
        run.state = 'failed'
        run.failure = 'The demo provider stopped before completing the work.'
        run.queueHold = true
        run.revision++
        changeWork(thread, run)
        notify(thread, run, 'failed')
      } else if (scenario === 'delegation') {
        const delegation: TextDelegation = {
          id: id(),
          parentRunId: run.runId,
          childRunId: id(),
          senderAgentId: thread.summary.agentId,
          recipientAgentId: DEMO_IDS.engineer,
          originThreadId: thread.summary.threadId,
          depth: 1,
          ordinal: 1,
          request: 'Check the implementation details and report the tradeoffs.',
          state: 'running',
          revision: 1,
        }
        run.state = 'waiting'
        run.revision++
        changeWork(thread, run)
        thread.delegations.push(delegation)
        emit(
          'delegation-changed',
          delegation,
          delegation.id,
          delegation.revision,
          thread.summary.threadId,
        )
      }
    } else {
      for (const delegation of thread.delegations.filter(
        (item) => item.parentRunId === run.runId && active.has(item.state),
      )) {
        delegation.state = 'completed'
        delegation.revision++
        emit(
          'delegation-changed',
          delegation,
          delegation.id,
          delegation.revision,
          thread.summary.threadId,
        )
      }
      const message = addMessage(thread, thread.summary.agentId, [
        {
          kind: 'text',
          text: 'The plan is ready. I’ve incorporated your direction and captured the next steps so we can continue from here.',
        },
      ])
      changeMessage(thread, message)
      run.state = 'completed'
      run.queueHold = false
      run.revision++
      changeWork(thread, run)
      notify(thread, run, 'completed')
    }
    thread.stages.set(run.runId, stage + 1)
  }

  function checkedCursor(value: string, threadId?: string) {
    const prefix = cursor(threadId, 0).slice(0, -1)
    const suffix = value.slice(prefix.length)
    if (
      !value.startsWith(prefix) ||
      !/^(0|[1-9]\d*)$/.test(suffix) ||
      !Number.isSafeInteger(Number(suffix))
    )
      throw new Error('Invalid stream cursor')
    const position = Number(suffix),
      journal = log(threadId)
    if (position < journal.floor)
      throw new WireError(409, 'resync-required', 'resync-required')
    if (position > journal.head) throw new Error('Future stream cursor')
    return position
  }
  function snapshot(url: URL, threadId?: string) {
    const thread = threadId ? getThread(threadId) : undefined
    const query = url.searchParams
    const integer = (key: string) => {
      const raw = query.get(key)
      if (raw === null) return undefined
      if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw)))
        throw new Error('Invalid page position')
      return Number(raw)
    }
    const identifier = (key: string) => {
      const raw = query.get(key)
      if (raw !== null && !uuid.test(raw)) throw new Error('Invalid page ID')
      return raw
    }
    const afterThread = identifier('afterThreadId'),
      afterNotice = identifier('afterNotificationId')
    const afterMessage = integer('afterMessagePosition'),
      afterWork = integer('afterWorkPosition')
    const at = query.get('at')
    if (
      (afterThread ||
        afterNotice ||
        afterMessage !== undefined ||
        afterWork !== undefined) &&
      !at
    )
      throw new Error('Invalid missing snapshot cursor')
    if (at !== null && checkedCursor(at, threadId) !== log(threadId).head)
      throw new WireError(409, 'resync-required', 'resync-required')
    const limit = integer('limit') ?? (thread ? 1000 : 100)
    if (limit < 1 || limit > (thread ? 1000 : 100))
      throw new Error('Invalid snapshot page limit')
    const base = {
      version: 1,
      scope: streamScope(threadId),
      cursor: cursor(threadId),
    }
    if (thread) {
      const messages = thread.messages.filter(
        (message) => message.position > (afterMessage ?? 0),
      )
      const work = thread.work.filter(
        (run) => run.queuePosition > (afterWork ?? 0),
      )
      const messagePage = messages.slice(0, limit),
        workPage = work.slice(0, limit)
      return {
        ...base,
        messages: messagePage,
        work: workPage,
        interactions: thread.interactions.filter(
          (card) =>
            workPage.some((run) => run.runId === card.runId) ||
            card.sourceAgentId,
        ),
        delegations: thread.delegations,
        next:
          messages.length > limit || work.length > limit
            ? {
                afterMessagePosition:
                  messagePage.at(-1)?.position ?? afterMessage ?? null,
                afterWorkPosition:
                  workPage.at(-1)?.queuePosition ?? afterWork ?? null,
              }
            : null,
      }
    }
    const summaries = [...threads.values()]
      .map((thread) => thread.summary)
      .sort((a, b) => a.threadId.localeCompare(b.threadId))
      .filter((summary) => !afterThread || summary.threadId > afterThread)
    let notes = [...notifications.values()].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    if (afterNotice) {
      const index = notes.findIndex((notice) => notice.id === afterNotice)
      if (index === -1)
        throw new WireError(409, 'resync-required', 'resync-required')
      notes = notes.slice(index + 1)
    }
    const page = summaries.slice(0, limit),
      notificationPage = notes.slice(0, limit)
    return {
      ...base,
      threads: page,
      notifications: notificationPage,
      next:
        summaries.length > limit || notes.length > limit
          ? {
              afterThreadId: page.at(-1)?.threadId ?? afterThread ?? null,
              afterNotificationId:
                notificationPage.at(-1)?.id ?? afterNotice ?? null,
            }
          : null,
    }
  }
  function events(request: Request, url: URL, threadId?: string) {
    if (threadId) getThread(threadId)
    const after = url.searchParams.get('after')
    if (!after) throw new Error('Invalid missing stream cursor')
    const position = checkedCursor(after, threadId),
      journal = log(threadId)
    const encoder = new TextEncoder()
    let close = (_cancelled = false) => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let ended = false
        const listener = (event: Event | 'resync-required' | 'gone') => {
          if (ended) return
          if (typeof event === 'string') {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify({ version: 1, code: event })}\n\n`,
              ),
            )
            close()
            return
          }
          const frame = `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          if (encoder.encode(frame).length > 256 * 1024) {
            listener('resync-required')
            return
          }
          controller.enqueue(encoder.encode(frame))
        }
        const abort = () => close()
        close = (cancelled = false) => {
          if (ended) return
          ended = true
          journal.listeners.delete(listener)
          request.signal.removeEventListener('abort', abort)
          if (!cancelled) controller.close()
        }
        if (request.signal.aborted) {
          close()
          return
        }
        for (const event of journal.events.filter(
          (event) => Number(event.cursor.split(':').at(-1)) > position,
        ))
          listener(event)
        if (!ended) {
          journal.listeners.add(listener)
          request.signal.addEventListener('abort', abort, { once: true })
        }
      },
      cancel() {
        close(true)
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  function parseParts(value: unknown): TextMessage['parts'] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 32)
      throw new Error('Invalid message parts')
    const parts = value.map((part) => {
      const row = record(part)
      if (row.kind === 'text') {
        fields(row, ['kind', 'text'], ['text'])
        return { kind: 'text' as const, text: text(row.text) }
      }
      fields(row, ['kind', 'artifactId', 'purpose'], ['artifactId', 'purpose'])
      if (
        row.kind !== 'file' ||
        (row.purpose !== 'attachment' && row.purpose !== 'voice_note')
      )
        throw new Error('Invalid file part')
      return {
        kind: 'file' as const,
        artifactId: text(row.artifactId),
        purpose: row.purpose as 'attachment' | 'voice_note',
      }
    })
    if (parts.filter((part) => part.kind === 'file').length > 10)
      throw new Error('Invalid file count')
    return parts
  }
  async function handle(request: Request): Promise<Response> {
    try {
      await ready
      const url = new URL(request.url),
        path = url.pathname,
        method = request.method
      if (url.origin !== DEMO_ORIGIN)
        throw new WireError(404, 'not-found', 'Route not found')
      if (disposed)
        throw new WireError(503, 'unavailable', 'Demo Core is stopped')
      if (path.startsWith('/__demo/')) {
        if (!options.testControls)
          throw new WireError(404, 'not-found', 'Route not found')
        if (path === '/__demo/inspect' && method === 'GET')
          return json({
            ids: DEMO_IDS,
            chats: [...chats.values()],
            threads: [...threads.values()].map((thread) => ({
              ...thread,
              stages: Object.fromEntries(thread.stages),
              scenarios: Object.fromEntries(thread.scenarios),
            })),
            notifications: [...notifications.values()],
            controls: [...controls.values()],
            answers: [...answers.values()],
            offline,
          })
        const input = method === 'POST' ? record(await request.json()) : {}
        if (path === '/__demo/message' && method === 'POST') {
          const thread = getThread(text(input.threadId))
          const message = parseMessage(input.message)
          const previous = thread.messages.findIndex(
            (item) => item.id === message.id,
          )
          if (previous < 0) thread.messages.push(message)
          else if (thread.messages[previous].revision < message.revision)
            thread.messages[previous] = message
          changeMessage(thread, message)
          return json({ ok: true })
        }
        if (path === '/__demo/identity' && method === 'POST') {
          for (const key of ['installationId', 'callerId'] as const) {
            if (input[key] !== undefined) {
              const value = text(input[key])
              if (!uuid.test(value)) throw new Error('Invalid identity')
              scope[key] = value
            }
          }
          for (const journal of logs.values()) {
            for (const listener of [...journal.listeners])
              listener('resync-required')
            journal.floor = journal.head
            journal.events = []
          }
          return json({ ...scope })
        }
        if (path === '/__demo/work' && method === 'POST') {
          const thread = getThread(text(input.threadId))
          if (input.work) {
            const value = parseWork(input.work)
            const current = thread.work.find((run) => run.runId === value.runId)
            const newer = !current || value.revision > current.revision
            if (!current) thread.work.push(value)
            else if (newer) Object.assign(current, value)
            if (newer) changeWork(thread, value)
            else
              emit(
                'work-changed',
                value,
                value.runId,
                value.revision,
                thread.summary.threadId,
              )
          }
          if (input.interaction) {
            const value = parseInteraction(input.interaction)
            const current = thread.interactions.find(
              (card) => card.id === value.id,
            )
            const newer = !current || value.revision > current.revision
            if (!current) thread.interactions.push(value)
            else if (newer) Object.assign(current, value)
            if (newer) changeInteraction(thread, value)
            else
              emit(
                'interaction-changed',
                value,
                value.id,
                value.revision,
                thread.summary.threadId,
              )
          }
          if (input.delegation) {
            const value = parseDelegation(input.delegation)
            const current = thread.delegations.find(
              (item) => item.id === value.id,
            )
            if (!current) thread.delegations.push(value)
            else if (value.revision > current.revision)
              Object.assign(current, value)
            emit(
              'delegation-changed',
              value,
              value.id,
              value.revision,
              thread.summary.threadId,
            )
          }
          return json({ ok: true })
        }
        if (path === '/__demo/notification' && method === 'POST') {
          const notice = parseNotice(input.notification)
          getThread(notice.threadId)
          const current = notifications.get(notice.id)
          if (!current || notice.revision > current.revision)
            notifications.set(notice.id, clone(notice))
          emit('notification', notice, notice.id, notice.revision)
          return json({ ok: true })
        }
        if (path === '/__demo/advance' && method === 'POST') {
          const steps = input.steps ?? 1
          if (
            !Number.isInteger(steps) ||
            Number(steps) < 1 ||
            Number(steps) > 100
          )
            throw new Error('Invalid step count')
          for (let step = 0; step < Number(steps); step++)
            for (const thread of input.threadId
              ? [getThread(text(input.threadId))]
              : threads.values())
              advance(thread)
          return json({ ok: true })
        }
        if (path === '/__demo/connection' && method === 'POST') {
          if (typeof input.offline !== 'boolean')
            throw new Error('Invalid offline state')
          offline = input.offline
          if (offline)
            for (const journal of logs.values())
              for (const listener of journal.listeners)
                listener('resync-required')
          return json({ ok: true })
        }
        if (path === '/__demo/retention' && method === 'POST') {
          const threadId = input.threadId ? text(input.threadId) : undefined
          const journal = log(threadId)
          journal.floor = journal.head
          journal.events = []
          for (const listener of journal.listeners) listener('resync-required')
          return json({ ok: true })
        }
        if (path === '/__demo/operation' && method === 'POST') {
          if (typeof input.waiting !== 'boolean')
            throw new Error('Invalid waiting state')
          administration.setOperationWaiting(
            text(input.operationId),
            input.waiting,
          )
          return json({ ok: true })
        }
        if (path === '/__demo/reset' && method === 'POST') {
          await reset()
          return json({ ok: true })
        }
        if (path === '/__demo/scenario' && method === 'POST') {
          const thread = getThread(text(input.threadId))
          const scenario = text(input.scenario)
          if (
            ![
              'question',
              'approval',
              'delegation',
              'failure',
              'complete',
            ].includes(scenario)
          )
            throw new Error('Invalid scenario')
          const run = thread.work.find((run) => active.has(run.state))
          if (!run) throw new Error('Active run not found')
          thread.scenarios.set(run.runId, scenario as Scenario)
          return json({ ok: true })
        }
        throw new WireError(404, 'not-found', 'Route not found')
      }
      if (offline)
        throw new WireError(503, 'unavailable', 'Demo Core is offline')
      if (method === 'GET' && path === '/v1/bootstrap')
        return json({ ...administration.bootstrap(), ...scope })
      if (method === 'GET' && path === '/v1/directory') return json(directory())
      const mediaResponse = await media.handle(request)
      if (mediaResponse) return mediaResponse
      const adminResponse = await administration.handle(request)
      if (adminResponse) return adminResponse
      if (method === 'POST' && path === '/v1/direct-chats') {
        const row = await body(request)
        fields(row, ['version', 'context', 'agentId'], ['context', 'agentId'])
        return json({
          version: 1,
          chatId: directChat(context(row.context), text(row.agentId)).id,
        })
      }
      if (method === 'POST' && path === '/v1/text/submissions') {
        const row = await body(request)
        fields(
          row,
          [
            'version',
            'submissionId',
            'scope',
            'target',
            'mode',
            'parts',
            ...(row.mode === 'reply' ? ['threadId'] : []),
          ],
          ['submissionId', 'scope', 'target', 'mode', 'parts'],
        )
        const caller = fields(
          row.scope,
          ['installationId', 'callerId'],
          ['installationId', 'callerId'],
        )
        if (
          caller.installationId !== scope.installationId ||
          caller.callerId !== scope.callerId
        )
          throw new WireError(403, 'forbidden', 'Caller scope mismatch')
        const target = fields(
          row.target,
          ['context', 'chatId'],
          ['context', 'chatId'],
        )
        const targetContext = context(target.context),
          chat = authorizeChat(text(target.chatId), targetContext, true)
        const parts = parseParts(row.parts),
          submissionId = text(row.submissionId)
        if (row.mode !== 'root' && row.mode !== 'reply')
          throw new Error('Invalid submission mode')
        if (row.mode === 'reply') text(row.threadId)
        const prior = receipts.get(submissionId)
        if (prior) return json({ ...prior, alreadyAccepted: true }, 202)
        admit(targetContext, chat.agentId)
        media.validateParts(
          {
            ...scope,
            context: targetContext,
            chatId: chat.id,
            ...(row.mode === 'reply' ? { threadId: text(row.threadId) } : {}),
          },
          parts,
        )
        const thread =
          row.mode === 'root' ? newThread(chat) : getThread(text(row.threadId))
        if (thread.summary.chatId !== chat.id)
          throw new Error('Thread not found in chat')
        const message = addMessage(thread, scope.callerId, parts),
          run = addRun(thread, message, 'question')
        changeMessage(thread, message)
        changeWork(thread, run)
        const receipt = {
          version: 1,
          status: 'accepted',
          submissionId,
          chatId: chat.id,
          threadId: thread.summary.threadId,
          messageId: message.id,
          runId: run.runId,
          alreadyAccepted: false,
        }
        receipts.set(submissionId, clone(receipt))
        return json(receipt, 202)
      }
      const receiptMatch = /^\/v1\/text\/receipts\/([^/]+)$/.exec(path)
      if (method === 'GET' && receiptMatch) {
        const receipt = receipts.get(decodeURIComponent(receiptMatch[1]))
        if (!receipt) throw new WireError(404, 'not-found', 'Receipt not found')
        return json({ ...receipt, alreadyAccepted: true })
      }
      if (
        method === 'POST' &&
        (path === '/v1/work/controls' || path === '/v1/work/controls/receipt')
      )
        return workControl(request, path.endsWith('/receipt'))
      if (
        method === 'POST' &&
        (path === '/v1/work/interactions/answer' ||
          path === '/v1/work/interactions/receipt')
      )
        return answer(request, path.endsWith('/receipt'))
      const noticeMatch = /^\/v1\/notifications\/([0-9a-f-]{36})\/read$/.exec(
        path,
      )
      if (method === 'POST' && noticeMatch) {
        const row = await body(request)
        fields(row, ['version'])
        const notice = notifications.get(noticeMatch[1])
        if (!notice) throw new Error('Notification not found')
        if (!notice.read) {
          notice.read = true
          notice.revision++
          emit('notification', notice, notice.id, notice.revision)
        }
        return json({ version: 1, status: 'read', notificationId: notice.id })
      }
      const streamMatch =
        /^\/v1\/threads\/([0-9a-f-]{36})\/(snapshot|events)$/.exec(path)
      if (
        method === 'GET' &&
        (path === '/v1/app/snapshot' || streamMatch?.[2] === 'snapshot')
      )
        return json(snapshot(url, streamMatch?.[1]))
      if (
        method === 'GET' &&
        (path === '/v1/app/events' || streamMatch?.[2] === 'events')
      )
        return events(request, url, streamMatch?.[1])
      throw new WireError(404, 'not-found', 'Route not found')
    } catch (error) {
      return errorResponse(error)
    }
  }

  async function workControl(
    request: Request,
    lookup: boolean,
  ): Promise<Response> {
    try {
      const row = await body(request)
      fields(
        row,
        [
          'version',
          'operationId',
          'context',
          'chatId',
          'threadId',
          'runId',
          'attemptId',
          'action',
        ],
        ['operationId', 'context', 'chatId', 'threadId', 'runId', 'action'],
      )
      const operationId = text(row.operationId),
        action = text(row.action)
      if (
        operationId.length > 200 ||
        !['stop', 'resume', 'retry', 'cancel-queued', 'steer'].includes(action)
      )
        throw new Error('Invalid control')
      if (row.attemptId !== undefined && row.attemptId !== null)
        text(row.attemptId)
      const chat = authorizeChat(text(row.chatId), context(row.context)),
        thread = getThread(text(row.threadId)),
        run = thread.work.find((run) => run.runId === text(row.runId))
      if (!run || thread.summary.chatId !== chat.id)
        throw new WireError(403, 'forbidden', 'Run target denied')
      const prior = controls.get(operationId)
      if (prior) return json(prior)
      if (lookup) return json({ version: 1, operationId, status: 'unknown' })
      let outcome = 'accepted',
        reason = ''
      const reject = (message: string) => {
        outcome = 'rejected'
        reason = message
      }
      if (action === 'steer') {
        outcome = 'unsupported'
        reason = 'Adapter steering is unsupported'
      } else if (action === 'cancel-queued') {
        if (run.state !== 'queued' || run.attemptId)
          reject('Work is not queued')
        else run.state = 'cancelled'
      } else if (action === 'stop') {
        if (!active.has(run.state)) reject('Work is already settled')
        else if (run.attemptId && row.attemptId !== run.attemptId)
          reject('Attempt target changed')
        else {
          run.state = run.attemptId ? 'cancellation-requested' : 'cancelled'
          run.queueHold = true
          run.cancelDelivery = run.attemptId ? 'requested' : 'not-needed'
          settleInteractions(thread, 'cancelled', run.runId)
          for (const delegation of thread.delegations.filter(
            (item) => item.parentRunId === run.runId && active.has(item.state),
          )) {
            delegation.state = 'cancelled'
            delegation.revision++
            emit(
              'delegation-changed',
              delegation,
              delegation.id,
              delegation.revision,
              thread.summary.threadId,
            )
          }
        }
      } else if (action === 'resume') {
        if (
          !run.queueHold ||
          !['failed', 'cancelled', 'completed'].includes(run.state)
        )
          reject('Work is not safely held')
        else run.queueHold = false
      } else if (action === 'retry') {
        const state = directory()
        const live =
          state.agents.some(
            (agent) =>
              agent.id === chat.agentId && agent.lifecycle === 'active',
          ) &&
          (chat.context.kind === 'installation' ||
            state.organizations.some(
              (org) =>
                org.id === contextId(chat.context) &&
                org.lifecycle === 'active',
            ))
        if (!live) reject('Agent is not available for new work')
        else if (
          run.state !== 'failed' ||
          !run.queueHold ||
          row.attemptId !== run.attemptId ||
          thread.work.find(
            (item) => active.has(item.state) || item.queueHold,
          ) !== run
        )
          reject('Failed work is not safe to retry')
        else {
          run.state = 'queued'
          run.failure = null
          thread.stages.set(run.runId, 0)
          thread.scenarios.set(run.runId, 'complete')
          settleInteractions(thread, 'superseded', run.runId)
        }
      }
      if (outcome === 'accepted') {
        run.revision++
        changeWork(thread, run)
      }
      const receipt = {
        version: 1,
        operationId,
        outcome,
        reason,
        runId: run.runId,
        threadId: thread.summary.threadId,
        state: run.state,
      }
      controls.set(operationId, clone(receipt))
      return json(receipt)
    } catch (error) {
      return errorResponse(error)
    }
  }
  async function answer(request: Request, lookup: boolean): Promise<Response> {
    try {
      const row = await body(request)
      fields(
        row,
        [
          'version',
          'operationId',
          'interactionId',
          'threadId',
          'runId',
          'attemptId',
          'proposalId',
          'answer',
        ],
        [
          'operationId',
          'interactionId',
          'threadId',
          'runId',
          'attemptId',
          'answer',
        ],
      )
      const operationId = text(row.operationId),
        thread = getThread(text(row.threadId))
      if (operationId.length > 200)
        throw new Error('Invalid response operation ID')
      const card = thread.interactions.find(
        (card) => card.id === text(row.interactionId),
      )
      if (!card) throw new Error('Interaction not found')
      if (
        card.runId !== text(row.runId) ||
        card.attemptId !== text(row.attemptId)
      )
        throw new WireError(403, 'forbidden', 'Interaction target mismatch')
      const response = record(row.answer),
        kind = text(response.kind)
      const allowed: Record<string, string[]> = {
        choice: ['kind', 'optionId', 'text'],
        text: ['kind', 'text'],
        dismiss: ['kind'],
        approve: ['kind', 'comment'],
        decline: ['kind', 'comment'],
      }
      if (!allowed[kind]) throw new Error('Invalid answer kind')
      fields(response, allowed[kind])
      if (kind === 'choice') text(response.optionId)
      if (kind === 'text') text(response.text)
      if (
        (response.text !== undefined && typeof response.text !== 'string') ||
        (response.comment !== undefined && typeof response.comment !== 'string')
      )
        throw new Error('Invalid answer text')
      const prior = answers.get(operationId)
      if (prior) return json(prior)
      if (lookup) return json({ version: 1, operationId, status: 'unknown' })
      const run = thread.work.find((run) => run.runId === card.runId)!
      const valid =
        card.kind === 'approval'
          ? row.proposalId === card.proposalId &&
            ['approve', 'decline'].includes(kind) &&
            (response.comment === undefined ||
              String(response.comment).length <= 2000)
          : kind === 'dismiss' ||
            (kind === 'text' &&
              card.freeText &&
              !!String(response.text).trim() &&
              String(response.text).length <= 8000) ||
            (kind === 'choice' &&
              card.options.some((option) => option.id === response.optionId) &&
              (response.text === undefined ||
                (card.freeText && String(response.text).length <= 8000)))
      const outcome =
        card.state === 'pending' &&
        run.state !== 'cancellation-requested' &&
        valid
          ? 'accepted'
          : 'rejected'
      if (outcome === 'accepted') {
        card.state = 'settled'
        card.revision++
        card.response = {
          operationId,
          actorId: scope.callerId,
          answer: clone(response),
          acceptedAt: now(),
        }
        changeInteraction(thread, card)
        run.state = 'running'
        run.revision++
        changeWork(thread, run)
        thread.stages.set(run.runId, 3)
      }
      const receipt = {
        version: 1,
        operationId,
        outcome,
        interaction: clone(card),
      }
      answers.set(operationId, clone(receipt))
      return json(receipt)
    } catch (error) {
      return errorResponse(error)
    }
  }

  async function seedData() {
    const definitions: {
      state: string
      title: string
      scenario: Scenario
      agent?: string
    }[] = [
      {
        state: 'completed',
        title: 'Shape a calmer workspace for the next release',
        scenario: 'complete',
      },
      {
        state: 'running',
        title: 'Bring the research findings into focus',
        scenario: 'question',
      },
      {
        state: 'queued',
        title: 'Explore the next product direction',
        scenario: 'question',
      },
      {
        state: 'waiting',
        title: 'Choose the direction for the launch story',
        scenario: 'question',
      },
      {
        state: 'waiting',
        title: 'Review the proposal before publishing',
        scenario: 'approval',
      },
      {
        state: 'running',
        title: 'Check the engineering tradeoffs together',
        scenario: 'delegation',
      },
      {
        state: 'failed',
        title: 'Prepare the weekly digest',
        scenario: 'failure',
      },
      {
        state: 'preparing',
        title: 'Turn this voice note into a plan',
        scenario: 'complete',
      },
      {
        state: 'cancelled',
        title: 'An earlier idea we paused',
        scenario: 'complete',
      },
      {
        state: 'cancellation-requested',
        title: 'Stopping an exploration',
        scenario: 'complete',
      },
      {
        state: 'recovery-needed',
        title: 'Review an interrupted handoff',
        scenario: 'complete',
      },
    ]
    const primary: Chat = {
      id: seededId(),
      context: { kind: 'organization', organizationId: DEMO_IDS.organization },
      agentId: DEMO_IDS.researcher,
    }
    chats.set(primary.id, primary)
    for (const [index, definition] of definitions.entries()) {
      const thread = newThread(primary, seededId())
      thread.summary.createdAt = new Date(
        Date.now() - (definitions.length - index) * 3_600_000,
      ).toISOString()
      const input = addMessage(
        thread,
        scope.callerId,
        [{ kind: 'text', text: definition.title }],
        true,
        seededId(),
      )
      const run = addRun(thread, input, definition.scenario, seededId())
      changeMessage(thread, input)
      changeWork(thread, run)
      if (definition.state !== 'queued') advance(thread)
      if (definition.state === 'completed') {
        advance(thread)
        advance(thread)
        advance(thread)
      } else if (
        definition.state === 'waiting' ||
        definition.state === 'failed' ||
        definition.scenario === 'delegation'
      ) {
        advance(thread)
        advance(thread)
      } else if (definition.state !== 'running') {
        run.state = definition.state
        run.queueHold = [
          'cancelled',
          'cancellation-requested',
          'recovery-needed',
        ].includes(run.state)
        if (run.state === 'cancellation-requested')
          run.cancelDelivery = 'requested'
        run.revision++
        changeWork(thread, run)
        if (run.state === 'recovery-needed')
          notify(thread, run, 'recovery-needed')
      }
      if (definition.state === 'failed') {
        const followup = addMessage(
          thread,
          scope.callerId,
          [
            {
              kind: 'text',
              text: 'When that is ready, add a short version for the team.',
            },
          ],
          true,
          seededId(),
        )
        const queued = addRun(thread, followup, 'complete', seededId())
        changeMessage(thread, followup)
        emit(
          'work-changed',
          queued,
          queued.runId,
          queued.revision,
          thread.summary.threadId,
        )
        summary(thread, 'failed')
      }
    }
    // Other contexts share identities but retain independent direct conversations.
    for (const [organizationId, agentId, title] of [
      [
        DEMO_IDS.studio,
        DEMO_IDS.designer,
        'Explore an inviting visual direction',
      ],
      [DEMO_IDS.personal, DEMO_IDS.engineer, 'Make a small plan for the week'],
      [null, DEMO_IDS.rootAgent, 'Your Kipster installation is ready'],
    ] as const) {
      const chat: Chat = {
        id: seededId(),
        context: organizationId
          ? { kind: 'organization', organizationId }
          : { kind: 'installation', installationId: scope.installationId },
        agentId,
      }
      chats.set(chat.id, chat)
      const thread = newThread(chat, seededId()),
        message = addMessage(
          thread,
          scope.callerId,
          [{ kind: 'text', text: title }],
          true,
          seededId(),
        ),
        run = addRun(thread, message, 'complete', seededId())
      changeMessage(thread, message)
      changeWork(thread, run)
      for (let step = 0; step < 4; step++) advance(thread)
    }
    const first = [...threads.values()][0]
    const firstTarget = {
      ...scope,
      context: primary.context,
      chatId: primary.id,
      threadId: first.summary.threadId,
    }
    const file = await media.addArtifact({
      id: seededId(),
      name: 'workspace-plan.md',
      mimeType: 'text/markdown',
      bytes: new TextEncoder().encode(
        '# A calmer workspace\n\nMake the next action clear. Preserve room for focused work.\n',
      ),
      target: firstTarget,
      provenance: { kind: 'generated', authorId: DEMO_IDS.engineer },
      ownership: { kind: 'agent', id: DEMO_IDS.engineer },
    })
    const image = await media.addArtifact({
      id: seededId(),
      name: 'palette.svg',
      mimeType: 'image/svg+xml',
      bytes: new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" rx="24" fill="#d9e9ee"/><circle cx="140" cy="120" r="65" fill="#8ca89b"/><circle cx="300" cy="120" r="65" fill="#d4b5ae"/></svg>',
      ),
      target: firstTarget,
    })
    const publication = addMessage(first, primary.agentId, [
      {
        kind: 'text',
        text: 'Here are the workspace notes and an early palette study.',
      },
      { kind: 'file', artifactId: file.id, purpose: 'attachment' },
      { kind: 'file', artifactId: image.id, purpose: 'attachment' },
    ])
    changeMessage(first, publication)
    const voiceThread = [...threads.values()][7]
    const audio = new Uint8Array(44 + 1600 * 2),
      view = new DataView(audio.buffer)
    const ascii = (offset: number, value: string) => {
      for (let i = 0; i < value.length; i++)
        audio[offset + i] = value.charCodeAt(i)
    }
    ascii(0, 'RIFF')
    view.setUint32(4, audio.length - 8, true)
    ascii(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 8000, true)
    view.setUint32(28, 16000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    ascii(36, 'data')
    view.setUint32(40, 3200, true)
    for (let sample = 0; sample < 1600; sample++)
      view.setInt16(
        44 + sample * 2,
        Math.sin((sample * Math.PI * 2 * 220) / 8000) * 1000,
        true,
      )
    const voice = await media.addArtifact({
      id: seededId(),
      name: 'voice-note.wav',
      mimeType: 'audio/wav',
      bytes: audio,
      target: { ...firstTarget, threadId: voiceThread.summary.threadId },
    })
    const voiceMessage = voiceThread.messages[0]
    voiceMessage.parts.push({
      kind: 'file',
      artifactId: voice.id,
      purpose: 'voice_note',
    })
    voiceMessage.preparation = [
      {
        id: `${voiceMessage.id}:1`,
        artifactId: voice.id,
        partIndex: 1,
        revision: 1,
        status: 'preparing',
        provider: 'demo-transcription',
      },
    ]
    voiceMessage.revision++
    changeMessage(voiceThread, voiceMessage)
    voiceThread.stages.set(voiceThread.work[0].runId, 0)
  }
  async function reset() {
    for (const journal of logs.values())
      for (const listener of journal.listeners) listener('resync-required')
    chats.clear()
    threads.clear()
    notifications.clear()
    receipts.clear()
    controls.clear()
    answers.clear()
    logs.clear()
    media.reset()
    seed = 100
    offline = false
    administration = createAdministration({
      emit,
      cursor: () => cursor(),
      onLifecycle: lifecycle,
    })
    await seedData()
  }
  const ready = seedData()
  const timer =
    options.autoAdvance === false
      ? undefined
      : setInterval(() => {
          if (!offline && !disposed)
            for (const thread of threads.values()) advance(thread)
        }, options.tickMs ?? 1800)
  return {
    handle,
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const journal of logs.values())
        for (const listener of journal.listeners) listener('gone')
    },
  }
}
