import { openRuntime } from '../../dist/runtime.js'
import { answerInteraction } from '../../dist/modules/work/public.js'
import { applyAdminApproval } from '../../dist/workflows/admin-approvals.js'
const [url, home, requestJSON, boundary] = process.argv.slice(2)
const runtime = await openRuntime({ connectionString: url, home, names: { owner: 'Owner', organization: 'Org', rootAgent: 'Root' } })
const actor = { installationId: runtime.bootstrap.installationId, personId: runtime.bootstrap.ownerId }
if (boundary === 'before') process.kill(process.pid, 'SIGKILL')
const result = await answerInteraction(runtime.db, runtime.jobs, actor, JSON.parse(requestJSON), (client, card) => applyAdminApproval(client, runtime.jobs, actor, card))
if (boundary === 'after') process.kill(process.pid, 'SIGKILL')
if (result.outcome !== 'accepted') throw new Error('Expected accepted receipt')
await runtime.close()
