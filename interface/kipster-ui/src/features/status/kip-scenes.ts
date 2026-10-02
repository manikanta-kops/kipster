import type { LiveState } from './live-state'
import {
  clamp,
  hash,
  smooth as ease,
  type DotColor,
  type DotFrame,
  type Scene,
} from './pixel-scenes'
import { kipStanding, kipTorso } from '../../components/kip-sprite'

/*
 * Kip's sign: the night-farm scenes from kipster.app, one per live state.
 * Kip is drawn in white dots; colour only marks the comb, beak and state.
 */

const lerp = (a: number, b: number, p: number) => a + (b - a) * p

const legs = (a: string, b: string) => [...kipTorso, a, b]
const sprites = {
  stand: kipStanding,
  walkA: legs('.....Y...Y...', '....YY...YY..'),
  walkB: legs('......YY.....', '......YYY....'),
  scratch: legs('....Y...Y....', '...Y....YY...'),
  peck: [
    '.............',
    '.............',
    '.SS..........',
    '.SWS.........',
    '.SWWS........',
    '..SWWWWWW....',
    '..WWWWSSSWW..',
    '...WWWSSWWWRR',
    '....WWWWWWWKW',
    '......Y.Y..WY',
    '.....YY.YY...',
  ],
  look: [
    '........RR...',
    '.......RRRR..',
    '.SS....WWWWY.',
    '.SWS...WWKW..',
    '.SWWS..WWWWR.',
    '..SWWWWWWWWR.',
    ...kipTorso.slice(6),
    '......Y.Y....',
    '.....YY.YY...',
  ],
  sit: [
    '.............',
    '.............',
    '.........RR..',
    '........RRRR.',
    '.SS.....WWWW.',
    '.SWS...WWWKWY',
    '.SWWS..WWWWR.',
    '..SWWWWWWWWR.',
    '..WWWWSSSWW..',
    '..WWWWWSSWW..',
    '...SWWWWWWS..',
  ],
  front: [
    '....RRR....',
    '...RRRRR...',
    '...WWWWW...',
    '..WKWWWKW..',
    '..WWWYWWW..',
    '.SWWWRWWWS.',
    'SWWWWWWWWWS',
    'SSWWWWWWWSS',
    '.SWWWWWWWS.',
    '...Y...Y...',
    '..YY...YY..',
  ],
  flap: [
    '....RRR....',
    'S..RRRRR..S',
    'SS.WWWWW.SS',
    '.SWKWWWKWS.',
    '..WWWYWWW..',
    '..WWWRWWW..',
    '.WWWWWWWWW.',
    '..WWWWWWW..',
    '..WWWWWWW..',
    '...Y...Y...',
    '..YY...YY..',
  ],
  chick: ['..CC.', '.CCKY', 'CCCC.', '.Y.Y.'],
  chickB: ['..CC.', '.CCKY', 'CCCC.', '..YY.'],
  egg: ['.EE.', 'EEEE', 'EEEE', 'EEEE', '.EE.'],
  eggCrack: ['.EE.', 'EXEE', 'EEXE', 'EXEE', '.EE.'],
  nest: ['BB.BBBBB.BB', '.BBBBBBBBB.'],
  coop: [
    '....O....',
    '...OOO...',
    '..OOOOO..',
    '.OOOOOOO.',
    'OOOOOOOOO',
    '.HHHHHHH.',
    '.HHKKKHH.',
    '.HHKKKHH.',
    '.HHKKKHH.',
  ],
}
type Sprite = keyof typeof sprites

