import { resolve } from 'node:path'

// Real files the `__files__` fixture trigger attaches, with the MIME type Core
// records and the preview Chrome shows. A message holds at most 10 files, so the
// fixture sends the rest in a second publication.
export const fixtureDirectory = resolve(import.meta.dirname, 'fixtures')
export const fixtureFiles = [
  ['tone.mp3', 'audio/mpeg', 'audio'],
  ['tone.m4a', 'audio/mp4', 'audio'],
  ['dot.png', 'image/png', 'image'],
  ['diagram.svg', 'image/svg+xml', 'image'],
  ['clip.mp4', 'video/mp4', 'video'],
  ['report.pdf', 'application/pdf', 'pdf'],
  ['notes.md', 'text/markdown', 'text'],
  ['table.csv', 'text/csv', 'text'],
  ['data.json', 'application/json', 'text'],
  ['readme.txt', 'text/plain', 'text'],
  ['bundle.zip', 'application/zip', 'generic'],
].map(([name, mimeType, preview]) => ({ name, mimeType, preview }))
export const filesPerMessage = 10
