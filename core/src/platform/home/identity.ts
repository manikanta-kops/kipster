import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { link, lstat, open, readdir, readFile, rename, rm } from 'node:fs/promises'

export const identityFileNames = ['AGENTS.md', 'soul.md', 'identity.md'] as const
export type IdentityFileName = typeof identityFileNames[number]
/** `owner` may change any identity file; `kipster` may change only the Learned section of identity.md. */
export type IdentityAuthor = 'owner' | 'kipster'
export interface IdentityFile { file: IdentityFileName; content: string; sha256: string }
export interface IdentityBackup { id: string; sha256: string; size: number; createdAt: string }

export const MAX_IDENTITY_BYTES = 64 * 1024
export const KEPT_IDENTITY_BACKUPS = 5
export const LEARNED_BEGIN = '<!-- kipster:learned:begin -->'
export const LEARNED_END = '<!-- kipster:learned:end -->'

export class IdentityConflictError extends Error {
  constructor(readonly file: IdentityFileName, readonly currentSha256: string | null) {
    super(`Identity file changed since it was read: ${file}`)
  }
}
export class IdentityAccessError extends Error {
  constructor(readonly file: IdentityFileName) {
    super(`Only the owner may change ${file} outside the Learned section of identity.md: access denied`)
  }
}

function markers(text: string): { begin: number; end: number } | null {
  const begin = text.indexOf(LEARNED_BEGIN), end = text.indexOf(LEARNED_END)
  if (begin < 0 && end < 0) return null
  if (begin < 0 || end < begin || text.includes(LEARNED_BEGIN, begin + 1) || text.includes(LEARNED_END, end + 1)) throw new Error('Invalid Learned section markers in identity.md')
  return { begin: begin + LEARNED_BEGIN.length, end }
}
/** The Learned section's text, or null when the file has none. */
export function learnedSection(text: string): string | null {
  const found = markers(text)
  if (!found) return null
  const inner = text.slice(found.begin, found.end)
  return inner.startsWith('\n') ? inner.slice(1) : inner
}
/** Replaces only the text between the Learned markers, appending the section when it is absent. */
export function withLearned(text: string, section: string): string {
  if (section.includes(LEARNED_BEGIN) || section.includes(LEARNED_END)) throw new Error('Invalid Learned section content')
  const body = section && !section.endsWith('\n') ? `${section}\n` : section
  const found = markers(text)
  if (found) return `${text.slice(0, found.begin)}\n${body}${text.slice(found.end)}`
  const gap = !text ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  return `${text}${gap}${LEARNED_BEGIN}\n${body}${LEARNED_END}\n`
}

