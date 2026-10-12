import { createHash, randomUUID } from 'node:crypto'
import { access, constants, lstat, open, readdir, readlink, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { digest, exists, json, privateDirectory, save, syncDirectory } from './files.mjs'
import { run } from './process.mjs'

const build = 'b11565', release = `https://github.com/ggml-org/llama.cpp/releases/download/${build}/`
const server = (name, size, sha256) => ({ name, url: release + name, size, sha256 })
/**
 * The pinned embedding runtime. Server assets and their SHA-256 come from the GitHub release
 * asset digests of ggml-org/llama.cpp b11565; the model's from Hugging Face LFS metadata of
 * ggml-org/embeddinggemma-2-GGUF at the pinned revision.
 */
export const embeddingRuntime = {
  server: {
    build,
    directory: `llama-${build}`,
    platforms: {
      'darwin-arm64': server('llama-b11565-bin-macos-arm64.tar.gz', 12105509, '19289548468babcd5131cecccf3a9bc7c67030cc7f0a978dafc0db1ba7891068'),
      'darwin-x64': server('llama-b11565-bin-macos-x64.tar.gz', 11596850, '853c2c2ed9d796f3f6d0210aac7768a8398997cf2afdc9916a6112003b13760f'),
      'linux-x64': server('llama-b11565-bin-ubuntu-x64.tar.gz', 17712716, 'c571742335d8b3d9a7a15773907d1b0c7d948ece274e88fa17bd77176ad52638'),
      'linux-arm64': server('llama-b11565-bin-ubuntu-arm64.tar.gz', 13828645, '6a862c22bd58f8f86168e0ef7ed875166ad625d42f7cac9825d63b8c55af5c1e'),
    },
  },
  model: {
    name: 'embeddinggemma-2-Q8_0',
    file: 'embeddinggemma-2-Q8_0.gguf',
    url: 'https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/bfcd298762cc34d0357ece5ebdd31791a3a374d8/embeddinggemma-2-Q8_0.gguf',
    size: 309855456,
    sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
  },
  port: 43180,
}
export const embeddingPackage = '@kipster/embedding-llama-cpp'

/** The server asset for a platform, or null when llama.cpp publishes none for it. */
export function serverAsset(manifest = embeddingRuntime, platform = process.platform, arch = process.arch) {
  return manifest?.server.platforms[`${platform}-${arch}`] ?? null
}
function source(value) {
  const address = new URL(value)
  if (address.username || address.password || !(address.protocol === 'https:' || address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))) throw new Error('Embedding runtime downloads require HTTPS; HTTP is allowed only on loopback for local testing.')
  return address
}

/** Streams a download beside its destination and renames it into place only after its size and SHA-256 match. */
export async function downloadVerified(url, destination, expected, { timeout = 30 * 60000 } = {}) {
  const temporary = `${destination}.${randomUUID()}.download`
  try {
    const response = await fetch(source(url), { signal: AbortSignal.timeout(timeout) })
    source(response.url)
    if (!response.ok) throw new Error(`Download of ${url} failed (HTTP ${response.status}).`)
    const file = await open(temporary, 'wx', 0o600), hash = createHash('sha256')
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > expected.size) throw new Error(`Size mismatch for ${url}.`)
        hash.update(chunk); await file.writeFile(chunk)
      }
      await file.sync()
    } finally { await file.close() }
    if (size !== expected.size || hash.digest('hex') !== expected.sha256) throw new Error(`Size or SHA-256 mismatch for ${url}; the download was discarded.`)
    await rename(temporary, destination)
    await syncDirectory(dirname(destination))
  } finally { await rm(temporary, { force: true }) }
}

