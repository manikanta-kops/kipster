import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  connectedHTML,
  instanceArguments,
  isolatedEnvironment,
} from '../isolation.mjs'
import { scenarios } from '../verify/scenarios.mjs'

const kitRoot = resolve(import.meta.dirname, '..')
test('instance arguments reject shared databases and malformed or duplicate ports', () => {
  assert.deepEqual(
    instanceArguments([
      '31000',
      '31001',
      'postgresql://fixture@localhost/verify_123',
    ]).ports,
    [31000, 31001],
  )
  for (const args of [
    [],
    ['31000', '31000', 'postgresql://fixture@localhost/verify_123'],
    ['31000', '31001', 'postgresql://fixture@localhost/kipster'],
    ['43120;true', '31001', 'postgresql://fixture@localhost/verify_123'],
    ['0', '31001', 'postgresql://fixture@localhost/verify_123'],
  ]) {
    assert.throws(() => instanceArguments(args))
  }
})
test('environment is constructed without ambient provider credentials and CLI homes', () => {
  const env = isolatedEnvironment('/disposable/home', '/toolchain/bin')
  assert.equal(env.HOME, '/disposable/home')
  assert.equal(env.CODEX_HOME, '/disposable/home/disabled-codex')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/disposable/home/disabled-claude')
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'KIPSTER_DATABASE_URL',
    'KIPSTER_TEST_DATABASE_URL',
    'NODE_OPTIONS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NPM_CONFIG_USERCONFIG',
  ])
    assert.equal(env[key], undefined)
})
test('connection is assigned before the production entry can discover a fixed port', () => {
  const html = connectedHTML(
    '<html><head><script type="module" src="/assets/entry.js"></script></head></html>',
  )
  assert.ok(
    html.indexOf('localStorage.setItem') < html.indexOf('type="module"'),
  )
  assert.ok(html.includes('location.origin'))
  assert.throws(() => connectedHTML('<html></html>'))
})
test('kit declares allocated ports, foreground entry and mandatory trusted-base gate', async () => {
  const kit = parse(await readFile(resolve(kitRoot, 'kit.yml'), 'utf8'))
  assert.deepEqual(Object.keys(kit).sort(), [
    'check',
    'merge',
    'setup',
    'verify',
    'version',
  ])
  assert.equal(kit.version, 1)
  assert.equal(kit.setup, 'npm ci')
  assert.equal(kit.check, 'node .kipster/check.mjs')
  assert.deepEqual(kit.verify, {
    start: 'node .kipster/verify/start.mjs {port} {port2} {databaseUrl}',
    ready: 'http://127.0.0.1:{port}/health',
    ports: 2,
    database: 'postgres',
    timeoutSeconds: 180,
  })
  const start = await readFile(resolve(kitRoot, 'verify/start.mjs'), 'utf8')
  assert.doesNotMatch(start, /import\([^)]*(?:adapters\/|host\.js)/)
  assert.match(start, /fixtureAdapter/)
  assert.match(start, /replaceEnvironment\(isolatedEnvironment\(home\)\)/)
  const check = await readFile(resolve(kitRoot, 'check.mjs'), 'utf8')
  assert.match(check, /origin\/next\^\{commit\}/)
  assert.match(check, /KIPSTER_MIGRATION_BASE = 'origin\/next'/)
})
test('every feature has exactly four ordered nonempty sections and runnable scenario rows', async () => {
  const files = (await readdir(resolve(kitRoot, 'verify/features'))).filter(
    (name) => name.endsWith('.md'),
  )
  assert.ok(files.length >= 1)
  const mapped = new Set()
  for (const file of files) {
    const text = await readFile(
      resolve(kitRoot, 'verify/features', file),
      'utf8',
    )
    assert.deepEqual(
      [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      [
        'Sub-features',
        'How to get to it (user point of view)',
        'Driving it',
        'Gotchas',
      ],
      file,
    )
    const sections = text.split(/^## .+$/m).slice(1)
    assert.ok(
      sections.every((section) => section.trim().length),
      file,
    )
    const table = sections[2]
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('|'))
    assert.deepEqual(
      table[0]
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
      ['User action', 'Exact command', 'Observable result'],
    )
    assert.ok(table.length > 2, file)
    for (const row of table.slice(2)) {
      const cells = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      assert.equal(cells.length, 3, file)
      assert.ok(cells.every(Boolean), file)
      const scenario = /`node \.kipster\/verify\/drive\.mjs ([a-z-]+)`/.exec(
        cells[1],
      )?.[1]
      assert.ok(scenarios.includes(scenario), `${file}: ${cells[1]}`)
      mapped.add(scenario)
    }
  }
  assert.deepEqual([...mapped].sort(), [...scenarios].sort())
})
test('context links resolve to existing repository documents', async () => {
  const text = await readFile(resolve(kitRoot, 'context/index.md'), 'utf8')
  for (const match of text.matchAll(/\]\(([^)]+)\)/g))
    assert.ok(
      (
        await stat(resolve(kitRoot, 'context', match[1].split('#')[0]))
      ).isFile(),
      match[1],
    )
})
