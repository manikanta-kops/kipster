import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { channelsFromGitHub, compareVersions, generateChannels, writeSite } from '../channels.mjs'
import { writeReleaseMetadata } from '../release.mjs'

function release(name, version, { signed = false, date = '2026-10-02T09:00:00Z', draft = false } = {}) {
  const tag = `${name}-v${version}`
  const file = name === 'ui' ? `Kipster_${version}_aarch64.dmg` : `kipster-${name}-${version}.tgz`
  const files = [{ name: file, size: 42, sha256: 'a'.repeat(64) }]
  const metadata = { schemaVersion: 1, package: `@kipster/${name}`, version, files }
  if (name === 'core') metadata.protocolRange = { current: 2, oldest: 1 }
  if (name === 'ui') {
    metadata.protocol = 2
    if (signed) {
      files.push({ name: 'Kipster.app.tar.gz', size: 100, sha256: 'b'.repeat(64) }, { name: 'Kipster.app.tar.gz.sig', size: 64, sha256: 'c'.repeat(64) })
      metadata.updater = { platform: 'darwin-aarch64', file: 'Kipster.app.tar.gz', signature: `signature-for-${version}` }
    }
  }
  return {
    tag_name: tag, prerelease: version.split('+')[0].includes('-'), draft, published_at: date, body: `Notes for ${tag}.`, metadata,
    assets: [...files.map(file => ({ ...file, digest: `sha256:${file.sha256}`, browser_download_url: `https://github.com/manikanta-kops/kipster/releases/download/${tag}/${file.name}` })), { name: 'release.json', id: tag }],
  }
}

const generate = releases => generateChannels(releases, (_asset, release) => release.metadata)

test('semver precedence follows numeric identifiers, stable versions, and build metadata', () => {
  const ordered = ['0.9.0', '0.10.0-next.2', '0.10.0-next.10', '0.10.0', '0.11.0-alpha', '0.11.0-alpha.2', '0.11.0-alpha.beta', '0.11.0-beta', '0.11.0']
  for (let index = 1; index < ordered.length; index++) assert.ok(compareVersions(ordered[index], ordered[index - 1]) > 0)
  assert.equal(compareVersions('1.0.0+first', '1.0.0+second'), 0)
  assert.equal(compareVersions('1.0.0-next.9007199254740993', '1.0.0-next.9007199254740992'), 1)
  for (const version of ['v1.0.0', '01.0.0', '1.0', '1.0.0-next.01', '1.0.0-', '1.0.0+']) assert.throws(() => compareVersions(version, '1.0.0'), /Invalid semver/)
})

test('channels select independently per package by semver, including stable fallback on next', async () => {
  const site = await generate([
    release('core', '0.3.0-next.9'), release('codex-cli', '0.3.0-next.10'),
    release('core', '0.3.0', { date: '2026-09-01T09:00:00Z' }), release('codex-cli', '0.2.0'),
    release('core', '0.2.0', { date: '2026-10-03T09:00:00Z' }), release('ui', '0.1.0-next.12'),
    release('embedding-ollama', '0.2.0'),
  ])
  const stable = site['v1/stable.json'].packages, next = site['v1/next.json'].packages
  assert.equal(stable['@kipster/core'].version, '0.3.0')
  assert.equal(next['@kipster/core'].version, '0.3.0')
  assert.equal(next['@kipster/codex-cli'].version, '0.3.0-next.10')
  assert.equal(stable['@kipster/codex-cli'].version, '0.2.0')
  assert.equal(next['@kipster/embedding-ollama'].version, '0.2.0')
  assert.equal(next['@kipster/ui'].version, '0.1.0-next.12')
  assert.equal(stable['@kipster/ui'], undefined)
  assert.deepEqual(site['v1/releases.json'].packages['@kipster/core'].map(entry => entry.version), ['0.3.0', '0.3.0-next.9', '0.2.0'])
  assert.deepEqual(next['@kipster/core'].protocolRange, { current: 2, oldest: 1 })
  assert.equal(next['@kipster/ui'].protocol, 2)
  assert.equal(next['@kipster/ui'].updater, null)
  assert.match(next['@kipster/core'].notes, /Notes for/)
  assert.equal(next['@kipster/core'].publishedAt, '2026-09-01T09:00:00Z')
  assert.deepEqual(next['@kipster/core'].files[0], {
    name: 'kipster-core-0.3.0.tgz', size: 42, sha256: 'a'.repeat(64),
    url: 'https://github.com/manikanta-kops/kipster/releases/download/core-v0.3.0/kipster-core-0.3.0.tgz',
  })
})

