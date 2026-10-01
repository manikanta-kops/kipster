import { PlugsConnectedIcon } from '@phosphor-icons/react/dist/csr/PlugsConnected'
import { BellIcon } from '@phosphor-icons/react/dist/csr/Bell'
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix'
import { MicrophoneIcon } from '@phosphor-icons/react/dist/csr/Microphone'
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple'
import type { IconProps } from '@phosphor-icons/react'
import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain'
import { IdentificationCardIcon } from '@phosphor-icons/react/dist/csr/IdentificationCard'
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple'
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus'
import { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp'
import { SunIcon } from '@phosphor-icons/react/dist/csr/Sun'
import { MoonIcon } from '@phosphor-icons/react/dist/csr/Moon'
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple'
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
import { XIcon } from '@phosphor-icons/react/dist/csr/X'
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple'
import { ArrowsInSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsInSimple'
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle'
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check'
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText'
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle'
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { BuildingsIcon } from '@phosphor-icons/react/dist/csr/Buildings'
import { HandIcon } from '@phosphor-icons/react/dist/csr/Hand'
import { InfoIcon } from '@phosphor-icons/react/dist/csr/Info'

const icons = {
  bell: BellIcon,
  settings: GearSixIcon,
  connection: PlugsConnectedIcon,
  microphone: MicrophoneIcon,
  download: DownloadSimpleIcon,
  brain: BrainIcon,
  identity: IdentificationCardIcon,
  panel: SidebarSimpleIcon,
  plus: PlusIcon,
  arrow: ArrowUpIcon,
  sun: SunIcon,
  moon: MoonIcon,
  folder: FolderSimpleIcon,
  chevron: CaretDownIcon,
  close: XIcon,
  expand: ArrowsOutSimpleIcon,
  shrink: ArrowsInSimpleIcon,
  chat: ChatCircleIcon,
  check: CheckIcon,
  file: FileTextIcon,
  spark: SparkleIcon,
  organization: BuildingsIcon,
  refresh: ArrowClockwiseIcon,
  hand: HandIcon,
  info: InfoIcon,
} as const

// Pixel Kip: R comb and wattle, O beak, W body in the current color. Eyes are holes.
const kipRows = [
  '..R.R..',
  '.RRRRR.',
  '.WWWWW.',
  'WW.W.WW',
  'WWWOWWW',
  'WWWRWWW',
  '.WWWWW.',
]
const kipFill = { R: '#ff453a', O: '#ff9f0a', W: 'currentColor' } as const

function KipGlyph({
  size = 20,
  className,
}: {
  size?: IconProps['size']
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="-0.5 -0.5 8 8"
      shapeRendering="crispEdges"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {kipRows.flatMap((row, y) =>
        [...row].map((cell, x) =>
          cell === '.' ? null : (
            <rect
              key={`${x}:${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={kipFill[cell as keyof typeof kipFill]}
            />
          ),
        ),
      )}
    </svg>
  )
}

/** Direct imports keep unused icons out of the development module graph too. */
export function Icon({
  name,
  weight = 'regular',
  ...props
}: Omit<IconProps, 'name'> & { name: keyof typeof icons | 'kip' }) {
  if (name === 'kip')
    return <KipGlyph size={props.size} className={props.className} />
  const Glyph = icons[name]
  return (
    <Glyph
      size={20}
      weight={weight}
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  )
}
