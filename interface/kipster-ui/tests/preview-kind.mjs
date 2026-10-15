import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  previewFormat,
  previewKind,
} from '../src/features/media/preview-kind.ts'
import {
  readTextPreview,
  TEXT_PREVIEW_BYTES,
} from '../src/features/media/text-preview.ts'

const all = { canPlay: () => true, pdf: true }
const none = { canPlay: () => false, pdf: false }

test('MIME types choose the preview kind', () => {
  for (const [type, kind] of [
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['IMAGE/WEBP', 'image'],
    ['image/svg+xml', 'image'],
    ['audio/mpeg', 'audio'],
    ['audio/mp4', 'audio'],
    ['audio/x-m4a', 'audio'],
    ['audio/aac', 'audio'],
    ['audio/flac', 'audio'],
    ['audio/webm;codecs=opus', 'audio'],
    ['video/mp4', 'video'],
    ['video/quicktime', 'video'],
    ['application/pdf', 'pdf'],
    ['text/plain', 'text'],
    ['text/plain; charset=utf-8', 'text'],
    ['text/markdown', 'text'],
    ['text/csv', 'text'],
    ['text/html', 'text'],
    ['application/json', 'text'],
    ['application/geo+json', 'text'],
    ['application/x-yaml', 'text'],
    ['application/zip', null],
    ['application/vnd.ms-excel', null],
    ['image/heic', null],
    ['image/svg', null],
  ])
    assert.equal(previewKind(type, '', all), kind, type)
})

test('generic MIME types fall back to the file extension', () => {
  for (const [name, kind] of [
    ['song.mp3', 'audio'],
    ['memo.M4A', 'audio'],
    ['clip.mov', 'video'],
    ['clip.mp4', 'video'],
    ['diagram.svg', 'image'],
    ['report.pdf', 'pdf'],
    ['README.md', 'text'],
    ['table.csv', 'text'],
    ['data.json', 'text'],
    ['server.log', 'text'],
    ['main.rs', 'text'],
    ['app.tsx', 'text'],
    ['Dockerfile', 'text'],
    ['archive.zip', null],
    ['no-extension', null],
    ['', null],
  ]) {
    assert.equal(previewKind('application/octet-stream', name, all), kind, name)
    assert.equal(previewKind('', name, all), kind, name)
  }
  assert.deepEqual(previewFormat('', 'diagram.svg', all), {
    kind: 'image',
    mimeType: 'image/svg+xml',
  })
  assert.deepEqual(previewFormat('application/octet-stream', 'clip.mov', all), {
    kind: 'video',
    mimeType: 'video/quicktime',
  })
})

test('a specific MIME type wins over the extension', () => {
  assert.equal(previewKind('application/zip', 'notes.txt', all), null)
  assert.equal(previewKind('text/plain', 'archive.zip', all), 'text')
})

test('formats the environment cannot render get the generic card', () => {
  for (const type of [
    'audio/flac',
    'audio/mpeg',
    'video/quicktime',
    'application/pdf',
  ])
    assert.equal(previewKind(type, '', none), null, type)
  assert.equal(previewKind('image/png', '', none), 'image')
  assert.equal(previewKind('text/csv', '', none), 'text')
  const asked = []
  previewKind('audio/x-m4a', '', {
    canPlay: (kind, type) => (asked.push([kind, type]), true),
    pdf: false,
  })
  assert.deepEqual(asked, [['audio', 'audio/x-m4a']])
})

test('previewKind works without a browser', () => {
  assert.equal(previewKind('audio/mpeg'), null)
  assert.equal(previewKind('application/pdf'), null)
  assert.equal(previewKind('text/plain'), 'text')
  assert.equal(previewKind(), null)
})

test('text previews read only a bounded start of large files', async () => {
  const size = 20 * 1024 * 1024
  const blob = new Blob([new Uint8Array(size).fill(0x61)])
  let read = 0
  const slice = blob.slice.bind(blob)
  blob.slice = (start, end) => {
    read += Math.min(end ?? size, size) - (start ?? 0)
    return slice(start, end)
  }
  const preview = await readTextPreview(blob)
  assert.equal(preview.truncated, true)
  assert.equal(preview.text.length, TEXT_PREVIEW_BYTES)
  assert.equal(read, TEXT_PREVIEW_BYTES)
})

test('text previews keep whole small files, cut characters cleanly and refuse binary', async () => {
  assert.deepEqual(await readTextPreview(new Blob(['a,b\n1,2\n'])), {
    text: 'a,b\n1,2\n',
    truncated: false,
  })
  assert.deepEqual(await readTextPreview(new Blob(['ab€cd']), 4), {
    text: 'ab',
    truncated: true,
  })
  assert.deepEqual(
    await readTextPreview(new Blob(['<script>alert(1)</script>'])),
    { text: '<script>alert(1)</script>', truncated: false },
  )
  assert.equal(
    await readTextPreview(new Blob([new Uint8Array([80, 75, 3, 4, 0, 0])])),
    null,
  )
})
