import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import ts from '@typescript/typescript6'

const runtime = 'core/src/runtime.ts'
const isMigration = name => /\/migrations\/.*\.sql$/.test(name)
const git = (directory, args) => execFileSync('git', ['-C', directory, ...args], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })

async function diskFiles(directory, relative = 'core/src') {
  const files = []
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${name}`)
    if (entry.isDirectory()) files.push(...await diskFiles(directory, name))
    else if (isMigration(name)) files.push(name)
  }
  return files
}

async function migrationFiles(directory, ref) {
  const names = ref
    ? git(directory, ['ls-tree', '-r', '-z', '--name-only', ref, '--', 'core/src']).toString('utf8').split('\0').filter(isMigration)
    : await diskFiles(directory)
  return Promise.all(names.map(async name => {
    const version = path.posix.basename(name)
    const match = /^(\d{3})_.+\.sql$/.exec(version)
    if (!match || Number(match[1]) === 0) throw new Error(`Invalid migration filename ${name}; use NNN_name.sql with a positive three-digit number.`)
    const contents = ref ? git(directory, ['show', `${ref}:${name}`]) : await readFile(path.join(directory, name))
    return { path: name, version, number: Number(match[1]), contents }
  }))
}

function runtimePaths(source, directory) {
  const tree = ts.createSourceFile(runtime, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const loader = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadMigrations')
  const declarations = loader?.body?.statements.filter(ts.isVariableStatement).flatMap(node =>
    node.declarationList.flags & ts.NodeFlags.Const ? [...node.declarationList.declarations] : []) ?? []
  const lists = declarations.filter(node => ts.isIdentifier(node.name) && node.name.text === 'paths')
  const list = lists[0]?.initializer
  if (tree.parseDiagnostics.length || lists.length !== 1 || !list || !ts.isArrayLiteralExpression(list) || !list.elements.every(ts.isStringLiteral)) {
    throw new Error('Keep loadMigrations() paths in runtime.ts as a literal array of migration paths so CI can check its order.')
  }
  if (!list.elements.every(node => node.text.startsWith('./'))) throw new Error('runtime.ts migration paths must start with ./ and point to migration files under core/src.')
  const location = pathToFileURL(path.join(directory, runtime))
  return list.elements.map(node => path.relative(directory, fileURLToPath(new URL(node.text, location))).split(path.sep).join('/'))
}

async function orderedManifest(directory, ref, files) {
  const sorted = [...files].sort((a, b) => a.number - b.number || a.path.localeCompare(b.path))
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1], current = sorted[index]
    if (previous.number === current.number) {
      const number = String(current.number).padStart(3, '0')
      throw new Error(`Duplicate migration number ${number}: ${previous.path} and ${current.path}. Before merging, update from next and number the unshipped migration above the latest number; add a new migration instead of editing ${number}. If already merged, stop rollout and have the owner resolve the conflicting merge; restore a compatible Core and database backup if it was applied. Appending a file cannot remove a duplicate shipped number.`)
    }
  }
  const source = ref ? git(directory, ['show', `${ref}:${runtime}`]).toString('utf8') : await readFile(path.join(directory, runtime), 'utf8')
  const listed = runtimePaths(source, directory)
  const expected = sorted.map(file => file.path)
  if (listed.length !== expected.length || listed.some((name, index) => name !== expected[index])) {
    throw new Error(`runtime.ts migration list must match every migration file on disk once, in number order. Update loadMigrations() to list:\n${expected.join('\n')}\nKeep shipped files unchanged; add a new migration instead of editing an existing number.`)
  }
  return sorted
}

/** Read a commit's SQL and ordered runtime list without executing that commit's code. */
export async function readMigrationManifest(directory, ref) {
  return orderedManifest(directory, ref, await migrationFiles(directory, ref))
}

export async function checkMigrations(directory, baseRef) {
  // Resolve first: a missing/shallow base must fail, never silently disable the freeze.
  const base = git(directory, ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`]).toString('utf8').trim()
  const before = await migrationFiles(directory, base)
  const current = await migrationFiles(directory)
  const byPath = new Map(current.map(file => [file.path, file]))
  for (const file of before) {
    const next = byPath.get(file.path)
    if (!next || !next.contents.equals(file.contents)) {
      const number = String(file.number).padStart(3, '0')
      throw new Error(`Shipped migration ${file.path} was ${next ? 'edited' : 'deleted or moved'}. Restore it byte-for-byte; add a new migration instead of editing ${number}.`)
    }
  }
  const highest = Math.max(0, ...before.map(file => file.number))
  const oldPaths = new Set(before.map(file => file.path))
  for (const file of current) {
    if (!oldPaths.has(file.path) && file.number <= highest) {
      const number = String(file.number).padStart(3, '0')
      throw new Error(`New migration ${file.path} must have a number above ${String(highest).padStart(3, '0')}. Update from next and give the unshipped migration the next unused number; add a new migration instead of editing ${number}. If this collision has already merged, stop rollout and have the owner resolve the conflicting merge before shipping; restore a compatible Core and database backup if it was applied.`)
    }
  }
  return orderedManifest(directory, undefined, current)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { base: { type: 'string', default: process.env.KIPSTER_MIGRATION_BASE ?? 'origin/next' } } })
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim()
    const migrations = await checkMigrations(root, values.base)
    console.log(`Database migration freeze passed against ${values.base} (${migrations.length} migrations).`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
