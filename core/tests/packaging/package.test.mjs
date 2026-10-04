import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const coreRoot = fileURLToPath(new URL('../../', import.meta.url))
const npmCli = process.env.npm_execpath
const typescriptManifest = createRequire(path.join(coreRoot, 'package.json')).resolve('typescript/package.json')
const compiler = path.join(path.dirname(typescriptManifest), JSON.parse(readFileSync(typescriptManifest, 'utf8')).bin.tsc)
const guard = fileURLToPath(new URL('./import-guard.mjs', import.meta.url))

function run(command, args, cwd, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})\n${stdout}\n${stderr}`))
      else resolve(stdout)
    })
  })
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    assert.equal(entry.isSymbolicLink(), false, `Unexpected linked package file: ${filename}`)
    return entry.isDirectory() ? filesUnder(filename) : [filename]
  })
}

test('Core works as a packed package outside repository resolution', { timeout: 180_000 }, async (t) => {
  assert.ok(npmCli, 'Run this check through npm run test:package')
  const temporary = mkdtempSync(path.join(tmpdir(), 'kipster-package-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  assert.ok(!temporary.startsWith(coreRoot), 'Consumer must be outside the repository')
  const consumer = path.join(temporary, 'consumer')
  mkdirSync(consumer)
  const npm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd)

  // Exercise the real prepack lifecycle, then install only the produced tarball.
  await npm(['pack', '--pack-destination', temporary], coreRoot)
  const tarballs = readdirSync(temporary).filter((name) => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = path.join(temporary, tarballs[0])
  writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
    name: 'kipster-isolated-consumer', version: '0.0.0', private: true, type: 'module',
    dependencies: { '@kipster/core': pathToFileURL(tarball).href },
  }, null, 2))
  await npm(['install', '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const installedRoot = path.join(consumer, 'node_modules/@kipster/core')
  const installed = JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8'))
  const installedFiles = filesUnder(installedRoot)

  await t.test('all exports have shipped JavaScript and declarations; private files stay private', async () => {
    assert.equal(lstatSync(installedRoot).isSymbolicLink(), false)
    assert.deepEqual(Object.keys(installed.exports).sort(), ['./adapter', './client', './embedding', './host', './maintenance', './protocol', './runtime', './transcription'])
    for (const entry of Object.values(installed.exports)) {
      assert.ok(entry.types.endsWith('.d.ts'))
      assert.ok(entry.import.endsWith('.js'))
      for (const target of [entry.types, entry.import, entry.default]) {
        assert.ok(statSync(path.join(installedRoot, target)).isFile())
      }
    }
    for (const filename of installedFiles) {
      assert.match(path.relative(installedRoot, filename).split(path.sep).join('/'), /^(dist\/|docs\/|templates\/|README\.md$|LICENSE$|NOTICE$|package\.json$)/)
    }
    await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      for (const specifier of ['@kipster/core', '@kipster/core/dist/protocol/index.js']) {
        await assert.rejects(import(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      }
    `], consumer)
  })

  await t.test('installed host binary renders its service template without starting a host', async () => {
    assert.equal(path.normalize(installed.bin['kipster-host']), path.join('dist', 'host.js'))
    const configuration = path.join(consumer, 'host.json')
    writeFileSync(configuration, JSON.stringify({version:1,home:'/tmp/kipster-package-host',databaseUrl:'postgresql://kipster@localhost/unused',listen:{host:'127.0.0.1',port:43120,allowedHosts:[],allowedOrigins:['tauri://localhost']},adapters:[]}))
    const output = await run(process.execPath, [path.join(consumer,'node_modules/.bin/kipster-host'),'service-template','--config',configuration], consumer)
    assert.match(output, /<string>serve<\/string>/)
    assert.match(output, /SuccessfulExit/)
    assert.ok(statSync(path.join(installedRoot,'docs/host-macos.md')).isFile())
    assert.ok(statSync(path.join(installedRoot,'templates/kipster-host.plist')).isFile())
  })

  for (const subpath of Object.keys(installed.exports)) {
    const specifier = `@kipster/core${subpath.slice(1)}`
    await t.test(`${specifier} imports without starting resources and exits naturally`, async () => {
      const output = await run(process.execPath, ['--import', guard, '--input-type=module', '-e', `
        await import(${JSON.stringify(specifier)});
        console.log('import completed');
      `], consumer, 10_000)
      assert.equal(output.trim(), 'import completed')
    })
  }

  await t.test('import guard detects attempted startup, including unreferenced resources', async () => {
    for (const effect of [
      'import("node:net").then(net => net.createServer().listen(0).unref())',
      'import("node:child_process").then(cp => cp.spawn(process.execPath, ["-e", ""]))',
      'setInterval(() => {}, 1000).unref()',
    ]) {
      await assert.rejects(run(process.execPath, ['--import', guard, '--input-type=module', '-e', `await ${effect}`], consumer, 10_000), /Import attempted/)
    }
  })

  cpSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), path.join(consumer, 'src'), { recursive: true })
  const compilerOptions = {
    target: 'ES2023', strict: true, exactOptionalPropertyTypes: true,
    types: [], skipLibCheck: false, verbatimModuleSyntax: true,
  }
  writeFileSync(path.join(consumer, 'tsconfig.node.json'), JSON.stringify({
    compilerOptions: { ...compilerOptions, module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023'], rootDir: 'src', outDir: 'dist', noEmitOnError: true },
    include: ['src/**/*.ts'],
  }))
  writeFileSync(path.join(consumer, 'tsconfig.browser.json'), JSON.stringify({
    compilerOptions: { ...compilerOptions, module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM'], noEmit: true },
    include: ['src/browser.ts'],
  }))

  await t.test('emitted types resolve under NodeNext and browser resolution without ambient Node types', async () => {
    await run(process.execPath, [compiler, '-p', 'tsconfig.node.json'], consumer)
    await run(process.execPath, [compiler, '-p', 'tsconfig.browser.json'], consumer)
  })

  await t.test('adapter fixture uses the injected host and no runtime singleton', async () => {
    await run(process.execPath, ['--import', guard, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createFixtureAdapter } from './dist/adapter.js';
      const first = [];
      const second = [];
      const a = await createFixtureAdapter({ record: value => first.push(value) });
      const b = await createFixtureAdapter({ record: value => second.push(value) });
      assert.equal(a.id, 'packaging-fixture');
      assert.deepEqual(first, []);
      a.record();
      assert.deepEqual(first, ['fixture used the supplied host']);
      assert.deepEqual(second, []);
      b.record();
      assert.deepEqual(second, ['fixture used the supplied host']);
    `], consumer, 10_000)
  })

  await t.test('packed maintenance entry ships reads plus intent-append without starting the runtime', async () => {
    await run(process.execPath, ['--import', guard, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import * as maintenance from '@kipster/core/maintenance';
      assert.deepEqual(Object.keys(maintenance).sort(), ['inspect', 'inspectRun', 'list', 'requestAction', 'status']);
      for (const entry of Object.values(maintenance)) assert.equal(typeof entry, 'function');
      await assert.rejects(maintenance.status({ connectionString: 'postgresql://127.0.0.1:1/none' }));
      console.log('maintenance surface verified');
    `], consumer, 30_000)
  })

  await t.test('packed concrete text adapter uses public context, handle and host tool', async () => {
    await run(process.execPath, ['--import', guard, '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createTextFixture } from './dist/adapter.js';
      const calls = [];
      const adapter = await createTextFixture({ now: () => '2026-01-01T00:00:00Z', invokeTool: async request => { calls.push(request); return {}; } });
      const handle = await adapter.execute({ runId: 'r', attemptId: 'a', organizationId: null, agentId: 'agent', instructions: 'current', input: [{ messageId: 'u', text: 'hello' }] });
      const events = [];
      for await (const event of handle.events) events.push(event);
      assert.deepEqual(events.map(event => event.kind), ['text', 'ended']);
      assert.deepEqual(calls, [{ attemptId: 'a', callId: 'packed-call', name: 'echo', arguments: { text: 'hello' } }]);
      assert.deepEqual(await handle.cancel(), { acknowledged: true, confirmedEnded: true });
      assert.equal(await handle.reconcile(), 'ended');
      await adapter.close();
    `], consumer, 10_000)
  })

  await t.test('protocol/client browser bundle has no backend imports and runs without Node globals', async () => {
    const bundle = await build({
      absWorkingDir: consumer, entryPoints: ['src/browser.ts'], bundle: true,
      platform: 'browser', format: 'iife', globalName: 'KipsterFixture',
      target: 'es2023', treeShaking: false, metafile: true, write: false,
    })
    for (const input of Object.keys(bundle.metafile.inputs)) {
      assert.ok(input === 'src/browser.ts' || input.startsWith('node_modules/@kipster/core/dist/protocol/'), `Unexpected browser input: ${input}`)
    }
    for (const output of Object.values(bundle.metafile.outputs)) assert.deepEqual(output.imports, [])
    const browser = { URL }
    runInNewContext(bundle.outputFiles[0].text, browser)
    assert.equal(browser.KipsterFixture.options.baseUrl, 'https://kipster.example/')
    assert.equal(browser.KipsterFixture.acceptedText.parts[0].text, 'hello')
    assert.equal(browser.KipsterFixture.rejectsMutation, true)
    assert.equal(browser.KipsterFixture.rejectsUnboundedRead, true)
    assert.equal(browser.KipsterFixture.parsedWaiting.state, 'waiting')
    assert.equal(browser.KipsterFixture.parsedInteractionNotice.kind, 'interaction')
    assert.equal(browser.KipsterFixture.parsedInteractionNotice.interactionState, 'pending')
    assert.equal(browser.KipsterFixture.rejectsMalformedAttempt, true)
    assert.equal(browser.KipsterFixture.rejectsExtraAnswer, true)
    t.diagnostic(`Unminified consumer browser bundle: ${bundle.outputFiles[0].contents.byteLength} bytes; no backend or external imports.`)
  })

  await t.test('installation footprint is reported independently of browser bundling', async () => {
    const tree = JSON.parse(await npm(['ls', '--all', '--json'], consumer))
    assert.deepEqual(Object.keys(tree.dependencies), ['@kipster/core'])
    assert.deepEqual(Object.keys(tree.dependencies['@kipster/core'].dependencies ?? {}).sort(), ['pg', 'pg-boss'])
    const bytes = installedFiles.reduce((total, filename) => total + statSync(filename).size, 0)
    t.diagnostic(`Packed Core: ${statSync(tarball).size} bytes; installed Core: ${installedFiles.length} files, ${bytes} bytes; runtime dependencies: pg and pg-boss. Compiler, bundler and Node types are development-only dependencies.`)
  })
})
