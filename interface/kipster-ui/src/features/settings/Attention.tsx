import { useContext } from 'react'
import { createPortal } from 'react-dom'
import { PlatformContext } from '../../platform/context'
import type { Platform } from '../../platform/platform'
import type { InboxNotification } from '../../data/settings'
import { useAttention } from './use-attention'
import { InterfacePreferencesContext } from '../../data/interface-preferences'
type Props = {
  scope: string
  notifications: InboxNotification[]
  attentionIds: string[]
  selected: string | null
  open: (notification: InboxNotification) => void
  /** Where the toast appears, so it sits in the layout instead of over content. */
  host: HTMLElement | null
}
export function Attention(props: Props) {
  const platform = useContext(PlatformContext)
  return platform ? (
    <ScopedAttention key={props.scope} {...props} platform={platform} />
  ) : null
}
function ScopedAttention({
  platform,
  scope,
  notifications,
  attentionIds,
  selected,
  open,
  host,
}: Props & { platform: Platform }) {
  const preferences = useContext(InterfacePreferencesContext)
  const attention = useAttention(
    platform,
    preferences,
    scope,
    notifications,
    attentionIds,
    selected,
  )
  const notice = attention.notice
  return (
    <>
      {notice &&
        host &&
        createPortal(
          <output className="attention-toast mat thick">
            <span title={notice.title}>{notice.title}</span>
            <button
              className="attention-open"
              onClick={() => {
                open(notice)
                attention.dismiss()
              }}
            >
              Open
            </button>
            <button
              className="attention-dismiss"
              aria-label="Dismiss attention"
              onClick={attention.dismiss}
            >
              Dismiss
            </button>
          </output>,
          host,
        )}
      <output className="sr-only">{attention.delivery}</output>
    </>
  )
}
