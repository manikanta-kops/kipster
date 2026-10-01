import type { LiveState } from './live-state'

export const dotColors = {
  white: '#f3f4f6',
  run: '#7fd6ff',
  amber: '#ff9f0a',
  red: '#ff453a',
  green: '#32d74b',
  soft: '#ffcb7d',
  orange: '#ff7a3d',
  blue: '#5fa8ff',
  grey: '#9a9aa2',
} as const
export type DotColor = keyof typeof dotColors
export const dotColorKeys = Object.keys(dotColors) as DotColor[]

const colorIndex = Object.fromEntries(
  dotColorKeys.map((key, index) => [key, index]),
) as Record<DotColor, number>

export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
export const clamp = (v: number, min = 0, max = 1) =>
  v < min ? min : v > max ? max : v
export const smooth = (p: number) => {
  const c = clamp(p)
  return c * c * (3 - 2 * c)
}
const lerp = (a: number, b: number, p: number) => a + (b - a) * p

/** One frame of target brightness (0 to 1) and color per dot. */
export class DotFrame {
  readonly value: Float32Array
  readonly color: Uint8Array
  readonly cols: number
  readonly rows: number
  private readonly memos = new Map<string, unknown>()
  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.value = new Float32Array(cols * rows)
    this.color = new Uint8Array(cols * rows)
  }
  clear() {
    this.value.fill(0)
  }
  dot(x: number, y: number, v = 1, color: DotColor = 'white') {
    const cx = Math.round(x),
      cy = Math.round(y)
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows || v <= 0) return
    const i = cy * this.cols + cx
    if (v > this.value[i]) {
      this.value[i] = Math.min(v, 1)
      this.color[i] = colorIndex[color]
    }
  }
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    v: number,
    color?: DotColor,
  ) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.dot(x + i, y + j, v, color)
  }
  line(x0: number, y0: number, x1: number, y1: number, v: number) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++)
      this.dot(lerp(x0, x1, i / n), lerp(y0, y1, i / n), v)
  }
  bitmap(
    rows: readonly string[],
    x: number,
    y: number,
    v: number,
    color: DotColor,
  ) {
    rows.forEach((row, r) =>
      [...row].forEach((c, q) => c === '#' && this.dot(x + q, y + r, v, color)),
    )
  }
  memo<T>(key: string, make: () => T): T {
    if (!this.memos.has(key)) this.memos.set(key, make())
    return this.memos.get(key) as T
  }
}

/**
 * A scene draws one frame from the global time and the time since the state
 * began. `still` is the representative frame used with reduced motion.
 */
export interface Scene {
  still: number
  draw(frame: DotFrame, time: number, age: number): void
}

const questionMark = ['##.', '..#', '.#.', '...', '.#.']

function checkPath(x0: number, y0: number, a: number) {
  const points: [number, number][] = []
  for (let i = 0; i <= a; i++) points.push([x0 + i, y0 + a + i])
  for (let i = 1; i <= 2 * a; i++) points.push([x0 + a + i, y0 + 2 * a - i])
  return points
}
function outline(x0: number, y0: number, x1: number, y1: number) {
  const points: [number, number][] = []
  for (let x = x0 + 1; x < x1; x++) points.push([x, y0])
  for (let y = y0 + 1; y < y1; y++) points.push([x1, y])
  for (let x = x1 - 1; x > x0; x--) points.push([x, y1])
  for (let y = y1 - 1; y > y0; y--) points.push([x0, y])
  return points
}
function chase(
  frame: DotFrame,
  ring: [number, number][],
  progress: number,
  length: number,
) {
  const head = Math.floor(progress * ring.length)
  for (let k = 0; k < length; k++) {
    const [x, y] =
      ring[(((head - k) % ring.length) + ring.length) % ring.length]
    frame.dot(x, y, 1 - k / (length + 1), 'amber')
  }
}

