import { useState } from 'react'
import type { PendingSubmission } from '../../data/conversation-storage'
import type { WorkspaceData } from './model'

export function ConversationRecovery({
  entries,
  data,
  retry,
  discard,
  openThread,
}: {
  entries: PendingSubmission[]
  data: WorkspaceData
  retry: (entry: PendingSubmission) => Promise<void>
  discard: (entry: PendingSubmission) => Promise<void>
  openThread?: (id: string) => void
}) {
  const [error, setError] = useState('')
  const pending = entries.filter(
    (entry) => !['accepted', 'discarded'].includes(entry.state),
  )
  return (
    <div className="submission-recovery">
      {pending.map((entry) => (
        <div className={`pending-submission ${entry.state}`} key={entry.id}>
          <span className="recovery-status">
            {entry.submission.target.threadId ? 'Reply' : 'New thread'} ·{' '}
            {entry.state === 'sending'
              ? 'Sending · waiting for receipt'
              : entry.state === 'uncertain'
                ? 'Acceptance not yet confirmed'
                : entry.state === 'rejected'
                  ? 'Not accepted'
                  : 'Saved locally, not sent'}
          </span>
          {entry.submission.target.threadId && (
            <small className="recovery-target">
              In thread:{' '}
              {data.threadsById[entry.submission.target.threadId]?.title ??
                entry.submission.target.threadId}
            </small>
          )}
          {!Object.values(data.messagesById).some(
            (message) => message.submissionId === entry.id,
          ) && (
            <p className="recovery-body">
              {entry.submission.parts
                .map((part) =>
                  part.type === 'text'
                    ? part.text
                    : part.type === 'local-file'
                      ? `File metadata: ${part.file.name}`
                      : part.type === 'file'
                        ? `Artifact: ${part.artifactId}`
                        : part.type === 'removed'
                          ? 'File removed'
                          : part.type === 'document'
                            ? 'Rich doc'
                            : `Unsupported content: ${part.originalKind}`,
                )
                .join('\n')}
            </p>
          )}
          {entry.receipt?.status === 'rejected' && (
            <p className="rejection-reason">{entry.receipt.message}</p>
          )}
          <div className="recovery-actions">
            {openThread && entry.submission.target.threadId && (
              <button
                onClick={() => openThread(entry.submission.target.threadId!)}
              >
                Open original thread
              </button>
            )}
            {entry.state !== 'rejected' && (
              <button
                onClick={() =>
                  void retry(entry).catch(() =>
                    setError(
                      'Recovery could not be saved. Your original send is retained.',
                    ),
                  )
                }
              >
                Check and retry original send
              </button>
            )}
            {['unsent', 'rejected'].includes(entry.state) && (
              <button
                onClick={() =>
                  void discard(entry).catch(() =>
                    setError(
                      'Recovery could not be saved. Your original send is retained.',
                    ),
                  )
                }
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      ))}
      {error && (
        <p role="alert" className="recovery-error">
          {error}
        </p>
      )}
    </div>
  )
}
