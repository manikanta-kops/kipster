// Release steps. `prepare` runs locally; the others run in GitHub workflows.
//   node scripts/release.mjs prepare            open a release pull request into next from the pending changesets
//   node scripts/release.mjs plan [names]       packages=<json> of unreleased versions, for $GITHUB_OUTPUT
//   node scripts/release.mjs build <name> <dir> build one package's release files into <dir>
//   node scripts/release.mjs metadata <name> <dir> refresh hashes after notarization/stapling
//   node scripts/release.mjs notes <name>       that version's changelog section
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })

export function packages() {
  return read(join(root, 'package.json')).workspaces
    .flatMap(pattern => pattern.endsWith('/*')
      ? readdirSync(join(root, pattern.slice(0, -2))).map(name => join(pattern.slice(0, -2), name)).filter(dir => existsSync(join(root, dir, 'package.json')))
      : [pattern])
    .map(dir => {
      const { name, version } = read(join(root, dir, 'package.json'))
      const app = existsSync(join(root, dir, 'src-tauri'))
      return { name, dir, version, app, tag: `${name.replace(/^@kipster\//, '')}-v${version}`, runner: app ? 'macos-latest' : 'ubuntu-latest' }
    })
}

export function plan(list, tags, only = []) {
  return list.filter(pkg => pkg.version !== '0.0.0' && !tags.has(pkg.tag) && (!only.length || only.includes(pkg.name) || only.includes(pkg.name.replace(/^@kipster\//, ''))))
}

export function notes(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.indexOf(`## ${version}`)
  if (start < 0) return `Version ${version}.`
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}

function find(name) {
  const pkg = packages().find(item => item.name === name || item.name === `@kipster/${name}`)
  if (!pkg) throw new Error(`Unknown package: ${name}`)
  return pkg
}

export function appBuildArgs(env = process.env) {
  return ['run', 'tauri', '-w', 'interface/kipster-ui', '--', 'build', '--ci',
    '--target', 'aarch64-apple-darwin', '--bundles', 'app,dmg',
    '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: Boolean(env.TAURI_SIGNING_PRIVATE_KEY?.trim()) } })]
}

export function copyAppArtifacts(pkg, bundle, out, signed) {
  const dmg = readdirSync(join(bundle, 'dmg')).filter(name => name.endsWith(`_${pkg.version}_aarch64.dmg`))
  if (dmg.length !== 1) throw new Error(`Expected one aarch64 DMG for ${pkg.version}.`)
  const sources = [join(bundle, 'dmg', dmg[0])]
  if (signed) sources.push(join(bundle, 'macos', 'Kipster.app.tar.gz'), join(bundle, 'macos', 'Kipster.app.tar.gz.sig'))
  return sources.map(source => {
    copyFileSync(source, join(out, basename(source)))
    return join(out, basename(source))
  })
}

export function writeReleaseMetadata(pkg, out, range) {
  const files = readdirSync(out).filter(name => name !== 'release.json').sort().map(name => {
    const bytes = readFileSync(join(out, name))
    return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  if (!files.length) throw new Error(`No release files were produced for ${pkg.name}.`)
  const metadata = { schemaVersion: 1, package: pkg.name, version: pkg.version, files }
  if (pkg.name === '@kipster/core' || pkg.app) {
    if (!Number.isSafeInteger(range?.current) || !Number.isSafeInteger(range?.oldest) || range.oldest < 1 || range.current < range.oldest) {
      throw new Error('A valid build-time protocolRange is required.')
    }
    if (pkg.app) metadata.protocol = range.current
    else metadata.protocolRange = { current: range.current, oldest: range.oldest }
  }
  if (pkg.app) {
    const archive = files.find(file => file.name.endsWith('.app.tar.gz'))
    if (archive) {
      const signature = readFileSync(join(out, `${archive.name}.sig`), 'utf8').trim()
      if (!signature) throw new Error('The updater signature is empty.')
      metadata.updater = { platform: 'darwin-aarch64', file: archive.name, signature }
    }
  }
  writeFileSync(join(out, 'release.json'), JSON.stringify(metadata, null, 2) + '\n')
  return metadata
}

async function metadata(pkg, out) {
  if (pkg.name !== '@kipster/core' && !pkg.app) {
    writeReleaseMetadata(pkg, out)
    return join(out, 'release.json')
  }
  const { protocolRange } = await import(pathToFileURL(join(root, 'core/dist/protocol/version.js')))
  writeReleaseMetadata(pkg, out, protocolRange)
  return join(out, 'release.json')
}

async function build(pkg, out) {
  mkdirSync(out, { recursive: true })
  if (readdirSync(out).length) throw new Error('Use an empty output directory for release files.')
  if (pkg.name !== '@kipster/core' && pkg.name !== '@kipster/installer') run('npm', ['run', 'build', '-w', 'core'])
  if (!pkg.app) {
    run('npm', ['pack', '-w', pkg.dir, '--pack-destination', out])
    const tarball = join(out, `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`)
    if (!existsSync(tarball)) throw new Error(`No release tarball was produced for ${pkg.name}.`)
    return [tarball, await metadata(pkg, out)]
  }
  const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim())
  if (signed && !read(join(root, pkg.dir, 'src-tauri/tauri.conf.json')).plugins?.updater?.pubkey?.trim()) {
    throw new Error('Commit the public key from scripts/setup-updater-key.sh before signing app releases.')
  }
  run('npm', appBuildArgs())
  const target = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, pkg.dir, 'src-tauri/target')
  const files = copyAppArtifacts(pkg, join(target, 'aarch64-apple-darwin/release/bundle'), out, signed)
  return [...files, await metadata(pkg, out)]
}

function prepare() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  if (git('status', '--porcelain')) throw new Error('Commit or stash your changes before preparing a release.')
  run('git', ['fetch', '--quiet', '--tags', 'origin', 'next'])
  const pending = git('ls-tree', '--name-only', 'origin/next', '.changeset/').split('\n').filter(path => path.endsWith('.md') && !path.endsWith('/README.md'))
  if (!pending.length) throw new Error('next has no changesets to release.')
  const branch = `release/${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`
  run('git', ['switch', '--quiet', '-c', branch, 'origin/next'])
  const before = new Map(packages().map(pkg => [pkg.name, pkg.version]))
  run('npx', ['changeset', 'version'])
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'])
  const released = packages().filter(pkg => before.get(pkg.name) !== pkg.version)
  const title = `Release ${released.map(pkg => `${pkg.name.replace(/^@kipster\//, '')} ${pkg.version}`).join(', ')}`
  const body = released.map(pkg => `## ${pkg.name} ${pkg.version}\n\n${notes(readFileSync(join(root, pkg.dir, 'CHANGELOG.md'), 'utf8'), pkg.version)}`).join('\n\n')
  run('git', ['add', '-A'])
  run('git', ['commit', '--quiet', '-m', title])
  run('git', ['push', '--quiet', '-u', 'origin', branch])
  run('gh', ['pr', 'create', '--base', 'next', '--head', branch, '--title', title, '--body', `${body}\n\nAfter merging, open a pull request from \`next\` to \`master\` to publish these versions.`])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, name, out] = process.argv.slice(2)
  if (command === 'prepare') {
    prepare()
  } else if (command === 'plan') {
    const tags = new Set(execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n'))
    console.log(`packages=${JSON.stringify(plan(packages(), tags, (name ?? '').split(',').map(item => item.trim()).filter(Boolean)))}`)
  } else if (command === 'build' && name && out) {
    const files = await build(find(name), resolve(out))
    console.log(files.join('\n'))
  } else if (command === 'metadata' && name && out) {
    console.log(await metadata(find(name), resolve(out)))
  } else if (command === 'notes' && name) {
    const pkg = find(name)
    const changelog = join(root, pkg.dir, 'CHANGELOG.md')
    console.log(existsSync(changelog) ? notes(readFileSync(changelog, 'utf8'), pkg.version) : `Version ${pkg.version}.`)
  } else {
    console.error('Usage: node scripts/release.mjs prepare | plan [names] | build <name> <dir> | metadata <name> <dir> | notes <name>')
    process.exitCode = 2
  }
}