export const scenes: Record<LiveState, Scene> = {
  ready: {
    still: 1.2,
    draw(f, time) {
      const { cols: W, rows: H } = f
      const { ridge, stars } = f.memo('ridge', () => {
        const peaks = [
          [0.14, 0.42],
          [0.48, 0.8],
          [0.83, 0.55],
        ]
        const ridge = Array.from({ length: W }, (_, x) => {
          let h = 1.2
          for (const [px, ph] of peaks)
            h = Math.max(h, ph * (H - 1) - Math.abs(x - px * (W - 1)) * 0.72)
          return H - 1 - Math.round(h)
        })
        const stars: [number, number, number][] = []
        for (let i = 0; i < 80 && stars.length < 6; i++) {
          const x = Math.floor(hash(i * 3 + 1) * W),
            y = Math.floor(hash(i * 3 + 2) * (H - 2))
          if (
            y < ridge[x] - 1 &&
            !stars.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) < 4)
          )
            stars.push([x, y, hash(i * 9)])
        }
        return { ridge, stars }
      })
      ridge.forEach((y, x) => {
        const peak =
          (x === 0 || ridge[x - 1] >= y) && (x === W - 1 || ridge[x + 1] >= y)
        f.dot(x, y, peak ? 0.95 : 0.55)
        for (let yy = y + 1; yy < H; yy++)
          if ((x + yy) % 2 === 0) f.dot(x, yy, 0.12)
      })
      const twinkle = Math.floor(time / 3.3) % stars.length,
        phase = (time % 3.3) / 0.9
      stars.forEach(([x, y, r], i) => {
        const glint = i === twinkle && phase < 1 ? Math.sin(Math.PI * phase) : 0
        f.dot(x, y, 0.16 + r * 0.14 + glint * 0.7)
      })
    },
  },

  queued: {
    still: 0.5,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const gate = W - 4,
        front = gate - 4,
        top = Math.floor((H - 2) / 2),
        count = Math.floor(front / 4)
      const p = clamp(((age % 1.9) / 1.9 - 0.5) / 0.5),
        move = smooth(p)
      for (let y = top - 2; y < top + 4; y++)
        f.dot(gate, y, 0.22 + 0.3 * Math.sin(Math.PI * p))
      for (let k = 0; k <= count; k++) {
        const x = Math.round(front - k * 4 + 4 * move)
        if (x >= gate) continue
        const v =
          k === 0
            ? (1 - move) * 0.85
            : k === count
              ? 0.28 * move
              : 0.92 - (k - move) * 0.14
        f.rect(x, top, 2, 2, clamp(v))
      }
    },
  },

  preparing: {
    still: 1,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const c = Math.floor((H - 1) / 2),
        lines = [c - 2, c + 2]
      const words = f.memo('words', () =>
        [3, 17].map((seed, line) => {
          const end = line === 0 ? W - 3 : Math.round(W * 0.62)
          const runs: [number, number][] = []
          for (let x = 1, i = 0; x < end;) {
            const length = 3 + Math.floor(hash(seed + i++) * 5)
            runs.push([x, Math.min(end, x + length - 1)])
            x += length + 2
          }
          return runs
        }),
      )
      const inWord = (line: number, x: number) =>
        words[line].some(([s, e]) => x >= s && x <= e)
      const phase = age % 3.6,
        p = smooth((phase - 1.3) / 0.7)
      const lineV =
        phase < 1.3 ? 0 : phase < 3 ? 0.85 * p : 0.85 * (1 - (phase - 3) / 0.6)
      if (phase < 2) {
        for (let x = 1; x < W - 1; x += 2) {
          const envelope = Math.pow(Math.sin((Math.PI * x) / (W - 1)), 0.7)
          const amp =
            c *
            envelope *
            (0.3 +
              0.7 *
                Math.abs(
                  Math.sin(age * 7.3 + x * 0.9) *
                    Math.sin(age * 3.1 + x * 0.37),
                )) *
            clamp(phase / 0.35)
          const half = Math.round(amp)
          for (let y = c - half; y <= c + half; y++) {
            const line = y < c ? 0 : y > c ? 1 : inWord(0, x) ? 0 : 1
            if (inWord(line, x)) f.dot(x, lerp(y, lines[line], p), 0.85)
            else f.dot(x, y, 0.85 * (1 - p))
          }
        }
      }
      if (lineV > 0)
        for (let x = 0; x < W; x++)
          lines.forEach((y, line) => inWord(line, x) && f.dot(x, y, lineV))
    },
  },

  thinking: {
    still: 1.3,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const cx = (W - 1) / 2,
        cy = (H - 1) / 2,
        rx = W * 0.36,
        ry = (H - 1) * 0.42
      const at = (i: number, t: number): [number, number] => {
        const angle = (t * 2 * Math.PI) / 5.2 + (i * 2 * Math.PI) / 3
        const r = 0.86 + 0.14 * Math.sin((t * 2 * Math.PI) / 7.5)
        return [cx + rx * r * Math.cos(angle), cy + ry * r * Math.sin(angle)]
      }
      const link =
        0.14 * Math.pow(Math.max(0, Math.sin((age * 2 * Math.PI) / 6.4)), 3)
      if (link > 0.02) {
        const p = [0, 1, 2].map((i) => at(i, age))
        for (let i = 0; i < 3; i++) {
          const [a, b] = [p[i], p[(i + 1) % 3]]
          f.line(a[0], a[1], b[0], b[1], link)
        }
      }
      for (let i = 0; i < 3; i++)
        for (let k = 5; k >= 0; k--) {
          const [x, y] = at(i, age - k * 0.075)
          f.dot(
            x,
            y,
            k === 0 ? 0.9 : 0.4 * (1 - k / 6),
            k === 0 ? 'run' : 'white',
          )
        }
      f.dot(cx, cy, 0.16 + 0.08 * Math.sin(age * 3))
    },
  },

  writing: {
    still: 2.1,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const speed = 17
      const plan = f.memo('lines', () => {
        let at = 0.2
        const lines = Array.from({ length: 10 }, (_, k) => {
          const length =
            Math.round(
              W * (k % 4 === 3 ? 0.45 : 0.72) + hash(k + 3) * W * 0.18,
            ) - 2
          const runs: [number, number][] = []
          for (let x = 1, i = 0; x < length;) {
            const run = 2 + Math.floor(hash(k * 13 + i++) * 5)
            runs.push([x, Math.min(length, x + run - 1)])
            x += run + 1
          }
          const line = { length, runs, start: at }
          at += length / speed + 0.35
          return line
        })
        return { lines, period: at }
      })
      const { lines, period } = plan
      const cycle = Math.floor(age / period),
        inCycle = age % period
      let j = 0
      while (j < lines.length - 1 && lines[j + 1].start <= inCycle) j++
      const current = cycle * lines.length + j,
        since = inCycle - lines[j].start
      const shift = Math.round(2 * (1 - smooth(since / 0.3)))
      for (let back = 0; back < 4 && current - back >= 0; back++) {
        const line = lines[(current - back) % lines.length],
          y = H - 2 - back * 2 + shift
        const reach =
          back === 0 ? Math.min(line.length, since * speed) : line.length
        const v = [0.7, 0.4, 0.22, 0.1][back]
        for (const [s, e] of line.runs)
          for (let x = s; x <= e && x <= reach; x++) f.dot(x, y, v)
        if (back === 0 && reach < line.length)
          f.dot(Math.floor(reach) + 1, y, 0.9, 'run')
      }
    },
  },

  delegating: {
    still: 0.55,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const phase = age % 3.4
      let e = 0,
        dir = 1,
        arriveRight = 0,
        arriveLeft = 0
      if (phase < 1.1) e = smooth(phase / 1.1)
      else if (phase < 1.7) {
        e = 1
        arriveRight = Math.sin((Math.PI * (phase - 1.1)) / 0.6)
      } else if (phase < 2.8) {
        e = 1 - smooth((phase - 1.7) / 1.1)
        dir = -1
      } else arriveLeft = Math.sin((Math.PI * (phase - 2.8)) / 0.6)
      const figure = ['.#.', '###', '.#.', '#.#'],
        top = H - 5
      f.bitmap(figure, 1, top, 0.62 + 0.38 * arriveLeft, 'white')
      f.bitmap(figure, W - 4, top, 0.72 + 0.28 * arriveRight, 'blue')
      const from = 5,
        to = W - 6
      const at = (p: number): [number, number] => [
        lerp(from, to, p),
        top - Math.sin(Math.PI * p) * 3,
      ]
      for (let x = from; x <= to; x += 2)
        f.dot(...at((x - from) / (to - from)), 0.1)
      const moving = phase < 1.1 || (phase >= 1.7 && phase < 2.8)
      if (moving)
        for (let k = 3; k >= 0; k--)
          f.dot(
            ...at(clamp(e - dir * k * 0.045)),
            k === 0 ? 1 : 0.5 - k * 0.12,
            k === 0 ? 'run' : 'white',
          )
      else {
        const [x, y] = at(e)
        f.dot(
          x + (e > 0.5 ? -1 : 1),
          y - 1,
          0.5 + 0.5 * (arriveLeft + arriveRight),
          'run',
        )
      }
    },
  },

  question: {
    still: 1.2,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const top = Math.floor((H - 9) / 2),
        x0 = Math.floor(W / 2) - 6
      const ring = f.memo('bubble', () => outline(x0, top, x0 + 10, top + 6))
      ring.forEach(([x, y]) => f.dot(x, y, 0.4, 'amber'))
      f.dot(x0 + 2, top + 7, 0.4, 'amber')
      f.dot(x0 + 1, top + 8, 0.4, 'amber')
      const phase = age % 2.4
      if (phase < 0.8) chase(f, ring, phase / 0.8, 4)
      f.bitmap(
        questionMark,
        x0 + 4,
        top + 1,
        0.72 + 0.28 * Math.sin((age * 2 * Math.PI) / 1.6),
        'amber',
      )
    },
  },

  approval: {
    still: 1.2,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const top = Math.floor((H - 9) / 2),
        x0 = Math.floor(W / 2) - 6
      const ring = f.memo('button', () =>
        outline(x0 - 2, top, x0 + 13, top + 8),
      )
      ring.forEach(([x, y]) => f.dot(x, y, 0.36, 'amber'))
      const phase = age % 2.4
      if (phase < 0.9) chase(f, ring, phase / 0.9, 5)
      const drawn = Math.floor(age / 0.06) + 1
      const breathe = 0.7 + 0.3 * Math.sin((age * 2 * Math.PI) / 1.6)
      checkPath(x0, top + 2, 2).forEach(
        ([x, y], i) => i < drawn && f.dot(x, y, breathe, 'amber'),
      )
      f.bitmap(questionMark, x0 + 9, top + 2, 0.82, 'amber')
    },
  },

  held: {
    still: 1.6,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const v = 0.4 + 0.5 * (0.5 - 0.5 * Math.cos((age * 2 * Math.PI) / 3.2))
      const y0 = Math.floor((H - 5) / 2),
        cx = Math.floor(W / 2)
      f.rect(cx - 3, y0, 2, 5, v, 'soft')
      f.rect(cx + 1, y0, 2, 5, v, 'soft')
    },
  },

  stopping: {
    still: 1,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const cx = (W - 1) / 2,
        cy = (H - 1) / 2
      for (let i = 0; i < 18; i++) {
        const phase = ((age + hash(i) * 1.5) % 1.5) / 1.5,
          angle = hash(i + 50) * Math.PI * 2
        const p = phase * phase * phase
        const x = lerp(cx + Math.cos(angle) * W * 0.55, cx, p),
          y = lerp(cy + Math.sin(angle) * H * 0.75, cy, p)
        if (Math.abs(x - cx) < 1.6 && Math.abs(y - cy) < 1.6) continue
        f.dot(x, y, 0.2 + 0.6 * p)
      }
      f.rect(
        Math.round(cx - 1),
        Math.round(cy - 1),
        3,
        3,
        0.8 + 0.15 * Math.sin(age * 6),
      )
    },
  },

  done: {
    still: 2.2,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const x0 = Math.floor((W - 7) / 2),
        y0 = Math.floor((H - 5) / 2)
      const path = checkPath(x0, y0, 2)
      const shown = Math.min(path.length, Math.floor(age / 0.05) + 1),
        drawnAt = path.length * 0.05
      path.forEach(
        ([x, y], i) =>
          i < shown &&
          f.dot(
            x,
            y,
            i === shown - 1 && age < drawnAt + 0.1
              ? 1
              : age > 2.6
                ? 0.78
                : 0.95,
            'green',
          ),
      )
      const sparkle = (age - drawnAt) / 0.65
      if (sparkle > 0 && sparkle < 1)
        for (let r = 0; r < 8; r++) {
          const angle = (r * Math.PI) / 4 + Math.PI / 8,
            d = 3 + sparkle * 8
          f.dot(
            x0 + 3 + Math.cos(angle) * d * 1.4,
            y0 + 2 + Math.sin(angle) * d * 0.6,
            0.85 * (1 - sparkle),
          )
        }
    },
  },

  failed: {
    still: 1.5,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const x0 = Math.floor((W - 5) / 2),
        y0 = Math.floor((H - 5) / 2)
      const glitch = age < 0.7,
        step = Math.floor(age / 0.05)
      const dx = glitch ? Math.round((hash(step) - 0.5) * 4) : 0
      const v = glitch ? 0.55 + 0.45 * hash(step + 3) : 0.95
      for (let i = 0; i < 5; i++) {
        const shift = glitch && hash(step * 7 + i) < 0.35 ? dx : 0
        f.dot(x0 + i + shift, y0 + i, v, 'red')
        f.dot(x0 + 4 - i + shift, y0 + i, v, 'red')
      }
      if (glitch)
        for (let j = 0; j < 7; j++) {
          const q = Math.floor(hash(step * 11 + j) * W * H)
          f.dot(q % W, Math.floor(q / W), 0.28, 'red')
        }
    },
  },

  recovery: {
    still: 0.9,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      const scan = ((age % 2.8) / 2.8) * (W + 8) - 4
      const x = Math.floor(W / 2) - 1,
        y0 = Math.floor((H - 7) / 2)
      for (let y = 0; y < H; y++) {
        f.dot(scan, y, 0.16, 'orange')
        f.dot(scan - 1, y, 0.07, 'orange')
      }
      const mark: [number, number][] = []
      for (let y = 0; y < 5; y++) mark.push([x, y0 + y], [x + 1, y0 + y])
      mark.push([x, y0 + 6], [x + 1, y0 + 6])
      mark.forEach(([mx, my]) =>
        f.dot(
          mx,
          my,
          0.66 + 0.34 * clamp(1 - Math.abs(mx - scan) / 2.5),
          'orange',
        ),
      )
    },
  },

  unknown: {
    still: 0.4,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      f.bitmap(
        questionMark,
        Math.floor(W / 2) - 1,
        Math.floor((H - 5) / 2),
        0.5 + 0.2 * Math.sin((age * 2 * Math.PI) / 2.4),
        'grey',
      )
    },
  },

  offline: {
    still: 0.3,
    draw(f, _time, age) {
      const { cols: W, rows: H } = f
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if ((x + y) % 2 === 0) f.dot(x, y, 0.06, 'grey')
      if (age % 1.8 < 0.8)
        f.dot(Math.floor(W / 2), Math.floor(H / 2), 0.75, 'grey')
    },
  },
}
