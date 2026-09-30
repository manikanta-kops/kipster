import { Icon } from '../../components/Icon'

type Family = 'pdf' | 'image' | 'audio' | 'video' | 'archive' | 'code' | 'doc'

function family(name: string, mimeType = ''): Family {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const mime = mimeType.toLowerCase()
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar'].includes(ext)) return 'archive'
  if (
    [
      'js',
      'ts',
      'tsx',
      'jsx',
      'json',
      'css',
      'html',
      'sh',
      'py',
      'rs',
    ].includes(ext)
  )
    return 'code'
  return 'doc'
}

/** A small glossy document tile showing the file's extension. */
export function FileBadge({
  name,
  mimeType,
  voice = false,
}: {
  name: string
  mimeType?: string
  voice?: boolean
}) {
  if (voice)
    return (
      <span className="file-badge voice" aria-hidden="true">
        <Icon name="microphone" size={16} weight="fill" />
      </span>
    )
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4) : ''
  return (
    <span className={`file-badge ${family(name, mimeType)}`} aria-hidden="true">
      {ext ? ext.toUpperCase() : <Icon name="file" size={16} />}
    </span>
  )
}
