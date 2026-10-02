/**
 * Inline Markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[label](url)`) to HTML
 * and back. Fields are edited as HTML; documents store Markdown.
 */
const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  )
const safeUrl = (url: string) => /^(https?:|mailto:)/i.test(url.trim())

/** The next unescaped `token` at or after `from`, outside code spans. */
function closing(src: string, token: string, from: number) {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\') {
      i++
      continue
    }
    if (src[i] === '`' && token !== '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) i = end
      continue
    }
    if (token === '*' && src.startsWith('**', i)) {
      i++
      continue
    }
    if (src.startsWith(token, i)) return i
  }
  return -1
}

export function toHtml(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && i + 1 < src.length) {
      out += escapeHtml(src[i + 1])
      i += 2
      continue
    }
    if (c === '\n') {
      out += '<br>'
      i++
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) {
        out += `<code>${escapeHtml(src.slice(i + 1, end))}</code>`
        i = end + 1
        continue
      }
    }
    const pair = src.startsWith('**', i)
      ? '**'
      : src.startsWith('~~', i)
        ? '~~'
        : ''
    if (pair) {
      const end = closing(src, pair, i + 2)
      if (end > i + 2) {
        const tag = pair === '**' ? 'b' : 's'
        out += `<${tag}>${toHtml(src.slice(i + 2, end))}</${tag}>`
        i = end + 2
        continue
      }
    }
    if (c === '*') {
      const end = closing(src, '*', i + 1)
      if (end > i + 1) {
        out += `<i>${toHtml(src.slice(i + 1, end))}</i>`
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const middle = closing(src, '](', i + 1)
      const end = middle > i ? src.indexOf(')', middle + 2) : -1
      if (end > middle) {
        const label = toHtml(src.slice(i + 1, middle))
        const url = src.slice(middle + 2, end)
        out += safeUrl(url)
          ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
          : label
        i = end + 1
        continue
      }
    }
    out += escapeHtml(c)
    i++
  }
  return out
}

const escapeMarkdown = (text: string) =>
  text.replace(/[\\*`[]/g, '\\$&').replace(/~~/g, '\\~\\~')

function wrap(marker: string, inner: string) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!
  return core ? `${lead}${marker}${core}${marker}${trail}` : inner
}

function serialize(node: Node): string {
  let out = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeMarkdown((child.textContent ?? '').replace(/\u00a0/g, ' '))
      continue
    }
    if (!(child instanceof HTMLElement)) continue
    if (child.classList.contains('cm-pin')) continue
    const inner = serialize(child)
    const weight = child.style.fontWeight
    switch (child.tagName) {
      case 'B':
      case 'STRONG':
        out += wrap('**', inner)
        break
      case 'I':
      case 'EM':
        out += wrap('*', inner)
        break
      case 'S':
      case 'DEL':
      case 'STRIKE':
        out += wrap('~~', inner)
        break
      case 'CODE': {
        const text = child.textContent ?? ''
        out += text && !text.includes('`') ? `\`${text}\`` : inner
        break
      }
      case 'A': {
        const href = child.getAttribute('href') ?? ''
        out += safeUrl(href) && inner.trim() ? `[${inner}](${href})` : inner
        break
      }
      case 'BR':
        out += '\n'
        break
      case 'DIV':
      case 'P':
        out += (out && !out.endsWith('\n') ? '\n' : '') + inner
        break
      default:
        out +=
          weight === 'bold' || Number(weight) >= 600 ? wrap('**', inner) : inner
    }
  }
  return out
}

/** Markdown for a field's DOM; comment highlights and markers are not content. */
export function toMarkdown(root: Node, multiline: boolean) {
  const md = serialize(root).replace(/\n+$/, '')
  return multiline ? md : md.replace(/\n/g, ' ')
}

/** The visible text of inline Markdown, which comment offsets count in. */
export function plainText(md: string) {
  const element = document.createElement('div')
  element.innerHTML = toHtml(md)
  return element.textContent ?? ''
}

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.cm-pin')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}

