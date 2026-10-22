import { useEffect, useId, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  CoreSettingsClient,
  Directory,
  Lesson,
} from '../../data/core-settings'
import { TextHttpError } from '../../data/text'
import { ActionRow, Block, Callout, Confirm, Row, SaveRow, Switch } from './ui'
import { useSheet } from './sheet'
import { errorText } from './format'

/** Lessons in a kip's identity.md Learned section, as Core picks them. */
const LEARNED = 10
const lessonsKey = (client: CoreSettingsClient) => ['lessons', client.endpoint]
const day = (value: string) =>
  new Date(
    value.length === 10 ? `${value}T12:00:00` : value,
  ).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
const nights = (count: number) =>
  count === 1 ? 'Came up on 1 night' : `Came up on ${count} nights`
const workspace = (directory: Directory | null, organizationId: string) =>
  directory?.organizations.find((o) => o.id === organizationId)?.name ??
  'a deleted workspace'
const kipName = (directory: Directory | null, agentId: string) =>
  directory?.agents.find((a) => a.id === agentId)?.name ?? 'A removed kip'
/** Most confirmed first, then most recently confirmed. */
const weight = (a: Lesson, b: Lesson) =>
  b.confirmations - a.confirmations ||
  b.lastConfirmedNight.localeCompare(a.lastConfirmedNight)