async function verifiedTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(path)
      if (isAbsolute(target) || !resolve(dirname(path), target).startsWith(root + sep)) throw new Error('The llama.cpp archive links outside its directory.')
    } else if (entry.isDirectory()) await verifiedTree(path)
    else if (!entry.isFile()) throw new Error('The llama.cpp archive contains an unsupported file type.')
  }
}
/** Extracts the release directory with the server and its shared libraries, then moves it into place. */
async function extract(archive, destination, top) {
  const entries = (await run('tar', ['-tzf', archive], { label: 'List llama.cpp archive' })).split('\n').filter(Boolean)
  if (!entries.length || entries.some(name => isAbsolute(name) || name.split('/').includes('..') || !(name === top + '/' || name.startsWith(top + '/')))) throw new Error('The llama.cpp archive has an unexpected layout.')
  const staging = `${destination}.staging-${randomUUID()}`
  await privateDirectory(staging)
  try {
    await run('tar', ['-xzf', archive, '-C', staging, '--no-same-owner'], { label: 'Extract llama.cpp archive', timeout: 300000 })
    const extracted = join(staging, top)
    await verifiedTree(extracted)
    const binary = await lstat(join(extracted, 'llama-server'))
    if (!binary.isFile()) throw new Error('The llama.cpp archive has no llama-server.')
    await access(join(extracted, 'llama-server'), constants.X_OK)
    await rm(destination, { recursive: true, force: true })
    await rename(extracted, destination)
    await syncDirectory(dirname(destination))
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/**
 * Installs the pinned llama-server build for this platform and the model under <home>/embedding,
 * skipping what is already present and verified. Returns the host.json server entry, or why
 * memory search is unavailable on this platform.
 */
export async function installEmbeddingRuntime(home, { manifest = embeddingRuntime, platform = process.platform, arch = process.arch } = {}) {
  const asset = serverAsset(manifest, platform, arch)
  if (!asset) return { available: false, reason: `llama.cpp publishes no ${platform}-${arch} build for Kipster's pinned release, so memory search is unavailable on this platform. Memory keeps working without search.` }
  const root = join(home, 'embedding')
  for (const path of [root, join(root, 'llama.cpp'), join(root, 'models')]) await privateDirectory(path)
  const directory = join(root, 'llama.cpp', manifest.server.build), marker = join(directory, '.kipster-release.json')
  const installed = await exists(marker) && (await json(marker)).sha256 === asset.sha256 && await exists(join(directory, 'llama-server'))
  if (!installed) {
    const archive = join(root, 'llama.cpp', asset.name)
    try {
      await downloadVerified(asset.url, archive, asset)
      await extract(archive, directory, manifest.server.directory)
      await save(marker, { name: asset.name, sha256: asset.sha256 })
    } finally { await rm(archive, { force: true }) }
  }
  const model = join(root, 'models', manifest.model.file)
  if (!(await exists(model) && (await digest(model)).sha256 === manifest.model.sha256)) await downloadVerified(manifest.model.url, model, manifest.model)
  return { available: true, server: { binary: join(directory, 'llama-server'), model, modelSha256: manifest.model.sha256, modelName: manifest.model.name, port: manifest.port } }
}

/** The host.json server entry for a runtime already installed under <home>/embedding, without downloading or hashing. */
export async function installedEmbeddingRuntime(home, { manifest = embeddingRuntime, platform = process.platform, arch = process.arch } = {}) {
  const asset = serverAsset(manifest, platform, arch)
  if (!asset) return null
  const directory = join(home, 'embedding/llama.cpp', manifest.server.build), marker = join(directory, '.kipster-release.json'), model = join(home, 'embedding/models', manifest.model.file)
  if (!await exists(marker) || (await json(marker)).sha256 !== asset.sha256 || !await exists(join(directory, 'llama-server')) || !await exists(model) || (await lstat(model)).size !== manifest.model.size) return null
  // Core verifies the model's SHA-256 before it starts the server.
  return { binary: join(directory, 'llama-server'), model, modelSha256: manifest.model.sha256, modelName: manifest.model.name, port: manifest.port }
}

/**
 * Names the embedding package in host.json only once its channel has released it, so an update
 * never needs a package the channel lacks. Without a release or a runtime for this platform the
 * configuration stays as it is and memory works without search.
 */
export async function withEmbedding(config, home, released, install) {
  if (!released) return { config, report: `${embeddingPackage} has no release on this channel yet; memory works without search.` }
  const runtime = await install()
  if (!runtime.available) return { config, report: runtime.reason }
  const previous = config.embedding?.module?.includes(`/${embeddingPackage}/`) ? config.embedding : undefined
  return { config: { ...config, embedding: {
    module: join(home, 'current/node_modules', embeddingPackage, 'dist/index.js'),
    options: previous?.options ?? {},
    server: { ...runtime.server, port: previous?.server?.port ?? runtime.server.port },
  } }, report: null }
}
