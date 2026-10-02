import { WorkSummary } from '../work/WorkSummary'
import type { WorkRecords } from '../../data/work'
import { Fragment, type ReactNode, type RefObject } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { quickFade } from '../../app/motion'
import { KipBody } from '../../components/Kip'
import { Message, Avatar } from './Message'
import {
  formatTime,
  type Thread,
  type WorkspaceData,
  type Chat,
  type Agent,
} from './model'
export function RootFeed({
  work,
  chat,
  agent,
  data,
  visible,
  threadId,
  triggers,
  onOpen,
  rootUnavailable,
  rootNotice,
}: {
  work: WorkRecords
  chat: Chat
  agent: Agent
  data: WorkspaceData
  visible: Thread[]
  threadId: string | null
  triggers: RefObject<Map<string, HTMLButtonElement>>
  onOpen: (id: string) => void
  rootUnavailable?: (thread: Thread) => ReactNode
  rootNotice?: (thread: Thread) => ReactNode
}) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className="feed"
      key={chat.id}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={quickFade}
    >
      {visible.length ? (
        <AnimatePresence initial={false}>
          {visible.map((item, index) => {
            const itemWork = work.workflows.find(
              (w) => w.target.threadId === item.id,
            )
            const root = data.messagesById[item.rootMessageId]
            const date = root?.createdAt ?? item.createdAt
            const previous = visible[index - 1]
            const previousDate = previous
              ? (data.messagesById[previous.rootMessageId]?.createdAt ??
                previous.createdAt)
              : undefined
            const replyCount = Math.max(
              0,
              item.replyCount ?? item.messageIds.length - 1,
            )
            return (
              <Fragment key={item.id}>
                {date &&
                  (!previousDate ||
                    new Date(previousDate).toDateString() !==
                      new Date(date).toDateString()) && (
                    <div className="date-divider">
                      <time dateTime={date}>
                        {new Date(date).toLocaleDateString(undefined, {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        })}
                      </time>
                    </div>
                  )}
                <motion.article
                  initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={quickFade}
                  key={item.id}
                  onClick={(event) => {
                    const target = event.target as Element
                    if (
                      event.defaultPrevented ||
                      target.closest(
                        'a, button, input, textarea, select, summary, audio, video, [role="button"], [contenteditable="true"]',
                      ) ||
                      window.getSelection()?.toString()
                    )
                      return
                    onOpen(item.id)
                  }}
                  className={`feed-message gloss ${threadId === item.id ? 'active-message' : ''}`}
                >
                  {root ? (
                    <Message message={root} data={data} />
                  ) : (
                    (rootUnavailable?.(item) ?? (
                      <output>Loading thread…</output>
                    ))
                  )}
                  {root && rootNotice?.(item)}
                  <div className="root-foot">
                    <button
                      ref={(element) => {
                        if (element) triggers.current.set(item.id, element)
                        else triggers.current.delete(item.id)
                      }}
                      className={replyCount > 0 ? 'reply-link' : 'sr-only'}
                      aria-label={`Open thread: ${item.title}`}
                      aria-expanded={threadId === item.id}
                      onClick={() => {
                        onOpen(item.id)
                      }}
                    >
                      {replyCount > 0 && (
                        <>
                          <span
                            className="reply-participants"
                            aria-hidden="true"
                          >
                            {(item.participantIds ?? [])
                              .slice(0, 3)
                              .map((id) => (
                                <Avatar
                                  key={id}
                                  name={data.actorsById[id]?.name ?? '?'}
                                  isSelf={id === data.currentHumanId}
                                  color={
                                    data.actorsById[id]?.kind === 'agent'
                                      ? data.actorsById[id].color
                                      : undefined
                                  }
                                  kip={data.agentRoles.some(
                                    (role) => role.agentId === id,
                                  )}
                                />
                              ))}
                          </span>
                          <span className="reply-count">
                            {`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                          </span>
                          {replyCount > 0 && (
                            <span className="reply-description">
                              Last reply
                              {item.lastReplyAuthor
                                ? ` by ${item.lastReplyAuthor}`
                                : ''}
                              {item.lastMessageAt
                                ? ` ${formatTime(item.lastMessageAt)}`
                                : ''}
                            </span>
                          )}
                        </>
                      )}
                    </button>
                    <WorkSummary work={itemWork} />
                  </div>
                </motion.article>
              </Fragment>
            )
          })}
        </AnimatePresence>
      ) : (
        <div className="empty-state">
          {data.agentRoles.some((role) => role.agentId === agent.id) ? (
            <>
              <span className="empty-mark kip" aria-hidden="true">
                <KipBody />
              </span>
              <h2>Hey, it's {agent.name}.</h2>
              <p>
                Ask {agent.name} anything.
                <br />
                {agent.name} runs your other kips.
              </p>
            </>
          ) : (
            <>
              <span className="empty-mark agent" aria-hidden="true">
                <Avatar name={agent.name} color={agent.color} />
              </span>
              <h2>A little space to think.</h2>
              <p>
                Start a conversation with {agent.name}.<br />
                Your ideas can grow from here.
              </p>
            </>
          )}
        </div>
      )}
    </motion.div>
  )
}
