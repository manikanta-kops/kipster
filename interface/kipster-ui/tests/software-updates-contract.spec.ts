import { test, expect } from '@playwright/test'
import {
  acceptsAppUpdate,
  appUpdateEndpoint,
  compareVersions,
  parseReleaseCatalog,
  parseUpdateStatus,
  parseUpdateSettings,
  knownUpdateSettings,
} from '../src/data/software-update-contract.ts'
import { updateStatus, updateSettings } from '@kipster/core/protocol'
import { createFakeCore, DEMO_ORIGIN } from '../src/fake-core/index.ts'

test('app endpoints follow the installation channel or the device pin', () => {
  expect(appUpdateEndpoint('stable', null)).toBe(
    'https://updates.kipster.app/v1/app/stable.json',
  )
  expect(appUpdateEndpoint('next', null)).toBe(
    'https://updates.kipster.app/v1/app/next.json',
  )
  expect(appUpdateEndpoint('next', '1.2.3-next.4+build.5')).toBe(
    'https://updates.kipster.app/v1/app/1.2.3-next.4%2Bbuild.5.json',
  )
  for (const value of [
    '../stable',
    '1.0',
    'v1.2.3',
    '1.2.3-01',
    '1.02.3',
    '1.2.3/next',
  ])
    expect(() => appUpdateEndpoint('stable', value)).toThrow()
})

test('semver comparison orders numeric prereleases and ignores build metadata', () => {
  const versions = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.2.0',
    '1.10.0',
    '2.0.0',
  ]
  for (let i = 1; i < versions.length; i++) {
    expect(compareVersions(versions[i - 1], versions[i])).toBe(-1)
    expect(compareVersions(versions[i], versions[i - 1])).toBe(1)
  }
  expect(compareVersions('1.2.3+one', '1.2.3+two')).toBe(0)
  expect(compareVersions('999999999999999999999.0.0', '9.0.0')).toBe(1)
})

test('channel updates never downgrade; an exact device pin may downgrade', () => {
  expect(acceptsAppUpdate('2.0.0-next.4', '1.9.0', null)).toBe(false)
  expect(acceptsAppUpdate('2.0.0-next.4', '2.0.0', null)).toBe(true)
  expect(acceptsAppUpdate('2.0.0', '1.9.0', '1.9.0')).toBe(true)
  expect(acceptsAppUpdate('2.0.0', '1.9.0', '1.8.0')).toBe(false)
  expect(acceptsAppUpdate('2.0.0', '2.0.0', '2.0.0')).toBe(false)
})

test('fake Core implements the shared settings, checks, install receipts and backup guard', async () => {
  const core = createFakeCore({
    testControls: true,
    autoAdvance: false,
    coreVersion: '0.7.0',
  })
  const send = async (path: string, method = 'GET', body?: unknown) =>
    core.handle(
      new Request(DEMO_ORIGIN + path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    )
  try {
    expect(await (await send('/v1/settings/updates')).json()).toEqual({
      version: 1,
      channel: 'stable',
      mode: 'automatic',
    })
    const settings = {
      version: 1,
      operationId: crypto.randomUUID(),
      channel: 'next',
      mode: 'notify',
    }
    expect((await send('/v1/settings/updates', 'PUT', settings)).status).toBe(
      200,
    )
    const checked = parseUpdateStatus(
      await (await send('/v1/updates/check', 'POST', { version: 1 })).json(),
    )
    expect(checked.core.available?.version).toBe('0.9.0-next.1')
    expect(checked.core.state).toBe('idle')
    const install = {
      version: 1,
      operationId: crypto.randomUUID(),
      target: '0.6.0',
      pin: true,
    }
    expect((await send('/v1/updates/install', 'POST', install)).status).toBe(
      409,
    )
    await send('/__demo/updates', 'POST', { state: 'backups' })
    expect(
      (
        await send('/v1/updates/install', 'POST', {
          ...install,
          backupId: 'backup-0.6.0',
        })
      ).status,
    ).toBe(409)
    const confirmed = {
      ...install,
      backupId: 'backup-0.6.0',
      confirmDataLoss: true,
    }
    const first = await (
      await send('/v1/updates/install', 'POST', confirmed)
    ).json()
    expect(first.core.pinned).toBe('0.6.0')
    expect(first.core.state).toBe('installing')
    expect(
      await (await send('/v1/updates/install', 'POST', confirmed)).json(),
    ).toEqual(first)
    expect(
      (
        await send('/v1/updates/install', 'POST', {
          ...confirmed,
          target: '0.7.0',
        })
      ).status,
    ).toBe(409)
    await send('/__demo/updates', 'POST', { state: 'installed' })
    expect(
      parseUpdateStatus(await (await send('/v1/updates')).json()).core
        .lastResult?.outcome,
    ).toBe('installed')
    expect(await (await send('/v1/bootstrap')).json()).toMatchObject({
      coreVersion: '0.6.0',
    })
    expect(
      parseUpdateStatus(
        await (
          await send('/v1/updates/unpin', 'POST', {
            version: 1,
            operationId: crypto.randomUUID(),
          })
        ).json(),
      ).core.pinned,
    ).toBeNull()
    const inspection = await (await send('/__demo/updates')).json()
    expect(
      parseReleaseCatalog(inspection.releases).packages['@kipster/ui'],
    ).toHaveLength(5)
    expect(
      parseUpdateStatus({
        ...inspection.status,
        future: true,
        core: { ...inspection.status.core, state: 'future-state' },
      }).core.state,
    ).toBe('unknown')
  } finally {
    core.dispose()
  }
})

test('update responses use Core schemas and preserve additive app catalog metadata', async () => {
  const core = createFakeCore({ testControls: true, autoAdvance: false })
  try {
    const inspection = await (
      await core.handle(new Request(DEMO_ORIGIN + '/__demo/updates'))
    ).json()
    const future = {
      ...inspection.status,
      channel: 'future-channel',
      mode: 'future-mode',
      core: { ...inspection.status.core, state: 'future-state', future: true },
    }
    expect(parseUpdateStatus(future)).toEqual(updateStatus.parse(future))
    expect(parseUpdateSettings(future)).toEqual(updateSettings.parse(future))
    expect(knownUpdateSettings(parseUpdateSettings(future))).toBe(false)
    for (const managed of [undefined, 'false'])
      expect(() =>
        parseUpdateStatus({
          ...inspection.status,
          core: { ...inspection.status.core, managed },
        }),
      ).toThrow('Backend response is incompatible')
    const release = {
      ...inspection.releases.packages['@kipster/ui'][0],
      future: { value: 1 },
    }
    expect(
      parseReleaseCatalog({
        schemaVersion: 1,
        packages: { '@kipster/ui': [release] },
      }).packages['@kipster/ui'][0],
    ).toMatchObject({
      protocol: release.protocol,
      updater: release.updater,
      future: release.future,
    })
  } finally {
    core.dispose()
  }
})
