import { useEffect } from 'react'

/**
 * Sets `--mx`/`--my` on the `.gloss` element under the pointer so its edge
 * highlight follows the cursor. One listener serves the whole document.
 */
export function usePointerGloss() {
  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return
    let frame = 0
    let last: PointerEvent | null = null
    const paint = () => {
      frame = 0
      const target = last?.target
      if (!(target instanceof Element)) return
      const surface = target.closest<HTMLElement>('.gloss')
      if (!surface || !last) return
      const box = surface.getBoundingClientRect()
      surface.style.setProperty('--mx', `${last.clientX - box.left}px`)
      surface.style.setProperty('--my', `${last.clientY - box.top}px`)
    }
    const onMove = (event: PointerEvent) => {
      last = event
      if (!frame) frame = requestAnimationFrame(paint)
    }
    document.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
    }
  }, [])
}
