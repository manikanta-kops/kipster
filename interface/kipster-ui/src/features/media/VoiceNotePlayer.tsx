import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play'
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause'

const BARS = 36
/** Larger recordings show a neutral waveform instead of being decoded. */
const MEASURE_LIMIT = 4 * 1024 * 1024
/** Samples read per bar; enough for a loudness estimate at any length. */
const SAMPLES_PER_BAR = 2048

/** Reads the recording once to draw its real loudness and learn its length. */
async function measure(blob: Blob, signal: AbortSignal) {
  if (blob.size > MEASURE_LIMIT || typeof OfflineAudioContext === 'undefined')
    return null
  try {
    const bytes = await blob.arrayBuffer()
    if (signal.aborted) return null
    const context = new OfflineAudioContext(1, 1, 44100)
    const buffer = await context.decodeAudioData(bytes)
    if (signal.aborted) return null
    const samples = buffer.getChannelData(0)
    const size = Math.max(1, Math.floor(samples.length / BARS))
    const stride = Math.max(1, Math.floor(size / SAMPLES_PER_BAR))
    const levels = Array.from({ length: BARS }, (_, bar) => {
      let sum = 0
      let count = 0
      const end = Math.min(samples.length, (bar + 1) * size)
      for (let i = bar * size; i < end; i += stride) {
        sum += samples[i] * samples[i]
        count++
      }
      return count ? Math.sqrt(sum / count) : 0
    })
    const loudest = Math.max(...levels)
    return {
      levels: levels.map((level) => (loudest > 0.001 ? level / loudest : 0)),
      duration: buffer.duration,
    }
  } catch {
    return null
  }
}

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function VoiceNotePlayer({ blob, name }: { blob: Blob; name: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [levels, setLevels] = useState<number[] | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(blob)
    // Object URLs are external resources whose lifetime follows this mounted view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(next)
    setFailed(false)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  useEffect(() => {
    const controller = new AbortController()
    void measure(blob, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setLevels(result?.levels ?? [])
      if (result) setDuration((known) => known || result.duration)
    })
    return () => controller.abort()
  }, [blob])
  if (failed)
    return <small>Playback unavailable. Download the original file.</small>
  const progress = duration ? Math.min(1, time / duration) : 0
  return (
    <div className={`voice-note${playing ? ' playing' : ''}`}>
      <button
        type="button"
        className="voice-play"
        aria-label={`${playing ? 'Pause' : 'Play'} ${name}`}
        disabled={!url}
        onClick={() => {
          const element = audio.current
          if (!element) return
          if (!element.paused) {
            element.pause()
            return
          }
          element.play().catch((error: unknown) => {
            // Pausing before playback starts rejects the pending play request.
            if (error instanceof DOMException && error.name === 'AbortError')
              return
            setFailed(true)
          })
        }}
      >
        {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
      </button>
      <span className="voice-wave">
        <span className="voice-bars" aria-hidden="true">
          {(levels?.length ? levels : Array<number>(BARS).fill(0)).map(
            (level, index) => (
              <span
                key={index}
                className={index / BARS < progress ? 'played' : undefined}
                style={{ '--level': level } as CSSProperties}
              />
            ),
          )}
        </span>
        <input
          type="range"
          className="voice-seek"
          aria-label={`Position in ${name}`}
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(time, duration || 0)}
          disabled={!duration}
          onChange={(event) => {
            const element = audio.current
            if (!element) return
            element.currentTime = Number(event.target.value)
            setTime(element.currentTime)
          }}
        />
      </span>
      <span className="voice-time">
        {clock(playing || time ? time : duration)}
      </span>
      {/* Voice notes are transcribed separately; the transcript follows the player. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        ref={audio}
        src={url || undefined}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setTime(0)
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const length = event.currentTarget.duration
          if (Number.isFinite(length)) setDuration(length)
        }}
        onError={() => setFailed(true)}
      />
    </div>
  )
}
