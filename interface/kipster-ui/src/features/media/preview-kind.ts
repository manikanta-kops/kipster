export function previewKind(type = '') {
  const mime = type.split(';')[0].toLowerCase()
  if (
    [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
    ].includes(mime)
  )
    return 'image'
  if (
    [
      'audio/webm',
      'audio/mp4',
      'audio/ogg',
      'audio/mpeg',
      'audio/wav',
    ].includes(mime)
  )
    return 'audio'
  if (['video/webm', 'video/mp4', 'video/ogg'].includes(mime)) return 'video'
  return null
}
