import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { mkdir, lstat, link, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { IdentityFiles, type IdentityFileName } from './identity.js'

export * from './identity.js'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function safeId(id: string): string {
  if (!uuid.test(id)) throw new Error('Invalid storage identity')
  return id
}
export class HomeInstructionError extends Error {
  constructor(readonly file: 'system' | 'agent' | 'soul' | 'identity' | 'organization') {
    super(`Required instruction file unavailable: ${file}`)
  }
}

export const MAX_ORGANIZATION_INSTRUCTIONS_BYTES = 64 * 1024

export interface HomeInstructions { system: string; agent: string; soul: string; identity: string; organization: string | null }

export class Home {
  readonly root: string
  readonly identity: IdentityFiles
  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('Kipster home must be absolute')
    this.root = resolve(root)
    this.identity = new IdentityFiles(id => this.agent(id), (path, create) => this.directory(path, create))
  }
  agent(id: string): string { return join(this.root, 'agents', safeId(id)) }
  organization(id: string): string { return join(this.root, 'organizations', safeId(id)) }
  output(agentId: string, threadId: string, attemptId: string): string {
    return join(this.agent(agentId), 'outputs', safeId(threadId), safeId(attemptId))
  }
  private segments(path: string): string[] {
    const suffix = relative(this.root, path)
    if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Path outside Kipster home')
    return suffix ? suffix.split(sep) : []
  }
  private async directory(path: string, create = true): Promise<void> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootStat = await lstat(this.root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Unsafe home directory: ${this.root}`)
    let current = this.root
    for (const segment of this.segments(path)) {
      current = join(current, segment)
      if (create) {
        try { await mkdir(current, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe home directory: ${current}`)
    }
  }
  private async readSeed(path: string, file: HomeInstructionError['file']): Promise<string> {
    try {
      await this.directory(dirname(path), false)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe instruction file')
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HomeInstructionError(file)
      throw error
    }
  }
  private async seed(path: string, content: string): Promise<void> {
    await this.directory(dirname(path))
    const temp = `${path}.${randomUUID()}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally { await handle.close() }
    try {
      await link(temp, path) // Atomic no-clobber publication; interrupted writes remain private temp files.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally { await unlink(temp) }
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe home file: ${path}`)
  }
  async initialize(installationId: string): Promise<void> {
    safeId(installationId)
    await this.directory(this.root)
    const marker = join(this.root, 'installation.json')
    await this.seed(marker, JSON.stringify({ installationId }) + '\n')
    let saved: unknown
    try { saved = JSON.parse(await readFile(marker, 'utf8')) } catch { throw new Error('Invalid home installation marker') }
    if (typeof saved !== 'object' || saved === null || !('installationId' in saved) || saved.installationId !== installationId) {
      throw new Error('Home belongs to another installation')
    }
    await this.directory(join(this.root, 'agents'))
    await this.directory(join(this.root, 'organizations'))
    await this.seed(join(this.root, 'system', 'instructions.md'), '# Kipster system\n\nKipster calls its agents kips. The words mean the same thing: people may say either, and a kip is an agent.\n')
  }
  /** Creates the agent's home. Identity files that do not exist yet start with `files`, or with a heading. */
  async provisionAgent(id: string, files: Partial<Record<IdentityFileName, string>> = {}): Promise<void> {
    const base = this.agent(id)
    await this.directory(base)
    await this.seed(join(base, 'AGENTS.md'), files['AGENTS.md'] ?? '# Agent instructions\n')
    await this.seed(join(base, 'soul.md'), files['soul.md'] ?? '# Soul\n')
    await this.seed(join(base, 'identity.md'), files['identity.md'] ?? '# Identity\n')
    await this.directory(join(base, 'journal'))
    await this.directory(join(base, 'files'))
    await this.directory(join(base, 'outputs'))
  }
  /**
   * Removes an agent's home with everything in it, identity files and their backups included. The
   * home is first moved to `.trash/<removalId>` and then deleted, so a removal that stopped part way
   * is finished by the next call with the same ID. A home that is already gone counts as removed.
   */
  async removeAgent(id: string, removalId: string): Promise<void> {
    const trash = join(this.root, '.trash', safeId(removalId))
    await rm(trash, { recursive: true, force: true })
    await this.directory(trash)
    try { await rename(this.agent(id), join(trash, 'agent')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(trash, { recursive: true, force: true })
  }
  async removeOrganization(id: string, removalId: string): Promise<void> {
    const trash = join(this.root, '.trash', safeId(removalId))
    await rm(trash, { recursive: true, force: true })
    await this.directory(trash)
    try { await rename(this.organization(id), join(trash, 'organization')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(trash, { recursive: true, force: true })
  }
  /** Creates the organization's home. An instructions file that does not exist yet starts with `instructions`, or with a heading. */
  async provisionOrganization(id: string, instructions = '# Organization instructions\n'): Promise<void> {
    const base = this.organization(id)
    await this.directory(base)
    await this.seed(join(base, 'instructions.md'), instructions)
    await this.directory(join(base, 'files'))
  }
  async organizationInstructions(id: string): Promise<string> {
    return this.readSeed(join(this.organization(id), 'instructions.md'), 'organization')
  }
  /**
   * Replaces an organization's instructions file with a synced temporary file and a rename, so a
   * reader sees the old or the new file, never a partial one. Callers serialize writers of one organization.
   */
  async prepareOrganizationInstructions(id: string, content: string): Promise<{ commit(): Promise<void>; discard(): Promise<void> }> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_ORGANIZATION_INSTRUCTIONS_BYTES) throw new Error('Invalid instructions size')
    const directory = this.organization(id)
    await this.directory(directory, false)
    const path = join(directory, 'instructions.md')
    const temp = join(directory, `.instructions.md.${randomUUID()}.tmp`)
    const discard = () => rm(temp, { force: true })
    try {
      const handle = await open(temp, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    } catch (error) { await discard(); throw error }
    return {
      discard,
      async commit() {
        await rename(temp, path)
        const handle = await open(directory, 'r')
        try { await handle.sync() } finally { await handle.close() }
      },
    }
  }
  async writeOrganizationInstructions(id: string, content: string): Promise<void> {
    const staged = await this.prepareOrganizationInstructions(id, content)
    try { await staged.commit() } finally { await staged.discard() }
  }
  async instructions(agentId: string, organizationId?: string): Promise<HomeInstructions> {
    const agent = this.agent(agentId)
    return {
      system: await this.readSeed(join(this.root, 'system', 'instructions.md'), 'system'),
      agent: await this.readSeed(join(agent, 'AGENTS.md'), 'agent'),
      soul: await this.readSeed(join(agent, 'soul.md'), 'soul'),
      identity: await this.readSeed(join(agent, 'identity.md'), 'identity'),
      organization: organizationId ? await this.readSeed(join(this.organization(organizationId), 'instructions.md'), 'organization') : null,
    }
  }
}
