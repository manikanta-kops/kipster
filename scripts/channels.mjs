// Stateless update catalogs. See docs/releasing.md for the /v1 contract.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = 'manikanta-kops/kipster'
const root = fileURLToPath(new URL('..', import.meta.url))

function semver(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) throw new Error(`Invalid semver: ${version}`)
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error(`Invalid semver: ${version}`)
  return { numbers: match.slice(1, 4).map(BigInt), prerelease }
}

// Numeric prerelease identifiers compare numerically; build metadata has no precedence.
export function compareVersions(left, right) {
  const a = semver(left), b = semver(right)
  const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0
  for (let index = 0; index < 3; index++) {
    const order = compare(a.numbers[index], b.numbers[index])
    if (order) return order
  }
  if (!a.prerelease.length || !b.prerelease.length) return compare(!a.prerelease.length, !b.prerelease.length)
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index]
    if (x === undefined || y === undefined) return compare(x !== undefined, y !== undefined)
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    const order = numericX && numericY ? compare(BigInt(x), BigInt(y))
      : numericX !== numericY ? compare(!numericX, !numericY) : compare(x, y)
    if (order) return order
  }
  return 0
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function releaseEntry(release, metadata) {
  const tag = /^([a-z][a-z0-9-]*)-v(.+)$/.exec(release.tag_name)
  requireValue(tag && metadata?.schemaVersion === 1, 'Expected a package tag and release.json schemaVersion 1.')
  requireValue(metadata.package === `@kipster/${tag[1]}` && metadata.version === tag[2], 'Metadata package/version does not match the release tag.')
  const version = semver(metadata.version)
  requireValue(release.prerelease === Boolean(version.prerelease.length), 'Release prerelease flag does not match its version.')
  requireValue(typeof release.published_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(release.published_at) && Number.isFinite(Date.parse(release.published_at)), 'Release has no valid publication date.')
  requireValue(release.body == null || typeof release.body === 'string', 'Release notes must be text.')
  requireValue(Array.isArray(metadata.files) && metadata.files.length > 0, 'Metadata has no files.')
  const names = new Set()
  const files = metadata.files.map(file => {
    requireValue(typeof file.name === 'string' && file.name.length > 0 && !/[\\/]/.test(file.name) && !['.', '..', 'release.json'].includes(file.name) && !names.has(file.name), 'Invalid or duplicate metadata filename.')
    names.add(file.name)
    requireValue(Number.isSafeInteger(file.size) && file.size > 0 && /^[a-f0-9]{64}$/.test(file.sha256), `Invalid size or sha256 for ${file.name}.`)
    const assets = release.assets.filter(asset => asset.name === file.name)
    requireValue(assets.length === 1 && assets[0].size === file.size, `Missing asset or size mismatch for ${file.name}.`)
    const asset = assets[0]
    requireValue(typeof asset.browser_download_url === 'string' && asset.browser_download_url.startsWith('https://'), `Missing HTTPS download URL for ${file.name}.`)
    requireValue(!asset.digest || asset.digest === `sha256:${file.sha256}`, `GitHub digest mismatch for ${file.name}.`)
    return { name: file.name, url: asset.browser_download_url, sha256: file.sha256, size: file.size }
  }).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  requireValue(release.assets.every(asset => asset.name === 'release.json' || names.has(asset.name)), 'A release asset is missing from metadata.')
  const entry = {
    package: metadata.package, version: metadata.version, prerelease: release.prerelease,
    notes: release.body ?? '', publishedAt: release.published_at, files,
  }
  if (metadata.package === '@kipster/core') {
    const range = metadata.protocolRange
    requireValue(Number.isSafeInteger(range?.current) && Number.isSafeInteger(range?.oldest) && range.oldest >= 1 && range.current >= range.oldest, 'Core metadata has no valid protocolRange.')
    entry.protocolRange = { current: range.current, oldest: range.oldest }
  }
  if (metadata.package === '@kipster/ui') {
    requireValue(Number.isSafeInteger(metadata.protocol) && metadata.protocol >= 1, 'App metadata has no valid protocol number.')
    entry.protocol = metadata.protocol
    entry.updater = null
    if (metadata.updater) {
      const updater = metadata.updater
      const file = files.find(item => item.name === updater.file)
      requireValue(updater.platform === 'darwin-aarch64' && file?.name.endsWith('.app.tar.gz') && names.has(`${file.name}.sig`) && typeof updater.signature === 'string' && updater.signature.trim().length > 0, 'App metadata has no complete signed darwin-aarch64 updater.')
      entry.updater = { platform: updater.platform, url: file.url, signature: updater.signature.trim() }
    } else {
      requireValue(!files.some(file => file.name.endsWith('.app.tar.gz') || file.name.endsWith('.sig')), 'App updater artifacts have no updater metadata.')
    }
  }
  return entry
}

