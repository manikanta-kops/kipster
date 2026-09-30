/** Host recording capability. Permission is requested only by start(). */
export interface RecordingSession {
  finished?: Promise<Blob>
  stop(): Promise<Blob>
  cancel(): void
}
export interface RecordingService {
  start(signal: AbortSignal): Promise<RecordingSession>
}
export const browserRecording: RecordingService = {
  async start(signal) {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === 'undefined'
    )
      throw new Error('Microphone recording is unavailable on this device.')
    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/mp4',
      'audio/ogg;codecs=opus',
    ].find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType)
      throw new Error('No supported recording format is available.')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const release = () => stream.getTracks().forEach((track) => track.stop())
    if (signal.aborted) {
      release()
      throw new DOMException('Cancelled', 'AbortError')
    }
    try {
      const recorder = new MediaRecorder(stream, { mimeType })
      const chunks: Blob[] = []
      let cancelled = false
      let finished = false
      let resolve: (blob: Blob) => void
      let reject: (error: Error) => void
      const result = new Promise<Blob>((yes, no) => {
        resolve = yes
        reject = no
      })
      // An error can arrive before the user presses Stop.
      void result.catch(() => {})
      const cleanup = () => {
        release()
        signal.removeEventListener('abort', cancel)
      }
      const cancel = () => {
        cancelled = true
        if (recorder.state !== 'inactive') recorder.stop()
        cleanup()
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      recorder.onerror = () => {
        finished = true
        cleanup()
        reject(new Error('Recording failed. Please try again.'))
      }
      recorder.onstop = () => {
        finished = true
        cleanup()
        if (cancelled) reject(new DOMException('Cancelled', 'AbortError'))
        else if (!chunks.length)
          reject(new Error('The recording contains no audio bytes.'))
        else resolve(new Blob(chunks, { type: mimeType }))
      }
      signal.addEventListener('abort', cancel, { once: true })
      recorder.start()
      return {
        finished: result,
        cancel,
        stop() {
          if (!finished && recorder.state !== 'inactive') recorder.stop()
          release()
          return result
        },
      }
    } catch (error) {
      release()
      throw error
    }
  },
}
