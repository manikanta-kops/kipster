import { createContext, useContext } from 'react'

/** A page inside a settings page, pushed by a row with a chevron. */
export type Frame = { title: string } & (
  | { kind: 'kip'; agentId: string }
  | { kind: 'file'; agentId: string; file: string }
  | { kind: 'backups'; agentId: string; file: string }
  | { kind: 'backup'; agentId: string; file: string; backupId: string }
  | { kind: 'adapter'; adapterId: string }
  | { kind: 'instructions'; organizationId: string }
  | { kind: 'testing' }
)

type Sheet = {
  push: (frame: Frame) => void
  /** Goes back one page, or more after finishing a nested task. */
  pop: (count?: number) => void
  toast: (text: string) => void
  /** Where bar tools and in-sheet dialogs render. */
  tools: HTMLElement | null
  overlay: HTMLElement | null
  /** Markdown files show as a preview or as their source. */
  source: boolean
  setSource: (source: boolean) => void
}
export const SheetContext = createContext<Sheet>({
  push: () => {},
  pop: () => {},
  toast: () => {},
  tools: null,
  overlay: null,
  source: false,
  setSource: () => {},
})
export const useSheet = () => useContext(SheetContext)
