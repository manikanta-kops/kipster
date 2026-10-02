import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appBuildArgs, copyAppArtifacts, notes, packages, plan, writeReleaseMetadata } from '../release.mjs'

const list = [
  { name: '@kipster/core', version: '0.2.0', tag: 'core-v0.2.0' },
  { name: '@kipster/codex-cli', version: '0.1.0', tag: 'codex-cli-v0.1.0' },
  { name: '@kipster/ui', version: '0.3.0-next.20261001120000', tag: 'ui-v0.3.0-next.20261001120000' },
  { name: '@kipster/embedding-ollama', version: '0.0.0', tag: 'embedding-ollama-v0.0.0' },
]

test('release plan covers every workspace package, and only the app builds on macOS', () => {
  const found = packages()
  assert.deepEqual(found.map(pkg => pkg.name).sort(), ['@kipster/codex-cli', '@kipster/core', '@kipster/embedding-ollama', '@kipster/transcription-spokenly', '@kipster/ui'])
  assert.deepEqual(found.filter(pkg => pkg.runner === 'macos-latest').map(pkg => pkg.name), ['@kipster/ui'])
})

test('release plan skips released tags and unversioned packages, and honours a package filter', () => {
  const tags = new Set(['codex-cli-v0.1.0'])
  assert.deepEqual(plan(list, tags).map(pkg => pkg.tag), ['core-v0.2.0', 'ui-v0.3.0-next.20261001120000'])
  assert.deepEqual(plan(list, tags, ['ui']).map(pkg => pkg.name), ['@kipster/ui'])
  assert.deepEqual(plan(list, tags, ['@kipster/core', 'codex-cli']).map(pkg => pkg.name), ['@kipster/core'])
})

test('release notes are the changelog section for exactly that version', () => {
  const changelog = '# @kipster/core\n\n## 0.2.0\n\n### Minor Changes\n\n- Add scheduled runs.\n\n## 0.1.0\n\n- First beta release.\n'
  assert.equal(notes(changelog, '0.2.0'), '### Minor Changes\n\n- Add scheduled runs.')
  assert.equal(notes(changelog, '0.1.0'), '- First beta release.')
  assert.equal(notes(changelog, '0.3.0'), 'Version 0.3.0.')
})

const directory = t => {
  const path = mkdtempSync(join(tmpdir(), 'kipster-release-test-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('release metadata records all artifact bytes and the build-time Core protocol range', t => {
  const out = directory(t)
  const file = 'kipster-core-0.2.0.tgz'
  writeFileSync(join(out, file), 'packed Core')
  const pkg = { name: '@kipster/core', version: '0.2.0', app: false }
  const metadata = writeReleaseMetadata(pkg, out, { current: 3, oldest: 2 })
  assert.deepEqual(metadata, {
    schemaVersion: 1, package: '@kipster/core', version: '0.2.0', protocolRange: { current: 3, oldest: 2 },
    files: [{ name: file, size: 11, sha256: createHash('sha256').update('packed Core').digest('hex') }],
  })
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')), metadata)
  writeFileSync(join(out, file), 'final stapled bytes')
  const refreshed = writeReleaseMetadata(pkg, out, { current: 3, oldest: 2 })
  assert.equal(refreshed.files.length, 1)
  assert.equal(refreshed.files[0].size, 19)
  assert.equal(refreshed.files[0].sha256, createHash('sha256').update('final stapled bytes').digest('hex'))
})

test('adapter metadata needs no protocol fields and empty releases are rejected', t => {
  const out = directory(t)
  const pkg = { name: '@kipster/codex-cli', version: '0.1.0', app: false }
  assert.throws(() => writeReleaseMetadata(pkg, out), /No release files/)
  writeFileSync(join(out, 'kipster-codex-cli-0.1.0.tgz'), 'adapter')
  assert.equal(writeReleaseMetadata(pkg, out).protocolRange, undefined)
  assert.throws(() => writeReleaseMetadata({ ...pkg, name: '@kipster/core' }, out), /protocolRange/)
})

test('app builds explicitly target Apple Silicon, sign with a key, and stay unsigned without one', () => {
  const signed = appBuildArgs({ TAURI_SIGNING_PRIVATE_KEY: 'test-key' })
  assert.equal(signed[signed.indexOf('--target') + 1], 'aarch64-apple-darwin')
  assert.equal(signed[signed.indexOf('--bundles') + 1], 'app,dmg')
  assert.deepEqual(JSON.parse(signed.at(-1)), { bundle: { createUpdaterArtifacts: true } })
  for (const env of [{}, { TAURI_SIGNING_PRIVATE_KEY: '' }, { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'password-only' }]) {
    assert.deepEqual(JSON.parse(appBuildArgs(env).at(-1)), { bundle: { createUpdaterArtifacts: false } })
  }
})

test('signed app metadata carries the archive signature, protocol and hashes for the DMG and signature file', t => {
  const bundle = directory(t), out = directory(t)
  mkdirSync(join(bundle, 'dmg'))
  mkdirSync(join(bundle, 'macos'))
  const pkg = { name: '@kipster/ui', version: '0.3.0-next.123', app: true }
  const dmg = `Kipster_${pkg.version}_aarch64.dmg`
  writeFileSync(join(bundle, 'dmg', dmg), 'disk image')
  writeFileSync(join(bundle, 'dmg', 'Kipster_0.1.0_aarch64.dmg'), 'stale disk image')
  writeFileSync(join(bundle, 'macos', 'Kipster.app.tar.gz'), 'updater archive')
  writeFileSync(join(bundle, 'macos', 'Kipster.app.tar.gz.sig'), 'updater-signature\n')
  assert.equal(copyAppArtifacts(pkg, bundle, out, true).length, 3)
  const metadata = writeReleaseMetadata(pkg, out, { current: 4, oldest: 3 })
  assert.equal(metadata.protocol, 4)
  assert.equal(metadata.protocolRange, undefined)
  assert.deepEqual(metadata.updater, { platform: 'darwin-aarch64', file: 'Kipster.app.tar.gz', signature: 'updater-signature' })
  assert.deepEqual(metadata.files.map(file => file.name), ['Kipster.app.tar.gz', 'Kipster.app.tar.gz.sig', dmg])
  for (const file of metadata.files) {
    const bytes = readFileSync(join(out, file.name))
    assert.equal(file.size, bytes.length)
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
  }
})

test('unsigned app releases copy only the DMG, even if stale updater files exist', t => {
  const bundle = directory(t), out = directory(t)
  mkdirSync(join(bundle, 'dmg'))
  mkdirSync(join(bundle, 'macos'))
  const pkg = { name: '@kipster/ui', version: '0.1.0', app: true }
  writeFileSync(join(bundle, 'dmg', 'Kipster_0.1.0_aarch64.dmg'), 'unsigned DMG')
  writeFileSync(join(bundle, 'macos', 'Kipster.app.tar.gz'), 'stale archive')
  assert.equal(copyAppArtifacts(pkg, bundle, out, false).length, 1)
  const metadata = writeReleaseMetadata(pkg, out, { current: 1, oldest: 1 })
  assert.equal(metadata.protocol, 1)
  assert.equal(metadata.updater, undefined)
  assert.throws(() => copyAppArtifacts(pkg, bundle, directory(t), true), /ENOENT/)
})