/** Each ink is a dot colour and brightness. `K` and unknown keys stay unlit. */
const inks: Record<string, [DotColor, number]> = {
  W: ['white', 0.95],
  S: ['white', 0.5],
  R: ['red', 0.85],
  Y: ['amber', 0.75],
  C: ['soft', 0.8],
  E: ['white', 0.85],
  G: ['amber', 1],
  X: ['orange', 1],
  B: ['soft', 0.35],
  O: ['white', 0.32],
  H: ['white', 0.17],
  N: ['blue', 0.95],
  n: ['blue', 0.5],
  grass: ['white', 0.22],
  grass2: ['white', 0.34],
  moon: ['soft', 0.6],
  star: ['white', 0.5],
  soil: ['white', 0.07],
  mark: ['white', 0.85],
  seed: ['soft', 0.85],
  dust: ['white', 0.45],
  feather: ['white', 0.85],
  run: ['run', 0.95],
  amber: ['amber', 1],
  red: ['red', 1],
  green: ['green', 1],
  soft: ['soft', 0.9],
  orange: ['orange', 1],
  grey: ['grey', 0.8],
  sound: ['run', 0.6],
}
const pip = { W: 'N', S: 'n' }
const questionMark = ['XX.', '..X', '.X.', '...', '.X.']
const noSignal = [
  '..XXXXX..',
  '.X.....X.',
  'X..XXX..X',
  '..X...X..',
  '....X....',
]
const cross = ['X.X', '.X.', 'X.X']

interface Options {
  v?: number
  flip?: boolean
  rot?: boolean
  lift?: number
  map?: Record<string, string> | null
}

/** Draws inks and sprites onto a frame, with the farm's ground line as the layout. */
class Farm {
  readonly f: DotFrame
  readonly W: number
  readonly gy: number
  readonly x0 = 1
  readonly x1: number
  grey = false
  constructor(f: DotFrame) {
    this.f = f
    this.W = f.cols
    this.gy = f.rows - 3
    this.x1 = f.cols - 2
  }
  px(x: number, y: number, ink: string, v = 1) {
    const found = inks[ink]
    if (!found || !(v > 0)) return
    const [color, level] = found
    this.f.dot(
      x,
      y,
      v * level * (this.grey ? 0.55 : 1),
      this.grey ? 'grey' : color,
    )
  }
  rect(x: number, y: number, w: number, h: number, ink: string, v: number) {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.px(x + i, y + j, ink, v)
  }
  spr(name: Sprite, x: number, y: number, o: Options = {}) {
    const rows = sprites[name],
      w = rows[0].length,
      h = rows.length,
      v = o.v ?? 1,
      flip = !!o.flip,
      rot = !!o.rot
    x = Math.round(x)
    y = Math.round(y)
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const ink = rows[rot ? h - 1 - j : j][flip !== rot ? w - 1 - i : i]
        if (ink !== '.') this.px(x + i, y + j, o.map?.[ink] ?? ink, v)
      }
    return { x, y, w, h }
  }
  kip(x: number, pose: Sprite, o: Options = {}) {
    return this.spr(
      pose,
      x,
      this.gy - sprites[pose].length + 1 - (o.lift ?? 0),
      o,
    )
  }
  glyph(rows: string[], x: number, y: number, ink: string, v: number) {
    rows.forEach((row, j) =>
      [...row].forEach((c, i) => c === 'X' && this.px(x + i, y + j, ink, v)),
    )
  }
}

const walk = (age: number, step = 0.14): Sprite =>
  Math.floor(age / step) % 2 ? 'walkA' : 'walkB'

