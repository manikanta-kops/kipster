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
import { QuestionMarkIcon } from '@phosphor-icons/react/dist/csr/QuestionMark'
import { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical'
import { ChatTeardropTextIcon } from '@phosphor-icons/react/dist/csr/ChatTeardropText'
import { ListChecksIcon } from '@phosphor-icons/react/dist/csr/ListChecks'
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image'
import { TableIcon } from '@phosphor-icons/react/dist/csr/Table'
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code'
import { TextTIcon } from '@phosphor-icons/react/dist/csr/TextT'
import { TextHTwoIcon } from '@phosphor-icons/react/dist/csr/TextHTwo'
import { TextHThreeIcon } from '@phosphor-icons/react/dist/csr/TextHThree'
import { ListBulletsIcon } from '@phosphor-icons/react/dist/csr/ListBullets'
import { ListNumbersIcon } from '@phosphor-icons/react/dist/csr/ListNumbers'
import { QuotesIcon } from '@phosphor-icons/react/dist/csr/Quotes'
import { MinusIcon } from '@phosphor-icons/react/dist/csr/Minus'
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise'
import { EyeIcon } from '@phosphor-icons/react/dist/csr/Eye'
import { TrashIcon } from '@phosphor-icons/react/dist/csr/Trash'
import { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown'
import { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy'
import { LinkIcon } from '@phosphor-icons/react/dist/csr/Link'
import { TextBIcon } from '@phosphor-icons/react/dist/csr/TextB'
import { TextItalicIcon } from '@phosphor-icons/react/dist/csr/TextItalic'
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning'
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip'
import { ArticleIcon } from '@phosphor-icons/react/dist/csr/Article'
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple'
import { LightbulbIcon } from '@phosphor-icons/react/dist/csr/Lightbulb'
import { StopIcon } from '@phosphor-icons/react/dist/csr/Stop'
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play'

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
  question: QuestionMarkIcon,
  drag: DotsSixVerticalIcon,
  comment: ChatTeardropTextIcon,
  checklist: ListChecksIcon,
  slider: SlidersHorizontalIcon,
  image: ImageIcon,
  table: TableIcon,
  code: CodeIcon,
  text: TextTIcon,
  heading: TextHTwoIcon,
  subheading: TextHThreeIcon,
  list: ListBulletsIcon,
  numbered: ListNumbersIcon,
  quote: QuotesIcon,
  divider: MinusIcon,
  caret: CaretRightIcon,
  undo: ArrowCounterClockwiseIcon,
  history: ClockCounterClockwiseIcon,
  eye: EyeIcon,
  trash: TrashIcon,
  down: ArrowDownIcon,
  copy: CopyIcon,
  link: LinkIcon,
  bold: TextBIcon,
  italic: TextItalicIcon,
  warning: WarningIcon,
  success: CheckCircleIcon,
  attach: PaperclipIcon,
  doc: ArticleIcon,
  pencil: PencilSimpleIcon,
  lightbulb: LightbulbIcon,
  stop: StopIcon,
  play: PlayIcon,
} as const

/** Direct imports keep unused icons out of the development module graph too. */
export function Icon({
  name,
  weight = 'regular',
  ...props
}: Omit<IconProps, 'name'> & { name: keyof typeof icons }) {
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
