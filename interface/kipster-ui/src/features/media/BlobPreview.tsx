import { useEffect, useState, type ReactNode } from 'react'
import { previewKind } from './preview-kind'
export function BlobPreview({
  blob,
  name,
  fallback = 'Preview unavailable for this format. Download the original file.',
}: {
  blob: Blob
  name: string
  /** Shown when the format cannot be previewed; `null` shows nothing. */
  fallback?: ReactNode
}) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    // Object URLs are external resources whose lifetime follows this mounted view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next)
    setFailed(false)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  const kind = previewKind(blob.type)
  if (!kind || failed)
    return typeof fallback === 'string' ? <small>{fallback}</small> : fallback
  if (!url) return <small>Loading preview…</small>
  return kind === 'image' ? (
    <img
      className="media-preview"
      src={url}
      alt={name}
      onError={() => setFailed(true)}
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
