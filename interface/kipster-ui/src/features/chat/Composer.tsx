import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { PendingMedia } from '../../data/conversation-storage'
import type { useMediaDraft } from '../media/use-media-draft'
import { VoiceNotePlayer } from '../media/VoiceNotePlayer'
import { BlobPreview } from '../media/BlobPreview'
import { VoiceRecorder } from '../media/VoiceRecorder'
import { FileBadge } from '../media/FileBadge'
import { formatSize } from './model'
import { Icon } from '../../components/Icon'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { quickFade } from '../../app/motion'

interface Props {
  textOnly?: boolean
  voiceEnabled?: boolean
  disabled?: boolean
  sending?: boolean
  label: string
  /** Shown attached to the input when the user must act, such as a draft conflict. */
  notice?: ReactNode
  recordingContext?: string
  value: string
  onChange: (value: string) => void
  media: ReturnType<typeof useMediaDraft>
  onSend: (text: string, attachments: PendingMedia[]) => void | Promise<boolean>
}
export function Composer({
  textOnly = false,
  label,
  notice,
  recordingContext,
  value,
  onChange,
  onSend,
  media,
  voiceEnabled = true,
  disabled = false,
  sending = false,
}: Props) {
  const recordingBusy = useRef(false)
  const [recording, setRecording] = useState(false)
  const onRecordingBusy = useCallback((busy: boolean) => {
    recordingBusy.current = busy
    setRecording(busy)
  }, [])
  const recorder = useRef<{ start(): void }>(null)
  const input = useRef<HTMLInputElement>(null)
  const reduceMotion = useReducedMotion()
  const attachments = textOnly ? [] : media.entries
  async function send() {
    if (
      disabled ||
      sending ||
      recordingBusy.current ||
      (!textOnly && media.blocked) ||
      (!value.trim() && !attachments.length)
    )
      return
    await onSend(value, attachments)
  }
  return (
    <form
      className="composer-wrap"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
    >
      {notice}
      {!textOnly && media.error && (
        <p role="alert" className="composer-notice">
          <span>{media.error}</span>
          <button type="button" onClick={() => void media.retryStorage()}>
            Retry attachment storage
          </button>
        </p>
      )}
      <AnimatePresence initial={false}>
        {attachments.length > 0 && (
          <motion.ul
            className="attachment-list"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={reduceMotion ? { duration: 0 } : quickFade}
          >
            {attachments.map((file) => (
              <li
                key={file.id}
                className={`pending-media ${file.state}${file.intent.purpose === 'voice_note' ? ' voice' : ''}`}
              >
                {file.intent.purpose !== 'voice_note' && (
                  <FileBadge
                    name={file.intent.name}
                    mimeType={file.intent.mimeType}
                  />
                )}
                <div className="pending-info">
                  {file.intent.purpose === 'voice_note' && (
                    <VoiceNotePlayer
                      blob={file.bytes}
                      name={file.intent.name}
                    />
                  )}
                  <span className="pending-name" title={file.intent.name}>
                    {file.intent.name}
                  </span>{' '}
                  <small
                    className={
                      file.intent.purpose === 'voice_note' &&
                      file.state === 'ready'
                        ? 'sr-only'
                        : undefined
                    }
                  >
                    {file.intent.purpose !== 'voice_note' &&
                      `${formatSize(file.intent.size)} · `}
                    {file.state === 'ready'
                      ? 'Uploaded'
                      : file.state === 'uploading'
                        ? `Uploading ${Math.round((media.progress[file.id] ?? 0) * 100)}%`
                        : file.state === 'uncertain'
                          ? 'Upload outcome unconfirmed'
                          : 'Saved locally'}
                  </small>
                  {file.state === 'uploading' && (
                    <span
                      className="upload-meter"
                      aria-hidden="true"
                      style={
                        {
                          '--progress': media.progress[file.id] ?? 0,
                        } as CSSProperties
                      }
                    />
                  )}
                  {file.error && (
                    <small className="media-error">{file.error}</small>
                  )}
                  {file.intent.purpose !== 'voice_note' && (
                    <BlobPreview
                      blob={file.bytes}
                      name={file.intent.name}
                      fallback={null}
                    />
                  )}
                </div>
                <span className="pending-actions">
                  {file.intent.purpose === 'voice_note' && (
                    <button
                      type="button"
                      className="icon-button pending-rerecord"
                      aria-label="Re-record voice note"
                      title="Re-record voice note"
                      disabled={disabled || sending || recording}
                      onClick={async () => {
                        await media.remove(file)
                        recorder.current?.start()
                      }}
                    >
                      <Icon name="refresh" />
                    </button>
                  )}
                  {file.state === 'uploading' && (
                    <button type="button" onClick={() => media.cancel(file)}>
                      Cancel upload
                    </button>
                  )}
                  {['saved', 'uncertain', 'uploading'].includes(file.state) && (
                    <button
                      type="button"
                      onClick={() => void media.retry(file)}
                    >
                      Retry upload
                    </button>
                  )}
                </span>
                <button
                  type="button"
                  className="icon-button pending-remove"
                  disabled={disabled}
                  aria-label={`Remove ${file.intent.name}`}
                  onClick={() => void media.remove(file)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      <div className={`composer${recording ? ' recording' : ''}`}>
        {!textOnly && (
          <motion.button
            whileTap={{ scale: 0.9 }}
            type="button"
            className="icon-button attach-button"
            disabled={disabled}
            aria-label="Attach files"
            onClick={() => input.current?.click()}
          >
            <Icon name="plus" />
          </motion.button>
        )}
        {!textOnly && (
          <input
            ref={input}
            type="file"
            disabled={disabled}
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []).map(
                (file) => ({
                  blob: file,
                  name: file.name,
                  purpose: 'attachment' as const,
                }),
              )
              void media.add(files)
              event.target.value = ''
            }}
          />
        )}
        <textarea
          disabled={disabled}
          aria-label={label}
          placeholder={label}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              send()
            }
          }}
        />
        {!textOnly && voiceEnabled && (
          <VoiceRecorder
            ref={recorder}
            onBusyChange={onRecordingBusy}
            key={recordingContext}
            disabled={disabled || sending}
            onRecorded={(blob) =>
              media.add([
                {
                  blob,
                  name: `Voice note.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`,
                  purpose: 'voice_note',
                },
              ])
            }
          />
        )}
        <motion.button
          whileTap={{ scale: 0.9 }}
          whileHover={
            !disabled && (value.trim() || attachments.length)
              ? { scale: 1.04 }
              : undefined
          }
          className="send-button"
          aria-label="Send message"
          disabled={
            disabled ||
            sending ||
            recording ||
            (!textOnly && media.blocked) ||
            (!value.trim() && !attachments.length)
          }
        >
          <Icon name="arrow" />
        </motion.button>
      </div>
    </form>
  )
}
