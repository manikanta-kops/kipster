import workletURL from './recording-worklet.js?url&no-inline'

/** Host recording capability. Permission is requested only by start(). */
export interface RecordingSession {
  finished?: Promise<Blob>
  stop(): Promise<Blob>
  cancel(): void
}
export interface RecordingService {
  start(signal: AbortSignal): Promise<RecordingSession>
}

function wav(chunks: Float32Array[]): Blob {
  const samples = chunks.reduce((count, chunk) => count + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  for (const chunk of chunks)
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample))
      view.setInt16(
        offset,
        Math.round(clamped * (clamped < 0 ? 32768 : 32767)),
        true,
      )
      offset += 2
    }
  return new Blob([buffer], { type: 'audio/wav' })
}

export const browserRecording: RecordingService = {
  async start(signal) {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === 'undefined' ||
      typeof AudioWorkletNode === 'undefined'
    )
      throw new Error('Microphone recording is unavailable on this device.')
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    })
    const release = () => stream.getTracks().forEach((track) => track.stop())
    if (signal.aborted) {
      release()
      throw new DOMException('Cancelled', 'AbortError')
    }
    let context: AudioContext
    try {
      context = new AudioContext({ sampleRate: 16000 })
    } catch (error) {
      release()
      throw error
    }
    const chunks: Float32Array[] = []
    let source: MediaStreamAudioSourceNode | undefined
    let recorder: AudioWorkletNode | undefined
    let finished = false
    let stopping = false
    let resolve!: (blob: Blob) => void
    let reject!: (error: Error) => void
    const result = new Promise<Blob>((yes, no) => {
      resolve = yes
      reject = no
    })
    // An error can arrive before the user presses Stop.
    void result.catch(() => {})
    const cleanup = async () => {
      release()
      signal.removeEventListener('abort', cancel)
      source?.disconnect()
      if (recorder) {
        recorder.onprocessorerror = null
        recorder.port.onmessage = null
        recorder.port.close()
        recorder.disconnect()
      }
      await context.close().catch(() => {})
    }
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      void cleanup().then(() => {
        if (error) reject(error)
        else if (!chunks.length)
          reject(new Error('The recording contains no audio bytes.'))
        else {
          try {
            resolve(wav(chunks))
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('Recording failed. Please try again.'),
            )
          }
        }
        chunks.length = 0
      })
    }
    const cancel = () => finish(new DOMException('Cancelled', 'AbortError'))
    signal.addEventListener('abort', cancel, { once: true })
    try {
      // Resume during the initiating user action, before loading the module.
      await Promise.all([
        context.resume(),
        context.audioWorklet.addModule(workletURL),
      ])
      if (finished) throw new DOMException('Cancelled', 'AbortError')
      source = context.createMediaStreamSource(stream)
      recorder = new AudioWorkletNode(context, 'kipster-recording')
      recorder.onprocessorerror = () =>
        finish(new Error('Recording failed. Please try again.'))
      recorder.port.onmessage = (
        event: MessageEvent<Float32Array | 'stopped'>,
      ) => {
        if (event.data === 'stopped') finish()
        else chunks.push(event.data)
      }
      source.connect(recorder)
      // The processor outputs silence; connecting keeps capture running without monitoring the mic.
      recorder.connect(context.destination)
      return {
        finished: result,
        cancel,
        stop() {
          if (!finished && !stopping) {
            stopping = true
            // The acknowledgement follows all captured samples on the same port.
            recorder!.port.postMessage('stop')
          }
          return result
        },
      }
    } catch (error) {
      cancel()
      await result.catch(() => {})
      throw error
    }
  },
}
