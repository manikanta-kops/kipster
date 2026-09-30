import { expect, test } from '@playwright/test'
import { TextHttpError } from '../src/data/text.js'
import {
  applyLearningEvent,
  mergeAdapterList,
  mergeLearning,
  mergeSettingsRecord,
  mergeSettingsSnapshot,
  parseAdapterList,
  parseEffectiveSettings,
  parseLearning,
  parseSettingsEvent,
  parseSettingsSnapshot,
  settingsPatch,
  uncertainFailure,
  type SettingsRecord,
} from '../src/data/core-settings.js'

const scope = { installationId: 'installation', callerId: 'owner' }
const agent = (revision: number, modelId?: string): SettingsRecord => ({
  target: 'agent',
  id: 'scout',
  revision,
  settings: { adapterId: 'codex', ...(modelId ? { modelId } : {}) },
})
const adapter = {
  id: 'codex',
  version: '1',
  available: false,
  reason: 'Provider login required',
  models: [{ id: 'gpt', efforts: ['low', 'high'] }],
  defaultModel: { id: 'gpt', effort: 'high' },
  supportedOptions: [],
  capabilities: null,
}
const envelope = (
  type: string,
  data: unknown,
  resourceId: string,
  revision = 1,
) => ({
  version: 1,
  eventId: 'event',
  cursor: 'a:installation:7',
  occurredAt: '2026-09-27T00:00:00.000Z',
  scope: { kind: 'application', ...scope },
  resourceId,
  revision,
  type,
  data,
})

test('settings snapshots skip broken records and tolerate newer versions', () => {
  const snapshot = parseSettingsSnapshot({
    version: 2,
    cursor: 'cursor',
    agents: [agent(2, 'gpt'), { ...agent(1), settings: { modelId: 3 } }, null],
    organizations: [
      { target: 'organization', id: 'org', revision: -1, settings: {} },
    ],
  })
  expect(snapshot.agents.scout.settings).toEqual({
    adapterId: 'codex',
    modelId: 'gpt',
  })
  expect(snapshot.organizations.org.revision).toBe(-1)
  expect(() =>
    parseSettingsSnapshot({
      version: 2,
      cursor: 'cursor',
      agents: [],
      organizations: null,
    }),
  ).toThrow(TextHttpError)
})

test('effective settings keep new statuses, sources and extra fields', () => {
  const effective = {
    version: 2,
    agentId: 'scout',
    organizationId: '',
    status: 'future-status',
    reason: 'New reason',
    settings: { adapterId: 'codex', modelId: 'retired' },
    sources: {
      adapterId: 'installation',
      modelId: 'agent',
      future: { anything: true },
    },
  }
  expect(parseEffectiveSettings(effective)).toEqual(effective)
  expect(() =>
    parseEffectiveSettings({ ...effective, sources: { adapterId: {} } }),
  ).toThrow(TextHttpError)
})

test('adapter lists skip broken entries and keep readable catalogs', () => {
  const list = parseAdapterList({
    version: 2,
    cursor: 'cursor',
    revision: 3,
    adapters: [adapter, null, { ...adapter, id: 7 }],
  })
  expect(list.adapters).toEqual([adapter])
  const catalog = parseAdapterList({
    version: 2,
    revision: 3,
    adapters: [
      {
        ...adapter,
        capabilities: { text: true, future: true },
        models: [{ id: 'gpt', efforts: ['low', 4, 'high'] }, { id: 4 }],
        supportedOptions: ['extra', null],
      },
    ],
  }).adapters[0]
  expect(catalog.models).toEqual([{ id: 'gpt', efforts: ['low', 'high'] }])
  expect(catalog.supportedOptions).toEqual(['extra'])
  expect(catalog.capabilities).toMatchObject({ future: true })
})

test('learning settings read sleep time as a plain string', () => {
  const learning = parseLearning({
    version: 2,
    enabled: false,
    sleepTime: '25:00',
    revision: 0,
    available: true,
    agents: [
      {
        agentId: 'scout',
        enabled: true,
        sleepTime: null,
        revision: 0,
        effective: false,
      },
      null,
    ],
  })
  expect(learning.sleepTime).toBe('25:00')
  expect(learning.agents.scout.sleepTime).toBeNull()
  expect(Object.keys(learning.agents)).toEqual(['scout'])
  expect(() =>
    parseLearning({ ...learning, sleepTime: 25, agents: [] }),
  ).toThrow(TextHttpError)
})

