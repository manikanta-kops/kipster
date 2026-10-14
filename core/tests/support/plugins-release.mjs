import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** The `@kipster/plugins` package Core's tests run. */
export const pluginsRoot = dirname(fileURLToPath(import.meta.resolve('@kipster/plugins/package.json')))
export const pluginsCli = join(pluginsRoot, 'dist/server/cli.js')
export const pluginsCatalogue = join(pluginsRoot, 'test/fixtures/catalogue')
export const installedPluginsVersion = JSON.parse(await readFile(join(pluginsRoot, 'package.json'), 'utf8')).version

function resolvePackage(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const path = join(directory, 'node_modules', name)
    if (existsSync(join(path, 'package.json'))) return path
    if (dirname(directory) === directory) return undefined
  }
}
/** The installed package's runtime dependencies, transitively, by directory. */
async function dependencies(root, found = new Map()) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const path = resolvePackage(name, root)
    if (!path || found.has(path)) continue
    found.set(path, name)
    await dependencies(path, found)
  }
  return found
}

/**
 * Packs the installed `@kipster/plugins` as another version, with its dependencies bundled so npm installs it offline.
 * `broken` makes a server that exits before it is ready. Returns the archive with its channel file fields.
 */
export async function pluginsRelease(directory, version, { broken = false } = {}) {
  const source = join(directory, `source-${version}`)
  await cp(pluginsRoot, source, { recursive: true })
  for (const [path, name] of await dependencies(pluginsRoot)) await cp(path, join(source, 'node_modules', name), { recursive: true })
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  manifest.version = version
  manifest.bundleDependencies = Object.keys(manifest.dependencies ?? {})
  delete manifest.scripts
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest, null, 2))
  if (broken) await writeFile(join(source, 'dist/server/cli.js'), "process.stderr.write('broken release\\n'); process.exit(3)\n")
  const output = join(directory, 'archives')
  await mkdir(output, { recursive: true })
  const { stdout } = await promisify(execFile)('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { cwd: source, maxBuffer: 64 * 1024 * 1024 })
  const name = JSON.parse(stdout)[0].filename
  const path = join(output, name)
  const bytes = await readFile(path)
  return { name, path, size: (await stat(path)).size, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Points npm at a private configuration that never reaches the network. Call before Core runs npm. */
export async function offlineNpm(home) {
  await mkdir(join(home, 'npm-cache'), { recursive: true })
  await writeFile(join(home, '.npmrc'), `offline=true\ncache=${join(home, 'npm-cache')}\nupdate-notifier=false\naudit=false\nfund=false\n`)
  process.env.HOME = home
}
