import { lazy, Suspense, useRef, useState } from 'react'
import { useManagement } from '../../data/use-management'
import type { WorkspaceSnapshot } from '../../data/directory'
import type { Agent } from '../chat/model'

const ManagementDialog = lazy(() =>
  import('./ManagementDialog').then((m) => ({ default: m.ManagementDialog })),
)

export function Management({
  data,
  organizationId,
  agents,
}: {
  data: WorkspaceSnapshot
  organizationId: string | null
  agents: Agent[]
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const management = useManagement(data)
  const [target, setTarget] = useState<{
    organizationId: string | null
  } | null>(null)
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="set-row set-action"
        onClick={() => setTarget({ organizationId })}
      >
        Manage kips and groups…
        {management.pending && (
          <span className="recovery-dot" aria-label="Request needs attention" />
        )}
      </button>
      {target && (
        <Suspense>
          <ManagementDialog
            data={data}
            organizationId={target.organizationId}
            agents={agents}
            management={management}
            onClose={() => {
              setTarget(null)
              requestAnimationFrame(() => trigger.current?.focus())
            }}
          />
        </Suspense>
      )}
    </>
  )
}
