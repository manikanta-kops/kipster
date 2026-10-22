import { workLabels, type Workflow } from '../../data/work'
export function WorkSummary({ work }: { work?: Workflow }) {
  // Completed is the usual end state, so only other states earn a label.
  if (!work || (work.state === 'completed' && !work.held)) return null
  return (
    <span className={`work-status work-${work.state}`}>
      <span aria-hidden="true" className="work-dot" />
      {workLabels[work.state] ?? work.state}
      {work.held && work.state !== 'held' ? ' · Follow-ups held' : ''}
    </span>
  )
}
