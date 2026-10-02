import { Icon } from '../../components/Icon'
import type { Summary } from '../../data/documents'
import {
  useDocumentList,
  useDocumentsContext,
  useDocumentSummary,
  type DocumentStore,
} from './store'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const needsYou = (doc: Summary) =>
  doc.turn === 'user' && doc.pendingQuestions > 0

/** A doc shared in a message. */
export function DocCard({
  documentId,
  revision,
}: {
  documentId: string
  revision: number
}) {
  const docs = useDocumentsContext()
  if (!docs)
    return (
      <p className="unsupported-part">
        <Icon name="doc" size={14} /> Rich doc
      </p>
    )
  return <Card store={docs.store} documentId={documentId} revision={revision} />
}

function Card({
  store,
  documentId,
  revision,
}: {
  store: DocumentStore
  documentId: string
  revision: number
}) {
  const docs = useDocumentsContext()!
  const doc = useDocumentSummary(store, documentId)
  const author = doc ? docs.author(doc.agentId) : null
  const open = docs.openId === documentId
  const latest = !doc || revision >= doc.currentRevision
  return (
    <button
      type="button"
      className={`doc-card-link mat thin gloss shine ${open ? 'open' : ''}`}
      disabled={!doc}
      aria-label={doc ? `Open rich doc: ${doc.title}` : 'Rich doc unavailable'}
      onClick={() => doc && docs.open(documentId)}
    >
      <span className="doc-thumb" aria-hidden="true">
        <i className="t" />
        <i />
        <i className="s" />
        <i className="o on" />
        <i className="o" />
        <i />
        <i className="s" />
      </span>
      <span className="doc-card-main">
        <span className="doc-kind">
          <Icon name="doc" size={14} />
          Rich doc · Rev {revision}
        </span>
        <b>{doc?.title ?? 'This doc is no longer available'}</b>
        {doc && (
          <span className="doc-card-meta">
            {!latest ? (
              <span className="status-chip">Older revision</span>
            ) : doc.turn === 'agent' ? (
              <span className="status-chip run">
                <i />
                {author!.name} is revising
              </span>
            ) : doc.pendingQuestions > 0 ? (
              <span className="status-chip wait">
                <i />
                {plural(doc.pendingQuestions, 'question')} for you
              </span>
            ) : (
              <span className="status-chip">Your turn</span>
            )}
            {latest && doc.openComments > 0 && (
              <span className="status-chip">
                <Icon name="comment" size={12} />
                {doc.openComments}
              </span>
            )}
          </span>
        )}
      </span>
      {doc && (
        <span className="open-arrow" aria-hidden="true">
          <Icon name="caret" size={15} weight="bold" />
        </span>
      )}
    </button>
  )
}

/** Docs for the open organization and the installation, newest first. */
export function DocsSection({
  organizationId,
}: {
  organizationId: string | null
}) {
  const docs = useDocumentsContext()!
  const list = useDocumentList(docs.store).filter(
    (doc) =>
      doc.context.kind === 'installation' ||
      (doc.context.kind === 'organization' &&
        doc.context.organizationId === organizationId),
  )
  if (!list.length) return null
  return (
    <section className="agent-group docs-group" aria-label="Rich docs">
      <h2 className="group-heading">
        <Icon name="doc" size={13} />
        Rich docs
      </h2>
      {list.map((doc) => {
        const open = docs.openId === doc.id
        return (
          <button
            key={doc.id}
            className={`agent-button doc-row gloss ${open ? 'selected' : ''}`}
            aria-current={open ? 'page' : undefined}
            aria-label={`${doc.title}${needsYou(doc) ? ', needs you' : ''}`}
            onClick={() => docs.open(doc.id)}
          >
            <span className="doc-mini" aria-hidden="true">
              <Icon name="doc" size={17} />
            </span>
            <span className="agent-info sidebar-label">
              <span className="agent-name">{doc.title}</span>
              <span className="agent-line">
                {docs.author(doc.agentId).name} · Rev {doc.currentRevision}
              </span>
            </span>
            {needsYou(doc) && <i className="needs" aria-hidden="true" />}
          </button>
        )
      })}
    </section>
  )
}
