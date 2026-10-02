import { cp, lstat, open, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { exists, json, privateDirectory, save, syncDirectory } from './files.mjs'

// Core setup and startup own these paths. Installer configuration, journals,
// releases, backups and diagnostic logs must survive a failed first install.
const paths = ['installation.json', 'agents', 'organizations', 'system', 'artifacts', 'adapter-generations', 'providers']
const copy = (source, target) => cp(source, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
async function syncTree(path) {
  const info = await lstat(path)
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await syncTree(join(path, name))
    await syncDirectory(path)
  } else if (info.isFile()) {
    const file = await open(path, 'r')
    try { await file.sync() } finally { await file.close() }
  }
}
export async function snapshotHome(home, work) {
  const snapshot = join(work, 'home-before-install'), present = []
  await privateDirectory(snapshot)
  for (const name of paths) if (await exists(join(home, name))) {
    await copy(join(home, name), join(snapshot, name))
    await syncTree(join(snapshot, name))
    present.push(name)
  }
  await save(join(snapshot, 'manifest.json'), { version: 1, present })
  await syncDirectory(work)
}
export async function restoreHome(home, work) {
  const snapshot = join(work, 'home-before-install'), manifest = await json(join(snapshot, 'manifest.json'))
  if (manifest.version !== 1 || !Array.isArray(manifest.present) || manifest.present.some(name => !paths.includes(name))) throw new Error('Invalid first-install home snapshot. Preserve the recovery journal and backup.')
  // The snapshot stays intact until recovery completes, so a crash during
  // restoration can repeat the copy alongside database restoration.
  for (const name of paths) {
    await rm(join(home, name), { recursive: true, force: true })
    if (manifest.present.includes(name)) {
      await copy(join(snapshot, name), join(home, name))
      await syncTree(join(home, name))
    }
  }
  await syncDirectory(home)
}

/** Older installers restored only the database; preserve their orphaned home. */
export async function preserveFailedHome(home) {
  const backup = join(home, 'backups', 'failed-install-home-' + randomUUID())
  await privateDirectory(backup)
  for (const name of paths) if (await exists(join(home, name))) {
    await rename(join(home, name), join(backup, name))
    await syncDirectory(backup); await syncDirectory(home)
  }
  return backup
}
