import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import type { Message } from './model'
import { formatTime } from './model'

/** The copy button and time shown under a message while it is hovered or focused. */
export function MessageActions({
  message,
  isSelf,
}: {
  message: Message
  /** A person's own message shows when it was sent; a kip's when it finished. */
  isSelf: boolean
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const texts = message.parts.flatMap((part) =>
    part.type === 'text' ? [part.text] : [],
  )
  // Older Cores send no message times; the thread's time would be wrong for replies.
  const time = isSelf ? message.sentAt : (message.finishedAt ?? message.sentAt)
  if (message.status === 'draft' || (!texts.length && !time)) return null
  return (
    <div className="message-actions">
      {texts.length > 0 && (
        <button
          type="button"
          className="message-copy"
          aria-label="Copy message"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(texts.join('\n\n'))
              .then(() => {
                setCopied(true)
                clearTimeout(timer.current)
                timer.current = setTimeout(() => setCopied(false), 1500)
              })
              .catch(() => {})
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={15} />
        </button>
      )}
      {time && <time dateTime={time}>{formatTime(time)}</time>}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  )
}
