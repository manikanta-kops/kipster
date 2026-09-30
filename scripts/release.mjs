// Release steps shared by the GitHub workflows. Run after `changeset version`.
//   node scripts/release.mjs plan [names]       packages=<json> of unreleased versions, for $GITHUB_OUTPUT
//   node scripts/release.mjs build <name> <dir> build one package's release files into <dir>
//   node scripts/release.mjs notes <name>       that version's changelog section
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function build(pkg, out) {
  mkdirSync(out, { recursive: true })
  if (pkg.name !== '@kipster/core') run('npm', ['run', 'build', '-w', 'core'])
  if (!pkg.app) {
    run('npm', ['pack', '-w', pkg.dir, '--pack-destination', out])
    const tarball = join(out, `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`)
    return existsSync(tarball) ? [tarball] : []
  }
  run('npm', ['run', 'tauri', '-w', pkg.dir, '--', 'build', '--ci', '--bundles', 'dmg'])
  const dmg = join(root, pkg.dir, 'src-tauri/target/release/bundle/dmg')
  return readdirSync(dmg).filter(name => name.endsWith('.dmg') && name.includes(`_${pkg.version}_`)).map(name => {
    copyFileSync(join(dmg, name), join(out, basename(name)))
    return join(out, basename(name))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, name, out] = process.argv.slice(2)
  if (command === 'plan') {
    const tags = new Set(execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n'))
    console.log(`packages=${JSON.stringify(plan(packages(), tags, (name ?? '').split(',').map(item => item.trim()).filter(Boolean)))}`)
  } else if (command === 'build' && name && out) {
    const files = build(find(name), resolve(out))
    if (!files.length) throw new Error(`No release files were produced for ${name}.`)
    console.log(files.join('\n'))
  } else if (command === 'notes' && name) {
    const pkg = find(name)
    const changelog = join(root, pkg.dir, 'CHANGELOG.md')
    console.log(existsSync(changelog) ? notes(readFileSync(changelog, 'utf8'), pkg.version) : `Version ${pkg.version}.`)
  } else {
    console.error('Usage: node scripts/release.mjs plan [names] | build <name> <dir> | notes <name>')
    process.exitCode = 2
  }
}
