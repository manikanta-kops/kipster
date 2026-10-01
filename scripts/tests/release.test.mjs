import test from 'node:test'
import assert from 'node:assert/strict'
import { notes, packages, plan } from '../release.mjs'

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
