import { useEffect, useState, type ReactNode } from 'react'
import { formatSize } from '../chat/model'
import { previewFormat } from './preview-kind'
import { readTextPreview, TEXT_PREVIEW_BYTES } from './text-preview'

// A PDF header may follow up to 1 KB of leading bytes.
async function looksLikePdf(blob: Blob) {
  const head = await blob.slice(0, 1024).arrayBuffer()
  return new TextDecoder('latin1').decode(head).includes('%PDF-')
}

export function BlobPreview({
  blob,
  name,
  fallback = 'Preview unavailable for this format. Download the original file.',
  compact = false,
}: {
  blob: Blob
  name: string
  /** Shown when the format cannot be previewed; `null` shows nothing. */
  fallback?: ReactNode
  /** Limits previews to images and players, for small attachment tiles. */
  compact?: boolean
}) {
  const format = previewFormat(blob.type, name)
  const kind =
    compact && (format?.kind === 'pdf' || format?.kind === 'text')
      ? null
      : format?.kind
  const mimeType = format?.mimeType
  const [url, setUrl] = useState('')
  const [text, setText] = useState<{ text: string; truncated: boolean }>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    let next = ''
    // Object URLs are external resources whose lifetime follows this mounted view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl('')
    setText(undefined)
    setFailed(false)
    const show = () => {
      next = URL.createObjectURL(
        blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }),
      )
      setUrl(next)
    }
    if (kind === 'text')
      // Only the start of the file is decoded, so large files stay cheap.
      void readTextPreview(blob).then(
        (result) => active && (result ? setText(result) : setFailed(true)),
        () => active && setFailed(true),
      )
    else if (kind === 'pdf')
      // A typed blob that is not really a PDF must never reach a frame.
      void looksLikePdf(blob).then(
        (pdf) => active && (pdf ? show() : setFailed(true)),
        () => active && setFailed(true),
      )
    else if (kind) show()
    return () => {
      active = false
      if (next) URL.revokeObjectURL(next)
    }
  }, [blob, kind, mimeType])
  if (!kind || failed)
    return typeof fallback === 'string' ? <small>{fallback}</small> : fallback
  if (kind === 'text')
    return text ? (
      <div className="text-preview">
        <section
          aria-label={`Text preview of ${name}`}
          // Scrollable content must be reachable from the keyboard.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
        >
          <pre>{text.text}</pre>
        </section>
        {text.truncated && (
          <small>
            Preview shows the first {formatSize(TEXT_PREVIEW_BYTES)}. Download
            the file for the rest.
          </small>
        )}
      </div>
    ) : (
      <small>Loading preview…</small>
    )
  if (!url) return <small>Loading preview…</small>
  return kind === 'image' ? (
    <img
      className="media-preview"
      src={url}
      alt={name}
      onError={() => setFailed(true)}
    />
  ) : kind === 'pdf' ? (
    <iframe
      className="pdf-preview"
      src={url}
      title={`PDF preview of ${name}`}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  ) : kind === 'audio' ? (
    // Uploaded originals have no caption track unless supplied by the backend.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      aria-label={`Play ${name}`}
      controls
      preload="metadata"
      src={url}
      onError={() => setFailed(true)}
    />
  ) : (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      className="media-preview"
      aria-label={`Play ${name}`}
      controls
      preload="metadata"
      src={url}
      onError={() => setFailed(true)}
    />
  )
}
