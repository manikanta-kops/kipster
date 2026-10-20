import { fork, type ChildProcess } from 'node:child_process'
import { access, constants, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type {
  TranscriptionFailure,
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '@kipster/core/transcription'
import { configuration } from './config.js'
import { provider, type Request } from './messages.js'
import { maxInputBytes } from './wav.js'

const failure = (reason: TranscriptionFailure): TranscriptionResult => ({
  status: 'unavailable',
  reason,
  provider,
})
const reasons = new Set([
  'unavailable',
  'timeout',
  'cancelled',
  'invalid-input',
  'output-limit',
  'provider-error',
])
function isResult(value: unknown): value is TranscriptionResult {
  const row = value as Record<string, unknown> | null
  return (
    !!row &&
    row.provider === provider &&
    (((row.status === 'succeeded' || row.status === 'no-speech') &&
      typeof row.text === 'string') ||
      (row.status === 'unavailable' &&
        typeof row.reason === 'string' &&
        reasons.has(row.reason)))
  )
}
interface Worker {
  child: ChildProcess
  exited: Promise<void>
  dead: boolean
}

/** Internal worker-path seam for process lifecycle tests; not a host option. */
export function createProvider(
  options: unknown,
  workerPath = new URL('./worker.js', import.meta.url),
): TranscriptionProvider {
  const config = configuration(options)
  let worker: Worker | undefined
  let tail = Promise.resolve()
  let closed = false
  let closing: Promise<void> | undefined
  const jobs = new Set<(reason: TranscriptionFailure) => void>()

  function start(): Worker {
    if (worker) return worker
    const child = fork(workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    })
    const state: Worker = { child, dead: false, exited: Promise.resolve() }
    state.exited = new Promise((resolve) => {
      const end = () => {
        state.dead = true
        if (worker === state) worker = undefined
        resolve()
      }
      child.once('exit', end)
      // Also handles a failed fork, which need not emit exit.
      child.once('error', end)
    })
    worker = state
    return state
  }
  async function stop(state: Worker): Promise<void> {
    if (worker === state) worker = undefined
    if (!state.dead) state.child.kill('SIGKILL')
    await state.exited
  }
  async function request(
    input: TranscriptionInput,
    signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    const state = start()
    const result = await new Promise<TranscriptionResult>((resolve) => {
      const finish = (result: TranscriptionResult) => {
        state.child.removeListener('message', message)
        state.child.removeListener('exit', died)
        state.child.removeListener('error', died)
        signal.removeEventListener('abort', aborted)
        resolve(result)
      }
      const message = (value: unknown) => {
        if (!isResult(value)) {
          finish(failure('provider-error'))
          return
        }
        if (value.status === 'unavailable') {
          finish(value)
          return
        }
        const text = value.text.trim()
        finish({ status: text ? 'succeeded' : 'no-speech', text, provider })
      }
      const died = () => finish(failure('provider-error'))
      const aborted = () => finish(failure('cancelled'))
      state.child.once('message', message)
      state.child.once('exit', died)
      state.child.once('error', died)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) {
        aborted()
        return
      }
      const messageBody: Request = {
        path: input.path,
        size: input.size,
        config,
      }
      try {
        state.child.send(messageBody, (error) => {
          if (error) died()
        })
      } catch {
        died()
      }
    })
    // Reap a failed/cancelled native process before allowing another queued call.
    if (
      signal.aborted ||
      (result.status === 'unavailable' && result.reason === 'provider-error')
    )
      await stop(state)
    return result
  }
  return {
    id: provider,
    contractMajor: 1,
    inputTypes: ['audio/wav'],
    async readiness() {
      if (closed)
        return { ready: false, reason: 'Transcription provider is closed' }
      try {
        const info = await stat(config.model)
        if (!info.isFile() || info.size !== config.modelSize)
          return {
            ready: false,
            reason: 'Transcription model has the wrong size',
          }
        await access(config.model, constants.R_OK)
        return { ready: true }
      } catch {
        return { ready: false, reason: 'Transcription model is unavailable' }
      }
    },
    async transcribe(input) {
      if (closed) return failure('provider-error')
      if (input.signal.aborted) return failure('cancelled')
      if (
        !isAbsolute(input.path) ||
        input.path.includes('\0') ||
        !Number.isSafeInteger(input.size) ||
        input.size < 1 ||
        input.size > maxInputBytes ||
        input.mimeType.split(';', 1)[0]!.trim().toLowerCase() !== 'audio/wav'
      )
        return failure('invalid-input')
      return new Promise<TranscriptionResult>((resolve) => {
        const controller = new AbortController()
        let done = false
        const finish = (result: TranscriptionResult) => {
          if (done) return
          done = true
          clearTimeout(timer)
          input.signal.removeEventListener('abort', abort)
          jobs.delete(cancel)
          resolve(result)
        }
        const cancel = (reason: TranscriptionFailure) => {
          controller.abort()
          finish(failure(reason))
        }
        const abort = () => cancel('cancelled')
        const timer = setTimeout(() => cancel('timeout'), config.timeoutMs)
        jobs.add(cancel)
        input.signal.addEventListener('abort', abort, { once: true })
        if (input.signal.aborted) abort()
        tail = tail.then(async () => {
          if (done) return
          try {
            finish(await request(input, controller.signal))
          } catch {
            finish(failure('provider-error'))
          }
        })
      })
    },
    close() {
      if (closing) return closing
      closed = true
      for (const cancel of jobs) cancel('cancelled')
      closing = (async () => {
        await tail
        if (worker) await stop(worker)
      })()
      return closing
    },
  }
}