function onlyLearnedChanged(file: IdentityFileName, before: string, after: string): boolean {
  if (file !== 'identity.md') return false
  const section = learnedSection(after)
  return section !== null && withLearned(before, section) === after
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const utf8 = new TextDecoder('utf-8', { fatal: true })
const backupName = /^([1-9]\d{0,8})\.md$/

async function readRegular(path: string, missing: string): Promise<{ bytes: Buffer; content: string; sha256: string }> {
  let stat
  try { stat = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(missing)
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe identity file')
  if (stat.size > MAX_IDENTITY_BYTES) throw new Error('Invalid identity file size')
  const bytes = await readFile(path)
  if (bytes.length > MAX_IDENTITY_BYTES) throw new Error('Invalid identity file size')
  let content: string
  try { content = utf8.decode(bytes) } catch { throw new Error('Invalid identity file encoding') }
  return { bytes, content, sha256: sha256(bytes) }
}
async function writeTemp(directory: string, name: string, bytes: Uint8Array): Promise<string> {
  const temp = join(directory, `.${name}.${randomUUID()}.tmp`)
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally { await handle.close() }
  return temp
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

const queues = new Map<string, Promise<void>>()
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(work)
  const settled = result.then(() => undefined, () => undefined)
  queues.set(key, settled)
  try { return await result } finally { if (queues.get(key) === settled) queues.delete(key) }
}

/**
 * Crash-safe writer for an agent's identity files. Every change is a compare-and-swap against the
 * SHA-256 the caller read, and the replaced version is kept under `backups/<file>/` in the agent
 * home; only the latest five backups of each file remain. Writes within one process are serialized;
 * an external edit is detected by hashing the live file again immediately before the rename.
 */
export class IdentityFiles {
  constructor(
    private readonly agentHome: (agentId: string) => string,
    private readonly verifyDirectory: (path: string, create: boolean) => Promise<void>,
  ) {}

  private path(agentId: string, file: IdentityFileName): string {
    if (!identityFileNames.includes(file)) throw new Error('Unknown identity file')
    return join(this.agentHome(agentId), file)
  }
  private backups(agentId: string, file: IdentityFileName): string { return join(dirname(this.path(agentId, file)), 'backups', file) }

  async read(agentId: string, file: IdentityFileName): Promise<IdentityFile> {
    const path = this.path(agentId, file)
    await this.verifyDirectory(dirname(path), false)
    const { content, sha256 } = await readRegular(path, 'Identity file not found')
    return { file, content, sha256 }
  }

  async write(agentId: string, file: IdentityFileName, content: string, expectedSha256: string, author: IdentityAuthor): Promise<IdentityFile> {
    return this.commit(agentId, file, expectedSha256, author, () => content)
  }

  /** Replaces the Kipster-managed Learned section of identity.md, creating it when absent. */
  async replaceLearned(agentId: string, section: string, expectedSha256: string): Promise<IdentityFile> {
    return this.commit(agentId, 'identity.md', expectedSha256, 'kipster', current => withLearned(current, section))
  }

  /** Backups of a file, newest first. */
  async listBackups(agentId: string, file: IdentityFileName): Promise<IdentityBackup[]> {
    const directory = this.backups(agentId, file)
    return exclusive(this.path(agentId, file), async () => {
      const found: IdentityBackup[] = []
      for (const id of await this.backupIds(directory)) {
        const path = join(directory, `${id}.md`)
        const { bytes, sha256 } = await readRegular(path, 'Identity backup not found')
        found.push({ id: String(id), sha256, size: bytes.length, createdAt: (await lstat(path)).mtime.toISOString() })
      }
      return found
    })
  }

  async readBackup(agentId: string, file: IdentityFileName, id: string): Promise<IdentityFile> {
    const { content, sha256 } = await readRegular(await this.backupPath(agentId, file, id), 'Identity backup not found')
    return { file, content, sha256 }
  }

  /** Restores a backup as an owner write, so the replaced version is itself kept as a backup. */
  async restore(agentId: string, file: IdentityFileName, id: string, expectedSha256: string): Promise<IdentityFile> {
    const backup = await this.readBackup(agentId, file, id)
    return this.commit(agentId, file, expectedSha256, 'owner', () => backup.content)
  }

  private async backupPath(agentId: string, file: IdentityFileName, id: string): Promise<string> {
    if (!backupName.test(`${id}.md`)) throw new Error('Identity backup not found')
    const directory = this.backups(agentId, file)
    await this.verifyDirectory(directory, false).catch(error => {
      throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('Identity backup not found') : error
    })
    return join(directory, `${id}.md`)
  }

  private async backupIds(directory: string): Promise<number[]> {
    try { await this.verifyDirectory(directory, false) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return (await readdir(directory)).flatMap(name => {
      const match = backupName.exec(name)
      return match ? [Number(match[1])] : []
    }).sort((a, b) => b - a)
  }

  private async keep(agentId: string, file: IdentityFileName, bytes: Uint8Array): Promise<string> {
    const directory = this.backups(agentId, file)
    await this.verifyDirectory(directory, true)
    const temp = await writeTemp(directory, 'backup', bytes)
    try {
      for (let id = ((await this.backupIds(directory))[0] ?? 0) + 1; ; id++) {
        const path = join(directory, `${id}.md`)
        try {
          await link(temp, path)
          await syncDirectory(directory)
          return path
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
    } finally { await rm(temp, { force: true }) }
  }

  private async prune(agentId: string, file: IdentityFileName): Promise<void> {
    const directory = this.backups(agentId, file)
    for (const id of (await this.backupIds(directory)).slice(KEPT_IDENTITY_BACKUPS)) await rm(join(directory, `${id}.md`), { force: true })
  }

  private async commit(agentId: string, file: IdentityFileName, expectedSha256: string, author: IdentityAuthor, change: (current: string) => string): Promise<IdentityFile> {
    const path = this.path(agentId, file)
    const directory = dirname(path)
    return exclusive(path, async () => {
      await this.verifyDirectory(directory, false)
      const current = await readRegular(path, 'Identity file not found')
      if (current.sha256 !== expectedSha256) throw new IdentityConflictError(file, current.sha256)
      const content = change(current.content)
      if (author !== 'owner' && !onlyLearnedChanged(file, current.content, content)) throw new IdentityAccessError(file)
      if (content === current.content) return { file, content, sha256: current.sha256 }
      const bytes = Buffer.from(content, 'utf8')
      if (bytes.length > MAX_IDENTITY_BYTES) throw new Error('Invalid identity file size')
      const temp = await writeTemp(directory, file, bytes)
      let backup: string | undefined
      try {
        backup = await this.keep(agentId, file, current.bytes)
        const live = await readRegular(path, 'Identity file not found').catch(() => null)
        if (live?.sha256 !== expectedSha256) throw new IdentityConflictError(file, live?.sha256 ?? null)
        await rename(temp, path)
        backup = undefined
        await syncDirectory(directory)
      } finally {
        await rm(temp, { force: true })
        if (backup) await rm(backup, { force: true })
      }
      await this.prune(agentId, file)
      return { file, content, sha256: sha256(bytes) }
    })
  }
}
