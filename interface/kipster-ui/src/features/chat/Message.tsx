import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { KipHead } from '../../components/Kip'
import { ArtifactCard } from '../media/ArtifactCard'
import type { Message as MessageModel, WorkspaceData } from './model'
import { formatSize, formatTime } from './model'
import { Markdown } from './Markdown'
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
  lead,
}: {
  message: MessageModel
  data: WorkspaceData
  /** Shown above the content, such as the work that led to this reply. */
  lead?: ReactNode
}) {
  const thread = data.threadsById[message.threadId]
  const chat = thread && data.chatsById[thread.chatId]
  const author = data.actorsById[message.authorId]
  const isSelf = message.authorId === data.currentHumanId
  const name = isSelf ? 'You' : (author?.name ?? 'Deleted participant')
  const lastTextPart = message.parts.findLastIndex(
    (part) => part.type === 'text',
  )
  return (
    <div className="message-content">
      <Avatar
        name={name}
        color={author?.kind === 'agent' ? author.color : undefined}
        isSelf={isSelf}
        kip={data.agentRoles.some((role) => role.agentId === message.authorId)}
      />
      <div className="message-body">
        <div className="message-meta">
          <strong>{name}</strong>
          {message.timestampKnown !== false && (
            <time dateTime={message.createdAt}>
              {formatTime(message.createdAt)}
            </time>
          )}
          {message.status === 'draft' && !lead && (
            <span className="message-state">Writing</span>
          )}
        </div>
        {lead}
        {message.parts.map((part, index) => {
          if (part.type === 'text')
            return (
              <Markdown
                key={index}
                text={part.text}
                streaming={message.status === 'draft' && index === lastTextPart}
              />
            )
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
            (file &&
              'availability' in file &&
              file.availability === 'local-preview')
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
        })}
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
      </div>
    </div>
  )
}