function backdrop(g: Farm, time: number) {
  const { W, gy } = g
  const { stars, tufts } = g.f.memo('farm', () => {
    const stars: [number, number, number][] = []
    for (let i = 0; i < 80 && stars.length < 6; i++) {
      const x = Math.floor(hash(i * 3 + 1) * (W - 8)),
        y = Math.floor(hash(i * 3 + 2) * (gy - 8))
      if (!stars.some((s) => Math.abs(s[0] - x) + Math.abs(s[1] - y) < 8))
        stars.push([x, y, hash(i * 9)])
    }
    const tufts = Array.from({ length: 6 }, (_, i) =>
      Math.floor(hash(i * 5 + 40) * W),
    )
    return { stars, tufts }
  })
  for (let x = 0; x < W; x++) {
    g.px(x, gy + 1, 'grass')
    if ((x + gy) % 2 === 0) g.px(x, gy + 2, 'soil')
  }
  tufts.forEach((x) => {
    g.px(x, gy, 'grass2')
    g.px(x + 1, gy - 1, 'grass2', 0.7)
  })
  const twinkle = Math.floor(time / 3.3) % stars.length,
    phase = (time % 3.3) / 0.9
  stars.forEach(([x, y, r], i) => {
    let v = 0.35 + r * 0.3
    if (i === twinkle && phase < 1) v += Math.sin(Math.PI * phase) * (1 - v)
    g.px(x, y, 'star', v)
  })
  const mx = W - 6
  ;[
    [1, 0],
    [2, 0],
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
  ].forEach(([dx, dy]) => g.px(mx + dx, 1 + dy, 'moon'))
}
function outline(x0: number, y0: number, x1: number, y1: number) {
  const points: [number, number][] = []
  for (let x = x0 + 1; x < x1; x++) points.push([x, y0])
  for (let y = y0 + 1; y < y1; y++) points.push([x1, y])
  for (let x = x1 - 1; x > x0; x--) points.push([x, y1])
  for (let y = y1 - 1; y > y0; y--) points.push([x0, y])
  return points
}
function checkPath(x0: number, y0: number, a: number) {
  const points: [number, number][] = []
  for (let i = 0; i <= a; i++) points.push([x0 + i, y0 + a + i])
  for (let i = 1; i <= 2 * a; i++) points.push([x0 + a + i, y0 + 2 * a - i])
  return points
}

const restX = (g: Farm) => Math.round((g.x0 + g.x1) / 2 - 7)

type Draw = (g: Farm, time: number, age: number) => void
const scene = (still: number, draw: Draw, mood = false): Scene => ({
  still,
  draw(f, time, age) {
    const g = new Farm(f)
    g.grey = mood
    backdrop(g, time)
    draw(g, time, age)
  },
})

