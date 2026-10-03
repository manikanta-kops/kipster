import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DocumentClient } from '../../data/documents'
import { formatSize } from '../chat/model'
import { FileBadge } from '../media/FileBadge'
import { Icon } from '../../components/Icon'
import { localFiles } from './store'

function useArtifact(
  client: DocumentClient,
  documentId: string,
  artifactId: string,
  wantContent: boolean,
) {
  const local = localFiles.get(artifactId)
  const metadata = useQuery({
    queryKey: ['document-artifact', client.endpoint, documentId, artifactId],
    queryFn: ({ signal }) => client.artifact(documentId, artifactId, signal),
    enabled: !local,
    retry: 1,
  })
  const content = useQuery({
    queryKey: [
      'document-artifact-content',
      client.endpoint,
      documentId,
      artifactId,
    ],
    queryFn: ({ signal }) => client.content(documentId, metadata.data!, signal),
    enabled: wantContent && !local && !!metadata.data,
    retry: 1,
    gcTime: 60_000,
  })
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!content.data) return
    const next = URL.createObjectURL(content.data)
    // Object URLs are revoked with the view that made them.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content.data])
  return {
    name: local?.name ?? metadata.data?.name ?? '',
    size: local?.size ?? metadata.data?.size,
    mimeType: metadata.data?.mimeType,
    url: local?.url ?? url,
    failed: metadata.isError || content.isError,
  }
}

export function DocImage({
  client,
  documentId,
  artifactId,
  onZoom,
}: {
  client: DocumentClient
  documentId: string
  artifactId: string
  onZoom: (url: string) => void
}) {
  const file = useArtifact(client, documentId, artifactId, true)
  if (file.failed)
    return <div className="img-frame missing">Image unavailable</div>
  return (
    <button
      type="button"
      className="img-frame"
      aria-label={`Zoom ${file.name || 'image'}`}
      onClick={() => file.url && onZoom(file.url)}
    >
      {file.url ? (
        <img src={file.url} alt={file.name} />
      ) : (
        <span className="img-loading" />
      )}
    </button>
  )
}

export function DocFile({
  client,
  documentId,
  artifactId,
}: {
  client: DocumentClient
  documentId: string
  artifactId: string
}) {
  const [want, setWant] = useState(false)
  const file = useArtifact(client, documentId, artifactId, want)
  useEffect(() => {
    if (!want || !file.url) return
    const link = document.createElement('a')
    link.href = file.url
    link.download = file.name
    link.click()
    // The download starts once per request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWant(false)
  }, [want, file.url, file.name])
  return (
    <div className="file-tile mat thin shine">
      <FileBadge name={file.name} mimeType={file.mimeType} />
      <span>
        <b>{file.failed ? 'File unavailable' : file.name || 'Loading…'}</b>
        {file.size !== undefined && <small>{formatSize(file.size)}</small>}
      </span>
      {!file.failed && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Download ${file.name}`}
          onClick={() => setWant(true)}
        >
          <Icon name="download" size={17} />
        </button>
      )}
    </div>
  )
}
