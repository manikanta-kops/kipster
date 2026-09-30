import { Postgres } from '../../dist/platform/postgres/public.js'
import { Home } from '../../dist/platform/home/public.js'
import { bootstrap } from '../../dist/modules/administration/public.js'

class CrashAfterSeed extends Home {
  async seed(path, content) {
    await super.seed(path, content)
    if (path.endsWith('/system/instructions.md')) process.kill(process.pid, 'SIGKILL')
  }
}
const db = new Postgres(process.argv[2])
await bootstrap(db, new CrashAfterSeed(process.argv[3]), { owner: 'Owner', organization: 'One', rootAgent: 'Root' })
throw new Error('Expected process death after system seed publication')
