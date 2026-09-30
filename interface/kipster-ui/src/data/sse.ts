import { incompatible, TextHttpError } from './response.ts'

/** Read JSON data frames; callers interpret the event kind and scope. */
export async function readEvents(
  response: Response,
  signal: AbortSignal,
  apply: (type: string | undefined, value: unknown) => void,
): Promise<never> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const { value, done } = await reader.read()
      if (done)
        throw new TextHttpError('Live connection interrupted.', 'unavailable')
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(
        /\r\n/g,
        '\n',
      )
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const lines = buffer.slice(0, end).split('\n')
        buffer = buffer.slice(end + 2)
        const type = lines
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim()
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (!data) continue
        let raw: unknown
        try {
          raw = JSON.parse(data)
        } catch {
          incompatible()
        }
        apply(type, raw)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
