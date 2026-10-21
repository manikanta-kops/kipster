class RecordingProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.stopped = false
    this.port.onmessage = () => {
      this.stopped = true
      this.port.postMessage('stopped')
    }
  }

  process(inputs) {
    if (this.stopped) return false
    const channels = inputs[0]
    if (channels.length) {
      const mono = new Float32Array(channels[0].length)
      for (const channel of channels)
        for (let i = 0; i < mono.length; i++)
          mono[i] += channel[i] / channels.length
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}

registerProcessor('kipster-recording', RecordingProcessor)
