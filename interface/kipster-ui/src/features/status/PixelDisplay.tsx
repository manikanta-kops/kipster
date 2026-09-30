import { useEffect, useRef } from 'react'
import type { LiveState } from './live-state'
import {
  DotFrame,
  clamp,
  dotColorKeys,
  dotColors,
  hash,
  scenes,
  smooth,
} from './pixel-scenes'

const dissolveSeconds = 0.6
const now = () => performance.now() / 1000

function dotSprite(color: string, size: number) {
  const canvas = document.createElement('canvas')
  const extent = Math.ceil(size * 3)
  canvas.width = canvas.height = extent
  const context = canvas.getContext('2d')!
  const middle = extent / 2
  const halo = context.createRadialGradient(
    middle,
    middle,
    0,
    middle,
    middle,
    size * 1.25,
  )
  halo.addColorStop(0, `${color}57`)
  halo.addColorStop(1, `${color}00`)
  context.fillStyle = halo
  context.fillRect(0, 0, extent, extent)
  const core = context.createRadialGradient(
    middle - size * 0.08,
    middle - size * 0.1,
    0,
    middle,
    middle,
    size * 0.38,
  )
  core.addColorStop(0, '#ffffffaa')
  core.addColorStop(0.55, color)
  core.addColorStop(1, color)
  context.fillStyle = core
  context.beginPath()
  context.arc(middle, middle, size * 0.37, 0, Math.PI * 2)
  context.fill()
  return canvas
}

/** One LED matrix. Brightness eases toward each frame, so pixels glow on and fade off. */
class Display {
  private frame: DotFrame
  private previous: DotFrame
  private readonly lit: Float32Array
  private readonly hue: Uint8Array
  private readonly order: Float32Array
  private state: LiveState | null = null
  private since = 0
  private prior: { state: LiveState | null; since: number } | null = null
  private changedAt = -1
  private scale = 0
  private sprites: HTMLCanvasElement[] = []
  private grid: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private quiet = true
  reduced = false

  get busy() {
    return !this.quiet && !this.reduced
  }

  private readonly canvas: HTMLCanvasElement
  private readonly cols: number
  private readonly rows: number
  private readonly pitch: number

  constructor(
    canvas: HTMLCanvasElement,
    cols: number,
    rows: number,
    pitch: number,
  ) {
    this.canvas = canvas
    this.cols = cols
    this.rows = rows
    this.pitch = pitch
    this.frame = new DotFrame(cols, rows)
    this.previous = new DotFrame(cols, rows)
    this.lit = new Float32Array(cols * rows)
    this.hue = new Uint8Array(cols * rows)
    this.order = new Float32Array(cols * rows).map(
      (_, i) => 0.62 * ((i % cols) / (cols - 1)) + 0.38 * hash(i + 7),
    )
  }

  get width() {
    return this.cols * this.pitch
  }
  get height() {
    return this.rows * this.pitch
  }

  show(state: LiveState | null, reduced: boolean) {
    this.reduced = reduced
    if (state === this.state) return this.paint(0)
    this.prior = { state: this.state, since: this.since }
    this.state = state
    this.since = now()
    this.changedAt = reduced ? -1 : this.since
    this.quiet = false
    this.paint(0)
  }

  private sceneAge(since: number, state: LiveState) {
    return this.reduced ? scenes[state].still : now() - since
  }
  private draw(target: DotFrame, state: LiveState | null, since: number) {
    target.clear()
    if (!state) return
    const age = this.sceneAge(since, state)
    scenes[state].draw(target, this.reduced ? age : now(), age)
  }