function tauriManifest(entry) {
  return {
    version: entry.version, notes: entry.notes, pub_date: entry.publishedAt,
    platforms: { [entry.updater.platform]: { url: entry.updater.url, signature: entry.updater.signature } },
  }
}

export async function generateChannels(releases, readMetadata, log = console.error) {
  const versions = new Map()
  for (const release of releases) {
    if (release.draft) continue
    const assets = release.assets.filter(asset => asset.name === 'release.json')
    if (!assets.length) {
      log(`Skipping ${release.tag_name}: no release.json.`)
      continue
    }
    requireValue(assets.length === 1, `${release.tag_name}: duplicate release.json assets.`)
    let entry
    try { entry = releaseEntry(release, await readMetadata(assets[0], release)) }
    catch (error) { throw new Error(`${release.tag_name}: ${error.message}`, { cause: error }) }
    const list = versions.get(entry.package) ?? []
    requireValue(!list.some(item => item.version === entry.version), `${release.tag_name}: duplicate package version.`)
    list.push(entry)
    versions.set(entry.package, list)
  }
  const stable = { schemaVersion: 1, packages: {} }, next = { schemaVersion: 1, packages: {} }, all = { schemaVersion: 1, packages: {} }
  for (const [name, list] of [...versions].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    list.sort((a, b) => compareVersions(b.version, a.version) || b.publishedAt.localeCompare(a.publishedAt) || b.version.localeCompare(a.version))
    all.packages[name] = list
    next.packages[name] = list[0]
    const latestStable = list.find(entry => !entry.prerelease)
    if (latestStable) stable.packages[name] = latestStable
  }
  const site = { 'v1/stable.json': stable, 'v1/next.json': next, 'v1/releases.json': all }
  const apps = (all.packages['@kipster/ui'] ?? []).filter(entry => entry.updater)
  for (const app of apps) site[`v1/app/${app.version}.json`] = tauriManifest(app)
  const stableApp = apps.find(entry => !entry.prerelease)
  if (stableApp) site['v1/app/stable.json'] = tauriManifest(stableApp)
  if (apps.length) site['v1/app/next.json'] = tauriManifest(apps[0])
  return site
}

const gh = args => execFileSync('gh', ['api', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

export async function channelsFromGitHub(repo = repository, api = gh, log = console.error) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo), 'Expected an owner/repository name.')
  const releases = JSON.parse(await api(['--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat()
  return generateChannels(releases, async asset => JSON.parse(await api([
    '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`,
  ])), log)
}

export function writeSite(out, site) {
  mkdirSync(out, { recursive: true })
  requireValue(readdirSync(out).length === 0, 'Use an empty output directory for the generated site.')
  for (const [path, value] of Object.entries(site)) {
    const destination = join(out, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, JSON.stringify(value, null, 2) + '\n')
  }
  writeFileSync(join(out, 'CNAME'), 'updates.kipster.app\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [out] = process.argv.slice(2)
  if (!out || process.argv.length !== 3) {
    console.error('Usage: node scripts/channels.mjs <out dir>')
    process.exitCode = 2
  } else {
    const site = await channelsFromGitHub(process.env.GITHUB_REPOSITORY ?? process.env.GH_REPO ?? repository)
    writeSite(resolve(out), site)
    console.log(`Wrote ${Object.keys(site).length} JSON files and CNAME to ${resolve(out)}.`)
  }
}
