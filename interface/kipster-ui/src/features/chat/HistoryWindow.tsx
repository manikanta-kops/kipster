import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { contentScrollEnd } from './use-scroll-history'
const pageSize = 100
/** Bound rich message DOM while keeping older content reachable and selectable. */
export function HistoryWindow<T>({
  items,
  render,
  controls,
}: {
  items: T[]
  render: (item: T) => ReactNode
  controls?: Ref<{ latest: () => void }>
}) {
  const [page, setPage] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const latest = Math.max(0, items.length - pageSize)
  const first = page === null ? latest : Math.min(page, latest)
  const last = Math.min(items.length, first + pageSize)
  const windowState = useRef({ page, first })
  useLayoutEffect(() => {
    windowState.current = { page, first }
  }, [page, first])
  useLayoutEffect(() => {
    const scroll = root.current?.closest('.thread-scroll')
    if (!scroll) return
    const observe = () => {
      const nearBottom =
        Math.abs(
          scroll.scrollTop - contentScrollEnd(scroll, root.current ?? scroll),
        ) < 80
      following.current = nearBottom
      if (!nearBottom && windowState.current.page === null)
        setPage(windowState.current.first)
    }
    const selectionChanged = () => {
      const selected = window.getSelection()
      if (
        selected &&
        !selected.isCollapsed &&
        root.current?.contains(selected.anchorNode)
      ) {
        following.current = false
        setPage(windowState.current.first)
      }
    }
    scroll.addEventListener('scroll', observe, { passive: true })
    document.addEventListener('selectionchange', selectionChanged)
    return () => {
      scroll.removeEventListener('scroll', observe)
      document.removeEventListener('selectionchange', selectionChanged)
    }
  }, [])
  useLayoutEffect(() => {
    const scroll = root.current?.closest('.thread-scroll')
    if (scroll && following.current && page === null)
      scroll.scrollTop = contentScrollEnd(scroll, root.current ?? scroll)
  }, [items, page])
  const choose = (next: number | null) => {
    following.current = next === null
    setPage(next)
    requestAnimationFrame(() => {
      if (next === null) {
        const scroll = root.current?.closest('.thread-scroll')
        if (scroll)
          scroll.scrollTop = contentScrollEnd(scroll, root.current ?? scroll)
      } else root.current?.scrollIntoView({ block: 'start' })
    })
  }
  useImperativeHandle(controls, () => ({ latest: () => choose(null) }))
  return (
    <div ref={root} className="history-window" data-latest={first === latest}>
      {items.length > pageSize && (
        <nav className="history-pages" aria-label="History pages">
          <button
            disabled={first === 0}
            onClick={() => choose(Math.max(0, first - pageSize))}
          >
            Older messages
          </button>
          <output>
            Messages {first + 1}–{last} of {items.length}
          </output>
          <button
            disabled={page === null || first === latest}
            onClick={() =>
              choose(first + pageSize >= latest ? null : first + pageSize)
            }
          >
            Newer messages
          </button>
          {page !== null && first < latest && (
            <button onClick={() => choose(null)}>Latest messages</button>
          )}
        </nav>
      )}
      {items.slice(first, last).map(render)}
    </div>
  )
}
