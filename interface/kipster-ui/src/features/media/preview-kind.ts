export type PreviewKind = 'image' | 'audio' | 'video' | 'pdf' | 'text'

/** What the current environment can render inline. */
export interface PreviewSupport {
  canPlay(kind: 'audio' | 'video', mimeType: string): boolean
  pdf: boolean
}

// SVG is shown only through <img>, where its scripts never run.
const images = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
])
const audio = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
  'audio/x-aac',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/flac',
  'audio/x-flac',
])
const video = new Set([
  'video/webm',
  'video/mp4',
  'video/ogg',
  'video/quicktime',
])
const textTypes = new Set([
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-sh',
  'application/x-shellscript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/x-sql',
  'application/graphql',
  'application/x-tex',
  'application/x-subrip',
])
// Generic types say nothing about the bytes, so the file name decides.
const generic = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-unknown',
  'application/unknown',
])
const byExtension: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
}
const textExtensions = new Set(
  (
    'txt text md markdown mdx csv tsv json jsonl ndjson log xml yaml yml toml ' +
    'ini cfg conf env properties sql graphql gql srt vtt tex rst adoc org diff patch ' +
    'js mjs cjs jsx ts mts cts tsx css scss sass less html htm vue svelte ' +
    'py rb php pl lua r swift kt kts java scala go rs c h cc cpp hpp cs m mm ' +
    'sh bash zsh fish ps1 bat cmd dockerfile makefile gradle'
  ).split(' '),
)

function extension(name: string) {
  const base = name.split(/[\\/]/).pop()!.toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') return base
  return base.includes('.') ? base.split('.').pop()! : ''
}

const playable = new Map<string, boolean>()
const browser: PreviewSupport = {
  canPlay(kind, mimeType) {
    if (typeof document === 'undefined') return false
    const key = `${kind} ${mimeType}`
    if (!playable.has(key))
      playable.set(
        key,
        document.createElement(kind).canPlayType(mimeType) !== '',
      )
    return playable.get(key)!
  },
  get pdf() {
    return (
      typeof navigator !== 'undefined' && navigator.pdfViewerEnabled === true
    )
  },
}

/**
 * Chooses how a file is shown inline, from its MIME type and, when that is
 * generic, its extension. `null` means the generic downloadable card.
 */
export function previewFormat(
  type = '',
  name = '',
  support: PreviewSupport = browser,
): { kind: PreviewKind; mimeType: string } | null {
  let mime = type.split(';')[0].trim().toLowerCase()
  const ext = extension(name)
  if (generic.has(mime)) {
    if (textExtensions.has(ext)) return { kind: 'text', mimeType: 'text/plain' }
    mime = byExtension[ext] ?? mime
  }
  if (images.has(mime)) return { kind: 'image', mimeType: mime }
  if (audio.has(mime))
    return support.canPlay('audio', mime)
      ? { kind: 'audio', mimeType: mime }
      : null
  if (video.has(mime))
    return support.canPlay('video', mime)
      ? { kind: 'video', mimeType: mime }
      : null
  if (mime === 'application/pdf')
    return support.pdf ? { kind: 'pdf', mimeType: mime } : null
  if (
    mime.startsWith('text/') ||
    textTypes.has(mime) ||
    (mime.endsWith('+json') && mime.startsWith('application/')) ||
    (mime.endsWith('+xml') && mime.startsWith('application/'))
  )
    return { kind: 'text', mimeType: 'text/plain' }
  return null
}

export function previewKind(
  type = '',
  name = '',
  support: PreviewSupport = browser,
) {
  return previewFormat(type, name, support)?.kind ?? null
}
