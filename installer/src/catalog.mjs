import { createHash, randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { syncDirectory } from './files.mjs'

export const defaultCatalog = 'https://updates.kipster.app/v1/'
export function version(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value) || value.split('+')[0].split('-').slice(1).join('-').split('.').some(part => /^0\d+$/.test(part))) throw new Error('Target must be a semver version string, such as 0.2.0 or 0.2.0-next.1.')
  return value
}
export const channelFor = target => version(target).split('+')[0].includes('-') ? 'next' : 'stable'
export function channel(value) {
  if (!['stable', 'next'].includes(value)) throw new Error('Channel must be stable or next.')
  return value
}
function url(value, local) {
  const address = new URL(value)
  if (address.username || address.password || !(address.protocol === 'https:' || local && address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))) throw new Error('Catalogs and downloads require HTTPS; HTTP is allowed only on loopback for local testing.')
  return address
}
export class Catalog {
  constructor(base = defaultCatalog) {
    this.base = url(base.endsWith('/') ? base : base + '/', true)
    this.local = this.base.protocol === 'http:'
  }
  async read(name) {
    const response = await fetch(new URL(name, this.base), { signal: AbortSignal.timeout(15000) })
    url(response.url, this.local)
    if (!response.ok) throw new Error(`Cannot fetch ${name} (HTTP ${response.status}). Retry when the update catalog is reachable.`)
    let bytes = 0, chunks = []
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > 8 * 1024 * 1024) throw new Error('Update catalog exceeds 8 MiB.')
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString())
    if (value.schemaVersion !== 1 || !value.packages || typeof value.packages !== 'object' || Array.isArray(value.packages)) throw new Error('Expected channel catalog schemaVersion 1 with packages.')
    return value.packages
  }
  async resolve(target, selectedChannel, names, pinned) {
    const latest = await this.read(`${channel(selectedChannel)}.json`)
    const requested = target ? version(target) : latest['@kipster/core']?.version
    version(requested)
    let history
    const exact = async (name, wanted) => {
      if (latest[name]?.version === wanted && latest[name].package === name) return latest[name]
      history ??= await this.read('releases.json')
      const found = history[name]?.find(entry => entry.version === wanted && entry.package === name)
      if (!found) throw new Error(`${name} ${wanted} is absent from the release catalog.`)
      return found
    }
    const entries = [await exact('@kipster/core', requested)]
    for (const name of names) {
      const entry = pinned ? await exact(name, pinned.packages.find(item => item.package === name)?.version) : latest[name]
      if (!entry || entry.package !== name) throw new Error(`Publish a ${selectedChannel} release for ${name} before installing this host.`)
      entries.push(entry)
    }
    const installer = latest['@kipster/installer']
    if (installer) {
      if (installer.package !== '@kipster/installer') throw new Error('Installer catalog key does not match its package identity.')
      entries.push(installer)
    }
    return { coreVersion: requested, entries: entries.map(entry => this.entry(entry)) }
  }
  entry(entry) {
    version(entry?.version)
    if (typeof entry.package !== 'string' || !/^@kipster\/[a-z][a-z0-9-]*$/.test(entry.package) || !Array.isArray(entry.files)) throw new Error('Invalid package entry in update catalog.')
    const files = entry.files.filter(file => typeof file.name === 'string' && file.name.endsWith('.tgz'))
    if (files.length !== 1) throw new Error(`Expected one package tarball for ${entry.package}.`)
    const file = files[0]
    if (!/^[a-zA-Z0-9_.+-]+\.tgz$/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 ** 3 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid size, sha256 or filename for ${entry.package}.`)
    url(file.url, this.local)
    return { package: entry.package, version: entry.version, file: { ...file } }
  }
  async download(entries, directory, verifying) {
    const files = []
    for (const entry of entries) {
      const file = entry.file, temporary = join(directory, randomUUID() + '.download'), destination = join(directory, `${entry.package.slice(9)}-${file.name}`)
      const response = await fetch(url(file.url, this.local), { signal: AbortSignal.timeout(120000) })
      url(response.url, this.local)
      if (!response.ok) throw new Error(`Download of ${entry.package} failed (HTTP ${response.status}).`)
      const fd = await open(temporary, 'wx', 0o600), hash = createHash('sha256'); let size = 0
      try {
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > file.size) throw new Error(`Size mismatch for ${entry.package}.`)
          hash.update(chunk); await fd.writeFile(chunk)
        }
        await fd.sync()
      } finally { await fd.close() }
      files.push({ entry, temporary, destination, size, sha256: hash.digest('hex') })
    }
    await verifying()
    for (const file of files) {
      if (file.size !== file.entry.file.size || file.sha256 !== file.entry.file.sha256) throw new Error(`Size or sha256 mismatch for ${file.entry.package}.`)
      await rename(file.temporary, file.destination)
    }
    await syncDirectory(directory)
    return files.map(({ entry, destination }) => ({ ...entry, path: destination }))
  }
}
