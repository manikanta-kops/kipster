import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dependencies, exists, locked, repository, run } from './local-common.mjs'

export function appEnvironment(source = process.env) {
  const env = { ...source }
  delete env.TAURI_CONFIG
  delete env.CARGO_TARGET_DIR
  return env
}
async function appID(path) {
  const result = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(path, 'Contents/Info.plist')], { capture: true })
  return result.output
}
async function quitApp() {
  const running = () => run('/usr/bin/lsappinfo', ['find', 'bundleID=app.kipster.desktop'], { capture: true })
  if (!(await running()).output) return
  await run('/usr/bin/osascript', ['-e', 'if application id "app.kipster.desktop" is running then tell application id "app.kipster.desktop" to quit'], { capture: true })
  for (let i = 0; i < 50; i++) {
    if (!(await running()).output) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Kipster is still running. Quit it normally, then rerun npm run app.')
}
export async function app({ buildOnly = false } = {}) {
  const ui = join(repository, 'interface/kipster-ui')
  return locked(join(ui, 'src-tauri/target/.app-command-lock'), async () => {
    try {
      await run('cargo', ['--version'], { capture: true })
      await run('/usr/bin/xcode-select', ['-p'], { capture: true })
    } catch { throw new Error('Install Rust (cargo) and Xcode Command Line Tools, then rerun npm run app.') }
    await dependencies()
    console.log('Building the Kipster desktop app…')
    await run('npm', ['run', 'tauri', '--', 'build', '--debug', '--bundles', 'app', '--config', JSON.stringify({ build: { devUrl: null } })], { cwd: ui, env: appEnvironment() })
    const built = join(ui, 'src-tauri/target/debug/bundle/macos/Kipster.app')
    if (await appID(built) !== 'app.kipster.desktop') throw new Error('Built app identity does not match Kipster.')
    if (buildOnly) { console.log(`Built: ${built}`); return }
    const applications = join(homedir(), 'Applications')
    await mkdir(applications, { recursive: true })
    const destination = join(applications, 'Kipster.app')
    if (await exists(destination) && await appID(destination) !== 'app.kipster.desktop') throw new Error(`Another app occupies ${destination}. It was not replaced.`)
    const staged = join(applications, `.Kipster-${randomUUID()}.app`)
    const previous = join(applications, `.Kipster-previous-${randomUUID()}.app`)
    await run('/usr/bin/ditto', [built, staged])
    let moved = false
    try {
      await quitApp()
      if (await exists(destination)) { await rename(destination, previous); moved = true }
      try { await rename(staged, destination) }
      catch (error) { if (moved) await rename(previous, destination); throw error }
      if (moved) await rm(previous, { recursive: true })
    } finally { await rm(staged, { recursive: true, force: true }) }
    // Remove only known generated app bundles. Keep the demo and all app user data.
    for (const [path, id] of [
      [built, 'app.kipster.desktop'],
      [join(ui, 'src-tauri/target/release/bundle/macos/Kipster.app'), 'app.kipster.desktop'],
      [join(ui, 'src-tauri/target/debug/bundle/macos/Kipster Connection Probe.app'), 'app.kipster.connection-probe'],
    ]) {
      if (await exists(path) && await appID(path) === id) await rm(path, { recursive: true })
    }
    await run('/usr/bin/open', [destination])
    console.log(`Opened ${destination}\nYou can close this terminal. The app saves its backend URL and can be reopened from Applications.`)
  })
}