export const kipScenes: Record<LiveState, Scene> = {
  ready: scene(
    0,
    (g) => g.kip(Math.round((g.x0 + g.x1) / 2 - 7), 'sit', { map: { K: 'S' } }),
    true,
  ),
  queued: scene(0.6, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      coopX = x1 - 8,
      doorX = coopX + 3
    g.spr('coop', coopX, gy - 8)
    const P = 2.2,
      ph = (a % P) / P,
      q = clamp((ph - 0.45) / 0.55),
      mv = ease(q)
    const sp = 7,
      kipX = x0 + 6,
      first = kipX + 15,
      n = Math.max(1, Math.floor((doorX - 2 - first) / sp))
    for (let k = 0; k <= n; k++) {
      const v = k === 0 ? 1 - mv : k === n ? mv : 1
      g.spr(
        q > 0 && q < 1 && Math.floor(a / 0.1) % 2 ? 'chickB' : 'chick',
        doorX - 2 - k * sp + sp * mv,
        gy - 3,
        { v },
      )
    }
    const cycle = a % 3.1
    g.kip(
      kipX,
      cycle < 0.3 ? 'peck' : cycle > 1.6 && cycle < 2.4 ? 'look' : 'stand',
    )
  }),
  preparing: scene(1.6, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round(x0 + (x1 - x0) * 0.2),
      beakX = kx + 12,
      hy = gy - 8,
      P = 3.6,
      ph = a % P
    g.kip(kx, Math.floor(a / 0.7) % 3 === 2 ? 'stand' : 'look')
    const speed = Math.max(10, (x1 - beakX) / 1.3),
      out = ph > P - 0.45 ? clamp((P - ph) / 0.45) : 1
    let arrived = 0
    for (let k = 0; k < 5; k++) {
      const e = ph - k * 0.42
      if (e < 0) continue
      const x = x1 - e * speed
      if (x <= beakX + 1) {
        arrived++
        continue
      }
      const f = clamp((x1 - x) / 3) * out
      g.px(x, hy - 1, 'sound', 0.75 * f)
      g.px(x - 1, hy, 'sound', 0.95 * f)
      g.px(x, hy + 1, 'sound', 0.75 * f)
    }
    for (let k = 0; k < arrived; k++)
      g.px(beakX + 2 + k * 2, gy, 'seed', 0.95 * out)
  }),
  thinking: scene(2.4, (g, _t, a) => {
    const span = g.x1 - g.x0,
      R = Math.min(22, span - 20),
      xa = g.x0 + Math.round((span - 13 - R) / 2),
      xb = xa + R,
      P = 6.4,
      ph = a % P
    let x = xa,
      flip = false,
      pose: Sprite = 'stand',
      thought = -1,
      end = 0
    if (ph < 1.6) [x, pose] = [lerp(xa, xb, ease(ph / 1.6)), walk(a)]
    else if (ph < 3.2)
      [x, pose, thought, end] = [xb, ph < 1.8 ? 'stand' : 'look', ph - 1.8, 3.2]
    else if (ph < 4.8)
      [x, flip, pose] = [lerp(xb, xa, ease((ph - 3.2) / 1.6)), true, walk(a)]
    else if (ph < 5.3)
      [flip, pose] = [true, Math.floor(a / 0.12) % 2 ? 'scratch' : 'stand']
    else [pose, thought, end] = ['look', ph - 5.4, P]
    const k = g.kip(x, pose, { flip })
    if (thought > 0) {
      const fade = clamp((end - ph) / 0.3)
      ;[
        [13, 1, 0.55],
        [15, -1, 0.75],
        [17, -2, 0.95],
      ].forEach(([dx, dy, v], i) => {
        if (thought > 0.2 + i * 0.28)
          g.px(flip ? k.x + 12 - dx : k.x + dx, k.y + dy + 1, 'run', v * fade)
      })
    }
  }),
  writing: scene(3.4, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      step = 4,
      walkFor = 0.3,
      per = 0.56,
      xs = x0 - 6,
      xe = x1 - 13,
      n = Math.ceil((xe - xs) / step)
    const T = n * per + 1.1,
      cycle = Math.floor(a / T),
      inCycle = a - cycle * T
    const k = Math.min(n, Math.floor(inCycle / per)),
      f = inCycle - k * per,
      walking = k < n && f < walkFor
    const kx =
      k >= n
        ? xs + n * step
        : xs + k * step + (walking ? step * ease(f / walkFor) : step)
    const fade =
      inCycle > n * per + 0.6 ? clamp(1 - (inCycle - n * per - 0.6) / 0.5) : 1
    for (let j = 0; j < (walking ? k : Math.min(n, k + 1)); j++) {
      const wx = xs + (j + 1) * step + 10,
        len = 1 + Math.floor(hash(j * 7 + cycle * 31) * 3)
      for (let q = 0; q < len; q++) g.px(wx + q, gy + 1, 'mark', 0.95 * fade)
    }
    g.kip(kx, k >= n ? 'stand' : walking ? walk(a, 0.1) : 'peck', { v: fade })
  }),
  delegating: scene(0.6, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      xa = x0 + Math.round((x1 - x0 - 50) / 2),
      xb = xa + 37,
      P = 3.4,
      ph = a % P
    let e: number,
      dir = 1,
      toB = false,
      toA = false
    if (ph < 1.1) e = ease(ph / 1.1)
    else if (ph < 1.7) [e, toB] = [1, true]
    else if (ph < 2.8) [e, dir] = [1 - ease((ph - 1.7) / 1.1), -1]
    else [e, toA] = [0, true]
    g.kip(xa, toA ? 'peck' : 'stand')
    g.kip(xb, toB ? 'peck' : 'stand', { flip: true, map: pip })
    const ax = xa + 12,
      hy = gy - 7,
      at = (q: number) => [lerp(ax, xb, q), hy - Math.sin(Math.PI * q) * 5]
    if (toA || toB)
      g.px(toB ? xb - 1 : xa + 13, gy, 'run', 0.6 + 0.4 * Math.sin(a * 18))
    else
      for (let k = 3; k >= 0; k--) {
        const [x, y] = at(clamp(e - dir * k * 0.05))
        g.px(x, y, k ? 'sound' : 'run', k ? 0.6 - k * 0.14 : 1)
      }
  }),
  question: scene(1.4, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round((x0 + x1) / 2 - 8),
      ph = a % 2.4
    const hop =
      ph < 0.9 ? Math.round(2.2 * Math.abs(Math.sin((ph / 0.45) * Math.PI))) : 0
    const k = g.kip(kx, 'front', {
      lift: hop,
      map: ph > 1.8 && ph < 1.93 ? { K: 'W' } : null,
    })
    if ((ph > 0.4 && ph < 0.58) || (ph > 0.85 && ph < 1.03)) {
      g.px(kx - 1, gy, 'dust', 0.6)
      g.px(kx + 11, gy, 'dust', 0.6)
    }
    g.glyph(
      questionMark,
      kx + 12,
      Math.max(0, k.y - 3),
      'amber',
      0.72 + 0.28 * Math.sin((a * 2 * Math.PI) / 1.6),
    )
  }),
  approval: scene(1.2, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round((x0 + x1) / 2 - 9),
      ph = a % 2.4
    g.kip(kx, 'front', {
      map: (ph > 0.3 && ph < 0.5) || (ph > 0.7 && ph < 0.9) ? { K: 'S' } : null,
    })
    const ex = kx + 13,
      ey = gy - 4
    g.spr(
      'egg',
      ex + (ph > 1.3 && ph < 1.9 && Math.floor(ph / 0.1) % 2 ? 1 : 0),
      ey,
      { map: { E: 'G' } },
    )
    const ring = g.f.memo('egg-ring', () => outline(-1, -1, 4, 5)),
      head = Math.floor(a * 9) % ring.length
    for (let k = 0; k < 3; k++) {
      const [px, py] = ring[(head - k + ring.length) % ring.length]
      g.px(ex + px, ey + py, 'amber', 0.9 - k * 0.3)
    }
  }),
  held: scene(1.0, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round((x0 + x1) / 2 - 8)
    g.kip(kx, 'sit', {
      lift: a % 3.2 > 2.3 ? 1 : 0,
      map: a % 2.9 < 0.14 ? { K: 'W' } : null,
    })
    g.spr('nest', kx + 1, gy - 1)
    const v = 0.35 + 0.35 * (0.5 - 0.5 * Math.cos((a * 2 * Math.PI) / 3.2)),
      py = gy - 10
    g.rect(kx + 15, py, 1, 3, 'soft', v)
    g.rect(kx + 17, py, 1, 3, 'soft', v)
  }),
  stopping: scene(1.6, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      P = 2.8,
      ph = a % P,
      stopX = Math.round((x0 + x1) / 2 - 6),
      startX = x0 - 14
    let x: number,
      pose: Sprite,
      d = -1
    if (ph < 0.7) [x, pose] = [lerp(startX, stopX - 4, ph / 0.7), walk(a, 0.07)]
    else if (ph < 1.1) {
      const q = (ph - 0.7) / 0.4
      ;[x, pose, d] = [stopX - 4 + 4 * (1 - (1 - q) * (1 - q)), 'look', q * 0.4]
    } else [x, pose, d] = [stopX, 'stand', 0.4 + (ph - 1.1)]
    if (d >= 0 && d < 1.6)
      for (let k = 0; k < 3; k++)
        g.px(
          x + 3 - k * 2 - d * 3,
          gy - Math.floor(d * 1.6) - (k % 2),
          'dust',
          clamp(0.85 - d * 0.55),
        )
    g.kip(Math.round(x), pose, { v: ph > P - 0.3 ? clamp((P - ph) / 0.3) : 1 })
  }),
  done: scene(2.4, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round((x0 + x1) / 2 - 9),
      ex = kx + 13
    const hop =
      a < 0.9 ? Math.round(2 * Math.abs(Math.sin((a / 0.45) * Math.PI))) : 0
    g.kip(kx, a < 0.9 && Math.floor(a / 0.13) % 2 === 0 ? 'flap' : 'front', {
      lift: hop,
      map: a > 1.3 ? { K: 'S' } : null,
    })
    if (a > 0.7) {
      const e = a - 0.7
      g.spr(
        'egg',
        ex,
        gy -
          4 -
          (e < 0.35 ? Math.round(3 * Math.sin((Math.PI * e) / 0.35)) : 0),
      )
    }
    const burst = (a - 0.75) / 0.6
    if (burst > 0 && burst < 1)
      for (let r = 0; r < 6; r++) {
        const angle = (r * Math.PI) / 3 + 0.5,
          d = 3 + burst * 4
        g.px(
          ex + 1.5 + Math.cos(angle) * d * 1.3,
          gy - 2 + Math.sin(angle) * d * 0.7,
          'green',
          0.9 * (1 - burst),
        )
      }
    if (a > 1.1) {
      const points = checkPath(ex - 1, gy - 11, 2),
        n = Math.min(points.length, Math.floor((a - 1.1) / 0.05) + 1)
      points.forEach(
        ([x, y], i) => i < n && g.px(x, y, 'green', a > 2.8 ? 0.8 : 0.95),
      )
    }
  }),
  failed: scene(1.6, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      kx = Math.round((x0 + x1) / 2 - 6)
    if (a < 0.45) {
      g.kip(lerp(kx - 8, kx, a / 0.45), walk(a, 0.08))
      return
    }
    const e = a - 0.45
    g.kip(
      kx + (e < 0.35 ? (Math.floor(e / 0.05) % 2 ? 1 : -1) : 0),
      e < 1.5 && Math.floor(e / 0.18) % 2 ? 'walkA' : 'stand',
      { rot: true, map: { K: 'red' } },
    )
    for (let k = 0; k < 3; k++) {
      const fe = e - k * 0.08
      if (fe < 0) continue
      const fy =
        gy -
        6 -
        (fe < 0.35 ? fe / 0.35 : 1) * (4 + k) +
        Math.max(0, fe - 0.35) * 3
      if (fy < gy)
        g.px(kx + 3 + k * 4 + Math.sin(fe * 3 + k) * 1.5, fy, 'feather', 0.85)
    }
    if (e < 0.25)
      for (let j = 0; j < 5; j++) {
        const q = hash(Math.floor(e / 0.05) * 11 + j)
        g.px(kx - 3 + q * 19, gy - 12 + hash(j + q) * 12, 'red', 0.35)
      }
    if (e > 0.5)
      for (let i = 0; i < 3; i++) {
        const angle = e * 4 + i * 2.094
        g.px(
          kx + 6 + Math.cos(angle) * 4,
          gy - 12 + Math.sin(angle) * 1.2,
          'red',
          0.9,
        )
      }
  }),
  recovery: scene(1.5, (g, _t, a) => {
    const { gy, x0, x1 } = g,
      ex = Math.round((x0 + x1) / 2 + 4),
      bx = ex - 17,
      ph = a % 3.2
    let x = bx,
      pose: Sprite = 'stand'
    if (ph < 0.8) pose = 'look'
    else if (ph < 1.2)
      [x, pose] = [bx + Math.round(3 * ease((ph - 0.8) / 0.4)), walk(a, 0.1)]
    else if (ph < 1.6) [x, pose] = [bx + 3, 'peck']
    else if (ph < 2.3) x = bx + 3
    else if (ph < 2.7)
      [x, pose] = [
        bx + 3 - Math.round(3 * ease((ph - 2.3) / 0.4)),
        walk(a, 0.1),
      ]
    g.kip(x, pose)
    g.spr(
      'eggCrack',
      ex + (ph > 1.45 && ph < 2.1 && Math.floor(ph / 0.09) % 2 ? 1 : 0),
      gy - 4,
      { map: { X: 'orange' } },
    )
  }),
  unknown: scene(
    0,
    (g) => {
      const x = restX(g)
      g.kip(x, 'sit', { map: { K: 'S' } })
      g.glyph(questionMark, x + 16, 5, 'soft', 0.8)
    },
    true,
  ),
  offline: scene(
    0,
    (g) => {
      const x = restX(g)
      g.kip(x, 'sit', { map: { K: 'S' } })
      g.grey = false
      g.glyph(noSignal, x + 15, 5, 'soft', 0.55)
      g.glyph(cross, x + 23, 8, 'red', 0.75)
    },
    true,
  ),
}