/** Each kip's lessons, its most confirmed first; ended ones on demand. Reloads when opened. */
export function LessonsPage({
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
    queryKey: [...lessonsKey(client), ended],
    queryFn: ({ signal, pageParam }) =>
      client.lessons({ ended, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
    gcTime: 0,
  })
  // Every page, so each kip's top lessons are right.
  const {
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
  } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError)
      void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])
  const lessons = query.data?.pages.flatMap((page) => page.lessons) ?? []
  const byKip = new Map<string, Lesson[]>()
  for (const lesson of lessons)
    byKip.set(lesson.agentId, [...(byKip.get(lesson.agentId) ?? []), lesson])
  const groups = [...byKip.entries()]
    .map(([agentId, items]) => {
      const current = items.filter((item) => !item.validTo).sort(weight)
      const old = items.filter((item) => item.validTo)
      return {
        agentId,
        name: kipName(directory, agentId),
        items: [...current, ...old],
        learned: new Set(current.slice(0, LEARNED).map((item) => item.id)),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <>
      <Block foot="Each night, kips learn how to do their work from what you and other kips tell them. A kip keeps its lessons in every workspace, and its 10 that came up most often are in the Learned section of its identity.md.">
        <Row
          label="Show merged and retired lessons"
          labelId={switchId}
          control={<Switch labelId={switchId} on={ended} change={setEnded} />}
        />
      </Block>
      {query.isPending ? (
        <Callout>Loading lessons…</Callout>
      ) : query.isError && !lessons.length ? (
        <Callout
          tone="danger"
          alert
          actions={
            <button className="set-button" onClick={() => void query.refetch()}>
              Retry
            </button>
          }
        >
          Lessons are unavailable: {errorText(query.error)}
        </Callout>
      ) : !lessons.length ? (
        <Callout>
          {ended
            ? 'No lessons yet.'
            : 'No lessons yet. Kips learn them from your conversations each night.'}
        </Callout>
      ) : (
        groups.map((group) => (
          <Block
            key={group.agentId}
            region={`Lessons of ${group.name}`}
            label={group.name}
          >
            {group.items.map((lesson) => (
              <Row
                key={lesson.id}
                label={lesson.statement}
                sub={[
                  nights(lesson.confirmations),
                  ...(lesson.organizationId
                    ? [
                        `Learned in ${workspace(directory, lesson.organizationId)}`,
                      ]
                    : []),
                  ...(lesson.validTo
                    ? [
                        `${lesson.replacedBy ? 'Merged' : 'Retired'} ${day(lesson.validTo)}`,
                      ]
                    : group.learned.has(lesson.id)
                      ? ['In identity.md']
                      : []),
                ].join(' · ')}
                dim={!!lesson.validTo}
                chevron
                onClick={() =>
                  push({
                    kind: 'lesson',
                    lessonId: lesson.id,
                    title: group.name,
                  })
                }
              />
            ))}
          </Block>
        ))
      )}
      {query.isFetchNextPageError && (
        <>
          <p role="alert" className="set-alert">
            More lessons are unavailable: {errorText(query.error)}
          </p>
          <Block>
            <ActionRow onClick={() => void query.fetchNextPage()}>
              Try again
            </ActionRow>
          </Block>
        </>
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

/** One lesson: read it, reword a current one, or delete it with confirmation. */
export function LessonPage({
  client,
  directory,
  lessonId,
}: {
  client: CoreSettingsClient
  directory: Directory | null
  lessonId: string
}) {
  const { push, pop, toast } = useSheet()
  const queries = useQueryClient()
  const key = [...lessonsKey(client), 'lesson', lessonId]
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => client.lesson(lessonId, signal),
    retry: false,
    gcTime: 0,
  })
  const [draft, setDraft] = useState<string | null>(null)
  const [state, setState] = useState<State>('idle')
  if (query.isPending) return <Callout>Loading lesson…</Callout>
  if (query.isError)
    return query.error instanceof TextHttpError &&
      query.error.code === 'not-found' ? (
      <Callout>This lesson was deleted.</Callout>
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
        This lesson is unavailable: {errorText(query.error)}
      </Callout>
    )
  const lesson = query.data
  const current = !lesson.validTo
  const value = draft ?? lesson.statement
  const changed = draft !== null && draft !== lesson.statement
  const busy = state === 'saving' || state === 'deleting'
  const name = kipName(directory, lesson.agentId)
  const reloaded = () =>
    void queries.invalidateQueries({ queryKey: lessonsKey(client) })

  async function save() {
    const text = value.trim()
    if (!text) return setState({ error: 'The lesson cannot be empty.' })
    setState('saving')
    try {
      const saved = await client.saveLesson(
        lessonId,
        text,
        AbortSignal.timeout(20000),
      )
      queries.setQueryData(key, saved)
      setDraft(null)
      setState('idle')
      reloaded()
      toast('Lesson saved')
    } catch (error) {
      setState({ error: errorText(error) })
      if (error instanceof TextHttpError && error.code === 'conflict')
        void query.refetch()
    }
  }
  async function remove() {
    setState('deleting')
    try {
      await client.deleteLesson(lessonId, AbortSignal.timeout(20000))
      reloaded()
      toast('Lesson deleted')
      pop()
    } catch (error) {
      setState({ error: errorText(error), deleting: true })
    }
  }

  const facts: [string, string][] = [
    ['Learned by', name],
    [
      'Learned in',
      lesson.organizationId
        ? workspace(directory, lesson.organizationId)
        : 'A chat outside workspaces',
    ],
    ['Came up', nights(lesson.confirmations).replace('Came up on ', '')],
    ['Last came up', day(lesson.lastConfirmedNight)],
    ['First learned', day(lesson.validFrom)],
    ...(lesson.validTo
      ? [
          [lesson.replacedBy ? 'Merged' : 'Retired', day(lesson.validTo)] as [
            string,
            string,
          ],
        ]
      : []),
    [
      'Sources',
      lesson.sources.length === 1
        ? '1 message'
        : `${lesson.sources.length} messages`,
    ],
  ]
  return (
    <>
      {!current && (
        <Callout
          actions={
            lesson.replacedBy && (
              <button
                className="set-button"
                onClick={() =>
                  push({
                    kind: 'lesson',
                    lessonId: lesson.replacedBy!,
                    title: name,
                  })
                }
              >
                Open merged lesson
              </button>
            )
          }
        >
          This lesson was{' '}
          {lesson.replacedBy ? 'merged into another' : 'retired'} on{' '}
          {day(lesson.validTo!)}. Only a current lesson can be edited.
        </Callout>
      )}
      <Block
        label="Lesson"
        bare
        foot={`How ${name} should do its work. Saving keeps how often it came up.`}
      >
        <div className="set-group">
          <textarea
            className="set-editor set-card-text set-card-statement"
            aria-label="Lesson"
            value={value}
            readOnly={!current}
            disabled={busy}
            maxLength={1000}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
      </Block>
      {current && (changed || state === 'saving') && (
        <div className="set-block">
          <div className="set-group">
            <SaveRow state={state === 'saving' ? 'saving' : 'dirty'}>
              {state !== 'saving' && (
                <>
                  <button
                    className="set-button"
                    onClick={() => {
                      setDraft(null)
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
      <Block
        foot={`${name} forgets the lesson. The messages it was learned from stay.`}
      >
        <ActionRow disabled={busy} onClick={() => setState('confirm')}>
          Delete lesson…
        </ActionRow>
      </Block>
      {(state === 'confirm' || state === 'deleting') && (
        <Confirm title="Delete this lesson?" cancel={() => setState('idle')}>
          <div className="set-confirm-form">
            <p>
              {name} forgets “{lesson.statement}”. The messages it was learned
              from stay.
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
                {state === 'deleting' ? 'Deleting…' : 'Delete lesson'}
              </button>
            </div>
          </div>
        </Confirm>
      )}
    </>
  )
}
