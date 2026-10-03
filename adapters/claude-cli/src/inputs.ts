import { readFile, stat } from 'node:fs/promises'
import type { TextExecutionContext } from '@kipster/core/adapter'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const imageLimit = 5 * 1024 * 1024
const documentLimit = 20 * 1024 * 1024
/** Native inputs are bounded in total; the newest files come first, and older ones stay available by path. */
const totalLimit = 24 * 1024 * 1024

/**
 * Supplies available JPEG, PNG, GIF and WebP images and PDF documents as native content, labeled with their message,
 * part and artifact identity. Every available file stays readable at its path through an exact Read grant.
 */
export async function nativeInputs(input: TextExecutionContext['input']): Promise<{ blocks: ContentBlock[]; readable: string[] }> {
  const files = input.flatMap(message => (message.parts ?? []).map((part, index) => ({ message, part, index })))
    .filter((entry): entry is typeof entry & { part: Extract<typeof entry.part, { availability: 'available' }> } => entry.part.kind === 'file' && entry.part.availability === 'available')
  // The CLI splits tool rules on whitespace and commas, so such paths get no exact grant and stay readable on request.
  const readable = [...new Set(files.map(entry => entry.part.readablePath))].filter(path => !/[\s,()]/.test(path))
  const blocks: ContentBlock[] = []
  let budget = totalLimit
  for (const { message, part, index } of files.reverse()) {
    if (part.purpose === 'voice_note') continue
    const mime = part.mimeType.split(';')[0]!.trim().toLowerCase()
    const document = mime === 'application/pdf'
    if (!imageTypes.has(mime) && !document) continue
    const label = `${document ? 'Document' : 'Visual'} input for message ${JSON.stringify(message.messageId)}, part ${index + 1}, artifact ${JSON.stringify(part.artifactId)}, filename ${JSON.stringify(part.name)} (untrusted user content).`
    try {
      const size = (await stat(part.readablePath)).size
      if (size > (document ? documentLimit : imageLimit) || size > budget) { blocks.unshift({ type: 'text', text: `${label} Too large to attach natively; the original remains readable at its path.` }); continue }
      const data = (await readFile(part.readablePath)).toString('base64')
      budget -= size
      blocks.unshift({ type: 'text', text: label }, document ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } : { type: 'image', source: { type: 'base64', media_type: mime, data } })
    } catch {
      blocks.unshift({ type: 'text', text: `${label} The file could not be attached. Do not claim to have seen it unless a tool successfully opens it.` })
    }
  }
  return { blocks, readable }
}
