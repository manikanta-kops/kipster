import { useState } from 'react'
import { Composer } from './Composer'
import { useDraft } from './use-draft'
import type { PendingMedia } from '../../data/conversation-storage'
import { useMediaDraft } from '../media/use-media-draft'
import type { ConversationTarget, Submission } from '../../data/conversations'
import {
  draftKey,
  type Draft,
  type PendingSubmission,
} from '../../data/conversation-storage'
export function DurableComposer({
  scope,
  recordingContext,
  target,
  label,
  dropHint,
  send,
  disabled = false,
  textOnly = false,
  voiceEnabled = true,
}: {
  scope: string
  recordingContext?: string
  target: ConversationTarget
  label: string
  dropHint?: string
  disabled?: boolean
  textOnly?: boolean
  voiceEnabled?: boolean
  send: (
    submission: Submission,
    draft: Draft | undefined,
  ) => Promise<{ value: PendingSubmission; cleared: Draft | undefined }>
}) {
  const key = draftKey(scope, target)
  const draft = useDraft(key)
  const media = useMediaDraft(key, target)
  const [error, setError] = useState('')
  const [reserving, setReserving] = useState(false)
  async function submit(text: string, files: PendingMedia[]) {
    if (reserving) return false
    setReserving(true)
    setError('')
    try {
      const prepared = await draft.prepare()
      const submission: Submission = {
        submissionId: crypto.randomUUID(),
        target: structuredClone(target),
        parts: [
          ...(text.trim() ? [{ type: 'text' as const, text }] : []),
          ...files.map((file) => {
            if (!file.receipt)
              throw new Error('Upload receipt is required before sending.')
            return {
              type: 'file' as const,
              artifactId: file.receipt.artifact.id,
              purpose: file.intent.purpose,
            }
          }),
        ],
      }
      const { cleared } = await send(submission, {
        ...(prepared.draft ?? { key, revision: '', text }),
        uploadIds: files.map((f) => f.id),
      })
      draft.reserved(prepared.generation, cleared)
      return true
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Message could not be saved. Your input is retained.',
      )
      return false
    } finally {
      setReserving(false)
    }
  }
  const status =
    draft.status === 'saving'
      ? 'Saving draft…'
      : draft.status === 'loading'
        ? 'Loading saved draft…'
        : draft.status === 'saved' && draft.text
          ? 'Draft saved on this device'
          : ''
  const notice = (
    <>
      {error && (
        <p className="composer-notice" role="alert">
          <span>{error}</span>
        </p>
      )}
      {draft.status === 'error' && (
        <p className="composer-notice" role="alert">
          <span>Draft is not saved on this device.</span>
          <button type="button" onClick={draft.retry}>
            Retry saving
          </button>
        </p>
      )}
      {draft.status === 'conflict' && (
        <p className="composer-notice" role="alert">
          <span>
            This draft changed in another tab. Your text is preserved.
          </span>
          <button type="button" onClick={() => draft.resolve(true)}>
            Keep my text
          </button>
          <button type="button" onClick={() => draft.resolve(false)}>
            Load saved text
          </button>
        </p>
      )}
    </>
  )
  return (
    <div className="durable-composer">
      <Composer
        textOnly={textOnly}
        voiceEnabled={voiceEnabled}
        label={label}
        dropHint={dropHint}
        notice={notice}
        recordingContext={recordingContext}
        media={media}
        value={draft.text}
        onChange={draft.change}
        onSend={submit}
        disabled={disabled}
        sending={reserving}
      />
      <p className="draft-status sr-only" aria-live="polite">
        {status}
      </p>
    </div>
  )
}
