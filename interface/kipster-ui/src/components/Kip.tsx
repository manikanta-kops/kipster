import { kipHead, kipStanding } from './kip-sprite'

// Kip in LED dots.
const ink = {
  W: '#f3f4f6',
  S: 'rgba(243, 244, 246, 0.55)',
  R: '#ff453a',
  Y: '#ff9f0a',
} as const

function Dots({
  rows,
  cell,
  radius,
  x0,
  y0,
  className,
}: {
  rows: string[]
  cell: number
  radius: number
  x0: number
  y0: number
  className: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
    >
      {rows.flatMap((row, y) =>
        [...row].map((key, x) =>
          key in ink ? (
            <circle
              key={`${x}:${y}`}
              cx={x0 + x * cell + cell / 2}
              cy={y0 + y * cell + cell / 2}
              r={radius}
              fill={ink[key as keyof typeof ink]}
            />
          ) : null,
        ),
      )}
    </svg>
  )
}

/** Kip's head in LED dots, for avatars and marks. The container supplies the black tile. */
export function KipHead() {
  return (
    <Dots
      rows={kipHead}
      cell={11.5}
      radius={4.6}
      x0={9.75}
      y0={9.75}
      className="kip-dots"
    />
  )
}

/** The whole Kip, for places with room to show it. */
export function KipBody() {
  return (
    <Dots
      rows={kipStanding}
      cell={6.4}
      radius={2.6}
      x0={8.4}
      y0={15}
      className="kip-dots"
    />
  )
}
