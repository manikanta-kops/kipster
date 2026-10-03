import { HistoryWindow } from '../chat/HistoryWindow'
import { ApplicationUpdates } from '../../data/application-updates'
import {
  SoftwareUpdates,
  useSoftwareUpdates,
} from '../../data/software-updates'
import { SoftwareUpdatePill } from '../status/SoftwareUpdatePill'
import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { PlatformContext } from '../../platform/context'
import {
  desktopAlertsKey,
  InterfacePreferencesContext,
} from '../../data/interface-preferences'
import { useMediaQuery } from '../../app/use-media-query'
import { agentHues, hueVar, isDarkOnly } from '../../app/appearance'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { Sidebar } from './Sidebar'
import { Management } from './Management'
import { defaultNavigation, type Navigation } from './navigation'
import { StatusIsland, type IslandAction } from '../status/StatusIsland'
import { ActionMenu } from '../status/ActionMenu'
import { KipHead } from '../../components/Kip'
import {
  summarize,
  deriveThreadState,
  type LiveState,
} from '../status/live-state'
import { Avatar, Message } from '../chat/Message'
import { RootFeed } from '../chat/RootFeed'
import { ThreadPane } from '../chat/ThreadPane'
import { DocPane } from '../documents/DocPane'
import { DocsSection } from '../documents/DocCard'
import { DocumentStore } from '../documents/store'
import {
  DocumentClient,
  type Summary as DocumentSummary,
} from '../../data/documents'
import { useScrollHistory } from '../chat/use-scroll-history'
import { usePointerGloss } from '../../app/use-pointer-gloss'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { quickFade } from '../../app/motion'
import type { Appearance } from '../../app/appearance'
import { DurableComposer } from '../chat/DurableComposer'
import { ConversationRecovery } from '../chat/ConversationRecovery'
import { Inbox } from '../notifications/Inbox'
import { Banners } from '../notifications/Banners'
import { useNotifications } from '../notifications/use-notifications'
import { ownNotificationChoices } from '../notifications/settings'
import {
  actionItems,
  chatMarks,
  isFailure,
  needsYou,
  type InboxNotification,
} from '../../data/notifications'
import { WorkPanel, WorkRecovery } from '../work/WorkPanel'
import { useWorkCommands } from '../work/use-work-commands'
import {
  createCoreWorkClient,
  inboxItems,
  summaryTarget,
  threadWork,
} from '../../data/core-work'
import { emptyWork } from '../../data/work'
import { conversationStorage, draftKey } from '../../data/conversation-storage'
import { createCoreManagement } from '../../data/management-core'
import { createMediaClient } from '../../data/media'
import { compatibility, type Compatibility } from '../../data/compatibility'
import { CompatibilityBlock } from './CompatibilityBlock'
import { WorkspaceContext } from '../../data/workspace-context'
import { useOutbox } from '../chat/use-outbox'
import type { WorkspaceData } from '../chat/model'
import type { ConversationTarget } from '../../data/conversations'
import type { Agent } from '../chat/model'
import {
  navigationPreferences,
  threadPreference,
  readPreferences,
  persistPreferences,
} from '../../data/preferences'
import {
  agentLabel,
  applyDirectoryEvent,
  chatGone,
  chatKey,
  directoryEventTypes,
  formerMemberChats,
  resolveSelection,
  summaryKey,
  workspaceView,
  type ChatTarget,
  type Directory,
  type DirectoryEvent,
} from '../../data/directory'
import {
  mergeAppNotices,
  mergeAppSummaries,
  mergeNotice,
  mergeRevisions,
  threadTitle,
  upsertRevision,
  waitingNotices,
} from '../../data/state'
import {
  TextClient,
  TextHttpError,
  type Bootstrap,
  type Summary,
  type Notice,
  type TextMessage,
  type TextWork,
  type TextInteraction,
  type TextDelegation,
  type ThreadRemoved,
  type WireEvent,
} from '../../data/text'

const CoreSettingsPanel = lazy(() =>
  import('../settings/CoreSettingsPanel').then((m) => ({
    default: m.CoreSettingsPanel,
  })),
)
const LifecyclePanel = lazy(() =>
  import('./LifecyclePanel').then((m) => ({ default: m.LifecyclePanel })),
)

const connecting = 'Connecting to Kipster…'
const delay = (signal: AbortSignal, time: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, time)
    signal.addEventListener('abort', done, { once: true })
  })

/** A stable avatar color, since agents have no stored one. */
const agentColor = (agentId: string) => {
  let hash = 0
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentHues[hash % agentHues.length]
}
/** The status island's state for a thread, from its summary's work state. */
const summaryState = (state: string): LiveState =>
  (
    ({
      queued: 'queued',
      preparing: 'preparing',
      running: 'thinking',
      waiting: 'delegating',
      'cancellation-requested': 'stopping',
      failed: 'failed',
      'recovery-needed': 'recovery',
      completed: 'ready',
      cancelled: 'ready',
      '': 'ready',
    }) as Record<string, LiveState>
  )[state] ?? 'unknown'

/** Summary states of a thread whose kip is busy with it. */
const working = new Set([
  'preparing',
  'running',
  'waiting',
  'cancellation-requested',
])

