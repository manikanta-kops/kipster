import { useId, useState } from 'react'
import type {
  Directory,
  Learning,
  LearningChange,
} from '../../data/core-settings'
import type { Settings } from './ExecutionSettings'
import { KipAvatar, type KipLook } from './KipAvatar'
import { ActionRow, Block, Row, SaveRow, Switch } from './ui'
import { useSheet } from './sheet'
import { clockTime, effortLabel, errorText } from './format'

type State = 'idle' | 'saving' | { error: string }

/** The installation switch, the default sleep time, the nightly model and counts, memories, lessons and each kip's summary. */
export function LearningPage({
  settings,
  look,
}: {
  settings: Settings
  look: (agentId: string) => KipLook
}) {
  const learning = settings.learning!
  const directory: Directory = settings.directory!
  const { push } = useSheet()
  const [time, setTime] = useState<string | null>(null)
  const [state, setState] = useState<State>('idle')
  const switchId = useId()
  const run = async (update: { enabled?: boolean; sleepTime?: string }) => {
    setState('saving')
    try {
      await settings.saveLearning(update)
      if (update.sleepTime) setTime(null)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  const chosenTime = time ?? learning.sleepTime
  const changed = !!time && time !== learning.sleepTime
  const agents = directory.agents
    .filter((a) => a.lifecycle !== 'deleted' && learning.agents[a.id])
    .sort((a, b) => Number(b.admin) - Number(a.admin))
  return (
    <>
      <Block
        region="Memory"
        foot="Daily, in this device’s local time. Kips can use their own."
      >
        <Row
          label="Learn from conversations"
          labelId={switchId}
          sub={
            learning.available
              ? 'Kips remember your conversations across chats. Each night, while they sleep, new conversation becomes searchable. Off by default.'
              : 'Kips remember your conversations across chats. Searching memory by meaning needs an embedding provider configured in Kipster Core. Off by default.'
          }
          control={
            <Switch
              labelId={switchId}
              on={learning.enabled}
              disabled={state === 'saving'}
              change={(on) => void run({ enabled: on })}
            />
          }
        />
        <Row
          label="Default sleep time"
          changed={changed}
          control={
            <input
              type="time"
              className="set-time"
              aria-label="Default sleep time"
              value={chosenTime}
              disabled={state === 'saving'}
              onChange={(e) => setTime(e.target.value)}
            />
          }
        />
        {(changed || state === 'saving') && (
          <SaveRow state={state === 'saving' ? 'saving' : 'dirty'}>
            {state !== 'saving' && (
              <>
                <button className="set-button" onClick={() => setTime(null)}>
                  Discard
                </button>
                <button
                  className="set-button primary"
                  onClick={() => void run({ sleepTime: time! })}
                >
                  Save
                </button>
              </>
            )}
          </SaveRow>
        )}
      </Block>
      {typeof state === 'object' && (
        <p role="alert" className="set-alert">
          Not saved: {state.error}
        </p>
      )}
      <NightlyModel settings={settings} />
      <MemoryCounts settings={settings} learning={learning} />
      <Block>
        <Row
          label="Memories"
          sub="What your kips remember about you. Read, correct or delete it."
          chevron
          onClick={() => push({ kind: 'memories', title: 'Memories' })}
        />
        <Row
          label="Lessons"
          sub="What each kip learned about doing its work."
          chevron
          onClick={() => push({ kind: 'lessons', title: 'Lessons' })}
        />
      </Block>
      {agents.length > 0 && (
        <Block
          label="Kips"
          foot="Each kip can be switched off or given its own sleep time."
        >
          {agents.map((agent) => {
            const own = learning.agents[agent.id]!
            return (
              <Row
                key={agent.id}
                lead={<KipAvatar look={look(agent.id)} />}
                label={agent.name}
                sub={
                  !learning.enabled
                    ? 'Off for all kips'
                    : !own.enabled
                      ? 'Off'
                      : `On · ${clockTime(own.sleepTime ?? learning.sleepTime)}${own.sleepTime ? '' : ' (default)'}`
                }
                chevron
                onClick={() =>
                  push({ kind: 'kip', agentId: agent.id, title: agent.name })
                }
              />
            )
          })}
        </Block>
      )}
    </>
  )
}

/** One kip's learning switch and sleep time, on its page. */
export function KipLearning({
  agentId,
  settings,
}: {
  agentId: string
  settings: Settings
}) {
  const learning = settings.learning!
  const agent = learning.agents[agentId]
  const [time, setTime] = useState<string | null>(null)
  const [state, setState] = useState<State>('idle')
  const switchId = useId()
  if (!agent) return null
  const run = async (update: {
    enabled?: boolean
    sleepTime?: string | null
  }) => {
    setState('saving')
    try {
      await settings.saveAgentLearning(agentId, update)
      if (update.sleepTime !== undefined) setTime(null)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  const chosenTime = time ?? agent.sleepTime ?? learning.sleepTime
  const changed = !!time && time !== (agent.sleepTime ?? learning.sleepTime)
  return (
    <section aria-label="Memory" className="set-block">
      <h4 className="set-label">Memory</h4>
      <div className="set-group">
        <Row
          label="Learn from conversations"
          labelId={switchId}
          sub={
            agent.effective
              ? 'Learning now.'
              : !learning.enabled
                ? 'Learning is off for all kips.'
                : agent.enabled
                  ? 'Not learning right now.'
                  : 'Off for this kip.'
          }
          control={
            <Switch
              labelId={switchId}
              on={agent.enabled}
              disabled={state === 'saving'}
              change={(on) => void run({ enabled: on })}
            />
          }
        />
        <Row
          label="Sleep time"
          changed={changed}
          sub={
            agent.sleepTime
              ? 'Own sleep time'
              : `Uses the default, ${clockTime(learning.sleepTime)}`
          }
          subTone={agent.sleepTime ? 'own' : undefined}
          control={
            <input
              type="time"
              className="set-time"
              aria-label="Sleep time"
              value={chosenTime}
              disabled={state === 'saving'}
              onChange={(e) => setTime(e.target.value)}
            />
          }
        />
        {agent.sleepTime && !changed && state !== 'saving' && (
          <ActionRow onClick={() => void run({ sleepTime: null })}>
            Use default sleep time
          </ActionRow>
        )}
        {(changed || state === 'saving') && (
          <SaveRow state={state === 'saving' ? 'saving' : 'dirty'}>
            {state !== 'saving' && (
              <>
                <button className="set-button" onClick={() => setTime(null)}>
                  Discard
                </button>
                <button
                  className="set-button primary"
                  onClick={() => void run({ sleepTime: time! })}
                >
                  Save
                </button>
              </>
            )}
          </SaveRow>
        )}
      </div>
      {typeof state === 'object' && (
        <p role="alert" className="set-alert">
          Not saved: {state.error}
        </p>
      )}
    </section>
  )
}

const modelKey = (adapterId: string, modelId: string) =>
  JSON.stringify([adapterId, modelId])

/** The model of the nightly memory run: the admin kip's, or one the adapters offer. Saved when chosen. */
function NightlyModel({ settings }: { settings: Settings }) {
  const learning = settings.learning!
  const chosen = learning.nightlyModel ?? null
  const adminModel = `${settings.directory?.agents.find((agent) => agent.admin)?.name ?? 'The admin kip'}’s model`
  const [state, setState] = useState<State>('idle')
  const adapters = settings.adapters?.adapters ?? []
  const options = adapters.flatMap((adapter) =>
    adapter.models.map((model) => ({
      key: modelKey(adapter.id, model.id),
      label: `${adapter.id} · ${model.id}${adapter.available ? '' : ' (unavailable)'}`,
      model: { adapterId: adapter.id, modelId: model.id },
      efforts: model.efforts,
    })),
  )
  const current = chosen && modelKey(chosen.adapterId, chosen.modelId)
  const listed = options.find((option) => option.key === current)
  const efforts = listed?.efforts ?? []
  const save = async (change: LearningChange) => {
    setState('saving')
    try {
      await settings.saveLearning(change)
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  return (
    <>
      <Block
        label="Nightly"
        foot={`Each night this model turns new conversation into memory. ${adminModel} is used unless you choose another.`}
      >
        <Row
          label="Nightly model"
          control={
            <select
              aria-label="Nightly model"
              value={current ?? ''}
              disabled={state === 'saving'}
              onChange={(e) => {
                const option = options.find((o) => o.key === e.target.value)
                void save({ nightlyModel: option ? option.model : null })
              }}
            >
              <option value="">{adminModel}</option>
              {chosen && !listed && (
                <option value={current!}>
                  {chosen.adapterId} · {chosen.modelId} (unavailable)
                </option>
              )}
              {options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          }
        />
        {chosen && (efforts.length > 0 || chosen.effort) && (
          <Row
            label="Nightly effort"
            control={
              <select
                aria-label="Nightly effort"
                value={chosen.effort ?? ''}
                disabled={state === 'saving'}
                onChange={(e) =>
                  void save({
                    nightlyModel: {
                      adapterId: chosen.adapterId,
                      modelId: chosen.modelId,
                      ...(e.target.value ? { effort: e.target.value } : {}),
                    },
                  })
                }
              >
                <option value="">Model default</option>
                {chosen.effort && !efforts.includes(chosen.effort) && (
                  <option value={chosen.effort}>
                    {effortLabel(chosen.effort)} (unavailable)
                  </option>
                )}
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effortLabel(effort)}
                  </option>
                ))}
              </select>
            }
          />
        )}
      </Block>
      {typeof state === 'object' && (
        <p role="alert" className="set-alert">
          Not saved: {state.error}
        </p>
      )}
    </>
  )
}

const counts = [
  {
    key: 'coreMemoryCount',
    label: 'Core memories',
    sub: 'Loaded into every turn',
    max: 200,
  },
  {
    key: 'searchMemoryCount',
    label: 'Memories from search',
    sub: 'Added when a message matches them by meaning',
    max: 50,
  },
  {
    key: 'searchChunkCount',
    label: 'Conversation pieces from search',
    sub: 'Parts of earlier chats added the same way',
    max: 30,
  },
] as const
type Count = (typeof counts)[number]['key']

/** How many core memories, memories and conversation pieces each turn gets, saved together. */
function MemoryCounts({
  settings,
  learning,
}: {
  settings: Settings
  learning: Learning
}) {
  const [draft, setDraft] = useState<Partial<Record<Count, string>>>({})
  const [state, setState] = useState<State>('idle')
  const saved = (key: Count) => String(learning[key] ?? '')
  const changed = counts.filter(
    ({ key }) => draft[key] !== undefined && draft[key] !== saved(key),
  )
  const invalid = changed.filter(({ key, max }) => {
    const value = Number(draft[key])
    return !/^\d+$/.test(draft[key]!) || value > max
  })
  const save = async () => {
    setState('saving')
    try {
      await settings.saveLearning(
        Object.fromEntries(
          changed.map(({ key }) => [key, Number(draft[key])]),
        ) as LearningChange,
      )
      setDraft({})
      setState('idle')
    } catch (error) {
      setState({ error: errorText(error) })
    }
  }
  return (
    <>
      <Block
        label="Each turn"
        foot="Counted in whole items. Defaults are 60, 10 and 6."
      >
        {counts.map(({ key, label, sub, max }) => (
          <Row
            key={key}
            label={label}
            sub={`${sub}, 0 to ${max}`}
            subTone={
              invalid.some((item) => item.key === key) ? 'bad' : undefined
            }
            changed={changed.some((item) => item.key === key)}
            control={
              <input
                type="number"
                className="set-field set-number"
                aria-label={label}
                min={0}
                max={max}
                step={1}
                value={draft[key] ?? saved(key)}
                disabled={state === 'saving'}
                onChange={(e) =>
                  setDraft((old) => ({ ...old, [key]: e.target.value }))
                }
              />
            }
          />
        ))}
        {(changed.length > 0 || state === 'saving') && (
          <SaveRow state={state === 'saving' ? 'saving' : 'dirty'}>
            {state !== 'saving' && (
              <>
                <button className="set-button" onClick={() => setDraft({})}>
                  Discard
                </button>
                <button
                  className="set-button primary"
                  disabled={invalid.length > 0}
                  onClick={() => void save()}
                >
                  Save
                </button>
              </>
            )}
          </SaveRow>
        )}
      </Block>
      {typeof state === 'object' && (
        <p role="alert" className="set-alert">
          Not saved: {state.error}
        </p>
      )}
    </>
  )
}
