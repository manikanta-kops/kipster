import { randomUUID } from 'node:crypto'
import { cp, lstat, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Catalog, channelFor, channel, defaultCatalog, version } from './catalog.mjs'
import { atomic, canonicalHome, exists, json, locked, point, privateDirectory, save, syncDirectory } from './files.mjs'
import { Database, databaseEndpoint } from './database.mjs'
import { run } from './process.mjs'
import { health, hostCLI, hostCommand, recoverOwnership, register, runtimeEnvironment, stop, sudoSteps, writeServices } from './services.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export async function prerequisites() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Kipster hosts require macOS on Apple Silicon. Run this command on an Apple Silicon Mac backend host.')
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 26 || minor < 10) throw new Error('Use Node.js 26.10 or later in major 26, matching .nvmrc: nvm install 26.10.0 && nvm use 26.10.0.')
}
export async function readPrivateConfig(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) throw new Error(`Use a private regular host configuration owned by this user; run chmod 600 on ${path}.`)
  return json(path)
}
function reference(value, fallback) {
  const match = typeof value === 'string' && /(?:^|\/)(?:node_modules\/)?@kipster\/([a-z][a-z0-9-]*)\/(.+)$/.exec(value)
  if (match && !match[2].split(/[\\/]/).includes('..')) return { name: `@kipster/${match[1]}`, entry: `node_modules/@kipster/${match[1]}/${match[2]}` }
  const direct = fallback && typeof value === 'string' && new RegExp(`(?:^|/)(${fallback})/(.+)$`).exec(value)
  if (direct && !direct[2].split(/[\\/]/).includes('..')) return { name: `@kipster/${direct[1]}`, entry: `node_modules/@kipster/${direct[1]}/${direct[2]}` }
  throw new Error('Configured adapters must identify a release package through node_modules/@kipster/<package>/<entry>. Use the packaged embedding/transcription module paths.')
}
export function managedConfiguration(config, home) {
  const names = new Set(), current = join(home, 'current')
  const result = { ...config, version: 1, home, adapters: (config.adapters ?? []).map(adapter => {
    const entry = reference(adapter.entry)
    names.add(entry.name)
    return { ...adapter, root: current, entry: entry.entry }
  }) }
  for (const kind of ['embedding', 'transcription']) if (config[kind]) {
    const entry = reference(config[kind].module, kind === 'embedding' ? 'embedding-ollama' : 'transcription-spokenly')
    names.add(entry.name); result[kind] = { ...config[kind], module: join(current, entry.entry) }
  }
  if (names.has('@kipster/core') || names.has('@kipster/installer') || names.has('@kipster/ui')) throw new Error('Configure adapter packages, not Core, the installer or the app, as providers.')
  return { config: result, names: [...names].sort() }
}
export function request(value) {
  if (!value || value.version !== 1 || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 128 || !['install', 'restore'].includes(value.action) || !['manual', 'automatic'].includes(value.reason) || typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt))) throw new Error('Expected updater request version 1 with id, action, target, reason and requestedAt.')
  version(value.target)
  if (value.backupId !== undefined && (typeof value.backupId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.backupId))) throw new Error('Invalid backupId in updater request.')
  // URLs, paths and other additive input fields are never used for installation.
  return { version: 1, id: value.id, action: value.action, target: value.target, ...(value.backupId ? { backupId: value.backupId } : {}), reason: value.reason, requestedAt: value.requestedAt }
}
async function within(path, root) {
  const canonical = await realpath(path)
  if (!canonical.startsWith(root + '/')) throw new Error('Installed release path escapes the configured home.')
  return canonical
}
export class Installer {
  constructor(home, settings, config, { onStep, platformCheck = prerequisites } = {}) {
    this.home = home; this.settings = settings; this.config = config; this.onStep = onStep; this.platformCheck = platformCheck
    this.env = runtimeEnvironment(config)
    if (settings.pgBin) this.env.PATH = settings.pgBin + ':' + this.env.PATH
    const maintenanceURL = settings.maintenanceDatabaseUrl ?? config.databaseUrl
    if (databaseEndpoint(maintenanceURL) !== databaseEndpoint(config.databaseUrl)) throw new Error('Maintenance login must connect to the same database endpoint as host.json.')
    this.database = new Database({ databaseUrl: maintenanceURL }, settings.pgBin, this.env)
    this.catalog = new Catalog(settings.catalogURL)
    this.directory = join(home, 'updates'); this.journalPath = join(this.directory, 'journal.json')
    this.hold = join(this.directory, 'hold')
  }
  static async open(home, options) {
    home = await canonicalHome(home)
    const settings = await json(join(home, 'updater.json'))
    if (settings.version !== 1 || !['launchd', 'manual'].includes(settings.services) || !Number.isInteger(settings.healthTimeout) || settings.healthTimeout < 100 || settings.healthTimeout > 300000) throw new Error('Invalid private updater configuration. Reinstall with the same home; preserve its data.')
    channel(settings.channel)
    return new Installer(home, settings, await readPrivateConfig(join(home, 'host.json')), options)
  }
  async directories() {
    for (const name of ['updates', 'releases', 'backups', 'updater', 'updater/versions', 'work', 'logs']) await privateDirectory(join(this.home, name))
  }
  async current() {
    if (!await exists(join(this.home, 'current'))) return null
    const path = await within(join(this.home, 'current'), join(this.home, 'releases'))
    const metadata = await json(join(path, 'release.json'))
    version(metadata.coreVersion)
    return { path, metadata }
  }
  async backups() {
    const rows = []
    for (const id of await readdir(join(this.home, 'backups'))) {
      if (!/^[0-9a-f-]{36}$/.test(id) || !await exists(join(this.home, 'backups', id, 'backup.json'))) continue
      const row = await json(join(this.home, 'backups', id, 'backup.json'))
      if (row.id !== id || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('Invalid backup metadata. Preserve the backup directory and inspect it before retrying.')
      version(row.coreVersion)
      rows.push(row)
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }
  async status() {
    const current = await this.current(), backups = await this.backups()
    return { coreVersion: current?.metadata.coreVersion ?? null, home: this.home, services: this.settings.services, update: await exists(join(this.directory, 'status.json')) ? await json(join(this.directory, 'status.json')) : null, backups: backups.map(({ id, coreVersion, createdAt }) => ({ id, coreVersion, createdAt })) }
  }
  async publish(journal, state, step, error = null) {
    const backups = (await this.backups()).slice(0, 3).map(({ id, coreVersion, createdAt }) => ({ id, coreVersion, createdAt }))
    await save(join(this.directory, 'status.json'), { version: 1, requestId: journal.request.id, state, step, from: journal.fromVersion, to: journal.request.target, error, updatedAt: new Date().toISOString(), backups })
    await this.onStep?.(step, journal)
  }
  async persist(journal) { await save(this.journalPath, journal) }
  async stage(journal, files) {
    const staged = join(journal.work, 'release')
    await privateDirectory(staged)
    await save(join(staged, 'package.json'), { name: 'kipster-installed-backend', version: '0.0.0', private: true })
    const packages = files.filter(item => item.package !== '@kipster/installer')
    await run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...packages.map(item => item.path)], { cwd: staged, env: this.env, timeout: 300000, label: 'Install backend packages' })
    for (const item of packages) {
      const installed = await json(join(staged, 'node_modules', item.package, 'package.json'))
      if (installed.name !== item.package || installed.version !== item.version) throw new Error(`Installed package identity does not match the verified catalog: ${item.package}.`)
    }
    await accessHost(staged)
    const host = await import(pathToFileURL(hostCLI(staged)).href)
    host.validateHostConfig(journal.targetConfig)
    const metadata = { coreVersion: journal.request.target, packages: packages.map(({ path, ...item }) => item) }
    await save(join(staged, 'release.json'), metadata)
    journal.stagedRelease = staged
    await this.persist(journal)
    return metadata
  }
  async stageUpdater(journal, files) {
    const offered = files.find(item => item.package === '@kipster/installer')
    let source = packageRoot, expected = (await json(join(packageRoot, 'package.json'))).version
    if (offered) {
      const installation = join(journal.work, 'installer')
      await privateDirectory(installation)
      await save(join(installation, 'package.json'), { private: true })
      await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', offered.path], { cwd: installation, env: this.env, timeout: 120000, label: 'Install updater package' })
      source = join(installation, 'node_modules/@kipster/installer'); expected = offered.version
    }
    const manifest = await json(join(source, 'package.json'))
    if (manifest.name !== '@kipster/installer' || manifest.version !== expected || Object.keys(manifest.dependencies ?? {}).length) throw new Error('Updater package identity or dependency layout is incompatible.')
    const result = JSON.parse(await run(process.execPath, [join(source, 'src/cli.mjs'), 'self-check'], { env: this.env, timeout: 15000, label: 'Updater self-check' }))
    if (result.version !== expected || result.requestVersion !== 1) throw new Error('Updater self-check returned an incompatible contract.')
    const destination = join(this.home, 'updater/versions', version(expected))
    if (!await exists(destination)) {
      const temporary = join(this.home, 'updater/versions', '.staging-' + randomUUID())
      await privateDirectory(temporary)
      for (const name of ['src', 'launchers', 'package.json']) await cp(join(source, name), join(temporary, name), { recursive: true })
      await rename(temporary, destination); await syncDirectory(dirname(destination))
    }
    journal.targetUpdater = destination
    journal.fromUpdater = await exists(join(this.home, 'updater/current')) ? await realpath(join(this.home, 'updater/current')) : null
    await this.persist(journal)
  }
  async activate(journal) {
    const destination = join(this.home, 'releases', journal.request.target)
    if (await exists(destination)) {
      const retired = join(this.home, 'releases', '.previous-' + randomUUID())
      // Journal the destination of an existing same-version release before moving it.
      journal.retired = { original: destination, path: retired }
      if (journal.fromRelease === destination) journal.fromRelease = retired
      await this.persist(journal)
      await rename(destination, retired)
    }
    await rename(journal.stagedRelease, destination)
    await syncDirectory(join(this.home, 'releases'))
    journal.targetRelease = destination
    await this.persist(journal)
    await point(join(this.home, 'current'), destination)
    await save(join(this.home, 'host.json'), journal.targetConfig)
    this.config = journal.targetConfig
  }
  async start(version_, journal) {
    await rm(this.hold, { force: true }); await syncDirectory(this.directory)
    if (this.settings.services === 'manual') {
      const current = await this.current()
      await hostCommand(current.path, 'start', this.home, this.env)
    }
    await this.publish(journal, 'running', 'checking')
    await health(this.config, version_, this.settings.healthTimeout)
  }
  async finish(journal) {
    if (journal.fromUpdater && journal.fromUpdater !== journal.targetUpdater) await point(join(this.home, 'updater/previous'), journal.fromUpdater)
    await point(join(this.home, 'updater/current'), journal.targetUpdater)
    journal.committed = true
    await this.persist(journal)
    await this.cleanup(journal)
    await rm(join(this.directory, 'first-install-failed.json'), { force: true })
    await this.publish(journal, 'done', null)
    await rm(this.journalPath, { force: true }); await syncDirectory(this.directory)
  }
  async cleanup(journal) {
    const keep = new Set([await realpath(join(this.home, 'current')), journal.fromRelease].filter(Boolean))
    for (const name of await readdir(join(this.home, 'releases'))) {
      const path = join(this.home, 'releases', name)
      if (!keep.has(path)) await rm(path, { recursive: true, force: true })
    }
    await this.pruneBackups()
    const keepUpdaters = new Set([journal.targetUpdater, journal.fromUpdater].filter(Boolean))
    if (await exists(join(this.home, 'updater/previous'))) {
      try { keepUpdaters.add(await within(join(this.home, 'updater/previous'), join(this.home, 'updater/versions'))) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    for (const name of await readdir(join(this.home, 'updater/versions'))) {
      const path = join(this.home, 'updater/versions', name)
      if (!keepUpdaters.has(path)) await rm(path, { recursive: true, force: true })
    }
    await rm(journal.work, { recursive: true, force: true })
  }
  async pruneBackups() {
    for (const backup of (await this.backups()).slice(3)) await rm(join(this.home, 'backups', backup.id), { recursive: true, force: true })
    for (const id of await readdir(join(this.home, 'backups'))) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue
      const directory = join(this.home, 'backups', id)
      if (!await exists(join(directory, 'backup.json'))) { await rm(directory, { recursive: true, force: true }); continue }
      for (const file of await readdir(directory)) if (/^[0-9a-f-]{36}\.dump\.tmp$/.test(file)) await rm(join(directory, file), { force: true })
    }
  }
  async rollbackJournal(journal, error) {
    await atomic(this.hold, journal.request.id + '\n')
    try {
      if (journal.childPid) {
        // A subprocess can outlive an abruptly terminated updater. Never signal
        // a recorded PID; wait or retry recovery after its owned work exits.
        const deadline = Date.now() + 10000
        let alive = true
        do {
          try { process.kill(journal.childPid, 0) } catch (failure) { if (failure.code === 'ESRCH') alive = false; else throw failure }
          if (alive) await delay(100)
        } while (alive && Date.now() < deadline)
        if (alive) throw new Error('An earlier migration process is still alive. Core remains held; the updater will retry recovery.')
      }
      const currentPath = journal.targetRelease ?? (journal.retired && !await exists(journal.retired.path) ? journal.retired.original : journal.fromRelease) ?? journal.stagedRelease
      if (await exists(join(this.home, '.host-control'))) {
        try { await stop(currentPath, this.home, this.env) }
        catch { await recoverOwnership(currentPath, this.home) }
      }
      await this.publish(journal, 'running', 'restoring')
      if (journal.destructive) await this.database.restore(join(this.home, 'backups', journal.backupId), journal.work)
      // A process can die after recording a same-version move but before rename.
      let previous = journal.fromRelease
      if (journal.retired && previous === journal.retired.path && !await exists(previous)) previous = journal.retired.original
      if (previous) await point(join(this.home, 'current'), previous)
      else await rm(join(this.home, 'current'), { force: true })
      await save(join(this.home, 'host.json'), journal.originalConfig)
      this.config = journal.originalConfig
      if (journal.fromUpdater) await point(join(this.home, 'updater/current'), journal.fromUpdater)
      await this.publish(journal, 'running', 'restarting')
      if (previous) await this.start(journal.fromVersion, journal)
      else {
        // A partially registered first-install daemon must stay gated while
        // current is absent. Retrying install can safely replace this marker.
        await save(join(this.directory, 'first-install-failed.json'), { requestId: journal.request.id })
      }
      await this.pruneBackups()
      await this.publish(journal, 'rolled-back', null, error)
      const candidate = journal.targetRelease ?? (!await exists(journal.stagedRelease ?? journal.work) ? join(this.home, 'releases', journal.request.target) : null)
      await rm(journal.work, { recursive: true, force: true })
      if (candidate && candidate !== previous) await rm(candidate, { recursive: true, force: true })
      await rm(this.journalPath, { force: true }); await syncDirectory(this.directory)
      return 'rolled-back'
    } catch (failure) {
      // Do not allow startup against a database whose recovery is uncertain.
      await atomic(this.hold, journal.request.id + '\n')
      try { await stop(journal.targetRelease ?? journal.fromRelease, this.home, this.env) } catch { /* The hold and journal preserve recovery until ownership is reachable. */ }
      await this.publish(journal, 'failed', 'restoring', `${error} Recovery failed: ${failure.message}`)
      return 'failed'
    }
  }
  async recover() {
    if (!await exists(this.journalPath)) {
      if (await exists(this.hold)) {
        if (await exists(join(this.directory, 'first-install-failed.json')) && !await exists(join(this.home, 'current'))) return 'rolled-back'
        throw new Error('Updater hold exists without a recovery journal. Inspect the private update files before removing it.')
      }
      return null
    }
    const journal = await json(this.journalPath)
    if (journal.version !== 1 || journal.home !== this.home || !isAbsolute(journal.work) || !journal.work.startsWith(join(this.home, 'work') + '/')) throw new Error('Invalid recovery journal. Preserve the home and backups for inspection.')
    if (journal.committed) { await this.finish(journal); return 'done' }
    if (!journal.stopped && !journal.destructive && !await exists(this.hold)) {
      await this.pruneBackups()
      await this.publish(journal, 'rolled-back', null, 'Interrupted before activation; the running version and database were preserved.')
      await rm(journal.work, { recursive: true, force: true }); await rm(this.journalPath, { force: true })
      return 'rolled-back'
    }
    await privateDirectory(journal.work)
    return this.rollbackJournal(journal, 'Interrupted update recovered to its previous version and database.')
  }
  async perform(input, { initial = false, selectedChannel = channelFor(input.target) } = {}) {
    const wanted = request(input)
    await this.platformCheck(); await this.directories()
    const current = await this.current()
    const journal = { version: 1, home: this.home, request: wanted, fromVersion: current?.metadata.coreVersion ?? null, fromRelease: current?.path ?? null, originalConfig: this.config, targetConfig: this.config, work: join(this.home, 'work', randomUUID()), initial }
    await privateDirectory(journal.work); await this.persist(journal)
    try {
      await this.database.check()
      const { config: targetConfig, names } = managedConfiguration(this.config, this.home)
      let restoring
      if (wanted.action === 'restore') {
        restoring = (await this.backups()).find(backup => wanted.backupId ? backup.id === wanted.backupId : backup.coreVersion === wanted.target)
        if (!restoring || restoring.coreVersion !== wanted.target) throw new Error('Restore target must match the selected backup Core version.')
        if (databaseEndpoint(restoring.config.databaseUrl) !== databaseEndpoint(this.config.databaseUrl)) throw new Error('Backup belongs to a different configured database endpoint. Restore only into the matching dedicated database.')
      }
      // A snapshot must not undo a database credential rotation or reconnect
      // Core to a different database after restoring this one.
      journal.targetConfig = restoring ? { ...restoring.config, databaseUrl: this.config.databaseUrl, taskDataUrl: this.config.taskDataUrl } : targetConfig
      await this.persist(journal)
      await this.publish(journal, 'running', 'downloading')
      const restoreNames = restoring?.release.packages.filter(item => item.package !== '@kipster/core').map(item => item.package)
      const plan = await this.catalog.resolve(wanted.target, selectedChannel, restoreNames ?? names, restoring?.release)
      const files = await this.catalog.download(plan.entries, journal.work, () => this.publish(journal, 'running', 'verifying'))
      await this.publish(journal, 'running', 'backing-up')
      journal.backupId = randomUUID()
      const backup = join(this.home, 'backups', journal.backupId)
      await privateDirectory(backup); await this.persist(journal)
      const metadata = { id: journal.backupId, coreVersion: journal.fromVersion ?? wanted.target, createdAt: new Date().toISOString(), config: this.config, release: current?.metadata ?? { coreVersion: wanted.target, packages: plan.entries.filter(item => item.package !== '@kipster/installer') } }
      await this.database.backup(backup, metadata)
      await this.publish(journal, 'running', 'installing')
      await this.stage(journal, files); await this.stageUpdater(journal, files)
      const jobs = initial ? await writeServices(this.home, this.env) : null
      if (initial) for (const step of sudoSteps(this.home, jobs)) console.log(`${step.command}\n  Requires sudo: ${step.why}.`)
      await atomic(this.hold, wanted.id + '\n')
      journal.stopped = true; await this.persist(journal)
      if (current) await stop(current.path, this.home, this.env)
      // Capture all writes committed while downloading and staging.
      await this.publish(journal, 'running', 'backing-up')
      // Publish the refreshed snapshot under a new ID instead of replacing a
      // dump and its checksum metadata independently. A crash at either write
      // leaves the original snapshot complete and the refresh unadvertised.
      const refreshedId = randomUUID(), refreshed = join(this.home, 'backups', refreshedId)
      await privateDirectory(refreshed)
      journal.refreshingBackupId = refreshedId; await this.persist(journal)
      await this.database.backup(refreshed, { ...metadata, id: refreshedId, createdAt: new Date().toISOString() })
      journal.backupId = refreshedId; delete journal.refreshingBackupId
      await this.persist(journal)
      await rm(backup, { recursive: true, force: true })
      journal.destructive = true; await this.persist(journal)
      await this.activate(journal)
      if (restoring) {
        await this.publish(journal, 'running', 'restoring')
        await this.database.restore(join(this.home, 'backups', restoring.id), journal.work)
      }
      await this.publish(journal, 'running', 'migrating')
      await hostCommand(journal.targetRelease, 'setup', this.home, this.env, async pid => { journal.childPid = pid; await this.persist(journal) })
      delete journal.childPid; await this.persist(journal)
      await this.publish(journal, 'running', 'restarting')
      if (initial) {
        await point(join(this.home, 'updater/current'), journal.targetUpdater)
        if (this.settings.services === 'launchd') await register(this.home, jobs)
      }
      await this.start(wanted.target, journal)
      await this.finish(journal)
      return await this.status()
    } catch (failure) {
      if (journal.committed) {
        // Health has passed and the commit is durable. A later run retries only
        // retention/status cleanup, never restores an obsolete snapshot.
        throw new Error('Update committed successfully; cleanup is pending and will retry on the next apply.')
      }
      if (journal.stopped || journal.destructive || await exists(this.hold)) await this.rollbackJournal(journal, failure.message)
      else {
        await this.pruneBackups()
        await this.publish(journal, 'failed', null, failure.message)
        await rm(journal.work, { recursive: true, force: true }); await rm(this.journalPath, { force: true })
      }
      throw failure
    }
  }
  async apply() {
    await this.directories()
    return locked(this.home, async () => {
      const recovered = await this.recover()
      if (recovered === 'failed') throw new Error('Recovery is incomplete; Core remains held and the updater will retry.')
      const file = join(this.directory, 'request.json')
      if (!await exists(file)) return null
      const wanted = request(await json(file)), previous = await exists(join(this.directory, 'status.json')) ? await json(join(this.directory, 'status.json')) : null
      if (previous?.requestId === wanted.id && ['done', 'failed', 'rolled-back'].includes(previous.state)) return this.status()
      return this.perform(wanted)
    }, true)
  }
  async update(target, backupId) {
    await this.directories()
    return locked(this.home, async () => {
      if (await this.recover() === 'failed') throw new Error('Finish recovery before starting another update.')
      if (await exists(join(this.directory, 'request.json'))) {
        const pending = request(await json(join(this.directory, 'request.json')))
        const status = await exists(join(this.directory, 'status.json')) ? await json(join(this.directory, 'status.json')) : null
        if (pending.id !== status?.requestId || status?.state === 'running') throw new Error('A Core update request is pending. Run kipster apply before submitting another request.')
      }
      const selectedChannel = target ? channelFor(target) : this.settings.channel
      const wanted = target ?? (await this.catalog.read(selectedChannel + '.json'))['@kipster/core']?.version
      const input = request({ version: 1, id: randomUUID(), action: backupId ? 'restore' : 'install', target: wanted, ...(backupId ? { backupId } : {}), reason: 'manual', requestedAt: new Date().toISOString() })
      await save(join(this.directory, 'request.json'), input)
      return this.perform(input, { selectedChannel })
    })
  }
}
async function accessHost(release) {
  const info = await lstat(hostCLI(release))
  if (!info.isFile()) throw new Error('The Core release has no host entry point.')
}
export async function install(options, hooks) {
  await (hooks?.platformCheck ?? prerequisites)()
  const source = options.config ? await readPrivateConfig(resolve(options.config)) : null
  const home = await canonicalHome(options.home ?? source?.home ?? join(process.env.HOME ?? '', '.kipster'))
  const config = source ?? {
    version: 1, home, databaseUrl: process.env.KIPSTER_DATABASE_URL,
    listen: { host: '127.0.0.1', port: 43120, allowedHosts: [], allowedOrigins: ['tauri://localhost'] },
    adapters: [{ id: 'codex-cli', root: join(home, 'current'), entry: 'node_modules/@kipster/codex-cli/dist/index.js' }],
  }
  if (!config.databaseUrl) throw new Error('Provide a private --config host JSON or set KIPSTER_DATABASE_URL. Configure PostgreSQL 18 and pgvector before installation.')
  config.home = home
  const maintenance = options.maintenanceConfig ? await readPrivateConfig(resolve(options.maintenanceConfig)) : null
  if (maintenance && typeof maintenance.databaseUrl !== 'string') throw new Error('Maintenance configuration must contain databaseUrl for the same dedicated database.')
  const settings = { version: 1, channel: channel(options.channel ?? 'stable'), catalogURL: options.catalog ?? defaultCatalog, services: options.noLaunchd ? 'manual' : 'launchd', pgBin: options.pgBin ? resolve(options.pgBin) : null, maintenanceDatabaseUrl: maintenance?.databaseUrl ?? null, healthTimeout: options.healthTimeout ?? 60000 }
  if (!Number.isInteger(settings.healthTimeout) || settings.healthTimeout < 100 || settings.healthTimeout > 300000) throw new Error('--health-timeout must be between 100 and 300000 milliseconds.')
  const installer = new Installer(home, settings, config, hooks)
  await installer.directories()
  return locked(home, async () => {
    if (await exists(installer.journalPath)) {
      if (await installer.recover() === 'failed') throw new Error('Finish interrupted installation recovery before retrying install.')
    }
    if (await installer.current()) throw new Error('This home already has Core installed. Use kipster update or kipster rollback.')
    await installer.database.check()
    const target = options.version ?? (await installer.catalog.read(settings.channel + '.json'))['@kipster/core']?.version
    await save(join(home, 'updater.json'), settings)
    await save(join(home, 'host.json'), config)
    return installer.perform({ version: 1, id: randomUUID(), action: 'install', target, reason: 'manual', requestedAt: new Date().toISOString() }, { initial: true, selectedChannel: settings.channel })
  })
}
