import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { isolatedEnvironment } from './isolation.mjs'

const root = resolve(import.meta.dirname, '..')
// Keep the installed database binaries available, but discard every ambient
// credential/configuration variable. The existing test wrappers own private DBs.
// Installer template tests reject "node" in their plist, including HOME. Keep
// check's private home outside node_modules; instance homes stay in the checkout.
const home = await mkdtemp('/tmp/kipster-factory-check-')
const env = isolatedEnvironment(home, process.env.PATH)
async function run(program, args) {
  console.log(`\n$ ${[program, ...args].join(' ')}`)
  const code = await new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => done(code ?? signal))
  })
  if (code !== 0)
    throw Error(`Check failed (${code}): ${program} ${args.join(' ')}`)
}
async function capture(program, args) {
  console.log(`\n$ ${[program, ...args].join(' ')}`)
  return new Promise((done, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? done(text)
        : reject(Error(`Check preparation failed (${code}): ${program}`)),
    )
  })
}
try {
  if (process.platform === 'darwin') {
    // Select the SDK belonging to the configured developer toolchain instead of
    // an unrelated Command Line Tools SDK. No system configuration is changed.
    if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR
    env.SDKROOT = (
      await capture('xcrun', ['--sdk', 'macosx', '--show-sdk-path'])
    ).trim()
    if (!env.SDKROOT) throw Error('The selected macOS toolchain has no SDK')
  }
  // Missing base refs are a factory checkout blocker, never grounds for skipping.
  await run('git', ['rev-parse', '--verify', 'origin/next^{commit}'])
  const base = await new Promise((done, reject) => {
    const child = spawn(
      'git',
      ['show', 'origin/next:core/protocol-shape.json'],
      { cwd: root, env },
    )
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? done(text) : reject(Error('Missing base protocol shape')),
    )
  })
  const basePath = join(home, 'protocol-shape.json')
  await writeFile(basePath, base)
  await run('npm', ['exec', '--', 'changeset', 'status', '--since=origin/next'])
  const scriptTests = (await readdir(join(root, 'scripts/tests')))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => `scripts/tests/${name}`)
  await run(process.execPath, ['--test', ...scriptTests])
  env.KIPSTER_MIGRATION_BASE = 'origin/next'
  await run('npm', ['run', 'check:migrations', '-w', 'core'])
  await run('npm', ['run', 'test:scripts', '-w', 'core'])
  await run('npm', ['run', 'typecheck', '-w', 'core'])
  await run('npm', ['run', 'check:boundaries', '-w', 'core'])
  await run('npm', [
    'run',
    'protocol:check',
    '-w',
    'core',
    '--',
    '--base',
    basePath,
  ])
  await run('npm', ['run', 'test:postgres', '-w', 'core'])
  await run('npm', ['run', 'test:package', '-w', 'core'])
  await run('npm', ['run', 'check', '-w', 'adapters'])
  await run('npm', ['run', 'test:postgres', '-w', 'installer'])
  if (process.platform === 'darwin')
    await run('npm', ['run', 'build:macos', '-w', 'installer'])
  await run('npm', ['run', 'check', '-w', 'interface/kipster-ui'])
  await run('npm', ['run', 'test:fake-core', '-w', 'interface/kipster-ui'])
  await run('npm', [
    'exec',
    '-w',
    'core',
    '--',
    'tsc',
    '-p',
    'tsconfig.fixture.json',
  ])
  await run(process.execPath, ['--test', '.kipster/tests/kit.test.mjs'])
  const files = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (/\.(md|mjs|yml)$/.test(entry.name)) files.push(path)
    }
  }
  await visit(join(root, '.kipster'))
  files.push(join(root, '.changeset/factory-onboarding.md'))
  await run('npm', [
    'exec',
    '--',
    'prettier',
    '--config',
    'interface/kipster-ui/.prettierrc.json',
    '--check',
    ...files.sort(),
  ])
  for (const file of files.filter((path) => path.endsWith('.mjs')))
    await run(process.execPath, ['--check', file])
  console.log(
    'Factory deterministic gate passed; instance boot and feature driving remain separate system/tester work.',
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
