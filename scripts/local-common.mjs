import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = fileURLToPath(new URL('../', import.meta.url))
export async function exists(path) {
  try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')) }
export async function saveJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error(`Expected an owned directory: ${path}`)
  await chmod(path, 0o700)
}
export function run(program, args, { cwd = repository, env = process.env, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
    let output = '', errorOutput = ''
    child.stdout?.on('data', bytes => { output = (output + bytes).slice(-2_000_000) })
    child.stderr?.on('data', bytes => { errorOutput = (errorOutput + bytes).slice(-100_000) })
    const interrupt = signal => child.kill(signal)
    const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM')
    process.once('SIGINT', sigint); process.once('SIGTERM', sigterm)
    const clean = () => { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm) }
    child.once('error', error => { clean(); reject(error) })
    child.once('close', (code, signal) => {
      clean()
      if (code === 0 || (allowFailure && !signal)) resolve({ code, output: output.trim(), error: errorOutput.trim() })
      else reject(new Error(`${program} failed (${signal ?? code}).${errorOutput ? '\n' + errorOutput.trim() : ''}`))
    })
  })
}
export async function dependencies(directory) {
  const digest = createHash('sha256').update(await readFile(join(directory, 'package-lock.json'))).update(await readFile(join(directory, 'package.json'))).update(process.versions.node).digest('hex')
  const stamp = join(directory, 'node_modules/.kipster-dependencies')
  if (await readFile(stamp, 'utf8').catch(() => '') === digest) return
  await run('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: directory })
  await writeFile(stamp, digest)
}
export async function locked(path, work) {
  await mkdir(dirname(path), { recursive: true })
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Another command is running, or an interrupted command left ${path}. If no command is running, remove only this empty lock directory and retry.`)
  }
  try { return await work() } finally { await rm(path, { recursive: true }) }
}
export async function initializeHome(home) {
  await privateDirectory(home)
  const marker = join(home, 'local-installation.json')
  if (await exists(marker)) {
    const saved = await json(marker)
    if (saved.kind !== 'kipster-development' || saved.version !== 1) throw new Error('This directory is not a supported Kipster development installation.')
    return saved
  }
  if ((await readdir(home)).some(name => name !== '.command-lock')) throw new Error(`Refusing to adopt existing unrecognized data in ${home}. Move it aside and rerun.`)
  const saved = { kind: 'kipster-development', version: 1 }
  await saveJSON(marker, saved)
  return saved
}