test('events read relevant updates and skip unrelated kinds or scopes', () => {
  expect(
    parseSettingsEvent(
      envelope('settings-changed', agent(4, 'gpt'), 'other', 5),
      scope,
    ),
  ).toEqual({
    cursor: 'a:installation:7',
    kind: 'settings',
    record: agent(4, 'gpt'),
  })
  expect(
    parseSettingsEvent(
      envelope('adapters-changed', { adapters: [adapter] }, 'installation', 2),
      scope,
    ),
  ).toMatchObject({ kind: 'adapters', list: { revision: 2 } })
  expect(
    parseSettingsEvent(
      envelope(
        'learning-changed',
        { target: 'agent', enabled: false, sleepTime: 'whenever' },
        'scout',
        2,
      ),
      scope,
    ),
  ).toMatchObject({ kind: 'learning', target: 'agent', id: 'scout' })
  expect(
    parseSettingsEvent(
      envelope(
        'learning-changed',
        { target: 'installation', enabled: true, sleepTime: null },
        'installation',
      ),
      scope,
    ),
  ).toMatchObject({ kind: 'learning', sleepTime: null })
  expect(
    parseSettingsEvent(
      envelope('agent-changed', { anything: true }, 'scout'),
      scope,
    ).kind,
  ).toBe('directory')
  expect(
    parseSettingsEvent(envelope('future-event', null, 'x'), scope).kind,
  ).toBe('skipped')
  expect(
    parseSettingsEvent(
      {
        ...envelope('settings-changed', null, 'scout'),
        scope: { kind: 'application', ...scope, callerId: 'someone' },
      },
      scope,
    ).kind,
  ).toBe('skipped')
  expect(() =>
    parseSettingsEvent(envelope('resync-required', null, 'x'), scope),
  ).toThrow(expect.objectContaining({ code: 'resync-required' }))
  expect(() =>
    parseSettingsEvent(
      envelope('settings-changed', { id: 'scout' }, 'scout'),
      scope,
    ),
  ).toThrow(TextHttpError)
})

test('settings merges keep the newer revision and drop records that left', () => {
  const held = { agents: { scout: agent(3, 'new') }, organizations: {} }
  expect(mergeSettingsRecord(held, agent(2, 'old'))).toBe(held)
  expect(
    mergeSettingsRecord(held, agent(3, 'same')).agents.scout.settings.modelId,
  ).toBe('same')
  const merged = mergeSettingsSnapshot(held, {
    agents: { scout: agent(2, 'late snapshot') },
    organizations: {},
  })
  expect(merged.agents.scout.settings.modelId).toBe('new')
  expect(
    mergeSettingsSnapshot(held, { agents: {}, organizations: {} }).agents,
  ).toEqual({})
})

test('adapter and learning merges ignore older revisions', () => {
  const newer = { revision: 4, adapters: [] }
  expect(mergeAdapterList(newer, { revision: 3, adapters: [adapter] })).toBe(
    newer,
  )
  const learning = {
    enabled: true,
    sleepTime: '02:30',
    revision: 5,
    available: true,
    agents: {
      scout: {
        agentId: 'scout',
        enabled: false,
        sleepTime: '03:15',
        revision: 2,
        effective: false,
      },
    },
  }
  const stale = mergeLearning(learning, {
    ...learning,
    enabled: false,
    revision: 4,
    agents: { scout: { ...learning.agents.scout, enabled: true, revision: 1 } },
  })
  expect(stale.enabled).toBe(true)
  expect(stale.agents.scout.enabled).toBe(false)
  const event = {
    cursor: 'c',
    kind: 'learning' as const,
    target: 'installation' as const,
    id: 'installation',
    enabled: false,
    sleepTime: '01:00',
  }
  expect(applyLearningEvent(learning, { ...event, revision: 4 })).toBe(learning)
  expect(applyLearningEvent(learning, { ...event, revision: 6 }).enabled).toBe(
    false,
  )
})

test('a patch holds only changed fields; an empty choice clears the saved value', () => {
  const saved = { adapterId: 'codex', modelId: 'gpt' }
  expect(settingsPatch(saved, {})).toEqual({})
  expect(settingsPatch(saved, { modelId: 'gpt' })).toEqual({})
  expect(settingsPatch(saved, { modelId: '', effort: 'high' })).toEqual({
    modelId: { clear: true },
    effort: { set: 'high' },
  })
  expect(settingsPatch(saved, { effort: '' })).toEqual({})
})

test('only failures without a definite answer are retried with the same operation', () => {
  expect(uncertainFailure(new TypeError('Load failed'))).toBe(true)
  expect(uncertainFailure(new TextHttpError('down', 'unavailable'))).toBe(true)
  expect(uncertainFailure(new TextHttpError('bad', 'invalid'))).toBe(false)
  expect(uncertainFailure(new TextHttpError('reused', 'conflict'))).toBe(false)
})
