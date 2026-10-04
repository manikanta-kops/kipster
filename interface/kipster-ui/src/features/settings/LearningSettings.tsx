import { useId, useState } from 'react'
import type { Directory } from '../../data/core-settings'
import type { Settings } from './ExecutionSettings'
import { KipAvatar, type KipLook } from './KipAvatar'
import { ActionRow, Block, Row, SaveRow, Switch } from './ui'
import { useSheet } from './sheet'
import { clockTime, errorText } from './format'

type State = 'idle' | 'saving' | { error: string }

/** The installation switch, the default sleep time and each kip's summary. */
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
        region="Learning"
        foot="Daily, in this device’s local time. Kips can use their own."
      >
        <Row
          label="Learn from conversations"
          labelId={switchId}
          sub={
            learning.available
              ? 'Kips learn from completed conversations and tidy what they learned while they sleep. Off by default.'
              : 'Learning needs an embedding profile configured in Kipster Core.'
          }
          control={
            <Switch
              labelId={switchId}
              on={learning.enabled}
              disabled={
                state === 'saving' || (!learning.available && !learning.enabled)
              }
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
    <section aria-label="Kip learning" className="set-block">
      <h4 className="set-label">Learning</h4>
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
              aria-label="Kip sleep time"
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
