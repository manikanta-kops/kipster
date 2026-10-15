/** Largest part of a text file read for an inline preview. */
export const TEXT_PREVIEW_BYTES = 96 * 1024

/**
 * Decodes only the start of a text file. Returns `null` for bytes that look
 * binary, so they get the generic file card instead of noise.
 */
export async function readTextPreview(
  blob: Blob,
  limit = TEXT_PREVIEW_BYTES,
): Promise<{ text: string; truncated: boolean } | null> {
  const truncated = blob.size > limit
  const bytes = new Uint8Array(await blob.slice(0, limit).arrayBuffer())
  if (bytes.includes(0)) return null
  let text = new TextDecoder('utf-8').decode(bytes)
  // A cut can split the final character; drop its replacement mark.
  if (truncated) text = text.replace(/\uFFFD+$/, '')
  return { text, truncated }
}