test('Tauri manifests contain the signed archive URL and signature in the exact v2 static shape', async () => {
  const site = await generate([release('ui', '0.3.0', { signed: true }), release('ui', '0.4.0-next.10', { signed: true }), release('ui', '0.4.0-next.2', { signed: true })])
  const app = site['v1/app/next.json']
  assert.deepEqual(app, {
    version: '0.4.0-next.10', notes: 'Notes for ui-v0.4.0-next.10.', pub_date: '2026-10-02T09:00:00Z',
    platforms: { 'darwin-aarch64': {
      url: 'https://github.com/manikanta-kops/kipster/releases/download/ui-v0.4.0-next.10/Kipster.app.tar.gz', signature: 'signature-for-0.4.0-next.10',
    } },
  })
  assert.deepEqual(app, site['v1/app/0.4.0-next.10.json'])
  assert.deepEqual(site['v1/app/stable.json'], site['v1/app/0.3.0.json'])
  assert.deepEqual(site['v1/next.json'].packages['@kipster/ui'].updater, {
    platform: 'darwin-aarch64', ...app.platforms['darwin-aarch64'],
  })
  const promoted = await generate([release('ui', '0.4.0', { signed: true }), release('ui', '0.4.0-next.10', { signed: true })])
  assert.equal(promoted['v1/app/next.json'].version, '0.4.0')
})

test('unsigned apps remain in the catalog; updater channels select only signed versions', async () => {
  const site = await generate([release('ui', '0.3.0', { signed: true }), release('ui', '0.4.0'), release('ui', '0.5.0-next.2')])
  assert.equal(site['v1/stable.json'].packages['@kipster/ui'].version, '0.4.0')
  assert.equal(site['v1/next.json'].packages['@kipster/ui'].version, '0.5.0-next.2')
  assert.equal(site['v1/app/stable.json'].version, '0.3.0')
  assert.equal(site['v1/app/next.json'].version, '0.3.0')
  assert.equal(site['v1/app/0.4.0.json'], undefined)
  const empty = await generate([release('ui', '0.3.0')])
  assert.equal(empty['v1/app/stable.json'], undefined)
  assert.equal(empty['v1/app/next.json'], undefined)
})

test('legacy releases are logged and skipped; drafts never download metadata', async () => {
  const legacy = release('core', '0.1.0-next.123')
  legacy.assets = legacy.assets.filter(asset => asset.name !== 'release.json')
  const logs = [], downloads = []
  const site = await generateChannels([legacy, release('core', '0.2.0', { draft: true })], asset => downloads.push(asset), message => logs.push(message))
  assert.deepEqual(downloads, [])
  assert.deepEqual(logs, ['Skipping core-v0.1.0-next.123: no release.json.'])
  assert.deepEqual(Object.keys(site).sort(), ['v1/next.json', 'v1/releases.json', 'v1/stable.json'])
  for (const catalog of Object.values(site)) assert.deepEqual(catalog, { schemaVersion: 1, packages: {} })
})

