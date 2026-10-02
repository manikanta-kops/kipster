import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const exists = async path => { try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
export const json = async path => JSON.parse(await readFile(path, 'utf8'))
export async function syncDirectory(path) {
  const fd = await open(path, 'r')
  try { await fd.sync() } finally { await fd.close() }
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error(`Use a directory owned by this user with mode 0700: ${path}`)
}
export async function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try { await file.writeFile(value); await file.sync() } finally { await file.close() }
  try { await rename(temporary, path); await syncDirectory(dirname(path)) }
  finally { await rm(temporary, { force: true }) }
}
export const save = (path, value) => atomic(path, JSON.stringify(value, null, 2) + '\n')
export async function point(path, target) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await symlink(target, temporary)
  try { await rename(temporary, path); await syncDirectory(dirname(path)) }
  finally { await rm(temporary, { force: true }) }
}
export async function digest(path) {
  const hash = createHash('sha256'); let size = 0
  for await (const bytes of createReadStream(path)) { size += bytes.length; hash.update(bytes) }
  return { size, sha256: hash.digest('hex') }
}
export async function canonicalHome(path) {
  if (process.getuid?.() === 0) throw new Error('Run kipster as the backend owner, without sudo. It requests sudo only to register system services.')
  await privateDirectory(resolve(path))
  const home = await realpath(path)
  if (Buffer.byteLength(join(home, '.host-control/control.sock')) > 103) throw new Error('Choose a shorter --home path for the macOS host-control socket (at most 103 bytes).')
  return home
}
// SQLite's operating-system lock releases on exit/SIGKILL; no stale PID is killed
// or removed. This database belongs to the installer, not the Core schema.
export async function locked(home, operation, busyIsNoop = false) {
  const path = join(home, '.installer-lock.sqlite')
  if (await exists(path)) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error('Installer lock is not a private regular file.')
  }
  const lock = new DatabaseSync(path)
  await chmod(path, 0o600)
  try {
    try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE') }
    catch (error) { if (/locked|busy/.test(error.message)) { if (busyIsNoop) return null; throw new Error('Another installer command is running. Retry after it finishes.') } throw error }
    try { return await operation() } finally { lock.exec('ROLLBACK') }
  } finally { lock.close() }
}