  paint(dt: number) {
    if (this.quiet && !this.reduced) return
    this.prepare()
    this.draw(this.frame, this.state, this.since)
    const progress =
      this.changedAt < 0 ? 1 : (now() - this.changedAt) / dissolveSeconds
    if (progress < 1 && this.prior) {
      this.draw(this.previous, this.prior.state, this.prior.since)
      const front = smooth(progress) * 1.08
      for (let i = 0; i < this.lit.length; i++) {
        const o = this.order[i]
        if (o > front) {
          this.frame.value[i] = this.previous.value[i]
          this.frame.color[i] = this.previous.color[i]
        } else if (front - o < 0.06 && this.frame.value[i] < 0.45) {
          this.frame.value[i] = 0.45
          this.frame.color[i] = 0
        }
      }
    } else this.changedAt = -1
    const rise = this.reduced ? 1 : 1 - Math.exp(-dt / 0.03)
    const fall = this.reduced ? 1 : 1 - Math.exp(-dt / 0.09)
    let glowing = false
    for (let i = 0; i < this.lit.length; i++) {
      const target = this.frame.value[i],
        delta = target - this.lit[i]
      this.lit[i] = clamp(this.lit[i] + delta * (delta > 0 ? rise : fall))
      if (target > 0.01) this.hue[i] = this.frame.color[i]
      if (this.lit[i] > 0.012) glowing = true
    }
    this.render()
    if (!this.state && !glowing) this.quiet = true
  }

  private prepare() {
    const scale = window.devicePixelRatio || 1
    if (scale === this.scale) return
    this.scale = scale
    const size = this.pitch * scale
    this.canvas.width = Math.round(this.width * scale)
    this.canvas.height = Math.round(this.height * scale)
    this.context = this.canvas.getContext('2d')
    this.sprites = dotColorKeys.map((key) => dotSprite(dotColors[key], size))
    const grid = document.createElement('canvas')
    grid.width = this.canvas.width
    grid.height = this.canvas.height
    const context = grid.getContext('2d')!
    context.fillStyle = 'rgba(255, 255, 255, 0.075)'
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.cols; x++) {
        context.beginPath()
        context.arc(
          (x + 0.5) * size,
          (y + 0.5) * size,
          size * 0.33,
          0,
          Math.PI * 2,
        )
        context.fill()
      }
    this.grid = grid
  }

  private render() {
    const context = this.context
    if (!context || !this.grid) return
    const size = this.pitch * this.scale,
      half = this.sprites[0].width / 2
    context.globalAlpha = 1
    context.clearRect(0, 0, this.canvas.width, this.canvas.height)
    context.drawImage(this.grid, 0, 0)
    for (let i = 0; i < this.lit.length; i++) {
      const b = this.lit[i]
      if (b < 0.012) continue
      context.globalAlpha = b
      context.drawImage(
        this.sprites[this.hue[i]],
        ((i % this.cols) + 0.5) * size - half,
        (Math.floor(i / this.cols) + 0.5) * size - half,
      )
    }
    context.globalAlpha = 1
  }
}

/*
 * One requestAnimationFrame loop for every display, painting at an LED-like
 * 30 fps. It sleeps while the page is hidden or every display is dark.
 */
const displays = new Set<Display>()
const frameSeconds = 1 / 30
let request = 0
let last = 0
function tick(time: number) {
  const elapsed = (time - last) / 1000
  const due = elapsed >= frameSeconds - 0.004
  if (due) last = time
  let busy = false
  for (const display of displays) {
    if (!display.busy) continue
    busy = true
    if (due) display.paint(Math.min(elapsed, 0.1))
  }
  request = busy && !document.hidden ? requestAnimationFrame(tick) : 0
}
function wake() {
  if (request || !displays.size || document.hidden) return
  last = performance.now()
  request = requestAnimationFrame(tick)
}
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', wake)

export function PixelDisplay({
  state,
  cols,
  rows = 9,
  pitch = 2.4,
  reduced,
}: {
  state: LiveState | null
  cols: number
  rows?: number
  pitch?: number
  reduced: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const display = useRef<Display | null>(null)
  useEffect(() => {
    const created = new Display(canvas.current!, cols, rows, pitch)
    display.current = created
    displays.add(created)
    return () => {
      displays.delete(created)
      display.current = null
    }
  }, [cols, rows, pitch])
  useEffect(() => {
    display.current?.show(state, reduced)
    wake()
  }, [state, reduced, cols, rows, pitch])
  return (
    <canvas
      ref={canvas}
      className="pixel-display"
      aria-hidden="true"
      style={{ width: cols * pitch, height: rows * pitch }}
    />
  )
}
