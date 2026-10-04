#!/usr/bin/env node
// Builds the Kipster backend app (bundle ID app.kipster.backend) for Apple Silicon.
//
//   node native/build.mjs [--out DIR] [--identity NAME] [--keychain FILE]
//
// Writes DIR/Kipster.app (default: launchers/macos, which npm packs). Without
// --identity the bundle is signed ad hoc, which is enough for tests but gives
// no stable privacy identity. Release builds pass the Developer ID identity;
// they are signed with the hardened runtime and a secure timestamp.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const bundleIdentifier = 'app.kipster.backend'
const native = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = resolve(native, '..')
const icon = resolve(packageRoot, '../interface/kipster-ui/src-tauri/icons/icon.icns')

export function build({ out = join(packageRoot, 'launchers/macos'), identity = '-', keychain, version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version } = {}) {
  if (process.platform !== 'darwin') throw new Error('Build the Kipster backend app on macOS.')
  const work = mkdtempSync(join(tmpdir(), 'kipster-backend-app-'))
  try {
    const app = join(work, 'Kipster.app'), contents = join(app, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, 'Resources'), { recursive: true })
    execFileSync('xcrun', ['clang', '-arch', 'arm64', '-mmacosx-version-min=13.0', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror',
      '-framework', 'Foundation', '-o', join(contents, 'MacOS/Kipster'), join(native, 'Kipster.m')], { stdio: 'inherit' })
    writeFileSync(join(contents, 'Info.plist'), readFileSync(join(native, 'Info.plist'), 'utf8').replaceAll('@VERSION@', version))
    writeFileSync(join(contents, 'PkgInfo'), 'APPL????')
    if (existsSync(icon)) copyFileSync(icon, join(contents, 'Resources/Kipster.icns'))
    execFileSync('/usr/bin/plutil', ['-lint', '-s', join(contents, 'Info.plist')], { stdio: 'inherit' })
    // The default designated requirement (identifier and signing team) stays the
    // same across builds and versions, so one macOS grant survives updates.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--identifier', bundleIdentifier, '--options', 'runtime',
      ...(identity === '-' ? [] : ['--timestamp']), ...(keychain ? ['--keychain', keychain] : []), app], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', app], { stdio: 'inherit' })
    mkdirSync(out, { recursive: true })
    const target = join(out, 'Kipster.app')
    rmSync(target, { recursive: true, force: true })
    renameSync(app, target)
    return target
  } finally { rmSync(work, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--out': 'out', '--identity': 'identity', '--keychain': 'keychain' }[args[i]]
    if (!key || !args[i + 1]) { console.error('usage: node native/build.mjs [--out DIR] [--identity NAME] [--keychain FILE]'); process.exit(64) }
    options[key] = key === 'out' ? resolve(args[i + 1]) : args[i + 1]
  }
  console.log(build(options))
}
