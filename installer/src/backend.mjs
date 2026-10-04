// The Kipster backend app and the runtime it starts.
//
// launchd runs <home>/backend/Kipster.app for Core and the updater, so macOS
// privacy attributes their work to Kipster (bundle ID app.kipster.backend).
// The Node it starts is recorded outside the signed bundle in runtime.json.
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, cp, lstat, readdir, readFile, readlink, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { atomic, exists, json, privateDirectory, save, syncDirectory } from './files.mjs'
import { run } from './process.mjs'

export const bundleIdentifier = 'app.kipster.backend'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

export const installedApp = home => join(home, 'backend/Kipster.app')
export const launcher = home => join(installedApp(home), 'Contents/MacOS/Kipster')
export const packagedApp = (root = packageRoot) => join(root, 'launchers/macos/Kipster.app')

/** Checks the seal and identity of a backend app; returns its signing team (null when ad hoc). */
export async function verifyApp(app, { requireTeam = false } = {}) {
  let details
  try {
    await promisify(execFile)('/usr/bin/codesign', ['--verify', '--strict', app], { timeout: 60000 })
    details = (await promisify(execFile)('/usr/bin/codesign', ['-d', '--verbose=2', app], { timeout: 30000 })).stderr
  } catch { throw new Error(`${app} is not a validly signed Kipster app. Reinstall @kipster/installer.`) }
  const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(details)?.[1]?.trim()
  if (field('Identifier') !== bundleIdentifier) throw new Error(`${app} is not signed as ${bundleIdentifier}.`)
  const team = field('TeamIdentifier')
  if (requireTeam && (!team || team === 'not set')) throw new Error(`${app} has no stable signing identity, so macOS could not keep its privacy access. Install a released @kipster/installer.`)
  return team && team !== 'not set' ? team : null
}

/** A digest of every path, mode and byte in the app, to detect a changed bundle. */
export async function treeDigest(root) {
  const hash = createHash('sha256')
  async function walk(path) {
    const info = await lstat(path), name = relative(root, path)
    if (info.isDirectory()) {
      hash.update(`d ${name}\n`)
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry))
    } else if (info.isSymbolicLink()) hash.update(`l ${name} ${await readlink(path)}\n`)
    else { hash.update(`f ${name} ${info.mode & 0o111 ? 'x' : '-'}\n`); hash.update(await readFile(path)) }
  }
  await walk(root)
  return hash.digest('hex')
}

/**
 * Installs the app at its fixed path when it differs from the installed one.
 * The replaced app is kept at the returned `previous` path until the caller
 * removes it or puts it back with restoreApp; `onPrevious` records that path
 * before anything moves.
 */
export async function installApp(home, source, { requireTeam = false, runCommand = run, onPrevious } = {}) {
  const target = installedApp(home)
  if (await exists(target) && await treeDigest(target) === await treeDigest(source)) return { changed: false, previous: null }
  await privateDirectory(dirname(target))
  const staging = join(dirname(target), '.staging-' + randomUUID())
  try {
    // ditto keeps the bundle exactly as signed; verify the copy, not the source.
    if (process.platform === 'darwin') await runCommand('/usr/bin/ditto', [source, join(staging, 'Kipster.app')], { timeout: 60000, label: 'Copy Kipster app' })
    else await cp(source, join(staging, 'Kipster.app'), { recursive: true, verbatimSymlinks: true })
    if (process.platform === 'darwin') await verifyApp(join(staging, 'Kipster.app'), { requireTeam })
    let previous = null
    if (await exists(target)) {
      previous = join(dirname(target), '.previous-' + randomUUID())
      await onPrevious?.(previous)
      await rename(target, previous)
    }
    await rename(join(staging, 'Kipster.app'), target)
    await syncDirectory(dirname(target))
    // Let Launch Services name the jobs' AssociatedBundleIdentifiers as Kipster.
    if (process.platform === 'darwin') await runCommand(lsregister, ['-f', target], { timeout: 30000 }).catch(() => {})
    return { changed: true, previous }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** Puts back an app kept by installApp, including after an interrupted swap. */
export async function restoreApp(home, previous) {
  if (!previous || !await exists(previous)) return
  const target = installedApp(home)
  await rm(target, { recursive: true, force: true })
  await rename(previous, target)
  await syncDirectory(dirname(target))
}

export const runtimeFile = home => join(home, 'runtime.json')
export async function readRuntime(home) {
  const value = await json(runtimeFile(home))
  if (value?.version !== 1 || typeof value.node !== 'string' || !isAbsolute(value.node)) throw new Error(`${runtimeFile(home)} is not a version 1 runtime manifest.`)
  return value.node
}
export const writeRuntime = (home, node) => save(runtimeFile(home), { version: 1, node })

/** Accepts an absolute Node 26.10+ for macOS on Apple Silicon. */
export async function validateNode(node, { platform = 'darwin', arch = 'arm64' } = {}) {
  if (typeof node !== 'string' || !isAbsolute(node)) throw new Error('Pass the absolute path of a Node.js 26.10 or later executable, for example --node "$(nvm which 26)".')
  let reported
  try { reported = JSON.parse(await run(node, ['-p', 'JSON.stringify([process.versions.node, process.platform, process.arch])'], { timeout: 30000, label: 'Node check' })) }
  catch { throw new Error(`${node} did not run as Node.js. Pass the absolute path of a Node.js 26.10 or later executable.`) }
  const [major, minor] = String(reported?.[0]).split('.').map(Number)
  if (major !== 26 || minor < 10) throw new Error(`${node} is Node.js ${reported?.[0]}. Kipster needs Node.js 26.10 or later in major 26.`)
  if (reported[1] !== platform || reported[2] !== arch) throw new Error(`${node} is built for ${reported[1]} ${reported[2]}; Kipster needs ${platform} ${arch}.`)
  return node
}

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
/** The `kipster` command for this home: runs through the app in its cli role. */
export const commandScript = home => `#!/bin/sh
# Kipster commands for this installation. They run through the Kipster backend
# app with the Node recorded in runtime.json.
home=${quote(home)}
app="$home/backend/Kipster.app/Contents/MacOS/Kipster"
if [ -x "$app" ]; then exec "$app" --role cli --home "$home" -- "$@"; fi
exec /usr/bin/env node "$home/bin/kipster.mjs" "$@"
`
/** Writes the stable entry points launchd and the owner use. */
export async function writeLaunchers(home, root = packageRoot) {
  await privateDirectory(join(home, 'bin'))
  await copyFile(join(root, 'launchers/core.mjs'), join(home, 'bin/core.mjs'))
  await copyFile(join(root, 'launchers/kipster.mjs'), join(home, 'bin/kipster.mjs'))
  await atomic(join(home, 'bin/kipster'), commandScript(home))
  await chmod(join(home, 'bin/kipster'), 0o700)
}
