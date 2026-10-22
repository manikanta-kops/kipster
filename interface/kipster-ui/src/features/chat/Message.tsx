import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { KipHead } from '../../components/Kip'
import { ArtifactCard } from '../media/ArtifactCard'
import type { Message as MessageModel, WorkspaceData } from './model'
import { formatSize, formatTime } from './model'
import { Markdown } from './Markdown'
import { kipName } from './kip-names'
import { MessageActions } from './MessageActions'
import { FileBadge } from '../media/FileBadge'
import { DocCard } from '../documents/DocCard'

export function Avatar({
  name,
  color = 'iris',
  isSelf = false,
  kip = false,
}: {
  name: string
  color?: string
  isSelf?: boolean
  /** The root admin wears Kip's LED head instead of an initial. */
  kip?: boolean
}) {
  if (kip)
    return (
      <span aria-hidden="true" className="avatar kip">
        <KipHead />
      </span>
    )
  return (
    <span aria-hidden="true" className={`avatar ${isSelf ? 'you' : color}`}>
      {isSelf ? 'Y' : name.charAt(0)}
    </span>
  )
}
export function Message({
  message,
  data,
  trail,
  continued = false,
  placement = 'thread',
  openThread,
}: {
  message: MessageModel
  data: WorkspaceData
  /** Shown after the content, such as the work behind this reply. */
  trail?: ReactNode
  /** Follows the same author's message, so the name is not repeated. */
  continued?: boolean
  /** A root in the feed or a message in its thread; kip messages label each differently. */
  placement?: 'feed' | 'thread'
  /** Opens a linked thread, in whichever chat it lives. */
  openThread?: (threadId: string) => void
}) {
  const thread = data.threadsById[message.threadId]
  const chat = thread && data.chatsById[thread.chatId]
  const author = data.actorsById[message.authorId]
  const isSelf = message.authorId === data.currentHumanId
  const name = isSelf ? 'You' : (author?.name ?? 'Deleted participant')
  const admin = data.agentRoles.some(
    (role) => role.agentId === message.authorId,
  )
  const sent = message.kipMessage
  // The message that opened or continues a linked thread comes from the sending kip.
  const from =
    thread?.linkedFrom &&
    !sent &&
    message.authorId === thread.linkedFrom.agentId
      ? thread.linkedFrom
      : undefined
  // A sent card stands on its own, under the message before it.
  const bare = continued || !!sent
  const lastTextPart = message.parts.findLastIndex(
    (part) => part.type === 'text',
  )
  const firstTextPart = message.parts.findIndex((part) => part.type === 'text')
  const content = message.parts.map((part, index) => {
    if (part.type === 'text') {
      // The feed previews all the text as one block, so the line limit applies once.
      if (placement === 'feed' && index !== firstTextPart) return null
      return (
        <Markdown
          key={index}
          text={
            placement === 'feed'
              ? message.parts
                  .flatMap((p) => (p.type === 'text' ? [p.text] : []))
                  .join('\n\n')
              : part.text
          }
          streaming={
            message.status === 'draft' &&
            (placement === 'feed' || index === lastTextPart)
          }
        />
      )
    }
    if (part.type === 'removed')
      return (
        <p className="removed-part" key={index}>
          <Icon name="file" size={14} /> File removed
        </p>
      )
    if (part.type === 'document')
      return (
        <DocCard
          key={index}
          documentId={part.documentId}
          revision={part.revision}
        />
      )
    if (part.type === 'unknown')
      return (
        <p key={index} className="unsupported-part">
          Unsupported content: {part.originalKind}
        </p>
      )
    if (part.type === 'file' && chat)
      return (
        <ArtifactCard
          key={index}
          artifactId={part.artifactId}
          fallback={data.artifactsById[part.artifactId]}
          voice={part.purpose === 'voice_note'}
          target={{
            installationId: data.installationId,
            callerId: data.currentHumanId,
            context: chat.context,
            chatId: chat.id,
            threadId: message.threadId,
          }}
        />
      )
    const file =
      part.type === 'local-file'
        ? part.file
        : data.artifactsById[part.artifactId]
    const local =
      part.type === 'local-file' ||
      (file && 'availability' in file && file.availability === 'local-preview')
    return (
      <div className="file-row" key={index}>
        <FileBadge name={file?.name ?? ''} />
        <span>
          {file?.name ?? 'Unavailable file'}
          <small>
            {file
              ? `${formatSize(file.size)}${local ? ' · Not uploaded' : ''}`
              : 'File unavailable'}
          </small>
        </span>
      </div>
    )
  })
  return (
    <div className={`message-content${bare ? ' continued' : ''}`}>
      {bare ? (
        <span aria-hidden="true" />
      ) : (
        <Avatar
          name={name}
          color={author?.kind === 'agent' ? author.color : undefined}
          isSelf={isSelf}
          kip={admin}
        />
      )}
      <div className="message-body">
        <div className={bare ? 'sr-only' : 'message-meta'}>
          <strong>{name}</strong>
          {admin && placement === 'thread' && (
            <span className="role-label">admin kip</span>
          )}
          {message.timestampKnown !== false && (
            <time dateTime={message.createdAt}>
              {formatTime(message.createdAt)}
            </time>
          )}
          {from && placement === 'feed' && (
            <span className="kip-tag">
              <Icon name="link" size={11} />
              Kip message
            </span>
          )}
          {message.status === 'draft' && !trail && (
            <span className="message-state">Writing</span>
          )}
        </div>
        {sent ? (
          <section
            className="kip-sent"
            aria-label={`Sent to ${kipName(data, sent.recipientId)}`}
          >
            <p className="kip-sent-top">
              <Icon name="arrowRight" size={14} />
              Sent to {kipName(data, sent.recipientId)}
            </p>
            {content}
            <div className="kip-sent-foot">
              <span>
                {kipName(data, sent.recipientId)}’s answer comes back here
              </span>
              <button
                className="kip-open"
                onClick={() => openThread?.(sent.threadId)}
              >
                Open in {kipName(data, sent.recipientId)}’s chat
                <Icon name="arrowRight" size={12} />
              </button>
            </div>
          </section>
        ) : (
          content
        )}
        {from && (
          <button
            className="kip-via"
            onClick={() => openThread?.(from.threadId)}
          >
            <Icon name="link" size={12} />
            {placement === 'feed' ? 'From' : 'Sent from'} “{from.title}” in{' '}
            {kipName(data, from.agentId)}’s chat
          </button>
        )}
        {message.kipAnswer && (
          <button
            className="kip-via"
            onClick={() => openThread?.(message.kipAnswer!.threadId)}
          >
            <Icon name="undo" size={12} />
            Answer from {kipName(data, message.kipAnswer.agentId)}’s thread
          </button>
        )}
        {message.preparation?.map((p) => (
          <section
            key={p.id}
            className={`preparation-card ${p.status}`}
            aria-label="Voice preparation"
            aria-live="polite"
          >
            <details>
              <summary>
                {p.status === 'preparing'
                  ? 'Preparing voice note…'
                  : p.status === 'succeeded'
                    ? 'Transcript'
                    : p.status === 'no-speech'
                      ? 'No speech detected'
                      : p.status === 'unavailable' || p.status === 'failed'
                        ? 'Transcription unavailable'
                        : p.status}
              </summary>
              <span className="sr-only">
                Derived from voice note {p.partIndex + 1} · {p.provider}
              </span>
              {p.transcript && <p>{p.transcript}</p>}
              {p.status === 'unavailable' && !p.error && (
                <p>Original audio and typed text remain available.</p>
              )}
              {p.error && (
                <p>
                  {p.error} Original audio and typed inputs remain available.
                </p>
              )}
            </details>
          </section>
        ))}
        {trail}
        {placement === 'thread' && (
          <MessageActions message={message} isSelf={isSelf} />
        )}
      </div>
    </div>
  )
}
