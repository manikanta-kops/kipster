import { useEffect, useEffectEvent, useState, type RefObject } from 'react'

interface Collected {
  files: File[]
  folders: number
}

const carriesFiles = (event: DragEvent) =>
  !!event.dataTransfer?.types.includes('Files')

function dropped(data: DataTransfer): Collected {
  const items = Array.from(data.items).filter((item) => item.kind === 'file')
  const folders = items.filter(
    (item) => item.webkitGetAsEntry?.()?.isDirectory,
  ).length
  if (!folders) return { files: Array.from(data.files), folders }
  const files = items.flatMap((item) => {
    if (item.webkitGetAsEntry?.()?.isDirectory) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
  return { files, folders }
}

// Copies from documents and spreadsheets carry their text plus an image of it; the text wins.
function pasted(data: DataTransfer): File[] {
  if (data.getData('text/plain')) return []
  return Array.from(data.files)
}

/**
 * Makes the nearest `[data-file-drop]` ancestor of `anchor` accept dropped
 * and pasted files while `enabled`.
 */
export function useFileDrop(
  anchor: RefObject<HTMLElement | null>,
  enabled: boolean,
  receive: (collected: Collected) => void,
) {
  const [zone, setZone] = useState<HTMLElement | null>(null)
  const [over, setOver] = useState(false)
  const deliver = useEffectEvent(receive)
  useEffect(() => {
    const target =
      anchor.current?.closest<HTMLElement>('[data-file-drop]') ?? anchor.current
    if (!enabled || !target) return
    // The zone is a DOM ancestor that exists only after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setZone(target)
    let depth = 0
    const reset = () => {
      depth = 0
      setOver(false)
    }
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth++
      setOver(true)
    }
    const hover = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setOver(false)
    }
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      reset()
      const collected = dropped(event.dataTransfer!)
      if (collected.files.length || collected.folders) deliver(collected)
    }
    const paste = (event: ClipboardEvent) => {
      const files = event.clipboardData ? pasted(event.clipboardData) : []
      if (!files.length) return
      event.preventDefault()
      deliver({ files, folders: 0 })
    }
    target.addEventListener('dragenter', enter)
    target.addEventListener('dragover', hover)
    target.addEventListener('dragleave', leave)
    target.addEventListener('drop', drop)
    target.addEventListener('paste', paste)
    window.addEventListener('drop', reset)
    return () => {
      target.removeEventListener('dragenter', enter)
      target.removeEventListener('dragover', hover)
      target.removeEventListener('dragleave', leave)
      target.removeEventListener('drop', drop)
      target.removeEventListener('paste', paste)
      window.removeEventListener('drop', reset)
      reset()
    }
  }, [anchor, enabled])
  return { zone: enabled ? zone : null, over: enabled && over }
}

/** Files dropped outside a drop zone would otherwise replace the app with the file. */
export function guardFileDrops() {
  const refuse = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'none'
  }
  window.addEventListener('dragover', refuse)
  window.addEventListener('drop', refuse)
}
