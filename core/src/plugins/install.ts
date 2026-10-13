import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, readlink, rename, rm, symlink, writeFile, access, constants } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ChannelEntry } from '../protocol/updates.js'
import { pluginServerModule, pluginsPackageName } from './supervisor.js'

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000
// npm needs no more than this: Core's database URLs, provider keys and NODE_OPTIONS stay out. Its own settings come from ~/.npmrc.
const inherited = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']

const versions = (directory: string) => join(directory, 'versions')
const current = (directory: string) => join(directory, 'current')

/** HTTPS, or HTTP on loopback for local channels. */
function downloadUrl(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Plugins downloads require HTTPS; HTTP is allowed only on loopback')
  return url
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
/** The release's package archive: its one `.tgz` file. */
export function pluginsArchive(entry: ChannelEntry): ChannelEntry['files'][number] {
  const archives = entry.files.filter(file => file.name.endsWith('.tgz'))
  if (archives.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(archives[0]!.name)) throw new Error('The plugins release has no single package archive')
  return archives[0]!
}

async function download(file: ChannelEntry['files'][number], destination: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(downloadUrl(file.url), { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) })
  downloadUrl(response.url)
  if (!response.ok || !response.body) throw new Error(`The download returned HTTP ${response.status}`)
  const output = await open(destination, 'wx', 0o600), hash = createHash('sha256')
  let size = 0
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      size += chunk.length
      if (size > file.size) throw new Error('The download does not match the size the channel names')
      hash.update(chunk); await output.write(chunk)
    }
    await output.sync()
  } finally { await output.close() }
  if (size !== file.size) throw new Error('The download does not match the size the channel names')
  if (hash.digest('hex') !== file.sha256) throw new Error('The download does not match the SHA-256 the channel names')
}

/** Runs npm from beside the running Node binary, as the installer does. */
function npm(args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  const env: Record<string, string> = {}
  for (const name of inherited) if (process.env[name] !== undefined) env[name] = process.env[name]!
  env.PATH = `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', args, { cwd, env, stdio: ['ignore', 'ignore', 'pipe'], signal: AbortSignal.any([signal, AbortSignal.timeout(INSTALL_TIMEOUT_MS)]) })
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr = (stderr + text).slice(-4000) })
    child.once('error', reject)
    child.once('close', (code, signalName) => {
      if (code === 0) return resolvePromise()
      const last = stderr.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('npm notice')).slice(-3).join(' ')
      reject(new Error(`npm install ended with ${signalName ? `signal ${signalName}` : `code ${code}`}${last ? `: ${last}` : ''}`))
    })
  })
}

/**
 * Downloads the release's archive, checks its size and SHA-256 against the channel, installs it with npm without
 * running scripts and checks the installed package is `@kipster/plugins` at the release's version. Returns the
 * installation directory, `<directory>/versions/<version>`; nothing runs from it until `switchPlugins` names it.
 */
export async function installPlugins(directory: string, entry: ChannelEntry, signal: AbortSignal): Promise<string> {
  if (entry.package !== pluginsPackageName) throw new Error(`The channel entry is not ${pluginsPackageName}`)
  const archive = pluginsArchive(entry)
  await mkdir(versions(directory), { recursive: true, mode: 0o700 })
  // Leftovers of an interrupted install.
  for (const name of await readdir(versions(directory))) if (name.startsWith('.')) await rm(join(versions(directory), name), { recursive: true, force: true })
  const staging = join(versions(directory), `.staging-${randomUUID()}`)
  try {
    await mkdir(staging, { mode: 0o700 })
    await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'kipster-plugins-release', version: '0.0.0', private: true }) + '\n', { mode: 0o600 })
    const file = join(staging, archive.name)
    await download(archive, file, signal)
    await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', '--save-exact', file], staging, signal)
    await rm(file, { force: true })
    const manifest = JSON.parse(await readFile(join(staging, 'node_modules', pluginsPackageName, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== pluginsPackageName || manifest.version !== entry.version) throw new Error(`The installed package is not ${pluginsPackageName} ${entry.version}`)
    try { await access(pluginServerModule(staging), constants.R_OK) } catch { throw new Error('The installed package has no plugin server') }
    const destination = join(versions(directory), entry.version)
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await syncDirectory(versions(directory))
    return destination
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** The installation `current` names, or null when the server runs the module host.json names. */
export async function installedPlugins(directory: string): Promise<string | null> {
  try { return resolve(directory, await readlink(current(directory))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
/** Points `current` at an installation in one rename, or removes it so the host.json module runs. */
export async function switchPlugins(directory: string, installation: string | null): Promise<void> {
  if (installation === null) await rm(current(directory), { force: true })
  else {
    if (dirname(resolve(installation)) !== versions(directory)) throw new Error('A plugins installation must be in the versions directory')
    const link = join(directory, `.current-${randomUUID()}`)
    await symlink(join('versions', basename(installation)), link)
    try { await rename(link, current(directory)) } catch (error) { await rm(link, { force: true }); throw error }
  }
  await syncDirectory(directory)
}
/** Removes installations other than those kept, such as the running one and the one it replaced. */
export async function prunePlugins(directory: string, keep: readonly (string | null)[]): Promise<void> {
  let names: string[]
  try { names = await readdir(versions(directory)) } catch { return }
  for (const name of names) {
    const path = join(versions(directory), name)
    if (!name.startsWith('.') && !keep.includes(path)) await rm(path, { recursive: true, force: true })
  }
}