test('invalid metadata, missing assets and protocol mismatches fail generation', async () => {
  const cases = [
    [r => r.metadata.schemaVersion = 2, /schemaVersion/],
    [r => r.metadata.version = '0.9.0', /package\/version/],
    [r => r.metadata.package = '@kipster/ui', /package\/version/],
    [r => r.prerelease = true, /prerelease flag/],
    [r => r.published_at = null, /publication date/],
    [r => r.published_at = '2026-10-02T09:00:00', /publication date/],
    [r => r.body = {}, /notes must be text/],
    [r => r.metadata.files = [], /no files/],
    [r => r.metadata.files[0].sha256 = 'bad', /sha256/],
    [r => r.metadata.files[0].name = '../artifact.tgz', /filename/],
    [r => r.metadata.files.push({ ...r.metadata.files[0] }), /duplicate/],
    [r => r.assets[0].size++, /size mismatch/],
    [r => r.assets[0].digest = `sha256:${'f'.repeat(64)}`, /digest mismatch/],
    [r => r.assets[0].browser_download_url = 'http://example.com/file', /HTTPS/],
    [r => r.assets.shift(), /Missing asset/],
    [r => r.assets.push({ name: 'unhashed.tgz' }), /missing from metadata/],
    [r => r.metadata.protocolRange.oldest = 3, /protocolRange/],
    [r => delete r.metadata.protocolRange, /protocolRange/],
  ]
  for (const [mutate, error] of cases) {
    const fixture = release('core', '0.2.0')
    mutate(fixture)
    await assert.rejects(generate([fixture]), error)
  }
  const app = release('ui', '0.2.0', { signed: true })
  app.metadata.updater.signature = ''
  await assert.rejects(generate([app]), /signed darwin-aarch64/)
  app.metadata.updater.signature = 'signature'
  app.metadata.updater.platform = 'darwin-x86_64'
  await assert.rejects(generate([app]), /signed darwin-aarch64/)
  delete app.metadata.updater
  await assert.rejects(generate([app]), /no updater metadata/)
  delete app.metadata.protocol
  await assert.rejects(generate([app]), /protocol number/)
  await assert.rejects(generate([release('core', '0.2.0'), release('core', '0.2.0')]), /duplicate package version/)
})

test('additive metadata fields are tolerated, and input order cannot change generated output', async () => {
  const list = [release('ui', '0.2.0', { signed: true }), release('core', '0.3.0'), release('core', '0.2.0')]
  list[0].metadata.future = { field: true }
  const first = await generate(list)
  assert.equal(JSON.stringify(first), JSON.stringify(await generate(list.toReversed())))
})

test('GitHub loader paginates all releases and downloads metadata with the authenticated asset API', async () => {
  const list = [release('core', '0.2.0'), release('codex-cli', '0.1.0')], calls = []
  const api = args => {
    calls.push(args)
    if (args.includes('--paginate')) return JSON.stringify(list.map(item => [item]))
    const fixture = list.find(item => args.at(-1).endsWith(item.tag_name))
    return JSON.stringify(fixture.metadata)
  }
  const site = await channelsFromGitHub('manikanta-kops/kipster', api)
  assert.deepEqual(calls[0], ['--paginate', '--slurp', 'repos/manikanta-kops/kipster/releases?per_page=100'])
  assert.deepEqual(calls[1], ['-H', 'Accept: application/octet-stream', 'repos/manikanta-kops/kipster/releases/assets/core-v0.2.0'])
  assert.equal(Object.keys(site['v1/releases.json'].packages).length, 2)
  await assert.rejects(channelsFromGitHub('invalid/repo/extra', api), /owner\/repository/)
  await assert.rejects(channelsFromGitHub('manikanta-kops/kipster', () => { throw new Error('GitHub unavailable') }), /GitHub unavailable/)
})

test('build-time metadata flows through to files on disk, and existing output is preserved', async t => {
  const artifact = mkdtempSync(join(tmpdir(), 'kipster-metadata-test-')), out = mkdtempSync(join(tmpdir(), 'kipster-channels-test-'))
  t.after(() => { rmSync(artifact, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }) })
  const fixture = release('core', '0.2.0')
  writeFileSync(join(artifact, fixture.metadata.files[0].name), 'real archive bytes')
  fixture.metadata = writeReleaseMetadata({ name: '@kipster/core', version: '0.2.0' }, artifact, { current: 2, oldest: 1 })
  Object.assign(fixture.assets[0], { size: fixture.metadata.files[0].size, digest: `sha256:${fixture.metadata.files[0].sha256}` })
  const site = await generate([fixture])
  writeSite(out, site)
  assert.equal(readFileSync(join(out, 'CNAME'), 'utf8'), 'updates.kipster.app\n')
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'v1/next.json'), 'utf8')), site['v1/next.json'])
  assert.throws(() => writeSite(out, {}), /empty output directory/)
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'v1/next.json'), 'utf8')), site['v1/next.json'])
})
