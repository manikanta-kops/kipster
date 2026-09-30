import { Postgres } from '../../dist/platform/postgres/public.js'
import { Home } from '../../dist/platform/home/public.js'
import { createAgent, createOrganization } from '../../dist/modules/administration/public.js'

// Starts an administration creation and dies with SIGKILL just before (`before-seed`) or just after
// (`after-seed`) the new home is seeded, after the rows and the operation are committed.
// Usage: admin-crash.mjs <database-url> <home> <installation-id> <owner-id> <organization|agent> <operation-id> <before-seed|after-seed> [organization-id]
const [url, root, installationId, personId, kind, operationId, moment, organizationId] = process.argv.slice(2)
const die = () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}) }

class CrashingHome extends Home {
  async provisionAgent(id) {
    if (moment === 'after-seed') await super.provisionAgent(id)
    await die()
  }
  async provisionOrganization(id) {
    if (moment === 'after-seed') await super.provisionOrganization(id)
    await die()
  }
}
const db = new Postgres(url)
const home = new CrashingHome(root)
const actor = { installationId, personId }
if (kind === 'organization') await createOrganization(db, home, actor, operationId, { name: 'Northwind' })
else await createAgent(db, home, actor, operationId, { name: 'Scout', ...(organizationId ? { organizationId } : {}) })
throw new Error('Expected process death around home seeding')
