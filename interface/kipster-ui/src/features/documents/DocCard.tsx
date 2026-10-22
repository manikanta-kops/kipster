import { Icon } from '../../components/Icon'
import {
  useDocumentsContext,
  useDocumentSummary,
  type DocumentStore,
} from './store'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
