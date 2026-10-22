import type { Documents } from '../documents/store'
import { useDocumentList } from '../documents/store'
import { Block, Callout, Row, StatusDot } from './ui'

/** Docs for the open organization and the installation; a row opens the doc and closes Settings. */
export function DocsPage({
  docs,
  organizationId,
  close,
}: {
  docs: Documents
  organizationId: string | null
  close: () => void
}) {
  const list = useDocumentList(docs.store).filter(
    (doc) =>
      doc.context.kind === 'installation' ||
      (doc.context.kind === 'organization' &&
        doc.context.organizationId === organizationId),
  )
  if (!list.length)
    return <Callout>No rich docs yet. Kips share them in their chats.</Callout>
  return (
    <Block foot="Docs your kips wrote for this organization and the admin kip’s docs.">
      {list.map((doc) => {
        const needsYou = doc.turn === 'user' && doc.pendingQuestions > 0
        return (
          <Row
            key={doc.id}
            label={doc.title}
            sub={`${docs.author(doc.agentId).name} · Rev ${doc.currentRevision}`}
            control={
              needsYou ? (
                <span className="set-summary">
                  <StatusDot tone="wait" />
                  Needs you
                </span>
              ) : undefined
            }
            chevron
            onClick={() => {
              close()
              docs.open(doc.id)
            }}
          />
        )
      })}
    </Block>
  )
}
