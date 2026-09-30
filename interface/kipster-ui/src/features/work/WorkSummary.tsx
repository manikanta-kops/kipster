import { workLabels, type Workflow } from '../../data/work'
export function WorkSummary({ work }: { work?: Workflow }) {
  if (!work) return null
  return (
    <span className={`work-status work-${work.state}`}>
      <span aria-hidden="true" className="work-dot" />
      {workLabels[work.state] ?? work.state}
      {work.held && work.state !== 'held' ? ' · Follow-ups held' : ''}
    </span>
  )
}
