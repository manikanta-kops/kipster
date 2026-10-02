import { test, expect } from '@playwright/test'
import type {
  SoftwareUpdater,
  DownloadedAppUpdate,
} from '../src/platform/software-updater.ts'
import type { SoftwareUpdates } from '../src/data/software-updates.ts'
import type {
  UpdateStatus,
  UpdateSettings,
} from '../src/data/software-update-contract.ts'

let Controller: typeof SoftwareUpdates
const store = new Map<string, string>()
test.beforeAll(async () => {
  Object.assign(globalThis, {
    __KIPSTER_APP_VERSION__: '1.0.0',
    __KIPSTER_DEMO__: false,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    },
  })
  Controller = (await import('../src/data/software-updates.ts')).SoftwareUpdates
})
test.beforeEach(() => {
  store.clear()
})

function setup(
  options: {
    mode?: 'automatic' | 'notify'
    channel?: 'stable' | 'next'
    available?: boolean
    backendAvailable?: boolean
    managed?: boolean
    protocol?: number
    failedDownload?: boolean
    failedInstall?: boolean
    failedCheck?: boolean
    waitDownload?: Promise<void>
    offline?: boolean
  } = {},
) {
  const calls: string[] = []
  const release = (version: string, protocol = options.protocol ?? 1) => ({
    package: '@kipster/ui',
    version,
    prerelease: version.includes('-'),
    notes: 'Notes',
    publishedAt: '2026-10-02T09:00:00Z',
    files: [],
    protocol,
    updater: {
      platform: 'darwin-aarch64',
      url: 'https://example.invalid/app.tar.gz',
      signature: 'signature',
    },
  })
  let status: UpdateStatus = {
    version: 1,
    channel: options.channel ?? 'stable',
    mode: options.mode ?? 'automatic',
    checkedAt: null,
    window: { start: '02:00', end: '05:00' },
    core: {
      version: '1.0.0',
      managed: options.managed ?? true,
      pinned: null,
      available: options.backendAvailable
        ? {
            ...release('1.1.0'),
            package: '@kipster/core',
            protocolRange: { oldest: 1, current: 1 },
          }
        : null,
      state: 'idle',
      step: null,
      error: null,
      lastResult: null,
      backups: [],
    },
  }
  const catalog = {
    schemaVersion: 1,
    packages: {
      '@kipster/ui': [
        release('1.2.0-next.1'),
        release('1.1.0'),
        release('0.9.0'),
      ],
    },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(`fetch:${url}`)
    if (url.endsWith('releases.json')) return Response.json(catalog)
    if (options.offline) throw new TypeError('Backend unreachable')
    if (url.endsWith('/v1/settings/updates') && init?.method === 'PUT') {
      const settings = JSON.parse(String(init.body)) as UpdateSettings
      status = { ...status, channel: settings.channel, mode: settings.mode }
      return Response.json({
        version: 1,
        channel: status.channel,
        mode: status.mode,
      })
    }
    return Response.json(status)
  }
  let quit: (() => Promise<void>) | undefined
  const native: SoftwareUpdater = {
    available: async () => options.available !== false,
    check: async (endpoint) => {
      calls.push(`check:${endpoint}`)
      if (options.failedCheck) throw new Error('The update check failed')
      const version = endpoint.includes('/next.json')
        ? '1.2.0-next.1'
        : endpoint.includes('/0.9.0.json')
          ? '0.9.0'
          : '1.1.0'
      const update: DownloadedAppUpdate = {
        version,
        body: 'Notes',
        download: async () => {
          calls.push(`download:${version}`)
          if (options.waitDownload && version === '1.1.0')
            await options.waitDownload
          if (options.failedDownload)
            throw new Error('Invalid updater signature')
        },
        install: async () => {
          calls.push(`install:${version}`)
          if (options.failedInstall) throw new Error('App install failed')
        },
        close: async () => {
          calls.push(`close:${version}`)
        },
      }
      return update
    },
    onQuit: async (callback) => {
      quit = callback
      return () => {
        quit = undefined
      }
    },
    arm: async (ready, automatic) => {
      calls.push(`arm:${ready}:${automatic}`)
    },
    finish: async (restart) => {
      calls.push(`finish:${restart}`)
    },
  }
  const controller = new Controller('https://backend.test', native)
  controller.setBootstrap({
    coreVersion: '1.0.0',
    protocol: { oldest: 1, current: 1 },
  })
  return {
    controller,
    calls,
    quit: () => quit?.(),
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('launch downloads in the background and automatic quit installs once', async () => {
  const ctx = setup()
  const stop = ctx.controller.start()
  try {
    await expect.poll(() => ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls).toContain(
      'check:https://updates.kipster.app/v1/app/stable.json',
    )
    expect(ctx.calls).toContain('arm:true:true')
    expect(ctx.calls.filter((call) => call.startsWith('install:'))).toEqual([])
    await ctx.quit()
    expect(ctx.calls.filter((call) => call.startsWith('install:'))).toEqual([
      'install:1.1.0',
    ])
    expect(ctx.calls).toContain('finish:false')
  } finally {
    stop()
    ctx.restore()
  }
})

test('notify mode stages the app but only an explicit restart installs', async () => {
  const ctx = setup({ mode: 'notify' })
  const stop = ctx.controller.start()
  try {
    await expect.poll(() => ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls).toContain('arm:true:false')
    expect(ctx.calls).not.toContain('arm:true:true')
    await ctx.controller.updateApp()
    expect(ctx.calls).toContain('install:1.1.0')
    expect(ctx.calls).toContain('finish:true')
  } finally {
    stop()
    ctx.restore()
  }
})

test('a failed automatic install disarms the update and allows the requested quit', async () => {
  const ctx = setup({ failedInstall: true })
  const stop = ctx.controller.start()
  try {
    await expect.poll(() => ctx.controller.snapshot().app.state).toBe('ready')
    await ctx.quit()
    expect(ctx.controller.snapshot().app.state).toBe('failed')
    expect(ctx.controller.snapshot().app.error).toContain('install failed')
    expect(ctx.calls.slice(-2)).toEqual(['arm:false:false', 'finish:false'])
  } finally {
    stop()
    ctx.restore()
  }
})

test('the backend installs first and incompatible apps never install automatically', async () => {
  const ctx = setup({ backendAvailable: true, protocol: 2 })
  const stop = ctx.controller.start()
  try {
    await expect.poll(() => ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls).toContain('arm:true:false')
    await expect(ctx.controller.updateApp()).rejects.toThrow('backend first')
    const status = ctx.controller.snapshot().status!
    ctx.controller.acceptStatus({
      ...status,
      core: { ...status.core, version: '1.1.0', available: null },
    })
    expect(ctx.calls).not.toContain('arm:true:true')
    expect(ctx.calls.filter((call) => call.startsWith('install:'))).toEqual([])
  } finally {
    stop()
    ctx.restore()
  }
})

test('switching channels during a download discards the old release before staging Beta', async () => {
  let finishDownload: () => void = () => {}
  const waitDownload = new Promise<void>((resolve) => {
    finishDownload = resolve
  })
  const ctx = setup({ waitDownload })
  try {
    await ctx.controller.refresh()
    const check = ctx.controller.checkApp()
    await expect
      .poll(() => ctx.controller.snapshot().app.state)
      .toBe('downloading')
    const save = ctx.controller.saveSettings({
      version: 1,
      channel: 'next',
      mode: 'automatic',
    })
    await expect
      .poll(() => ctx.controller.snapshot().settings.channel)
      .toBe('next')
    finishDownload()
    await Promise.all([check, save])
    expect(ctx.calls).toContain('close:1.1.0')
    expect(ctx.calls).toContain(
      'check:https://updates.kipster.app/v1/app/next.json',
    )
    expect(ctx.controller.snapshot().app.available?.version).toBe(
      '1.2.0-next.1',
    )
    expect(ctx.calls.filter((call) => call.startsWith('install:'))).toEqual([])
  } finally {
    finishDownload()
    ctx.restore()
  }
})

test('cached channel and an app pin select the endpoint when Core is unreachable', async () => {
  store.set(
    'kipster-update-policy:https://backend.test',
    JSON.stringify({ version: 1, channel: 'next', mode: 'notify' }),
  )
  store.set('kipster-app-update-pin', '0.9.0')
  const ctx = setup({ offline: true })
  const stop = ctx.controller.start()
  try {
    await expect.poll(() => ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls).toContain(
      'check:https://updates.kipster.app/v1/app/0.9.0.json',
    )
    expect(ctx.controller.snapshot().app.pinned).toBe('0.9.0')
    expect(ctx.calls).not.toContain('arm:true:true')
  } finally {
    stop()
    ctx.restore()
  }
})

test('an unsigned build makes no public update requests and a bad signature cannot become ready', async () => {
  const unsigned = setup({ available: false })
  try {
    await unsigned.controller.checkApp()
    expect(unsigned.controller.snapshot().app.message).toBe(
      'Updates are not available in this build',
    )
    expect(
      unsigned.calls.some((call) => call.includes('updates.kipster.app')),
    ).toBe(false)
  } finally {
    unsigned.restore()
  }
  const invalid = setup({ failedDownload: true })
  try {
    await invalid.controller.checkApp()
    expect(invalid.controller.snapshot().app.state).toBe('failed')
    expect(invalid.controller.snapshot().app.error).toContain('signature')
    expect(invalid.calls).not.toContain('arm:true:true')
    expect(invalid.calls.filter((call) => call.startsWith('install:'))).toEqual(
      [],
    )
  } finally {
    invalid.restore()
  }
})

test('checking again keeps a downloaded app without downloading it twice', async () => {
  const ctx = setup()
  try {
    await ctx.controller.checkApp()
    await ctx.controller.checkApp()
    expect(ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls.filter((call) => call.startsWith('download:'))).toEqual([
      'download:1.1.0',
    ])
    expect(ctx.calls.filter((call) => call.startsWith('install:'))).toEqual([])
  } finally {
    ctx.restore()
  }
})

test('a failed recheck disarms a previously downloaded automatic update', async () => {
  const options = { failedCheck: false }
  const ctx = setup(options)
  try {
    await ctx.controller.checkApp()
    expect(ctx.controller.snapshot().app.state).toBe('ready')
    options.failedCheck = true
    await ctx.controller.checkApp()
    expect(ctx.controller.snapshot().app.state).toBe('failed')
    expect(ctx.calls.at(-1)).toBe('arm:false:false')
    expect(ctx.calls.some((call) => call.startsWith('install:'))).toBe(false)
  } finally {
    ctx.restore()
  }
})

test('an unmanaged backend does not block compatible app updates or accept backend installs', async () => {
  const ctx = setup({ managed: false, backendAvailable: true })
  try {
    await ctx.controller.refresh()
    await ctx.controller.checkApp()
    expect(ctx.controller.snapshot().app.state).toBe('ready')
    expect(ctx.calls).toContain('arm:true:true')
    await expect(
      ctx.controller.installBackend({ target: '1.1.0' }),
    ).rejects.toMatchObject({ code: 'update-unmanaged' })
    expect(ctx.calls.some((call) => call.includes('/v1/updates/install'))).toBe(
      false,
    )
    await ctx.controller.installApp(true)
    expect(ctx.calls).toContain('install:1.1.0')
    expect(ctx.calls).toContain('finish:true')
  } finally {
    ctx.restore()
  }
})
