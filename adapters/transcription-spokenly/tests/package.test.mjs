import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Command failed (${code}): ${stdout}\n${stderr}`)))
  })
}

test('packing a clean source tree builds both exported entry points and supports an isolated runtime import', { timeout: 90000 }, async t => {
  const source = fileURLToPath(new URL('../', import.meta.url))
  const root = await mkdtemp(join(tmpdir(), 'kipster-spokenly-package-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const clean = join(root, 'source'), consumer = join(root, 'consumer')
  await mkdir(clean); await mkdir(consumer)
  for (const name of ['package.json', 'README.md', 'tsconfig.json', 'src']) await cp(join(source, name), join(clean, name), { recursive: true })
  // Reuse installed development dependencies read-only; pack builds only the temporary source tree.
  await symlink(join(source, 'node_modules'), join(clean, 'node_modules'), 'dir')
  assert.equal((await readdir(clean)).includes('dist'), false)
  const env = { ...process.env, npm_config_cache: join(root, 'npm-cache'), NODE_OPTIONS: '', NODE_PATH: '' }
  await run('npm', ['pack', '--pack-destination', root], clean, env)
  const tarball = (await readdir(root)).find(name => name.endsWith('.tgz'))
  assert.ok(tarball)
  await run('tar', ['-xzf', join(root, tarball), '-C', consumer], root, env)
  const packed = join(consumer, 'package')
  const manifest = JSON.parse(await readFile(join(packed, 'package.json'), 'utf8'))
  assert.ok((await readFile(join(packed, manifest.exports['.'].types), 'utf8')).includes('createTranscriptionProvider'))
  const imported = await import(pathToFileURL(join(packed, manifest.exports['.'].import)).href)
  assert.equal(typeof imported.createTranscriptionProvider, 'function')
  assert.equal((await readdir(packed)).includes('node_modules'), false)
  assert.equal((await readdir(packed)).includes('src'), false)
})
