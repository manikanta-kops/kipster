import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

// An isolated app bundle and throwaway signing key; never touches an installed Kipster.
assert.equal(process.platform, 'darwin', 'This smoke test needs macOS')
assert.equal(process.arch, 'arm64', 'This smoke test needs Apple silicon')
const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(
  join(await realpath(tmpdir()), 'kipster-updater-smoke-'),
)
const project = join(scratch, 'project')
const crate = join(project, 'src-tauri')
const frontend = join(scratch, 'frontend')
const dist = join(scratch, 'dist')
const key = join(scratch, 'throwaway.key')
const trace = join(scratch, 'trace.jsonl')
const assets = new Map()
const requests = []
const tauri = resolve(ui, '../../node_modules/.bin/tauri')
let running
let passed = false
const server = createServer((request, response) => {
  requests.push(request.url)
  const asset = assets.get(request.url)
  response.writeHead(asset ? 200 : 404, {
    'Content-Type': request.url?.endsWith('.json')
      ? 'application/json'
      : 'application/octet-stream',
  })
  response.end(asset)
})
async function run(
  command,
  args,
  { env, cwd = project, name = 'command', timeout = 600000 } = {},
) {
  const log = join(scratch, `${name}.log`)
  let output = ''
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    output += data
  })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', done)
    })
    await writeFile(log, output)
    assert.equal(code, 0, `${name} failed; diagnostics: ${log}`)
  } finally {
    clearTimeout(timer)
  }
}
async function launch(bundle, name) {
  const executable = join(bundle, 'Contents/MacOS/kipster-ui')
  const log = join(scratch, `${name}.log`)
  let output = ''
  running = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  running.stdout.on('data', (data) => {
    output += data
  })
  running.stderr.on('data', (data) => {
    output += data
  })
  const timer = setTimeout(() => running?.kill('SIGTERM'), 90000)
  try {
    const code = await new Promise((done, reject) => {
      running.once('error', reject)
      running.once('exit', done)
    })
    await writeFile(log, output)
    assert.equal(code, 0, `${name} failed; diagnostics: ${log}`)
  } finally {
    clearTimeout(timer)
    running = undefined
  }
}
try {
  await mkdir(frontend, { recursive: true })
  await cp(join(ui, 'src-tauri'), crate, {
    recursive: true,
    filter: (path) => !['target', 'gen'].includes(path.split('/').at(-1)),
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(
    join(frontend, 'index.html'),
    '<!doctype html><html><body><h1>Kipster updater smoke test</h1><output id="status">Starting…</output><script type="module" src="./smoke.ts"></script></body></html>',
  )
  await writeFile(
    join(frontend, 'smoke.ts'),
    `
    import { invoke } from ${JSON.stringify(resolve(ui, '../../node_modules/@tauri-apps/api/core.js'))};
    import { getVersion } from ${JSON.stringify(resolve(ui, '../../node_modules/@tauri-apps/api/app.js'))};
    import { nativeSoftwareUpdater } from ${JSON.stringify(join(ui, 'src/platform/software-updater.ts'))};
    const report = async (state, fields = {}) => { document.querySelector('#status').textContent = state; await invoke('smoke_report', { value: { state, ...fields } }); };
    try {
      const version = await getVersion();
      await report('launch', { version });
      const native = nativeSoftwareUpdater();
      if (!native || !(await native.available())) throw new Error('Updater is unavailable in the signed test build');
      if (version === '0.2.0') { await report('verified', { version }); await native.finish(false); }
      else {
        const update = await native.check(${JSON.stringify(origin + '/v1/app/stable.json')});
        if (!update || update.version !== '0.2.0') throw new Error('Expected signed version 0.2.0');
        await update.download();
        await native.onQuit(async () => { try { await report('quit-intercepted'); await update.install(); await report('installed'); await native.finish(false); } catch (error) { await report('failed', { message: String(error) }); await native.finish(false); } });
        await native.arm(true, true);
        await report('downloaded', { version: update.version });
        await invoke('smoke_request_quit');
      }
    } catch (error) { await report('failed', { message: String(error) }); await invoke('finish_software_update_quit'); }
  `,
  )
  await build({
    configFile: false,
    root: frontend,
    logLevel: 'warn',
    define: { __KIPSTER_DEMO__: 'false' },
    build: { outDir: dist, emptyOutDir: true },
  })
  // Only the disposable crate gets trace and quit commands, so no test controls ship.
  let lib = await readFile(join(crate, 'src/lib.rs'), 'utf8')
  assert.ok(lib.includes('url.scheme() != "https"'))
  assert.ok(lib.includes('url.host_str() != Some("updates.kipster.app")'))
  // The endpoint restriction changes only in this temporary crate, for loopback fixtures.
  lib = lib
    .replace('url.scheme() != "https"', 'url.scheme() != "http"')
    .replace(
      'url.host_str() != Some("updates.kipster.app")',
      'url.host_str() != Some("127.0.0.1")',
    )
  lib = lib.replace(
    'finish_software_update_quit])',
    'finish_software_update_quit, smoke_report, smoke_request_quit])',
  )
  // rustfmt may have placed the handler list on separate lines.
  if (!lib.includes('finish_software_update_quit, smoke_report'))
    lib = lib.replace(
      'finish_software_update_quit\n',
      'finish_software_update_quit,\n            smoke_report,\n            smoke_request_quit\n',
    )
  lib += `
    #[tauri::command]
    fn smoke_report(value: serde_json::Value) -> Result<(), String> {
      use std::io::Write;
      let mut file = std::fs::OpenOptions::new().create(true).append(true).open(${JSON.stringify(trace)}).map_err(|e| e.to_string())?;
      writeln!(file, "{}", value).map_err(|e| e.to_string())
    }
    #[tauri::command]
    fn smoke_request_quit(app: tauri::AppHandle) { app.exit(0); }
  `
  await writeFile(join(crate, 'src/lib.rs'), lib)
  const capabilityPath = join(crate, 'capabilities/default.json')
  const capability = JSON.parse(await readFile(capabilityPath, 'utf8'))
  capability.permissions.push('core:app:allow-version')
  await writeFile(capabilityPath, JSON.stringify(capability))
  await run(tauri, ['signer', 'generate', '--ci', '-w', key, '-p', ''], {
    name: 'signer',
  })
  const pubkey = (await readFile(key + '.pub', 'utf8')).trim()
  const base = JSON.parse(
    await readFile(join(crate, 'tauri.conf.json'), 'utf8'),
  )
  base.productName = 'Kipster Updater Smoke'
  base.identifier = 'app.kipster.updater-smoke'
  base.build = { frontendDist: dist }
  base.app.windows[0].title = 'Kipster Updater Smoke'
  base.plugins.updater = {
    pubkey,
    endpoints: [origin + '/v1/app/stable.json'],
    dangerousInsecureTransportProtocol: true,
  }
  base.bundle.targets = ['app']
  const env = {
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    CARGO_TARGET_DIR: join(ui, 'src-tauri/target'),
  }
  let bundle
  for (const version of ['0.2.0', '0.1.0']) {
    console.log(`Building isolated signed app ${version}…`)
    await writeFile(
      join(crate, 'tauri.conf.json'),
      JSON.stringify({ ...base, version }),
    )
    await run(tauri, ['build', '--ci'], { env, name: `build-${version}` })
    const output = join(
      env.CARGO_TARGET_DIR,
      'release/bundle/macos/Kipster Updater Smoke.app',
    )
    if (version === '0.2.0') {
      assets.set('/app.tar.gz', await readFile(output + '.tar.gz'))
      const signature = (await readFile(output + '.tar.gz.sig', 'utf8')).trim()
      assets.set(
        '/v1/app/stable.json',
        JSON.stringify({
          version,
          notes: 'Throwaway updater smoke test',
          pub_date: '2026-10-02T09:00:00Z',
          platforms: {
            'darwin-aarch64': { url: origin + '/app.tar.gz', signature },
          },
        }),
      )
    } else {
      bundle = join(scratch, 'installed/Kipster Updater Smoke.app')
      await cp(output, bundle, { recursive: true })
    }
  }
  console.log(
    'Launching 0.1.0, downloading the signed app, and installing on quit…',
  )
  await launch(bundle, 'first-launch')
  console.log('Launching the replaced app bundle…')
  await launch(bundle, 'second-launch')
  const events = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    events.filter((event) => event.state === 'failed'),
    [],
  )
  assert.deepEqual(
    events
      .filter((event) => event.state === 'launch')
      .map((event) => event.version),
    ['0.1.0', '0.2.0'],
  )
  assert.ok(events.some((event) => event.state === 'quit-intercepted'))
  assert.ok(events.some((event) => event.state === 'installed'))
  assert.ok(
    events.some(
      (event) => event.state === 'verified' && event.version === '0.2.0',
    ),
  )
  assert.ok(
    requests.includes('/v1/app/stable.json') &&
      requests.includes('/app.tar.gz'),
  )
  console.log(
    'PASS: signed macOS app self-update 0.1.0 → 0.2.0; installed on quit and verified on next launch',
  )
  passed = true
} finally {
  running?.kill('SIGTERM')
  await new Promise((done) => server.close(done))
  await rm(key, { force: true })
  await rm(key + '.pub', { force: true })
  // Temporary keys, manifests, apps and source copies never enter the repository.
  await rm(join(scratch, 'signer.log'), { force: true })
  if (passed) await rm(scratch, { recursive: true, force: true })
  else console.error(`Smoke test diagnostics: ${scratch}`)
}
