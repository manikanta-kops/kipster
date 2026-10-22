import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm, remarkBreaks]
const safe = (href: string | undefined) =>
  !!href &&
  /^(https?:\/\/|mailto:)/i.test(href) &&
  !Array.from(href).some((char) => char.charCodeAt(0) <= 32)

function Link({ href, children }: { href?: string; children: ReactNode }) {
  if (safe(href))
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  // Footnote and other in-page references keep only their text.
  if (!href || href.startsWith('#')) return <>{children}</>
  return (
    <>
      {children} ({href})
    </>
  )
}

// Raw HTML stays literal text. Links admit only ordinary web and mail URLs, and
// images show as links so a message never loads remote content by itself.
const components: Components = {
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => (
    <Link href={typeof src === 'string' ? src : undefined}>
      {alt || 'Image'}
    </Link>
  ),
  table: ({ children }) => (
    <div className="markdown-table">
      <table>{children}</table>
    </div>
  ),
}

export function Markdown({
  text,
  streaming = false,
  className = 'message-text',
}: {
  text: string
  streaming?: boolean
  className?: string
}) {
  return (
    <div className={`${className} markdown${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        components={components}
        urlTransform={(url) => url}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