/** Plain-text offset of a DOM position inside `root`. */
export function offsetIn(root: Node, container: Node, offset: number) {
  const range = document.createRange()
  range.setStart(root, 0)
  range.setEnd(container, offset)
  const fragment = range.cloneContents()
  fragment.querySelectorAll('.cm-pin').forEach((pin) => pin.remove())
  return fragment.textContent?.length ?? 0
}

export type FieldMark = {
  id: string
  number: number
  start: number
  end: number
  kind: 'draft' | 'open' | 'resolved'
}

/** Wraps each comment's text in a highlight and adds its numbered marker after it. */
export function applyMarks(root: HTMLElement, marks: FieldMark[]) {
  for (const mark of marks) {
    const segments: HTMLElement[] = []
    let position = 0
    for (const node of textNodes(root)) {
      const length = node.data.length
      const start = Math.max(mark.start, position)
      const end = Math.min(mark.end, position + length)
      if (start < end) {
        let target = node
        if (start > position) target = target.splitText(start - position)
        if (end < position + length) target.splitText(end - start)
        const highlight = document.createElement('mark')
        highlight.className = `cm ${mark.kind}`
        highlight.dataset.comment = mark.id
        target.before(highlight)
        highlight.append(target)
        segments.push(highlight)
      }
      position += length
    }
    const pin = document.createElement('button')
    pin.type = 'button'
    pin.className = `cm-pin ${mark.kind}`
    pin.contentEditable = 'false'
    pin.tabIndex = -1
    pin.dataset.comment = mark.id
    pin.setAttribute('aria-label', `Comment ${mark.number}`)
    pin.textContent = String(mark.number)
    if (segments.length) segments.at(-1)!.after(pin)
    else root.append(pin)
  }
}

/** Where each comment highlight sits now, after the user edited around it. */
export function markAnchors(root: HTMLElement) {
  const anchors: Record<string, { start: number; end: number; quote: string }> =
    {}
  const groups = new Map<string, HTMLElement[]>()
  root.querySelectorAll<HTMLElement>('mark[data-comment]').forEach((mark) => {
    const id = mark.dataset.comment!
    groups.set(id, [...(groups.get(id) ?? []), mark])
  })
  const text = plainOf(root)
  for (const [id, segments] of groups) {
    const start = offsetIn(root, segments[0], 0)
    const last = segments.at(-1)!
    const end = offsetIn(root, last, last.childNodes.length)
    if (end > start) anchors[id] = { start, end, quote: text.slice(start, end) }
  }
  return anchors
}

export const plainOf = (root: HTMLElement) =>
  textNodes(root)
    .map((node) => node.data)
    .join('')

/** Removes everything after the caret and returns it as Markdown. */
export function splitAtCaret(root: HTMLElement, multiline: boolean) {
  const selection = getSelection()
  if (!selection?.rangeCount) return ''
  const range = selection.getRangeAt(0).cloneRange()
  range.setEnd(root, root.childNodes.length)
  const after = range.extractContents()
  return toMarkdown(after, multiline)
}

export function caretAt(root: HTMLElement, where: 'start' | 'end') {
  const selection = getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed) return false
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer)) return false
  const offset = offsetIn(root, range.startContainer, range.startOffset)
  return where === 'start' ? offset === 0 : offset === plainOf(root).length
}

/** Focuses a field with the caret at its start, its end or a plain-text offset. */
export function placeCaret(root: HTMLElement, at: 'start' | 'end' | number) {
  root.focus({ preventScroll: true })
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(at !== 'end')
  if (typeof at === 'number') {
    let position = 0
    for (const node of textNodes(root)) {
      if (position + node.data.length >= at) {
        range.setStart(node, at - position)
        range.collapse(true)
        break
      }
      position += node.data.length
    }
  }
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
