import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from './local-app.mjs'
import { backend } from './local-backend.mjs'

const [command, ...args] = process.argv.slice(2)
const usage = `From the project root:
  npm run app                  Build, update ~/Applications/Kipster.app and open it
  npm run app -- --build-only   Build the app without installing or opening it
  npm run backend              Prepare persistent data and start/restart Core
  npm run backend -- --status  Show backend/database status without starting them
  npm run backend -- --stop    Stop this development backend and its database

Backend data: ~/.kipster/dev.
The app remembers its backend URL independently. No browser server or login service is installed.`
try {
  if (args.includes('--help')) { console.log(usage) }
  else {
    if (process.platform !== 'darwin') throw new Error('These local launch commands currently support macOS.')
    if (process.getuid?.() === 0) throw new Error('Run Kipster as your normal user, not root.')
    if (!['app', 'backend'].includes(command)) throw new Error(usage)
    const allowed = command === 'app' ? ['--build-only'] : ['--stop', '--status']
    if (args.length > 1 || args.some(arg => !allowed.includes(arg))) throw new Error(usage)
    const home = join(homedir(), '.kipster/dev')
    if (command === 'app') await app({ buildOnly: args[0] === '--build-only' })
    else await backend(home, args[0])
  }
} catch (error) {
  console.error(`\nKipster: ${error.message}`)
  process.exitCode = 1
}
