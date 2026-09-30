import { useContext, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { WorkspaceContext } from '../../data/workspace-context'
import type { Artifact } from '../chat/model'
import { formatSize } from '../chat/model'
import type { ConversationTarget } from '../../data/conversations'
import { targetIdentity } from '../../data/media'
import { BlobPreview } from './BlobPreview'
import { previewKind } from './preview-kind'
import { Icon } from '../../components/Icon'
import { FileBadge } from './FileBadge'
import { VoiceNotePlayer } from './VoiceNotePlayer'
export function ArtifactCard({
  artifactId,
  fallback,
  target,
  voice = false,
}: {
  artifactId: string
  fallback?: Artifact
  target: ConversationTarget
  voice?: boolean
}) {
  const workspace = useContext(WorkspaceContext)
  const client = workspace?.media
  const [download, setDownload] = useState(false)
  const [url, setUrl] = useState('')
  const metadata = useQuery({
    queryKey: [
      'artifact',
      workspace?.connectionKey,
      targetIdentity(target),
      artifactId,
      fallback?.revision,
    ],
    queryFn: ({ signal }) => client!.metadata(artifactId, target, signal),
    enabled: !!client && fallback?.availability !== 'local-preview',
    retry: false,
  })
  const artifact = metadata.data ?? fallback
  const content = useQuery({
    queryKey: [
      'artifact-content',
      workspace?.connectionKey,
      targetIdentity(target),
      artifactId,
      artifact?.revision,
    ],
    queryFn: ({ signal }) => client!.content(artifact!, target, signal),
    enabled:
      !!client &&
      !!metadata.data &&
      artifact?.availability === 'registered' &&
      (!!previewKind(artifact.mimeType) || download),
    retry: false,
    gcTime: 0,
  })
  useEffect(() => {
    if (!content.data) return
    const next = URL.createObjectURL(content.data)
    // Object URLs must be revoked with their owning card.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content.data])
  const unavailable =
    artifact?.availability !== 'registered' || metadata.isError
  const kind = previewKind(artifact?.mimeType)
  const player = voice && kind === 'audio' && content.data
  const name = artifact?.name ?? 'Unavailable file'
  const details = artifact ? formatSize(artifact.size) : ''
  const owner = artifact?.ownership
    ? `${artifact.ownership.kind === 'agent' ? 'Kip' : artifact.ownership.kind === 'installation' ? 'Installation' : artifact.ownership.kind === 'organization' ? 'Organization' : artifact.ownership.kind} owned${artifact.ownership.id ? ` · ${artifact.ownership.id}` : ''}${artifact.provenance?.kind === 'published' ? ' · Published copy' : ''}`
    : ''
  const about = [artifact?.mimeType?.split(';')[0], owner]
    .filter(Boolean)
    .join(' · ')
  return (
    <section
      className={`artifact-card shine gloss${voice ? ' voice' : ''}${kind && kind !== 'audio' && content.data ? ' has-preview' : ''}`}
      aria-label={`${voice ? 'Voice note' : 'File'}: ${artifact?.name ?? artifactId}`}
      title={about || undefined}
    >
      <div className="artifact-heading">
        {player ? (
          <VoiceNotePlayer blob={content.data!} name={name} />
        ) : (
          <>
            <FileBadge
              name={name}
              mimeType={artifact?.mimeType}
              voice={voice}
            />
            <span className="artifact-name">
              <strong>{name}</strong>
              {details && <small>{details}</small>}
            </span>
          </>
        )}
        {!unavailable &&
          (url ? (
            <a
              className="icon-button artifact-download"
              href={url}
              download={artifact?.name}
              aria-label={`Download ${artifact?.name}`}
            >
              <Icon name="download" />
            </a>
          ) : (
            <button
              type="button"
              className="icon-button artifact-download"
              aria-label={`Prepare download ${artifact?.name}`}
              onClick={() => setDownload(true)}
            >
              <Icon name="download" />
            </button>
          ))}
      </div>
      {player && <small className="artifact-meta">{name}</small>}
      {unavailable && !metadata.isError && !metadata.isFetching && (
        <small className="artifact-status">
          {artifact?.availability === 'deleted'
            ? 'File deleted'
            : ['missing', 'failed', 'local-preview'].includes(
                  artifact?.availability ?? '',
                )
              ? 'File unavailable'
              : artifact?.availability}
        </small>
      )}
      {!unavailable && !player && content.data && (
        <BlobPreview blob={content.data} name={name} />
      )}
      {(metadata.isError || content.isError) && (
        <div role="alert" className="artifact-error">
          <small>{content.error?.message ?? metadata.error?.message}</small>
          <button
            type="button"
            onClick={() => {
              void metadata.refetch()
              if (content.isError) void content.refetch()
            }}
          >
            Retry file
          </button>
        </div>
      )}
      {about && <span className="sr-only">{about}</span>}
    </section>
  )
}
