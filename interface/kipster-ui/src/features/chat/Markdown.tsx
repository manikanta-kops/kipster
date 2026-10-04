import { Fragment, type ReactNode } from 'react'

// Deliberately small, non-HTML Markdown renderer. React escapes every text node.
// Unknown syntax remains readable text; links admit only ordinary web/mail URLs.
function inline(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  return text.split(pattern).map((part, index) => {
    if (/^`[^`]+`$/.test(part))
      return <code key={index}>{part.slice(1, -1)}</code>
    if (/^\*\*[^*]+\*\*$/.test(part))
      return <strong key={index}>{part.slice(2, -2)}</strong>
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link) {
      const safe =
        /^(https?:\/\/|mailto:)/i.test(link[2]) &&
        !Array.from(link[2]).some((char) => char.charCodeAt(0) <= 32)
      return safe ? (
        <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      ) : (
        <Fragment key={index}>
          {link[1]} ({link[2]})
        </Fragment>
      )
    }
    return <Fragment key={index}>{part}</Fragment>
  })
}
export function Markdown({
  text,
  streaming = false,
  headings = false,
  className = 'message-text',
}: {
  text: string
  streaming?: boolean
  /** Documents such as identity files use `#` headings; chat messages keep them as text. */
  headings?: boolean
  className?: string
}) {
  const heading = (line: string) => headings && /^#{1,6}\s/.test(line)
  const blocks: ReactNode[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (heading(line)) {
      const level = Math.min(line.indexOf(' '), 3)
      const content = inline(line.replace(/^#+\s+/, ''))
      blocks.push(
        level === 1 ? (
          <h1 key={i}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={i}>{content}</h2>
        ) : (
          <h3 key={i}>{content}</h3>
        ),
      )
    } else if (line.startsWith('```')) {
      if (!lines.slice(i + 1).some((next) => /^```\s*$/.test(next))) {
        blocks.push(<p key={i}>{lines.slice(i).join('\n')}</p>)
        break
      }
      const code: string[] = []
      while (++i < lines.length && !lines[i].startsWith('```'))
        code.push(lines[i])
      blocks.push(
        <pre key={i}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
    } else if (/^>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quoted.push(lines[i++].replace(/^>\s?/, ''))
      i--
      blocks.push(
        <blockquote key={i}>
          <p>{inline(quoted.join('\n'))}</p>
        </blockquote>,
      )
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: ReactNode[] = []
      while (
        i < lines.length &&
        (ordered ? /^\s*\d+\.\s/ : /^\s*[-*]\s/).test(lines[i])
      ) {
        items.push(
          <li key={i}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>,
        )
        i++
      }
      i--
      blocks.push(ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>)
    } else if (line.trim()) {
      const paragraph = [line]
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        !heading(lines[i + 1]) &&
        !/^(```|>|\s*([-*]|\d+\.)\s)/.test(lines[i + 1])
      )
        paragraph.push(lines[++i])
      blocks.push(<p key={i}>{inline(paragraph.join('\n'))}</p>)
    }
  }
  return (
    <div className={`${className} markdown${streaming ? ' streaming' : ''}`}>
      {blocks}
    </div>
  )
}
