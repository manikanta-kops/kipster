import { useId, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  CoreSettingsClient,
  Directory,
  MemoryCard,
  MemoryCardEdit,
} from '../../data/core-settings'
import { TextHttpError } from '../../data/text'
import { ActionRow, Block, Callout, Confirm, Row, SaveRow, Switch } from './ui'
import { useSheet } from './sheet'
import { errorText } from './format'

const cardsKey = (client: CoreSettingsClient) => [
  'memory-cards',
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
      'A deleted organization')
    : 'Every organization'
const details = (card: MemoryCard) =>
  Object.keys(card.details).length ? JSON.stringify(card.details, null, 2) : ''

/** The cards every kip shares, newest first; replaced ones on demand. Reloads when opened. */
export function CardsPage({
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
    queryKey: [...cardsKey(client), ended],
    queryFn: ({ signal, pageParam }) =>
      client.memoryCards({ ended, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
  })
  const cards = query.data?.pages.flatMap((page) => page.cards) ?? []
  return (
    <>
      <Block foot="Each night, while kips sleep, they learn cards from what you tell them. Every kip shares them; a card learned in an organization stays there.">
        <Row
          label="Show replaced cards"
          labelId={switchId}
          control={<Switch labelId={switchId} on={ended} change={setEnded} />}
        />
      </Block>
      {query.isPending ? (
        <Callout>Loading cards…</Callout>
      ) : query.isError && !cards.length ? (
        <Callout
          tone="danger"
          alert
          actions={
            <button className="set-button" onClick={() => void query.refetch()}>
              Retry
            </button>
          }
        >
          Cards are unavailable: {errorText(query.error)}
        </Callout>
      ) : !cards.length ? (
        <Callout>
          {ended
            ? 'No cards yet.'
            : 'No cards yet. Kips learn them from your conversations each night.'}
        </Callout>
      ) : (
        <Block
          region="Cards"
          label={`${cards.length}${query.hasNextPage ? '+' : ''} cards`}
        >
          {cards.map((card) => (
            <Row
              key={card.id}
              label={card.statement}
              sub={[
                card.type,
                card.subject,
                workspace(directory, card.organizationId),
                card.validTo
                  ? `Replaced ${day(card.validTo)}`
                  : card.confirmed
                    ? 'Confirmed'
                    : 'Inferred',
                ...(card.core ? ['Core'] : []),
              ].join(' · ')}
              dim={!!card.validTo}
              chevron
              onClick={() =>
                push({ kind: 'card', cardId: card.id, title: card.subject })
              }
            />
          ))}
          {query.hasNextPage && (
            <ActionRow
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Show more cards'}
            </ActionRow>
          )}
        </Block>
      )}
      {query.isFetchNextPageError && (
        <p role="alert" className="set-alert">
          More cards are unavailable: {errorText(query.error)}
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

/** One card: read it, correct a current card, or delete it with confirmation. */
export function CardPage({
  client,
  directory,
  cardId,
}: {
  client: CoreSettingsClient
  directory: Directory | null
  cardId: string
}) {
  const { push, pop, toast } = useSheet()
  const queries = useQueryClient()
  const key = [...cardsKey(client), 'card', cardId]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.memoryCard(cardId, signal),
    retry: false,
    gcTime: 0,
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [state, setState] = useState<State>('idle')
  if (query.isPending) return <Callout>Loading card…</Callout>
  if (query.isError)
    return query.error instanceof TextHttpError &&
      query.error.code === 'not-found' ? (
      <Callout>This card was deleted.</Callout>
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
        This card is unavailable: {errorText(query.error)}
      </Callout>
    )
  const card = query.data
  const current = !card.validTo
  const fields = {
    statement: card.statement,
    type: card.type,
    subject: card.subject,
    details: details(card),
  }
  const value = (field: keyof typeof fields) => draft[field] ?? fields[field]
  const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter(
    (field) => draft[field] !== undefined && draft[field] !== fields[field],
  )
  const set = (field: keyof typeof fields, next: string) =>
    setDraft((old) => ({ ...old, [field]: next }))
  const busy = state === 'saving' || state === 'deleting'
  const reloaded = () =>
    void queries.invalidateQueries({ queryKey: cardsKey(client) })

  async function save() {
    const edit: { -readonly [K in keyof MemoryCardEdit]: MemoryCardEdit[K] } =
      {}
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
      const saved = await client.saveMemoryCard(
        cardId,
        edit,
        AbortSignal.timeout(20000),
      )
      queries.setQueryData(key, saved)
      setDraft({})
      setState('idle')
      reloaded()
      toast('Card saved')
    } catch (error) {
      setState({ error: errorText(error) })
      if (error instanceof TextHttpError && error.code === 'conflict')
        void query.refetch()
    }
  }
  async function remove() {
    setState('deleting')
    try {
      await client.deleteMemoryCard(cardId, AbortSignal.timeout(20000))
      reloaded()
      toast('Card deleted')
      pop()
    } catch (error) {
      setState({ error: errorText(error), deleting: true })
    }
  }

  const facts: [string, string][] = [
    [
      'Learned',
      card.confirmed
        ? 'Confirmed: you said it'
        : 'Inferred from a conversation',
    ],
    ['Core', card.core ? 'Loaded into every turn' : 'Found when relevant'],
    ['Organization', workspace(directory, card.organizationId)],
    ['Valid from', day(card.validFrom)],
    ...(card.validTo
      ? [['Replaced', day(card.validTo)] as [string, string]]
      : []),
    [
      'Sources',
      card.sources.length === 1
        ? '1 message'
        : `${card.sources.length} messages`,
    ],
  ]
  return (
    <>
      {!current && (
        <Callout
          actions={
            card.replacedBy && (
              <button
                className="set-button"
                onClick={() =>
                  push({
                    kind: 'card',
                    cardId: card.replacedBy!,
                    title: 'Replacement',
                  })
                }
              >
                Open replacement
              </button>
            )
          }
        >
          This card was replaced on {day(card.validTo!)}. Only a current card
          can be edited.
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
          <p className="set-foot">Saving marks the card as confirmed.</p>
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
      <Block foot="Kips forget the card. The messages it was learned from stay.">
        <ActionRow disabled={busy} onClick={() => setState('confirm')}>
          Delete card…
        </ActionRow>
      </Block>
      {(state === 'confirm' || state === 'deleting') && (
        <Confirm title="Delete this card?" cancel={() => setState('idle')}>
          <div className="set-confirm-form">
            <p>
              Kips forget “{card.statement}”. The messages it was learned from
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
                {state === 'deleting' ? 'Deleting…' : 'Delete card'}
              </button>
            </div>
          </div>
        </Confirm>
      )}
    </>
  )
}