export function Workspace({
  endpoint,
  appearance,
  changeConnection,
}: {
  endpoint: string
  appearance: Appearance
  changeConnection?: () => void
}) {
  const [applicationUpdates] = useState(() => new ApplicationUpdates())
  const platform = useContext(PlatformContext)
  const interfacePreferences = useContext(InterfacePreferencesContext)
  const softwareUpdates = useMemo(
    () => new SoftwareUpdates(endpoint),
    [endpoint],
  )
  const softwareState = useSoftwareUpdates(softwareUpdates)
  useEffect(() => softwareUpdates.start(), [softwareUpdates])
  const client = useMemo(() => new TextClient(endpoint), [endpoint])
  const documents = useMemo(
    () => new DocumentStore(new DocumentClient(client.endpoint)),
    [client],
  )
  const [openDoc, setOpenDoc] = useState<string | null>(null)
  const [queries] = useState(() => new QueryClient())
  useEffect(
    () => () => {
      void queries.cancelQueries()
      queries.clear()
    },
    [queries],
  )
  const mediaClient = useMemo(() => createMediaClient(endpoint), [endpoint])
  const [identity, setIdentity] = useState<Bootstrap | null>(null)
  const [blocked, setBlocked] = useState<{
    state: Exclude<Compatibility, 'compatible'>
    bootstrap: Bootstrap
  } | null>(null)
  const [checking, setChecking] = useState(false)
  const [directory, setDirectory] = useState<Directory | null>(null)
  // Management resolves moves against the directory as it is when a request is sent.
  const directoryRef = useRef(directory)
  directoryRef.current = directory
  const mediaWorkspace = useMemo(
    () => ({
      connectionKey: endpoint,
      media: mediaClient,
      management: createCoreManagement(endpoint, () => directoryRef.current),
    }),
    [endpoint, mediaClient],
  )
  const [navigation, setNavigation] = useState<Navigation>(defaultNavigation)
  const narrow = useMediaQuery('(max-width: 820px)')
  const [drawer, setDrawer] = useState(false)
  const drawerOpen = narrow && drawer
  const dock = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = dock.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      element.parentElement?.style.setProperty(
        '--dock-h',
        `${element.offsetHeight}px`,
      ),
    )
    observer.observe(element)
    return () => observer.disconnect()
  })
  useEffect(() => {
    if (!drawerOpen) return
    const opener = document.querySelector<HTMLElement>('.toolbar-menu')
    const sidebar = document.getElementById('workspace-sidebar')
    const items = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0)
    items()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        setDrawer(false)
      }
      if (event.key === 'Tab') {
        const available = items()
        const first = available[0],
          last = available.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      opener?.focus({ preventScroll: true })
    }
  }, [drawerOpen])

  const [chatIds, setChatIds] = useState<Record<string, string>>({})
  // A chat that could not be opened, by chat key.
  const [chatErrors, setChatErrors] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  // Everything received; chats that are gone are filtered out below.
  const [allSummaries, setSummaries] = useState<Record<string, Summary>>({})
  const knownNotices = useRef(new Set<string>())
  const [arrivals, setArrivals] = useState<string[]>([])
  const [allNotices, setNotices] = useState<Record<string, Notice>>({})
  // Threads Core reported gone, and unsent text kept from them.
  const [goneThreads, setGoneThreads] = useState<Record<string, true>>({})
  const [kept, setKept] = useState<
    { key: string; text: string; reply: boolean }[]
  >([])
  const [goneNotice, setGoneNotice] = useState('')
  useEffect(() => {
    if (
      directory &&
      navigation.agentId &&
      (['deleting', 'deleted'].includes(
        directory.agents[navigation.agentId]?.lifecycle ?? '',
      ) ||
        (navigation.target === 'organization' &&
          navigation.organizationId &&
          directory.organizations[navigation.organizationId]?.lifecycle !==
            'active'))
    ) {
      setGoneNotice(
        'This conversation is no longer available. Saved drafts and unsent messages remain in recovery below.',
      )
      setSelected(null)
    }
  }, [
    directory,
    navigation.agentId,
    navigation.organizationId,
    navigation.target,
  ])
  const [messages, setMessages] = useState<
    Record<string, Record<string, TextMessage>>
  >({})
  const [works, setWorks] = useState<Record<string, Record<string, TextWork>>>(
    {},
  )
  const [interactions, setInteractions] = useState<
    Record<string, Record<string, TextInteraction>>
  >({})
  const [delegations, setDelegations] = useState<
    Record<string, Record<string, TextDelegation>>
  >({})
  const [hydrated, setHydrated] = useState<Record<string, number>>({})
  const [hydrationErrors, setHydrationErrors] = useState<
    Record<string, string>
  >({})
  const [appReady, setAppReady] = useState(false)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const [localError, setLocalError] = useState('')
  const [connection, setConnection] = useState(connecting)
  const [threadConnection, setThreadConnection] = useState('')
  const [reload, setReload] = useState(0)
  const { theme } = appearance
  usePointerGloss()
  const reduceMotion = useReducedMotion()
  const [expanded, setExpanded] = useState(false)
  const feedScroll = useRef<HTMLDivElement>(null)
  const threadScroll = useRef<HTMLDivElement>(null)
  const historyControls = useRef<{ latest: () => void }>(null)
  const closeThreadButton = useRef<HTMLButtonElement>(null)
  const threadTriggers = useRef(new Map<string, HTMLButtonElement>())
  const [inboxOpener, setInboxOpener] = useState<HTMLElement | null>(null)
  const [actionMenu, setActionMenu] = useState<{
    anchor: HTMLButtonElement
    key: string
  } | null>(null)
  const [lifecycleOpen, setLifecycleOpen] = useState(false)
  const [settingsOpener, setSettingsOpener] = useState<HTMLElement | null>(null)
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    'workspace' | 'updates'
  >('workspace')
  // A chat whose agent is being deleted, or whose organization is, is gone with its threads.
  const summaries = useMemo(
    () =>
      directory
        ? Object.fromEntries(
            Object.entries(allSummaries).filter(
              ([id, s]) => !goneThreads[id] && !chatGone(directory, s),
            ),
          )
        : allSummaries,
    [directory, allSummaries, goneThreads],
  )
  const notices = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(allNotices).filter(
          ([, n]) =>
            !goneThreads[n.threadId] &&
            (!allSummaries[n.threadId] || summaries[n.threadId]),
        ),
      ),
    [allNotices, allSummaries, summaries, goneThreads],
  )
  const gone = useMemo(() => {
    const threads = new Set(Object.keys(goneThreads))
    const chats = new Set<string>()
    for (const s of Object.values(allSummaries))
      if (!summaries[s.threadId]) {
        threads.add(s.threadId)
        chats.add(s.chatId)
      }
    return { threads, chats }
  }, [goneThreads, allSummaries, summaries])
  /** Core reported the thread gone: forget it and its notifications. */
  const threadGone = useCallback((threadId: string) => {
    setGoneThreads((old) => ({ ...old, [threadId]: true }))
    setSummaries((old) => {
      const next = { ...old }
      delete next[threadId]
      return next
    })
    setNotices((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([, n]) => n.threadId !== threadId),
      ),
    )
  }, [])

  const markRead = useCallback(
    (ids: string[]) =>
      setNotices((old) => {
        const next = { ...old }
        for (const id of ids)
          if (next[id]) next[id] = { ...next[id], read: true }
        return next
      }),
    [],
  )
  const removeNotices = useCallback(
    (ids: string[]) =>
      setNotices((old) =>
        Object.fromEntries(
          Object.entries(old).filter(([id]) => !ids.includes(id)),
        ),
      ),
    [],
  )
  /** Clears everything read from Core, as for a new installation. */
  const forget = useCallback(() => {
    setSelected(null)
    setOpenDoc(null)
    setDirectory(null)
    setNavigation(defaultNavigation)
    setChatIds({})
    setSummaries({})
    setNotices({})
    setGoneThreads({})
    setKept([])
    setMessages({})
    setWorks({})
    setInteractions({})
    setDelegations({})
    setHydrated({})
    setHydrationErrors({})
    setAppReady(false)
    setPendingSelection(null)
  }, [])
  /** Stops every request and stream until the app and Core share a protocol. */
  const block = useCallback(
    (state: Exclude<Compatibility, 'compatible'>, bootstrap: Bootstrap) => {
      forget()
      setIdentity(null)
      setConnection(connecting)
      setBlocked({ state, bootstrap })
    },
    [forget],
  )
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        const bootstrap = await client.bootstrap(abort.signal)
        if (!abort.signal.aborted) {
          softwareUpdates.setBootstrap(bootstrap)
          const state = compatibility(bootstrap.protocol)
          if (state !== 'compatible') block(state, bootstrap)
          else {
            setBlocked(null)
            if (
              identity &&
              (identity.installationId !== bootstrap.installationId ||
                identity.callerId !== bootstrap.callerId)
            )
              forget()
            setIdentity(bootstrap)
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setBlocked(null)
          setConnection(
            error instanceof Error ? error.message : 'Backend unavailable.',
          )
        }
      } finally {
        if (!abort.signal.aborted) setChecking(false)
      }
    })()
    return () => abort.abort()
    // The comparison uses the identity captured when this connection attempt begins.
    // A new endpoint remounts the whole view; a reload may discover a replacement installation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, reload, softwareUpdates])

  useEffect(() => {
    const core = softwareState.status?.core
    if (
      blocked &&
      core &&
      core.state === 'idle' &&
      core.version !== blocked.bootstrap.coreVersion
    )
      setReload((n) => n + 1)
  }, [blocked, softwareState.status?.core])

  const scope = identity
    ? JSON.stringify([
        client.endpoint,
        identity.installationId,
        identity.callerId,
      ])
    : ''
  const currentScope = useRef(scope)
  currentScope.current = scope
  const view = useMemo(
    () =>
      directory && identity
        ? workspaceView(
            directory,
            identity.installationId,
            identity.callerId,
            agentColor,
          )
        : null,
    [directory, identity],
  )
  const former = useMemo(
    () => (directory ? formerMemberChats(directory, summaries) : []),
    [directory, summaries],
  )
  // Agents that management can add: active and not the admin agent.
  const addable = useMemo(
    () =>
      directory && view
        ? Object.values(directory.agents)
            .filter((a) => a.lifecycle === 'active' && !a.admin)
            .map((a) => view.actorsById[a.id] as Agent)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [directory, view],
  )
  const archivedSelection =
    navigation.target === 'organization' &&
    directory?.agents[navigation.agentId ?? '']?.lifecycle === 'archived' &&
    directory?.organizations[navigation.organizationId ?? '']?.lifecycle ===
      'active'
  const nav = archivedSelection
    ? navigation
    : view
      ? resolveSelection(view, former, navigation)
      : navigation
  useEffect(() => {
    if (view && appReady && JSON.stringify(nav) !== JSON.stringify(navigation))
      setNavigation(nav)
  }, [view, appReady, nav, navigation])
  // Chats are resolved only against a loaded directory and its thread summaries.
  const target: ChatTarget | null =
    identity && view && nav.agentId
      ? nav.target === 'installation'
        ? {
            kind: 'installation',
            installationId: identity.installationId,
            agentId: nav.agentId,
          }
        : {
            kind: 'organization',
            organizationId: nav.organizationId ?? '',
            agentId: nav.agentId,
          }
      : null
  const key = target ? chatKey(target) : ''
  const context = useMemo(
    () =>
      identity && key
        ? target?.kind === 'organization'
          ? {
              kind: 'organization' as const,
              organizationId: target.organizationId,
            }
          : {
              kind: 'installation' as const,
              installationId: identity.installationId,
            }
        : null,
    // The context follows the chat key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity, key],
  )
  const readOnly =
    archivedSelection ||
    (nav.target === 'organization' &&
      former.some(
        (f) =>
          f.organizationId === nav.organizationId && f.agentId === nav.agentId,
      ))
  const chatId =
    chatIds[key] ??
    Object.values(summaries).find((s) => summaryKey(s) === key)?.chatId ??
    null
  const threadScope = scope && key ? JSON.stringify([scope, key]) : ''
  const keyRef = useRef(key)
  keyRef.current = key
  const summariesRef = useRef(summaries)
  summariesRef.current = summaries
  const hydratedRef = useRef(hydrated)
  hydratedRef.current = hydrated
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const selectionChange = useRef(0)
  const chooseThread = (threadId: string | null) => {
    selectionChange.current++
    if (threadId) setOpenDoc(null)
    setSelected(threadId)
    setExpanded(false)
    if (!threadId && selected)
      requestAnimationFrame(() =>
        threadTriggers.current.get(selected)?.focus({ preventScroll: true }),
      )
    setPendingSelection(null)
    if (threadScope)
      void threadPreference
        .write(threadScope, threadId)
        .catch(() =>
          setLocalError(
            'This thread selection could not be saved on this device.',
          ),
        )
  }
  useEffect(() => {
    if (!threadScope) return
    const abort = new AbortController()
    const generation = selectionChange.current
    void threadPreference
      .read(threadScope)
      .then((id) => {
        if (!abort.signal.aborted && generation === selectionChange.current)
          setPendingSelection(id)
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setLocalError('Saved thread selection is unavailable on this device.')
      })
    return () => abort.abort()
  }, [threadScope])
  useEffect(() => {
    if (!appReady || !pendingSelection || !threadScope) return
    const saved = summaries[pendingSelection]
    if (saved && summaryKey(saved) === key) setSelected(pendingSelection)
    else
      void threadPreference
        .write(threadScope, null)
        .catch(() =>
          setLocalError('Saved thread selection could not be cleared.'),
        )
    setPendingSelection(null)
  }, [appReady, pendingSelection, key, summaries, threadScope])
  useEffect(() => {
    const open = selected ? summaries[selected] : undefined
    if (appReady && selected && (!open || summaryKey(open) !== key))
      chooseThread(null)
    // Selection is validated against each complete application snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReady, selected, key, summaries])
  // Restore the last organization and agent chosen on this device.
  const navigationChange = useRef(0)
  useEffect(() => {
    if (!scope) return
    let active = true
    const generation = navigationChange.current
    void readPreferences(navigationPreferences, scope).then(
      (saved) => {
        if (active && generation === navigationChange.current)
          setNavigation(saved)
      },
      () => {
        if (active)
          setLocalError('Saved navigation is unavailable on this device.')
      },
    )
    return () => {
      active = false
    }
  }, [scope])
  const latestNavigation = useRef(nav)
  latestNavigation.current = nav
  const navigate = (patch: Partial<Navigation>) => {
    navigationChange.current++
    const next = { ...latestNavigation.current, ...patch }
    latestNavigation.current = next
    setNavigation(next)
    if (scope)
      void persistPreferences(navigationPreferences, scope, next).catch(
        () =>
          currentScope.current === scope &&
          setLocalError('This selection could not be saved on this device.'),
      )
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || document.querySelector('dialog[open]')) return
      if (event.key === '\\' && (event.metaKey || event.ctrlKey) && !narrow) {
        event.preventDefault()
        navigate({ collapsed: !latestNavigation.current.collapsed })
      } else if (event.key === 'Escape' && openDoc && !drawerOpen) {
        closeDoc()
      } else if (event.key === 'Escape' && selected && !drawerOpen) {
        chooseThread(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (selected) closeThreadButton.current?.focus({ preventScroll: true })
  }, [selected])
  // Switching chats closes the open thread without forgetting that chat's own selection.
  const switchChat = (patch: Partial<Navigation>) => {
    selectionChange.current++
    setSelected(null)
    setPendingSelection(null)
    navigate(patch)
  }
  // A member's chat is opened, or found, by its context and agent. A former member's chat is
  // known from its thread summaries and cannot be opened again.
  useEffect(() => {
    if (!target || !context || chatId || readOnly) return
    const abort = new AbortController()
    void client.directChat(context, target.agentId, abort.signal).then(
      (id) => {
        if (abort.signal.aborted) return
        setChatIds((old) => ({ ...old, [key]: id }))
        setChatErrors((old) => {
          const next = { ...old }
          delete next[key]
          return next
        })
      },
      (error) => {
        if (!abort.signal.aborted)
          setChatErrors((old) => ({
            ...old,
            [key]: error instanceof Error ? error.message : 'Chat unavailable.',
          }))
      },
    )
    return () => abort.abort()
    // The target follows the chat key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, context, chatId, readOnly, reload])
  const adapter = useMemo(() => client.conversationAdapter(), [client])
  const outbox = useOutbox(scope, identity ? adapter : undefined)

  useEffect(() => {
    if (!identity) return
    const abort = new AbortController()
    let cursor: string | null = null
    let failures = 0
    const outdated = async () => {
      const current = await client.bootstrap(abort.signal).catch(() => null)
      if (!current || abort.signal.aborted) return false
      softwareUpdates.setBootstrap(current)
      const state = compatibility(current.protocol)
      if (state === 'compatible') return false
      block(state, current)
      return true
    }
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          if (!cursor) {
            const snap = await client.workspaceSnapshot(abort.signal)
            if (abort.signal.aborted) return
            setDirectory(snap.directory)
            setSummaries((old) => mergeAppSummaries(old, snap.threads))
            for (const note of snap.notifications)
              knownNotices.current.add(note.id)
            setNotices((old) => mergeAppNotices(old, snap.notifications))
            setAppReady(true)
            if (identity.capabilities?.documents)
              void documents.refresh(abort.signal).catch(() => undefined)
            cursor = snap.cursor
          }
          setConnection('')
          await client.events(
            '/v1/app/events',
            identity,
            null,
            cursor,
            abort.signal,
            (event: WireEvent) => {
              if (abort.signal.aborted) return
              if (event.type === 'thread-summary') {
                const summary = event.data as Summary
                setSummaries((old) =>
                  upsertRevision(old, summary.threadId, summary),
                )
              } else if (event.type === 'notification') {
                const note = event.data as Notice
                if (!knownNotices.current.has(note.id)) {
                  knownNotices.current.add(note.id)
                  setArrivals((ids) => [...ids.slice(-99), note.id])
                }
                setNotices((old) => ({
                  ...old,
                  [note.id]: mergeNotice(old[note.id], note),
                }))
              } else if (event.type === 'notification-removed') {
                const id = (event.data as Notice).id
                setNotices((old) =>
                  Object.fromEntries(
                    Object.entries(old).filter(([key]) => key !== id),
                  ),
                )
              } else if (event.type === 'thread-removed') {
                // Deleted with its agent: the same as a gone thread.
                threadGone((event.data as ThreadRemoved).threadId)
              } else if (event.type === 'document-changed') {
                documents.upsert(event.data as DocumentSummary)
              } else if (event.type === 'document-removed') {
                documents.remove((event.data as { id: string }).id)
              } else if (directoryEventTypes.has(event.type)) {
                const change = {
                  type: event.type,
                  data: event.data,
                } as DirectoryEvent
                const at = event.cursor
                setDirectory((old) =>
                  old ? applyDirectoryEvent(old, change, at) : old,
                )
              } else if (event.type !== 'unsupported')
                throw new TextHttpError(
                  'Backend update is incompatible. Update the client and reconnect.',
                  'incompatible',
                )
              cursor = event.cursor
              failures = 0
            },
            {
              connected: () => {
                applicationUpdates.publish({ kind: 'connection', message: '' })
                softwareUpdates.connectionRestored()
                // Read the shared interface choices again; this window's own fill those Core never saved.
                if (
                  interfacePreferences &&
                  identity.capabilities?.interfacePreferences
                ) {
                  const own = (key: string) =>
                    platform?.preferences.get(key) ?? null
                  const alerts = own(
                    desktopAlertsKey(
                      JSON.stringify([
                        client.endpoint,
                        identity.installationId,
                        identity.callerId,
                      ]),
                    ),
                  )
                  void interfacePreferences
                    .load(
                      {
                        palette: own('palette'),
                        theme: own('theme'),
                        desktopNotifications:
                          alerts === null ? null : alerts === 'enabled',
                        ...(platform ? ownNotificationChoices(platform) : {}),
                      },
                      abort.signal,
                    )
                    .catch(() => undefined)
                }
              },
              event: (value) => {
                const {
                  type,
                  data,
                  scope: eventScope,
                } = value as {
                  type: string
                  data: unknown
                  scope: {
                    kind: string
                    installationId: string
                    callerId: string
                  }
                }
                const sameInstallation =
                  eventScope.kind === 'application' &&
                  eventScope.installationId === identity.installationId &&
                  eventScope.callerId === identity.callerId
                if (sameInstallation && type === 'updates-changed')
                  softwareUpdates.acceptStatus(data)
                if (sameInstallation && type === 'interface-changed') {
                  try {
                    interfacePreferences?.accept(data)
                  } catch {
                    /* An unreadable change waits for the next read. */
                  }
                }
                if (sameInstallation && type === 'identity-changed')
                  void queries.invalidateQueries({
                    queryKey: ['identity-file'],
                  })
                if (sameInstallation && type === 'instructions-changed')
                  void queries.invalidateQueries({
                    queryKey: ['core-instructions'],
                  })
                if (
                  __KIPSTER_DEMO__ &&
                  sameInstallation &&
                  type === 'demo-app-updates-changed'
                )
                  softwareUpdates.acceptDemoApp(data)
                if (
                  [
                    'settings-changed',
                    'adapters-changed',
                    'learning-changed',
                  ].includes(type) ||
                  directoryEventTypes.has(type)
                )
                  applicationUpdates.publish({ kind: 'changed' })
              },
            },
          )
        } catch (error) {
          if (abort.signal.aborted) return
          if (error instanceof TextHttpError && error.code === 'incompatible') {
            if (await outdated()) return
            setConnection(error.message)
            return
          }
          if (
            error instanceof TextHttpError &&
            error.code === 'resync-required'
          )
            cursor = null
          softwareUpdates.connectionLost()
          const updating = softwareUpdates.snapshot().reconnecting
          applicationUpdates.publish({
            kind: 'connection',
            message: updating
              ? 'Updating backend. Reconnecting…'
              : 'Live settings interrupted. Reconnecting…',
          })
          setConnection(
            updating
              ? 'Updating backend. Reconnecting…'
              : 'Live connection interrupted. Reconnecting…',
          )
          await delay(
            abort.signal,
            Math.min(10000, 500 * 2 ** Math.min(failures++, 5)),
          )
          // Core may have been updated while the app was running.
          if (await outdated()) return
        }
      }
    })()
    return () => abort.abort()
  }, [
    client,
    identity,
    reload,
    threadGone,
    applicationUpdates,
    softwareUpdates,
    block,
    platform,
    interfacePreferences,
    queries,
    documents,
  ])

  // Read-only background snapshots hydrate root text; the selected thread owns its own stream.
  const retryHydration = useRef<((id: string) => void) | null>(null)
  useEffect(() => {
    if (!identity || !key) return
    const abort = new AbortController()
    const inFlight = new Set<string>()
    const attempts = new Map<string, { count: number; nextAt: number }>()
    const scan = () => {
      if (abort.signal.aborted) return
      for (const summary of Object.values(summariesRef.current)) {
        const id = summary.threadId
        if (inFlight.size >= 4) break
        if (
          summaryKey(summary) !== keyRef.current ||
          id === selectedRef.current ||
          inFlight.has(id) ||
          (hydratedRef.current[id] ?? -1) >= summary.revision
        )
          continue
        const retry = attempts.get(id)
        if (retry && (retry.count >= 5 || Date.now() < retry.nextAt)) continue
        inFlight.add(id)
        void client
          .threadSnapshot(id, abort.signal)
          .then((snap) => {
            if (abort.signal.aborted) return
            setMessages((old) => ({
              ...old,
              [id]: mergeRevisions(old[id] ?? {}, snap.messages, (m) => m.id),
            }))
            setWorks((old) => ({
              ...old,
              [id]: mergeRevisions(old[id] ?? {}, snap.work, (w) => w.runId),
            }))
            setInteractions((old) => ({
              ...old,
              [id]: mergeRevisions(
                old[id] ?? {},
                snap.interactions,
                (x) => x.id,
              ),
            }))
            setDelegations((old) => ({
              ...old,
              [id]: mergeRevisions(
                old[id] ?? {},
                snap.delegations,
                (x) => x.id,
              ),
            }))
            const latest = Math.max(
              hydratedRef.current[id] ?? -1,
              summary.revision,
            )
            hydratedRef.current = { ...hydratedRef.current, [id]: latest }
            setHydrated(hydratedRef.current)
            attempts.delete(id)
            setHydrationErrors((old) => {
              const next = { ...old }
              delete next[id]
              return next
            })
          })
          .catch((error) => {
            if (abort.signal.aborted) return
            if (error instanceof TextHttpError && error.code === 'gone')
              return threadGone(id)
            const count = (attempts.get(id)?.count ?? 0) + 1
            attempts.set(id, {
              count,
              nextAt: Date.now() + Math.min(8000, 500 * 2 ** count),
            })
            setHydrationErrors((old) => ({
              ...old,
              [id]:
                error instanceof TextHttpError && error.code === 'incompatible'
                  ? error.message
                  : count >= 5
                    ? 'Thread unavailable. Retry loading.'
                    : 'Thread unavailable. Retrying…',
            }))
          })
          .finally(() => {
            inFlight.delete(id)
          })
      }
    }
    retryHydration.current = (id) => {
      attempts.delete(id)
      setHydrationErrors((old) => {
        const next = { ...old }
        delete next[id]
        return next
      })
      scan()
    }
    scan()
    const timer = setInterval(scan, 1000)
    return () => {
      abort.abort()
      clearInterval(timer)
      retryHydration.current = null
    }
  }, [client, identity, key, threadGone])

  useEffect(() => {
    if (!identity || !selected) return
    const abort = new AbortController()
    let cursor: string | null = null
    let failures = 0
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          if (!cursor) {
            const snap = await client.threadSnapshot(selected, abort.signal)
            if (abort.signal.aborted) return
            setMessages((old) => ({
              ...old,
              [selected]: mergeRevisions(
                old[selected] ?? {},
                snap.messages,
                (m) => m.id,
              ),
            }))
            setWorks((old) => ({
              ...old,
              [selected]: mergeRevisions(
                old[selected] ?? {},
                snap.work,
                (w) => w.runId,
              ),
            }))
            setInteractions((old) => ({
              ...old,
              [selected]: mergeRevisions(
                old[selected] ?? {},
                snap.interactions,
                (x) => x.id,
              ),
            }))
            setDelegations((old) => ({
              ...old,
              [selected]: mergeRevisions(
                old[selected] ?? {},
                snap.delegations,
                (x) => x.id,
              ),
            }))
            cursor = snap.cursor
          }
          setThreadConnection('')
          await client.events(
            `/v1/threads/${encodeURIComponent(selected)}/events`,
            identity,
            selected,
            cursor,
            abort.signal,
            (event) => {
              if (abort.signal.aborted) return
              if (
                event.type === 'message-draft' ||
                event.type === 'message-final'
              ) {
                const message = event.data as TextMessage
                if (message?.id && message.threadId === selected)
                  setMessages((old) => ({
                    ...old,
                    [selected]: upsertRevision(
                      old[selected] ?? {},
                      message.id,
                      message,
                    ),
                  }))
              } else if (event.type === 'work-changed') {
                const work = event.data as TextWork
                if (work?.runId)
                  setWorks((old) => ({
                    ...old,
                    [selected]: upsertRevision(
                      old[selected] ?? {},
                      work.runId,
                      work,
                    ),
                  }))
              } else if (event.type === 'interaction-changed') {
                const interaction = event.data as TextInteraction
                setInteractions((old) => ({
                  ...old,
                  [selected]: upsertRevision(
                    old[selected] ?? {},
                    interaction.id,
                    interaction,
                  ),
                }))
              } else if (event.type === 'delegation-changed') {
                const delegation = event.data as TextDelegation
                setDelegations((old) => ({
                  ...old,
                  [selected]: upsertRevision(
                    old[selected] ?? {},
                    delegation.id,
                    delegation,
                  ),
                }))
              } else if (event.type !== 'unsupported')
                throw new TextHttpError(
                  'Backend update is incompatible. Update the client and reconnect.',
                  'incompatible',
                )
              cursor = event.cursor
              failures = 0
            },
          )
        } catch (error) {
          if (abort.signal.aborted) return
          if (error instanceof TextHttpError && error.code === 'incompatible') {
            setThreadConnection(error.message)
            return
          }
          if (error instanceof TextHttpError && error.code === 'gone') {
            setGoneNotice(
              'That thread is no longer available, so it was closed.',
            )
            threadGone(selected)
            return
          }
          if (
            error instanceof TextHttpError &&
            error.code === 'resync-required'
          )
            cursor = null
          setThreadConnection('Thread updates interrupted. Reconnecting…')
          await delay(
            abort.signal,
            Math.min(10000, 500 * 2 ** Math.min(failures++, 5)),
          )
        }
      }
    })()
    return () => abort.abort()
  }, [client, identity, selected, reload, threadGone])

  const current = Object.values(summaries)
    .filter((s) => summaryKey(s) === key)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.threadId.localeCompare(b.threadId),
    )
  const ordered = (id: string) =>
    Object.values(messages[id] ?? {}).sort((a, b) => a.position - b.position)
  const recordsFor = (threadId: string) => {
    const summary = summaries[threadId]
    return summary && identity
      ? threadWork({
          target: summaryTarget(identity, summary),
          agentId: summary.agentId,
          works: Object.values(works[threadId] ?? {}),
          interactions: Object.values(interactions[threadId] ?? {}),
          delegations: Object.values(delegations[threadId] ?? {}),
          messages: messages[threadId] ?? {},
          notices,
          archived:
            directory?.agents[summary.agentId]?.lifecycle === 'archived',
        })
      : emptyWork()
  }
  // Answer receipts carry the interaction as Core recorded it.
  const applyInteraction = useCallback(
    (threadId: string, interaction: TextInteraction) =>
      setInteractions((old) => ({
        ...old,
        [threadId]: upsertRevision(
          old[threadId] ?? {},
          interaction.id,
          interaction,
        ),
      })),
    [],
  )
  const workClient = useMemo(
    () =>
      createCoreWorkClient(client.endpoint, {
        interaction: applyInteraction,
        gone: threadGone,
      }),
    [client, applyInteraction, threadGone],
  )
  const workCommands = useWorkCommands(scope, identity ? workClient : undefined)
  // When the open thread or chat goes away, text typed there but not sent is kept and shown.
  const shown = useRef<{
    chatId: string | null
    context: typeof context
    selected: string | null
  }>({ chatId: null, context: null, selected: null })
  useEffect(() => {
    const last = shown.current
    shown.current = { chatId, context, selected }
    if (!identity || !last.chatId || !last.context) return
    const chatWent = gone.chats.has(last.chatId)
    if (!chatWent && !(last.selected && gone.threads.has(last.selected))) return
    const base: ConversationTarget = {
      installationId: identity.installationId,
      callerId: identity.callerId,
      context: last.context,
      chatId: last.chatId,
    }
    const targets = [
      ...(last.selected ? [{ ...base, threadId: last.selected }] : []),
      ...(chatWent ? [base] : []),
    ]
    for (const target of targets) {
      const saved = draftKey(scope, target)
      void conversationStorage.readDraft(saved).then(
        (draft) => {
          if (draft?.text.trim())
            setKept((old) =>
              old.some((k) => k.key === saved)
                ? old
                : [
                    ...old,
                    { key: saved, text: draft.text, reply: !!target.threadId },
                  ],
            )
        },
        () => undefined,
      )
    }
  })
  const discardKept = (saved: string) => {
    setKept((old) => old.filter((k) => k.key !== saved))
    void conversationStorage
      .readDraft(saved)
      .then(
        (draft) =>
          draft && conversationStorage.writeDraft(saved, draft.revision, ''),
      )
      .catch(() => undefined)
  }
  const preview: WorkspaceData = {
    installationId: identity?.installationId ?? '',
    currentHumanId: identity?.callerId ?? '',
    actorsById: { ...view?.actorsById },
    agentRoles: view?.agentRoles ?? [],
    organizations: view?.organizations ?? [],
    memberships: view?.memberships ?? [],
    groups: view?.groups ?? [],
    groupAssignments: view?.groupAssignments ?? [],
    chatsById: {},
    threadsById: {},
    messagesById: {},
    artifactsById: {},
  }
  for (const summary of Object.values(summaries)) {
    const items = ordered(summary.threadId)
    preview.chatsById[summary.chatId] = {
      id: summary.chatId,
      kind: 'direct',
      context:
        summary.contextKind === 'organization'
          ? { kind: 'organization', organizationId: summary.contextId }
          : { kind: 'installation', installationId: summary.contextId },
      participantIds: [identity?.callerId ?? '', summary.agentId],
    }
    preview.threadsById[summary.threadId] = {
      id: summary.threadId,
      chatId: summary.chatId,
      rootMessageId: items[0]?.id ?? '',
      title: threadTitle(items[0]),
      createdAt: summary.createdAt,
      messageIds: items.map((m) => m.id),
      replyCount: Math.max(0, items.length - 1),
      lastReplyAuthor:
        items.length > 1
          ? items.at(-1)!.authorId === identity?.callerId
            ? 'you'
            : agentLabel(directory, items.at(-1)!.authorId)
          : undefined,
      participantIds: [...new Set(items.map((m) => m.authorId))],
    }
    for (const message of items) {
      if (!preview.actorsById[message.authorId])
        preview.actorsById[message.authorId] = {
          id: message.authorId,
          kind: 'agent',
          name: agentLabel(directory, message.authorId),
          description: '',
          color: agentColor(message.authorId),
        }
      preview.messagesById[message.id] = {
        id: message.id,
        threadId: message.threadId,
        authorId: message.authorId,
        createdAt: summary.createdAt,
        timestampKnown: message.id === items[0]?.id,
        status: message.final ? 'final' : 'draft',
        revision: message.revision,
        preparation: message.preparation,
        parts: message.parts.map((part) =>
          part.kind === 'text'
            ? { type: 'text', text: part.text }
            : part.kind === 'document'
              ? {
                  type: 'document',
                  documentId: part.documentId,
                  revision: part.revision,
                }
              : part.kind === 'unknown'
                ? { type: 'unknown', originalKind: part.originalKind }
                : part.kind === 'removed'
                  ? { type: 'removed', artifactId: part.artifactId }
                  : {
                      type: 'file',
                      artifactId: part.artifactId,
                      purpose: part.purpose,
                    },
        ),
      }
    }
  }
  const [feedStarted, setFeedStarted] = useState({ key: '', ready: false })
  const feedReady =
    appReady &&
    ((feedStarted.key === key && feedStarted.ready) ||
      current.every((s) => !!hydrated[s.threadId]))
  if (feedStarted.key !== key || feedStarted.ready !== feedReady)
    setFeedStarted({ key, ready: feedReady })
  const feedFollowing = useScrollHistory(
    feedScroll,
    key,
    current
      .map(
        (s) =>
          `${s.threadId}:${s.revision}:${Object.keys(messages[s.threadId] ?? {}).length}`,
      )
      .join('|'),
    feedReady,
  )
  const threadFollowing = useScrollHistory(
    threadScroll,
    selected ?? '',
    selected
      ? ordered(selected)
          .map((m) => `${m.id}:${m.revision}`)
          .join('|')
      : '',
    !!selected && !!hydrated[selected],
    false,
    '.history-window[data-latest="true"]',
  )
  const latestThread = () => {
    threadFollowing.latest()
    historyControls.current?.latest()
  }
  const agent = target
    ? (view?.actorsById[target.agentId] as Agent | undefined)
    : undefined
  const agentName = target ? agentLabel(directory, target.agentId) : ''
  const removedAgent = readOnly
    ? directory?.agents[nav.agentId ?? '']
    : undefined
  const organization = view?.organizations.find(
    (o) => o.id === nav.organizationId,
  )
  const pendingFor = (threadId?: string) =>
    outbox.entries.filter(
      (e) =>
        e.submission.target.chatId === chatId &&
        (threadId
          ? e.submission.target.threadId === threadId
          : !e.submission.target.threadId ||
            e.submission.target.threadId !== selected),
    )
  const compose = (threadId?: string) =>
    readOnly ? (
      <p className="read-only-note">
        {removedAgent?.lifecycle === 'archived'
          ? `${removedAgent.name} is archived. Your draft is saved on this device and returns when restored.`
          : removedAgent?.lifecycle === 'deleted'
            ? `${removedAgent.name} was deleted.`
            : `${removedAgent?.name} is no longer a member of ${organization?.name}.`}{' '}
        This chat is read only.
      </p>
    ) : identity && context && chatId ? (
      <DurableComposer
        key={`${scope}:${chatId}:${threadId ?? 'root'}`}
        scope={scope}
        target={{
          installationId: identity.installationId,
          callerId: identity.callerId,
          context,
          chatId,
          ...(threadId ? { threadId } : {}),
        }}
        label={threadId ? 'Reply in this thread' : 'Start a new thread'}
        voiceEnabled={identity?.capabilities?.voiceRecording === true}
        disabled={!!connection || !!outbox.error}
        recordingContext={JSON.stringify([
          selected,
          expanded,
          nav.organizationId,
        ])}
        send={async (submission, draft) => {
          const reserved = await outbox.send(submission, draft)
          if (threadId) latestThread()
          else feedFollowing.latest()
          return reserved
        }}
      />
    ) : null
  const renderMessage = (message: TextMessage) => (
    <Message message={preview.messagesById[message.id]} data={preview} />
  )
  // Earlier runs that ended without an answer stay marked under their message.
  const ended: Record<string, string> = {
    cancelled: 'Stopped',
    failed: 'Didn’t finish',
    'recovery-needed': 'Needs a check',
  }
  const closeDoc = () => {
    setOpenDoc(null)
    if (!selected) setExpanded(false)
  }
  const openThread = (threadId: string) => {
    setOpenDoc(null)
    const saved = summaries[threadId]
    setInboxOpener(null)
    setGoneNotice('')
    if (!saved) return
    const savedKey = summaryKey(saved)
    if (savedKey === key) return chooseThread(threadId)
    // A thread in another chat opens that chat first.
    selectionChange.current++
    navigate(
      saved.contextKind === 'installation'
        ? { target: 'installation', agentId: saved.agentId }
        : {
            target: 'organization',
            organizationId: saved.contextId,
            agentId: saved.agentId,
          },
    )
    setSelected(threadId)
    setPendingSelection(null)
    void threadPreference
      .write(JSON.stringify([scope, savedKey]), threadId)
      .catch(() =>
        setLocalError(
          'This thread selection could not be saved on this device.',
        ),
      )
  }
  const inbox = identity
    ? inboxItems({
        scope: identity,
        notices: Object.values(notices),
        summaries,
        interactions,
        firstMessage: (threadId) => ordered(threadId)[0],
        agentName: (agentId) => agentLabel(directory, agentId),
        organizationName: (organizationId) =>
          directory?.organizations[organizationId]?.name,
      })
    : []
  const notifications = useNotifications({
    endpoint: client.endpoint,
    actions: identity
      ? identity.capabilities?.notificationActions === true
      : undefined,
    scope,
    items: inbox,
    arrivals,
    selected,
    ready: appReady,
    online: !connection,
    read: markRead,
    remove: removeNotices,
    openThread,
  })
  const openNotification = (n: InboxNotification) => {
    setSettingsOpener(null)
    openThread(n.target.threadId)
    notifications.readThread(n.target.threadId)
  }
  if (blocked)
    return (
      <CompatibilityBlock
        state={blocked.state}
        coreVersion={blocked.bootstrap.coreVersion}
        protocol={blocked.bootstrap.protocol}
        checking={checking}
        softwareUpdates={softwareUpdates}
        checkAgain={() => {
          setChecking(true)
          setReload((n) => n + 1)
        }}
        changeConnection={changeConnection}
      />
    )
  if (!identity || !view)
    return (
      <main className="workspace-state" aria-busy={connection === connecting}>
        <div
          className={`state-card mat thick lifted ${connection === connecting ? '' : 'error'}`}
        >
          <span className="state-mark kip" aria-hidden="true">
            <KipHead />
          </span>
          <h1>
            {connection === connecting
              ? 'Opening your workspace…'
              : 'Workspace unavailable'}
          </h1>
          <p role={connection === connecting ? undefined : 'alert'}>
            {connection === connecting
              ? 'Loading organizations and kips.'
              : connection}
          </p>
          {changeConnection && (
            <button onClick={changeConnection}>Change connection</button>
          )}
          {connection === connecting ? (
            <span className="state-progress" aria-hidden="true" />
          ) : (
            <button
              className="primary-button"
              onClick={() => setReload((n) => n + 1)}
            >
              Try again
            </button>
          )}
        </div>
      </main>
    )
  // Questions and approvals still waiting, wherever they were asked.
  const questions = waitingNotices(notices)
  const marks = chatMarks(
    inbox,
    Object.values(summaries)
      .filter((s) => working.has(s.state))
      .map((s) => s.threadId),
    (threadId) => summaries[threadId] && summaryKey(summaries[threadId]),
  )
  const markOf = (agentId: string, admin: boolean) =>
    marks[
      chatKey(
        admin
          ? {
              kind: 'installation',
              installationId: identity.installationId,
              agentId,
            }
          : {
              kind: 'organization',
              organizationId: nav.organizationId ?? '',
              agentId,
            },
      )
    ]
  const elsewhere = inbox.some(
    (n) =>
      needsYou(n) &&
      n.target.context.kind === 'organization' &&
      n.target.context.organizationId !== nav.organizationId,
  )
  const threadState = (id: string): LiveState =>
    connection || (selected === id && threadConnection)
      ? 'offline'
      : hydrated[id]
        ? deriveThreadState(
            recordsFor(id),
            id,
            ordered(id).some((m) => !m.final),
          )
        : summaryState(summaries[id]?.state ?? '')
  const unseenFailures = new Set(
    inbox.filter((n) => isFailure(n) && !n.read).map((n) => n.target.threadId),
  )
  // A failure shows until its notification is read, as the sidebar marks do.
  const islandState = (id: string): LiveState => {
    const state = threadState(id)
    return (state === 'failed' || state === 'recovery') &&
      !unseenFailures.has(id)
      ? 'ready'
      : state
  }
  const asking = (pending: InboxNotification[]): LiveState | undefined =>
    pending.length === 0
      ? undefined
      : pending.every((n) => n.kind === 'approval')
        ? 'approval'
        : 'question'
  const inChat = (threadId: string) =>
    !!summaries[threadId] && summaryKey(summaries[threadId]) === key
  const island = connection
    ? { state: 'offline' as const, several: false }
    : summarize(
        current.map((s) => islandState(s.threadId)),
        asking(inbox.filter((n) => n.pending && inChat(n.target.threadId))),
      )
  // Until a thread's messages load, its notification's own text names it.
  const titleOf = (threadId: string, fallback = 'Thread') => {
    const first = ordered(threadId)[0]
    return first ? threadTitle(first) : fallback
  }
  const actionTitle = (n: InboxNotification) =>
    titleOf(n.target.threadId, n.body || 'Thread')
  const actions = actionItems(inbox.filter((n) => inChat(n.target.threadId)))
  const latestBusy = current
    .filter(
      (s) =>
        !['ready', 'done', 'unknown', 'offline'].includes(
          islandState(s.threadId),
        ),
    )
    .at(-1)
  // Several threads waiting on the person open a list; one opens directly.
  const menuAnchor =
    actionMenu?.key === key && actions.length > 1 ? actionMenu.anchor : null
  if (actionMenu && !menuAnchor) setActionMenu(null)
  const islandAction: IslandAction | undefined = connection
    ? undefined
    : actions.length > 1
      ? {
          label: `${actions.length} threads need you`,
          expanded: !!menuAnchor,
          run: (anchor) =>
            setActionMenu((open) =>
              open?.key === key ? null : { anchor, key },
            ),
        }
      : actions.length === 1
        ? {
            label: `Open ${actionTitle(actions[0])}`,
            run: () => openNotification(actions[0]),
          }
        : latestBusy
          ? {
              label: `Open ${titleOf(latestBusy.threadId)}`,
              run: () => openThread(latestBusy.threadId),
            }
          : undefined
  // Kip's sign follows the root admin's own chat, whichever chat is open.
  const kipId = view.agentRoles[0]?.agentId
  const isKipThread = (s: (typeof summaries)[string] | undefined) =>
    s?.contextKind === 'installation' && s.agentId === kipId
  const kip = connection
    ? { state: 'offline' as const, several: false }
    : summarize(
        Object.values(summaries)
          .filter(isKipThread)
          .map((s) => islandState(s.threadId)),
        asking(
          inbox.filter(
            (n) => n.pending && isKipThread(summaries[n.target.threadId]),
          ),
        ),
      )
  const formerHere = former
    .filter((f) => f.organizationId === nav.organizationId)
    .map((f) => view.actorsById[f.agentId] as Agent)
    .sort((a, b) => a.name.localeCompare(b.name))
  // Sends and drafts whose thread or chat is gone stay visible, labelled, until dismissed.
  const orphaned = outbox.entries.filter(
    (e) =>
      !['accepted', 'discarded'].includes(e.state) &&
      (e.submission.target.chatId !== chatId ||
        gone.chats.has(e.submission.target.chatId) ||
        (!!e.submission.target.threadId &&
          gone.threads.has(e.submission.target.threadId))),
  )
  for (const id of gone.threads)
    preview.threadsById[id] = {
      id,
      chatId: '',
      rootMessageId: '',
      title: 'a thread that is no longer available',
      messageIds: [],
    }
  const themeToggle = isDarkOnly(appearance.palette)
    ? null
    : {
        label: `Switch to ${theme === 'light' ? 'dark' : 'light'} mode`,
        icon: theme === 'light' ? ('moon' as const) : ('sun' as const),
        toggle: () => appearance.setMode(theme === 'light' ? 'dark' : 'light'),
      }
  const records = selected ? recordsFor(selected) : emptyWork()
  const currentRun = records.workflows[0]?.runId
  const notices_ = (
    <>
      {connection && (
        <output className="connection-notice">
          {connection}{' '}
          <button onClick={() => setReload((n) => n + 1)}>Reconnect</button>
        </output>
      )}
      {chatErrors[key] && (
        <p className="connection-notice" role="alert">
          {chatErrors[key]}{' '}
          <button onClick={() => setReload((n) => n + 1)}>Try again</button>
        </p>
      )}
      {goneNotice && (
        <output className="connection-notice">
          {goneNotice}{' '}
          <button onClick={() => setGoneNotice('')}>Dismiss</button>
        </output>
      )}
      {outbox.error && (
        <p className="connection-notice" role="alert">
          {outbox.error}
        </p>
      )}
      {localError && (
        <p className="connection-notice" role="alert">
          {localError}
        </p>
      )}
    </>
  )
  const keptFromGone =
    orphaned.length > 0 || kept.length > 0 ? (
      <section
        className="submission-recovery kept-recovery"
        aria-label="Saved drafts and sends from other conversations"
      >
        <p className="recovery-heading">
          Saved drafts and sends from other conversations
        </p>
        {kept.map((k) => (
          <div className="pending-submission" key={k.key}>
            <span className="recovery-status">
              {k.reply ? 'Reply' : 'New thread'} · Not sent
            </span>
            <p className="recovery-body">{k.text}</p>
            <div className="recovery-actions">
              <button onClick={() => discardKept(k.key)}>Dismiss</button>
            </div>
          </div>
        ))}
        <ConversationRecovery
          entries={orphaned}
          data={preview}
          retry={outbox.retry}
          discard={outbox.discard}
        />
      </section>
    ) : null
  // Other threads of this chat with a work command still waiting for its outcome.
  const unresolvedElsewhere = workCommands.entries.filter(
    (e) =>
      e.operation.target.chatId === chatId &&
      e.operation.target.threadId !== selected &&
      !['accepted', 'rejected'].includes(e.state),
  )
  const docsEnabled = identity.capabilities?.documents === true
  const documentsContext = {
    store: documents,
    scope: identity,
    openId: openDoc,
    open: (id: string) => {
      setDrawer(false)
      setOpenDoc(id)
    },
    author: (agentId: string) => ({
      name: agentLabel(directory, agentId),
      color:
        (view.actorsById[agentId] as Agent | undefined)?.color ??
        agentColor(agentId),
      kip: view.agentRoles.some((role) => role.agentId === agentId),
    }),
  }
  const inspector = !!selected || !!openDoc
  return (
    <WorkspaceContext.Provider
      value={{
        ...mediaWorkspace,
        documents: docsEnabled ? documentsContext : null,
      }}
    >
      <QueryClientProvider client={queries}>
        <div
          className={`app-shell ${nav.collapsed && !narrow ? 'sidebar-collapsed' : ''} ${drawerOpen ? 'drawer-open' : ''} ${inspector ? 'has-thread' : ''} ${openDoc ? 'has-doc' : ''} ${inspector && expanded ? 'thread-expanded' : ''}`}
          style={{ '--agent-hue': hueVar(agent?.color) } as CSSProperties}
        >
          <a className="skip-link" href="#conversation">
            Skip to conversation
          </a>
          <Sidebar
            id="workspace-sidebar"
            utilities={
              <div className="sidebar-utilities">
                <SoftwareUpdatePill
                  updates={softwareUpdates}
                  open={(trigger) => {
                    setSettingsInitialTab('updates')
                    setSettingsOpener(trigger)
                  }}
                />
                <button
                  className="management-trigger"
                  aria-label={
                    notifications.needs
                      ? `Notifications, ${notifications.needs} need${notifications.needs === 1 ? 's' : ''} you`
                      : notifications.unread
                        ? `Notifications, ${notifications.unread} unread`
                        : 'Notifications, nothing new'
                  }
                  data-tip="Notifications"
                  onClick={(event) => setInboxOpener(event.currentTarget)}
                >
                  <Icon name="bell" />
                  <span className="sidebar-label">Notifications</span>
                  {notifications.needs > 0 ? (
                    <span className="unread-count">{notifications.needs}</span>
                  ) : (
                    notifications.unread > 0 && (
                      <span className="unread-mark" aria-hidden="true" />
                    )
                  )}
                </button>
                <button
                  className="management-trigger"
                  aria-label="Settings"
                  data-tip="Settings"
                  onClick={(event) => {
                    setSettingsInitialTab('workspace')
                    setSettingsOpener(event.currentTarget)
                  }}
                >
                  <Icon name="settings" />
                  <span className="sidebar-label">Settings</span>
                </button>
              </div>
            }
            documents={
              docsEnabled ? (
                <DocsSection organizationId={nav.organizationId} />
              ) : null
            }
            data={view}
            organizationId={nav.organizationId}
            selectedAgentId={nav.agentId}
            selectedTarget={nav.target}
            collapsed={nav.collapsed && !narrow}
            drawer={narrow}
            segment={nav.segment}
            markOf={markOf}
            elsewhere={elsewhere}
            kipState={kip.state}
            kipSeveral={kip.several}
            formerMembers={formerHere}
            onOrganization={(organizationId) =>
              // The admin chat is installation-wide and stays open across organizations.
              nav.target === 'installation'
                ? navigate({ organizationId, segment: 'all' })
                : switchChat({
                    organizationId,
                    agentId: null,
                    target: 'organization',
                    segment: 'all',
                  })
            }
            onToggle={() =>
              narrow
                ? setDrawer(false)
                : navigate({ collapsed: !latestNavigation.current.collapsed })
            }
            onAgent={(agentId, target) => {
              setDrawer(false)
              if (agentId !== nav.agentId || target !== nav.target)
                switchChat({ agentId, target })
            }}
            onSegment={(segment) => navigate({ segment })}
            connectionStatus={connection ? 'unavailable' : 'ready'}
            reconnect={() => setReload((n) => n + 1)}
          />
          {drawerOpen && (
            <button
              className="drawer-scrim"
              aria-label="Close sidebar"
              onClick={() => setDrawer(false)}
            />
          )}
          <main id="conversation" className="conversation" tabIndex={-1}>
            <header className="toolbar" data-tauri-drag-region>
              <button
                className="icon-button mat thin toolbar-menu"
                aria-label="Show sidebar"
                aria-controls="workspace-sidebar"
                aria-expanded={drawerOpen}
                onClick={() => setDrawer(true)}
              >
                <Icon name="panel" />
              </button>
              <StatusIsland
                state={island.state}
                several={island.several}
                action={islandAction}
                name={agentName}
                mark={
                  <Avatar
                    name={agentName}
                    color={agent?.color}
                    kip={nav.target === 'installation'}
                  />
                }
              />
              <AnimatePresence>
                {menuAnchor && (
                  <ActionMenu
                    key="actions"
                    anchor={menuAnchor}
                    name={agentName}
                    items={actions}
                    titleOf={actionTitle}
                    open={(n) => {
                      setActionMenu(null)
                      openNotification(n)
                    }}
                    onClose={(restoreFocus) => {
                      setActionMenu(null)
                      if (restoreFocus) menuAnchor.focus()
                    }}
                  />
                )}
              </AnimatePresence>
              {questions.length > 0 && (
                <button
                  className="waiting-pill mat thin"
                  aria-label={`Waiting for you: ${questions.length} ${questions.length === 1 ? 'question or approval' : 'questions and approvals'}`}
                  onClick={(event) => setInboxOpener(event.currentTarget)}
                >
                  <Icon name="hand" weight="duotone" />
                  <span className="count">{questions.length}</span>
                  <span className="waiting-label">Waiting for you</span>
                </button>
              )}
              {!narrow && themeToggle && (
                <div className="capsule mat thin">
                  <button
                    className="icon-button"
                    aria-label={themeToggle.label}
                    onClick={themeToggle.toggle}
                  >
                    <Icon name={themeToggle.icon} />
                  </button>
                </div>
              )}
            </header>
            <div ref={feedScroll} className="conversation-scroll feed-scroll">
              {notices_}
              {agent && chatId && appReady ? (
                <RootFeed
                  work={{
                    ...emptyWork(),
                    workflows: current.flatMap(
                      (s) => recordsFor(s.threadId).workflows,
                    ),
                  }}
                  chat={
                    preview.chatsById[chatId] ?? {
                      id: chatId,
                      kind: 'direct',
                      context: context!,
                      participantIds: [agent.id],
                    }
                  }
                  agent={agent}
                  data={preview}
                  visible={current.map((s) => preview.threadsById[s.threadId])}
                  threadId={selected}
                  triggers={threadTriggers}
                  onOpen={chooseThread}
                  rootNotice={(thread) =>
                    hydrationErrors[thread.id] && (
                      <p className="connection-notice">
                        {hydrationErrors[thread.id]}{' '}
                        <button
                          onClick={() => retryHydration.current?.(thread.id)}
                        >
                          Retry loading
                        </button>
                      </p>
                    )
                  }
                  rootUnavailable={(thread) => (
                    <p className="connection-notice">
                      {hydrationErrors[thread.id] ?? 'Loading thread…'}
                      {hydrationErrors[thread.id] && (
                        <button
                          onClick={() => retryHydration.current?.(thread.id)}
                        >
                          Retry loading
                        </button>
                      )}
                    </p>
                  )}
                />
              ) : (
                <div className="workspace-state">
                  <span className="avatar kip workspace-kip" aria-hidden="true">
                    <KipHead />
                  </span>
                  <h1>
                    {!appReady
                      ? connection && connection !== connecting
                        ? 'Workspace unavailable'
                        : 'Opening your workspace…'
                      : agent
                        ? chatErrors[key]
                          ? 'Conversation unavailable'
                          : `Opening ${agentName}’s conversation…`
                        : nav.organizationId
                          ? 'No kips in this organization'
                          : 'No organizations yet'}
                  </h1>
                  <p>
                    {!appReady
                      ? connection && connection !== connecting
                        ? connection
                        : 'Loading conversations…'
                      : agent
                        ? (chatErrors[key] ?? 'Opening conversation…')
                        : 'Choose another organization or open your main kip for installation-level conversations.'}
                  </p>
                </div>
              )}
            </div>
            <div className="composer-dock" ref={dock}>
              {feedFollowing.unread && (
                <button className="jump-latest" onClick={feedFollowing.latest}>
                  Back to latest messages
                </button>
              )}
              {unresolvedElsewhere.map((e) => (
                <div className="connection-notice" key={e.id}>
                  A work command in another thread is waiting for its outcome.{' '}
                  <button
                    onClick={() => chooseThread(e.operation.target.threadId)}
                  >
                    Open thread
                  </button>
                </div>
              ))}
              {keptFromGone}
              <ConversationRecovery
                entries={pendingFor()}
                data={preview}
                retry={outbox.retry}
                discard={outbox.discard}
                openThread={chooseThread}
              />
              {compose()}
            </div>
          </main>
          <AnimatePresence initial={false} mode="popLayout">
            {openDoc && docsEnabled ? (
              <DocPane
                key={`doc:${openDoc}`}
                id={openDoc}
                expanded={expanded}
                onExpand={() => setExpanded((value) => !value)}
                onClose={closeDoc}
                onThread={openThread}
              />
            ) : (
              selected &&
              summaries[selected] &&
              preview.threadsById[selected] &&
              agent && (
                <ThreadPane
                  key={selected}
                  thread={preview.threadsById[selected]}
                  agent={agent}
                  admin={nav.target === 'installation'}
                  state={threadState(selected)}
                  expanded={expanded}
                  onExpand={() => setExpanded((value) => !value)}
                  onClose={() => chooseThread(null)}
                  closeButton={closeThreadButton}
                  scroll={threadScroll}
                  history={
                    <>
                      {outbox.error && (
                        <p className="connection-notice" role="alert">
                          {outbox.error}
                        </p>
                      )}
                      {localError && (
                        <p className="connection-notice" role="alert">
                          {localError}
                        </p>
                      )}
                      {threadConnection && (
                        <p className="connection-notice">{threadConnection}</p>
                      )}
                    </>
                  }
                  messages={
                    <HistoryWindow
                      controls={historyControls}
                      key={selected}
                      items={ordered(selected)}
                      render={(message) => (
                        <motion.article
                          className="thread-reply"
                          key={message.id}
                          initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={quickFade}
                        >
                          {message.id ===
                            preview.threadsById[selected].rootMessageId && (
                            <div className="date-divider">
                              <time dateTime={summaries[selected].createdAt}>
                                {new Date(
                                  summaries[selected].createdAt,
                                ).toLocaleDateString(undefined, {
                                  day: 'numeric',
                                  month: 'long',
                                  year: 'numeric',
                                })}
                              </time>
                            </div>
                          )}
                          {renderMessage(message)}
                          {message.id ===
                            preview.threadsById[selected].rootMessageId && (
                            <div className="date-divider replies-divider">
                              <span>
                                {ordered(selected).length === 1
                                  ? 'No replies yet'
                                  : `${ordered(selected).length - 1} ${ordered(selected).length === 2 ? 'reply' : 'replies'}`}
                              </span>
                            </div>
                          )}
                          {Object.values(works[selected] ?? {})
                            .filter(
                              (w) =>
                                w.messageId === message.id &&
                                w.runId !== currentRun &&
                                ended[w.state],
                            )
                            .map((w) => (
                              <p className="queue-message-status" key={w.runId}>
                                {w.state === 'cancelled' && !w.attemptId
                                  ? 'Queued follow-up cancelled'
                                  : ended[w.state]}
                              </p>
                            ))}
                        </motion.article>
                      )}
                    />
                  }
                  work={
                    <WorkPanel
                      work={records}
                      threadId={selected}
                      data={preview}
                      commands={workCommands}
                    />
                  }
                  recovery={
                    <>
                      <WorkRecovery
                        work={records}
                        commands={workCommands}
                        threadId={selected}
                      />
                      <ConversationRecovery
                        entries={pendingFor(selected)}
                        data={preview}
                        retry={outbox.retry}
                        discard={outbox.discard}
                      />
                    </>
                  }
                  composer={compose(selected)}
                  unread={threadFollowing.unread}
                  latest={latestThread}
                />
              )
            )}
          </AnimatePresence>
        </div>
        {settingsOpener && (
          <Suspense>
            <CoreSettingsPanel
              softwareUpdates={softwareUpdates}
              initialTab={settingsInitialTab}
              versions={identity}
              workspaceControls={
                <>
                  <Management
                    data={view}
                    organizationId={nav.organizationId}
                    agents={addable}
                  />
                  {changeConnection && (
                    <button
                      className="management-trigger"
                      onClick={changeConnection}
                    >
                      <Icon name="connection" />
                      Change connection
                    </button>
                  )}
                  <button
                    className="management-trigger"
                    onClick={() => {
                      setLifecycleOpen(true)
                    }}
                  >
                    <Icon name="folder" />
                    Archive &amp; deletion
                  </button>
                </>
              }
              appearance={appearance}
              updates={applicationUpdates}
              endpoint={client.endpoint}
              scope={identity}
              organizationId={nav.organizationId ?? identity.organizationId}
              opener={settingsOpener}
              close={() => setSettingsOpener(null)}
            />
          </Suspense>
        )}
        {lifecycleOpen && directory && (
          <Suspense>
            <LifecyclePanel
              endpoint={client.endpoint}
              scope={scope}
              directory={directory}
              close={() => setLifecycleOpen(false)}
              history={(agentId, organizationId) => {
                setSettingsOpener(null)
                switchChat({ agentId, organizationId, target: 'organization' })
                setLifecycleOpen(false)
              }}
            />
          </Suspense>
        )}
        {inboxOpener && (
          <Inbox
            items={inbox}
            actors={view.actorsById}
            kipId={kipId}
            canClear={notifications.canClear}
            read={notifications.read}
            clear={notifications.clear}
            open={openNotification}
            availability={
              connection
                ? 'Inbox updates are reconnecting. Showing the last received records.'
                : ''
            }
            opener={inboxOpener}
            close={() => setInboxOpener(null)}
          />
        )}
        <Banners
          banners={notifications.banners}
          actors={view.actorsById}
          kipId={kipId}
          open={openNotification}
          dismiss={notifications.dismiss}
        />
      </QueryClientProvider>
    </WorkspaceContext.Provider>
  )
}
