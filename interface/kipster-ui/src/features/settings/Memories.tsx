import { useId, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  CoreSettingsClient,
  Directory,
  Memory,
  MemoryEdit,
} from '../../data/core-settings'
import { TextHttpError } from '../../data/text'
import { ActionRow, Block, Callout, Confirm, Row, SaveRow, Switch } from './ui'
import { useSheet } from './sheet'
import { errorText } from './format'

const memoriesKey = (client: CoreSettingsClient) => [
  'memories',
  client.endpoint,
]
const day = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
const workspace = (
  directory: Directory | null,
  organizationId: string | null,
) =>
  organizationId
    ? (directory?.organizations.find((o) => o.id === organizationId)?.name ??
      'A deleted workspace')
    : 'Every workspace'
const details = (memory: Memory) =>
  Object.keys(memory.details).length
    ? JSON.stringify(memory.details, null, 2)
    : ''

/** The memories every kip shares, newest first; ended ones on demand. Reloads when opened. */
export function MemoriesPage({
  client,
  directory,
}: {
  client: CoreSettingsClient
  directory: Directory | null
}) {
  const { push } = useSheet()
  const [ended, setEnded] = useState(false)
  const switchId = useId()
  const query = useInfiniteQuery({
    queryKey: [...memoriesKey(client), ended],
    queryFn: ({ signal, pageParam }) =>
      client.memories({ ended, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
  })
  const memories = query.data?.pages.flatMap((page) => page.memories) ?? []
  return (
    <>
      <Block foot="What your kips remember about you. Each night, while kips sleep, they learn memories from what you tell them. Every kip shares them; a memory learned in a workspace stays there.">
        <Row
          label="Show replaced and retired memories"
          labelId={switchId}
          control={<Switch labelId={switchId} on={ended} change={setEnded} />}
        />
      </Block>
      {query.isPending ? (
        <Callout>Loading memories…</Callout>
      ) : query.isError && !memories.length ? (
        <Callout
          tone="danger"
          alert
          actions={
            <button className="set-button" onClick={() => void query.refetch()}>
              Retry
            </button>
          }
        >
          Memories are unavailable: {errorText(query.error)}
        </Callout>
      ) : !memories.length ? (
        <Callout>
          {ended
            ? 'No memories yet.'
            : 'No memories yet. Kips learn them from your conversations each night.'}
        </Callout>
      ) : (
        <Block
          region="Memories"
          label={`${memories.length}${query.hasNextPage ? '+' : ''} memories`}
        >
          {memories.map((memory) => (
            <Row
              key={memory.id}
              label={memory.statement}
              sub={[
                memory.type,
                memory.subject,
                workspace(directory, memory.organizationId),
                memory.validTo
                  ? `${memory.replacedBy ? 'Replaced' : 'Retired'} ${day(memory.validTo)}`
                  : memory.confirmed
                    ? 'Confirmed'
                    : 'Inferred',
                ...(memory.core ? ['Core'] : []),
              ].join(' · ')}
              dim={!!memory.validTo}
              chevron
              onClick={() =>
                push({
                  kind: 'memory',
                  memoryId: memory.id,
                  title: memory.subject,
                })
              }
            />
          ))}
          {query.hasNextPage && (
            <ActionRow
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Show more memories'}
            </ActionRow>
          )}
        </Block>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="set-alert">
          More memories are unavailable: {errorText(query.error)}
        </p>
      )}
    </>
  )
}

type State =
  | 'idle'
  | 'saving'
  | 'confirm'
  | 'deleting'
  | { error: string; deleting?: boolean }

/** One memory: read it, correct a current memory, or delete it with confirmation. */
export function MemoryPage({
  client,
  directory,
  memoryId,
}: {
  client: CoreSettingsClient
  directory: Directory | null
  memoryId: string
}) {
  const { push, pop, toast } = useSheet()
  const queries = useQueryClient()
  const key = [...memoriesKey(client), 'memory', memoryId]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.memory(memoryId, signal),
    retry: false,
    gcTime: 0,
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [state, setState] = useState<State>('idle')
  if (query.isPending) return <Callout>Loading memory…</Callout>
  if (query.isError)
    return query.error instanceof TextHttpError &&
      query.error.code === 'not-found' ? (
      <Callout>This memory was deleted.</Callout>
    ) : (
      <Callout
        tone="danger"
        alert
        actions={
          <button className="set-button" onClick={() => void query.refetch()}>
            Retry
          </button>
        }
      >
        This memory is unavailable: {errorText(query.error)}
      </Callout>
    )
  const memory = query.data
  const current = !memory.validTo
  const fields = {
    statement: memory.statement,
    type: memory.type,
    subject: memory.subject,
    details: details(memory),
  }
  const value = (field: keyof typeof fields) => draft[field] ?? fields[field]
  const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
    (field) => draft[field] !== undefined && draft[field] !== fields[field],
  )
  const set = (field: keyof typeof fields, next: string) =>
    setDraft((old) => ({ ...old, [field]: next }))
  const busy = state === 'saving' || state === 'deleting'
  const reloaded = () =>
    void queries.invalidateQueries({ queryKey: memoriesKey(client) })

  async function save() {
    const edit: { -readonly [K in keyof MemoryEdit]: MemoryEdit[K] } = {}
    for (const field of changed) {
      const text = draft[field]!.trim()
      if (field === 'details') {
        let parsed: unknown = {}
        try {
          parsed = text ? JSON.parse(text) : {}
        } catch {
          parsed = null
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return setState({
            error:
              'Details must be a JSON object, such as {"due": "2026-12-01"}.',
          })
        edit.details = parsed as Record<string, unknown>
      } else if (!text)
        return setState({ error: `The ${field} cannot be empty.` })
      else edit[field] = text
    }
    setState('saving')
    try {
      const saved = await client.saveMemory(
        memoryId,
        edit,
        AbortSignal.timeout(20000),
      )
      queries.setQueryData(key, saved)
      setDraft({})
      setState('idle')
      reloaded()
      toast('Memory saved')
    } catch (error) {
      setState({ error: errorText(error) })
      if (error instanceof TextHttpError && error.code === 'conflict')
        void query.refetch()
    }
  }
  async function remove() {
    setState('deleting')
    try {
      await client.deleteMemory(memoryId, AbortSignal.timeout(20000))
      reloaded()
      toast('Memory deleted')
      pop()
    } catch (error) {
      setState({ error: errorText(error), deleting: true })
    }
  }

  const facts: [string, string][] = [
    [
      'Learned',
      memory.confirmed
        ? 'Confirmed: you said it'
        : 'Inferred from a conversation',
    ],
    ['Core', memory.core ? 'Loaded into every turn' : 'Found when relevant'],
    ['Workspace', workspace(directory, memory.organizationId)],
    ['Valid from', day(memory.validFrom)],
    ...(memory.validTo
      ? [
          [memory.replacedBy ? 'Replaced' : 'Retired', day(memory.validTo)] as [
            string,
            string,
          ],
        ]
      : []),
    [
      'Sources',
      memory.sources.length === 1
        ? '1 message'
        : `${memory.sources.length} messages`,
    ],
  ]
  return (
    <>
      {!current && (
        <Callout
          actions={
            memory.replacedBy && (
              <button
                className="set-button"
                onClick={() =>
                  push({
                    kind: 'memory',
                    memoryId: memory.replacedBy!,
                    title: 'Replacement',
                  })
                }
              >
                Open replacement
              </button>
            )
          }
        >
          This memory {memory.replacedBy ? 'was replaced' : 'was retired'} on{' '}
          {day(memory.validTo!)}. Only a current memory can be edited.
        </Callout>
      )}
      <Block label="Statement" bare>
        <div className="set-group">
          <textarea
            className="set-editor set-card-text set-card-statement"
            aria-label="Statement"
            value={value('statement')}
            readOnly={!current}
            disabled={busy}
            maxLength={2000}
            onChange={(e) => set('statement', e.target.value)}
          />
        </div>
      </Block>
      <Block label="About">
        <Row
          label="Type"
          sub="Such as fact, preference, person, goal or event"
          changed={changed.includes('type')}
          control={
            <input
              className="set-field"
              aria-label="Type"
              value={value('type')}
              readOnly={!current}
              disabled={busy}
              maxLength={40}
              onChange={(e) => set('type', e.target.value)}
            />
          }
        />
        <Row
          label="Subject"
          sub="Who or what it is about"
          changed={changed.includes('subject')}
          control={
            <input
              className="set-field"
              aria-label="Subject"
              value={value('subject')}
              readOnly={!current}
              disabled={busy}
              maxLength={200}
              onChange={(e) => set('subject', e.target.value)}
            />
          }
        />
      </Block>
      <Block
        label="Details"
        bare
        foot='Optional, as a JSON object such as {"due": "2026-12-01"}.'
      >
        <div className="set-group">
          <textarea
            className="set-editor set-card-text"
            aria-label="Details"
            spellCheck={false}
            value={value('details')}
            readOnly={!current}
            disabled={busy}
            onChange={(e) => set('details', e.target.value)}
          />
        </div>
      </Block>
      {current && (changed.length > 0 || state === 'saving') && (
        <div className="set-block">
          <div className="set-group">
            <SaveRow state={state === 'saving' ? 'saving' : 'dirty'}>
              {state !== 'saving' && (
                <>
                  <button
                    className="set-button"
                    onClick={() => {
                      setDraft({})
                      setState('idle')
                    }}
                  >
                    Discard
                  </button>
                  <button
                    className="set-button primary"
                    onClick={() => void save()}
                  >
                    Save
                  </button>
                </>
              )}
            </SaveRow>
          </div>
          <p className="set-foot">Saving marks the memory as confirmed.</p>
        </div>
      )}
      {typeof state === 'object' && (
        <p role="alert" className="set-alert">
          {state.deleting ? 'Not deleted' : 'Not saved'}: {state.error}
        </p>
      )}
      <Block label="Status" bare>
        <dl className="set-group">
          {facts.map(([label, text]) => (
            <div className="set-row" key={label}>
              <dt className="set-text">{label}</dt>
              <dd className="set-control">{text}</dd>
            </div>
          ))}
        </dl>
      </Block>
      <Block foot="Kips forget the memory. The messages it was learned from stay.">
        <ActionRow disabled={busy} onClick={() => setState('confirm')}>
          Delete memory…
        </ActionRow>
      </Block>
      {(state === 'confirm' || state === 'deleting') && (
        <Confirm title="Delete this memory?" cancel={() => setState('idle')}>
          <div className="set-confirm-form">
            <p>
              Kips forget “{memory.statement}”. The messages it was learned from
              stay.
            </p>
            <div className="set-confirm-actions">
              <button
                className="set-button"
                disabled={state === 'deleting'}
                onClick={() => setState('idle')}
              >
                Cancel
              </button>
              <button
                className="set-button danger solid"
                disabled={state === 'deleting'}
                onClick={() => void remove()}
              >
                {state === 'deleting' ? 'Deleting…' : 'Delete memory'}
              </button>
            </div>
          </div>
        </Confirm>
      )}
    </>
  )
}
