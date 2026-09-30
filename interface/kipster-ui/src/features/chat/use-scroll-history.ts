import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
export function contentScrollEnd(element: Element, content: Element = element) {
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
  if (content === element) return maximum
  return Math.min(
    maximum,
    Math.max(
      0,
      element.scrollTop +
        content.getBoundingClientRect().bottom -
        element.getBoundingClientRect().bottom,
    ),
  )
}
function endContent(element: Element, endSelector?: string) {
  return endSelector ? element.querySelector(endSelector) : element
}
function nearEnd(element: Element, endSelector?: string) {
  const content = endContent(element, endSelector)
  return (
    !!content &&
    Math.abs(element.scrollTop - contentScrollEnd(element, content)) < 90
  )
}
export function useScrollHistory(
  ref: RefObject<HTMLDivElement | null>,
  identity: string,
  revision: string,
  ready: boolean,
  manageScroll = true,
  endSelector?: string,
) {
  const near = useRef(false)
  const prior = useRef({ identity, height: 0, revision, ready: false })
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const [unread, setUnread] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const onScroll = () => {
      near.current = nearEnd(element, endSelector)
      if (near.current) setUnread(false)
    }
    element.addEventListener('scroll', onScroll)
    return () => element.removeEventListener('scroll', onScroll)
  }, [ref, identity, endSelector])
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    if (prior.current.identity !== identity) {
      if (manageScroll) element.scrollTop = 0
      near.current = manageScroll ? false : nearEnd(element, endSelector)
      setUnread(false)
      anchor.current = null
    } else if (anchor.current) {
      element.scrollTop =
        anchor.current.top + (element.scrollHeight - anchor.current.height)
      anchor.current = null
    } else if (
      prior.current.ready &&
      ready &&
      prior.current.revision !== revision &&
      prior.current.height &&
      (!manageScroll || element.scrollHeight !== prior.current.height)
    ) {
      if (near.current) {
        if (manageScroll) element.scrollTop = element.scrollHeight
      } else setUnread(true)
    }
    prior.current = { identity, height: element.scrollHeight, revision, ready }
  }, [identity, revision, ref, ready, manageScroll, endSelector])
  return {
    unread,
    older: () => {
      const el = ref.current
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop }
    },
    cancelAnchor: () => {
      anchor.current = null
    },
    latest: () => {
      const el = ref.current
      const content = el && endContent(el, endSelector)
      if (el && content) el.scrollTop = contentScrollEnd(el, content)
      near.current = true
      setUnread(false)
    },
  }
}
