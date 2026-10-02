import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkMigrations, readMigrationManifest } from '../check-migrations.mjs'

const first = 'core/src/platform/postgres/migrations/001_platform.sql'
const last = 'core/src/modules/identity/migrations/013_identity.sql'
const next = 'core/src/modules/work/migrations/014_work.sql'
const other = 'core/src/modules/identity/migrations/014_identity.sql'
const loader = paths => `export async function loadMigrations() { const paths = ${JSON.stringify(paths.map(name => './' + name.slice('core/src/'.length)))}; return paths }\n`
const cli = (f, base = f.base) => spawnSync(process.execPath, [new URL('../check-migrations.mjs', import.meta.url).pathname, '--base', base], { cwd: path.join(f.root, 'core'), encoding: 'utf8' })

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'kipster-migration-check-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const write = (name, content) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), content) }
  const list = paths => write('core/src/runtime.ts', loader(paths))
  const commit = () => { git('add', '.'); git('commit', '-qm', 'throwaway migration fixture'); return git('rev-parse', 'HEAD') }
  git('init', '-q')
  git('config', 'user.name', 'Migration test')
  git('config', 'user.email', 'migration-test@example.invalid')
  write(first, 'CREATE SCHEMA kipster;\n')
  write(last, 'CREATE TABLE kipster.identity(id int);\n')
  list([first, last])
  const base = commit()
  return { root, git, write, list, commit, base }
}

const failures = [
  ['edited migration', f => f.write(first, 'CREATE SCHEMA kipster;\r\n'), /edited.*add a new migration instead of editing 001/],
  ['deleted migration', f => rmSync(path.join(f.root, last)), /deleted or moved.*add a new migration instead of editing 013/],
  ['moved migration', f => { mkdirSync(path.join(f.root, 'core/src/modules/work/migrations'), { recursive: true }); renameSync(path.join(f.root, last), path.join(f.root, 'core/src/modules/work/migrations/013_identity.sql')) }, /deleted or moved/],
  ['low-numbered new migration', f => f.write('core/src/modules/work/migrations/012_retro.sql', 'SELECT 1;'), /above 013.*add a new migration instead of editing 012/],
  ['collision with the base number', f => f.write('core/src/modules/work/migrations/013_collision.sql', 'SELECT 1;'), /above 013.*owner resolve the conflicting merge/],
  ['duplicate new numbers across modules', f => { f.write(next, 'SELECT 1;'); f.write(other, 'SELECT 2;'); f.list([first, last, other, next]) }, /Duplicate migration number 014.*Appending a file cannot remove/],
  ['missing runtime entry', f => { f.write(next, 'SELECT 1;'); f.list([first, last]) }, /runtime.ts migration list must match/],
  ['extra runtime entry', f => f.list([first, last, next]), /runtime.ts migration list must match/],
  ['reordered runtime list', f => f.list([last, first]), /in number order/],
  ['duplicate runtime entry', f => f.list([first, last, last]), /runtime.ts migration list must match/],
  ['computed runtime list', f => f.write('core/src/runtime.ts', "export async function loadMigrations() { const paths = ['./platform/postgres/migrations/001_platform.sql', ...extra] }"), /literal array/],
  ['absolute runtime path', f => f.write('core/src/runtime.ts', "export async function loadMigrations() { const paths = ['/platform/postgres/migrations/001_platform.sql'] }"), /migration paths must start with/],
  ['invalid filename', f => f.write('core/src/modules/work/migrations/unordered.sql', 'SELECT 1;'), /use NNN_name.sql/],
]

for (const [name, mutate, message] of failures) {
  test(`freeze rejects ${name} in a throwaway commit`, async t => {
    const f = fixture(t)
    mutate(f)
    f.commit()
    await assert.rejects(checkMigrations(f.root, f.base), message)
    const result = cli(f)
    assert.equal(result.status, 1)
    assert.match(result.stderr, message)
    if (['edited migration', 'deleted migration', 'low-numbered new migration', 'missing runtime entry'].includes(name)) t.diagnostic(`exit ${result.status}: ${result.stderr.trim().split('\n')[0]}`)
  })
}

test('unchanged migrations and a valid new migration pass against the actual base commit', async t => {
  const f = fixture(t)
  assert.equal((await checkMigrations(f.root, f.base)).length, 2)
  f.write(next, 'SELECT 1;\n')
  f.list([first, last, next])
  f.commit()
  const files = await checkMigrations(f.root, f.base)
  assert.deepEqual(files.map(file => file.version), ['001_platform.sql', '013_identity.sql', '014_work.sql'])
  const result = cli(f)
  assert.equal(result.status, 0, result.stderr)
  t.diagnostic(`exit ${result.status}: ${result.stdout.trim()}`)
  // The upgrade input comes from git, including its list, rather than the working files.
  f.write(first, 'not the base SQL')
  assert.equal((await readMigrationManifest(f.root, f.base))[0].contents.toString(), 'CREATE SCHEMA kipster;\n')
})

test('parallel 014 additions pass separately, then fail on the push after the second merge', async t => {
  const f = fixture(t)
  f.write(next, 'SELECT 1;')
  f.list([first, last, next])
  const firstMerge = f.commit()
  assert.equal((await checkMigrations(f.root, f.base)).length, 3)
  f.git('checkout', '-q', f.base)
  f.write(other, 'SELECT 2;')
  f.list([first, last, other])
  f.commit()
  assert.equal((await checkMigrations(f.root, f.base)).length, 3)
  f.git('checkout', '-q', firstMerge)
  f.write(other, 'SELECT 2;')
  f.list([first, last, other, next])
  f.commit()
  await assert.rejects(checkMigrations(f.root, firstMerge), /above 014.*owner resolve the conflicting merge/)
  // A later push still catches the duplicate even when both files are in its base.
  await assert.rejects(checkMigrations(f.root, 'HEAD'), /Duplicate migration number 014/)
})

test('a missing base fails closed and the script CLI reports failures', async t => {
  const f = fixture(t)
  await assert.rejects(checkMigrations(f.root, 'missing-base'))
  f.write(first, readFileSync(path.join(f.root, first), 'utf8') + '-- edit\n')
  f.commit()
  const result = cli(f)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /add a new migration instead of editing 001/)
})
