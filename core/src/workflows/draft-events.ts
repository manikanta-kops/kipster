import type { ExecutionEvent } from '../adapter-api/index.js'

/** Read independently of persistence, retaining at most one pending text revision per
 * message. The event's first position is preserved relative to other messages/outcomes. */
export async function* coalesceDrafts(events: AsyncIterable<ExecutionEvent>): AsyncGenerator<ExecutionEvent> {
  const queue: { event: ExecutionEvent }[] = []
  const pending = new Map<string, { event: ExecutionEvent }>()
  const finalized = new Set<string>()
  let wake: (() => void) | undefined
  let done = false
  let stopped = false
  let failure: unknown
  const pump = (async () => {
    try {
      for await (const event of events) {
        if (stopped) break
        if (event.kind === 'text') {
          const key = JSON.stringify([event.attemptId, event.messageId])
          if (finalized.has(key) && !event.final) continue
          const prior = pending.get(key)
          if (prior && prior.event.kind === 'text' && !prior.event.final) prior.event = event
          else { const entry = { event }; queue.push(entry); pending.set(key, entry) }
          if (event.final) finalized.add(key)
        } else queue.push({ event })
        wake?.()
      }
    } catch (error) { failure = error }
    finally { done = true; wake?.() }
  })()
  try {
    while (!done || queue.length) {
      if (!queue.length) { await new Promise<void>(resolve => { wake = resolve }); wake = undefined; continue }
      const entry = queue.shift()!
      if (entry.event.kind === 'text') {
        const key = JSON.stringify([entry.event.attemptId, entry.event.messageId])
        if (pending.get(key) === entry) pending.delete(key)
      }
      yield entry.event
    }
    await pump
    if (failure) throw failure
  } finally { stopped = true }
}
