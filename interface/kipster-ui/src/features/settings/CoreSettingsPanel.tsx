import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PlatformContext } from '../../platform/context'
import type { Appearance } from '../../app/appearance'
import type { ApplicationUpdates } from '../../data/application-updates'
import type { ProtocolRange } from '../../data/compatibility'
import { CoreSettingsClient } from '../../data/core-settings'
import type {
  Directory as WorkspaceDirectory,
  WorkspaceSnapshot,
} from '../../data/directory'
import type { SoftwareUpdates } from '../../data/software-updates'
import type { Scope } from '../../data/text'
import { useCoreSettings } from '../../data/use-core-settings'
import { Icon } from '../../components/Icon'
import { NotificationSettings } from '../notifications/NotificationSettings'
import { ArchiveSettings } from '../workspace/LifecyclePanel'
import { AdapterPage, AdaptersPage } from './AdaptersSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { ConnectionSettings } from './ConnectionSettings'
import { GeneralSettings } from './GeneralSettings'
import { BackupPage, BackupsPage, IdentityFilePage } from './IdentityFiles'
import type { KipLook } from './KipAvatar'
import { KipPage, KipsPage } from './KipsSettings'
import { LearningPage } from './LearningSettings'
import { InstructionsPage, OrganizationPage } from './OrganizationSettings'
import { Panel } from './Panel'
import { Callout, Glyph } from './ui'
import { SheetContext, type Frame } from './sheet'
import { TestingPage, UpdatesPage } from './UpdatesPanel'

type PageId =
  | 'appearance'
  | 'notifications'
  | 'general'
  | 'updates'
  | 'kips'
  | 'organization'
  | 'adapters'
  | 'learning'
  | 'connection'
  | 'archive'
const pages: Record<
  PageId,
  {
    label: string
    icon: Parameters<typeof Icon>[0]['name']
    hue: string
    /** Words people may search for that are not in the label. */
    words: string
  }
> = {
  appearance: {
    label: 'Appearance',
    icon: 'paint',
    hue: 'var(--hue-amber)',
    words: 'palette theme light dark mode color',
  },
  notifications: {
    label: 'Notifications',
    icon: 'bell',
    hue: 'var(--hue-rose)',
    words: 'alerts banners badge dock test',
  },
  general: {
    label: 'General',
    icon: 'settings',
    hue: 'var(--hue-you)',
    words: 'login startup start keep running window',
  },
  updates: {
    label: 'Updates',
    icon: 'download',
    hue: 'var(--hue-sky)',
    words: 'version about software channel automatic protocol',
  },
  kips: {
    label: 'Kips',
    icon: 'users',
    hue: 'var(--hue-iris)',
    words: 'agents model effort identity soul files next run',
  },
  organization: {
    label: 'Organization',
    icon: 'organization',
    hue: 'var(--hue-ocean)',
    words: 'defaults instructions groups manage workspace',
  },
  adapters: {
    label: 'Adapters',
    icon: 'plug',
    hue: 'var(--hue-plum)',
    words: 'models providers capabilities',
  },
  learning: {
    label: 'Learning',
    icon: 'brain',
    hue: 'var(--hue-sage)',
    words: 'sleep memory learn',
  },
  connection: {
    label: 'Connection',
    icon: 'link',
    hue: 'var(--hue-mint)',
    words: 'backend server address',
  },
  archive: {
    label: 'Archive & deletion',
    icon: 'archive',
    hue: 'var(--hue-you)',
    words: 'delete restore remove',
  },
}
/** Pages that read Core's settings, directory and catalog. */
const workspacePages: PageId[] = [
  'kips',
  'organization',
  'adapters',
  'learning',
]

export function CoreSettingsPanel({
  manage,
  changeConnection,
  lifecycle,
  workspace,
  versions,
  updates,
  softwareUpdates,
  initialTab,
  appearance,
  endpoint,
  scope,
  organizationId,
  opener,
  close,
}: {
  /** The control that opens workspace management, shown under Organization. */
  manage?: ReactNode
  /** Present when this window can switch to another backend. */
  changeConnection?: () => void
  /** Archive and deletion, when the workspace directory is loaded. */
  lifecycle?: {
    directory: WorkspaceDirectory
    scope: string
    history: (agentId: string, organizationId: string) => void
  }
  /** The open workspace, for kip colors, roles and groups. */
  workspace?: WorkspaceSnapshot
  /** The connected Core's version and protocol range, from bootstrap. */
  versions?: { coreVersion: string; protocol: ProtocolRange }
  updates?: ApplicationUpdates
  softwareUpdates?: SoftwareUpdates
  initialTab?: 'workspace' | 'updates'
  appearance: Appearance
  endpoint: string
  scope: Scope
  /** The organization shown first. */
  organizationId: string
  opener?: HTMLElement | null
  close: () => void
}) {
  const platform = useContext(PlatformContext)
  const client = useMemo(() => new CoreSettingsClient(endpoint), [endpoint])
  const settings = useCoreSettings(client, scope, updates)
  const journalScope = JSON.stringify([
    client.endpoint,
    scope.installationId,
    scope.callerId,
  ])
  const ready = !!(settings.saved && settings.learning && settings.directory)
  const device = platform?.app ? 'Mac' : 'device'
  const shown: Record<PageId, boolean> = {
    appearance: true,
    notifications: !!platform,
    general: !!platform?.app,
    updates: !!(softwareUpdates || versions),
    kips: true,
    organization: true,
    adapters: true,
    learning: true,
    connection: !!changeConnection,
    archive: !!lifecycle,
  }
  const sections: [string, PageId[]][] = [
    [
      platform?.app ? 'This Mac' : 'This device',
      ['appearance', 'notifications', 'general', 'updates'],
    ],
    ['Workspace', ['kips', 'organization', 'adapters', 'learning']],
    ['Advanced', ['connection', 'archive']],
  ]
  const [page, setPage] = useState<PageId>(() =>
    initialTab === 'updates' && shown.updates ? 'updates' : 'kips',
  )
  const [stack, setStack] = useState<Frame[]>([])
  const [query, setQuery] = useState('')
  const [chosenOrganization, setChosenOrganization] = useState(organizationId)
  const [source, setSource] = useState(false)
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null)
  const [tools, setTools] = useState<HTMLElement | null>(null)
  const [overlay, setOverlay] = useState<HTMLElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const scrolls = useRef(new Map<string, number>())
  const moved = useRef(false)
  const frame = stack.at(-1)
  const viewKey = [page, ...stack.map((f) => JSON.stringify(f))].join('/')

  /** Keeps each page's scroll; pages pushed or popped also take focus. */
  const remember = (focus: boolean) => {
    if (scroller.current)
      scrolls.current.set(viewKey, scroller.current.scrollTop)
    moved.current = focus
  }
  const push = (next: Frame) => {
    remember(true)
    setStack((old) => [...old, next])
  }
  const pop = (count = 1) => {
    remember(true)
    setStack((old) => old.slice(0, Math.max(0, old.length - count)))
  }
  const go = (next: PageId) => {
    remember(false)
    setPage(next)
    setStack([])
  }
  useLayoutEffect(() => {
    if (!scroller.current) return
    scroller.current.scrollTop = scrolls.current.get(viewKey) ?? 0
    // The row that opened a page, or the back button, is gone: focus moves to the new title
    // so keyboard and screen reader users land where the content changed.
    if (moved.current) heading.current?.focus({ preventScroll: true })
    moved.current = false
  }, [viewKey])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])
  const sheet = {
    push,
    pop,
    toast: (text: string) =>
      setToast((old) => ({ text, id: (old?.id ?? 0) + 1 })),
    tools,
    overlay,
    source,
    setSource,
  }

  const needle = query.trim().toLowerCase()
  const matches = (id: PageId) =>
    !needle ||
    pages[id].label.toLowerCase().includes(needle) ||
    pages[id].words.includes(needle)
  const nav = sections
    .map(
      ([label, ids]) =>
        [label, ids.filter((id) => shown[id] && matches(id))] as const,
    )
    .filter(([, ids]) => ids.length)

  const directory = settings.directory
  const look = (agentId: string): KipLook => {
    const actor = workspace?.actorsById[agentId]
    const agent = directory?.agents.find((a) => a.id === agentId)
    const lifecycleAgent = lifecycle?.directory.agents[agentId]
    return {
      name: agent?.name ?? actor?.name ?? lifecycleAgent?.name ?? 'Kip',
      admin: agent?.admin ?? lifecycleAgent?.admin ?? false,
      color: actor?.kind === 'agent' ? actor.color : undefined,
      description:
        actor?.kind === 'agent' && actor.description
          ? actor.description
          : undefined,
    }
  }
  const agentName = (agentId: string) =>
    directory?.agents.find((a) => a.id === agentId)?.name ?? 'Kip'
  const readOnly = (agentId: string) =>
    directory?.agents.find((a) => a.id === agentId)?.lifecycle === 'archived'
  const workspaceView =
    workspacePages.includes(page) ||
    (frame && !['testing'].includes(frame.kind))

  function content() {
    if (frame) {
      if (frame.kind === 'testing')
        return softwareUpdates && <TestingPage updates={softwareUpdates} />
      if (!ready) return null
      switch (frame.kind) {
        case 'kip':
          return (
            <KipPage
              key={frame.agentId}
              client={client}
              settings={settings}
              journalScope={journalScope}
              endpoint={endpoint}
              agentId={frame.agentId}
              look={look}
            />
          )
        case 'file':
          return (
            <IdentityFilePage
              endpoint={endpoint}
              agentId={frame.agentId}
              agentName={agentName(frame.agentId)}
              file={frame.file}
              readOnly={readOnly(frame.agentId)}
            />
          )
        case 'backups':
          return (
            <BackupsPage
              endpoint={endpoint}
              agentId={frame.agentId}
              agentName={agentName(frame.agentId)}
              file={frame.file}
            />
          )
        case 'backup':
          return (
            <BackupPage
              endpoint={endpoint}
              agentId={frame.agentId}
              file={frame.file}
              backupId={frame.backupId}
              readOnly={readOnly(frame.agentId)}
            />
          )
        case 'adapter':
          return <AdapterPage settings={settings} adapterId={frame.adapterId} />
        case 'instructions':
          return (
            <InstructionsPage
              key={`${journalScope}:${frame.organizationId}`}
              client={client}
              journalScope={journalScope}
              organizationId={frame.organizationId}
              name={
                directory!.organizations.find(
                  (o) => o.id === frame.organizationId,
                )?.name ?? 'this organization'
              }
            />
          )
      }
    }
    switch (page) {
      case 'appearance':
        return <AppearanceSettings appearance={appearance} device={device} />
      case 'notifications':
        return (
          platform && (
            <NotificationSettings platform={platform} scope={journalScope} />
          )
        )
      case 'general':
        return platform?.app && <GeneralSettings app={platform.app} />
      case 'updates':
        return <UpdatesPage updates={softwareUpdates} versions={versions} />
      case 'connection':
        return (
          changeConnection && (
            <ConnectionSettings
              endpoint={endpoint}
              installationId={scope.installationId}
              versions={versions}
              problem={settings.connection}
              reconnect={settings.reconnect}
              change={changeConnection}
            />
          )
        )
      case 'archive':
        return (
          lifecycle && (
            <ArchiveSettings
              endpoint={endpoint}
              scope={lifecycle.scope}
              directory={lifecycle.directory}
              history={lifecycle.history}
              look={look}
            />
          )
        )
    }
    if (!ready) return null
    switch (page) {
      case 'kips':
        return <KipsPage client={client} settings={settings} look={look} />
      case 'organization':
        return (
          <OrganizationPage
            key={organizationId}
            client={client}
            settings={settings}
            journalScope={journalScope}
            chosen={chosenOrganization}
            choose={setChosenOrganization}
            workspace={workspace}
            look={look}
            manage={manage}
          />
        )
      case 'adapters':
        return <AdaptersPage settings={settings} />
      case 'learning':
        return <LearningPage settings={settings} look={look} />
    }
  }

  const title = frame ? frame.title : pages[page].label
  const crumb = frame
    ? stack.length > 1
      ? stack.at(-2)!.title
      : pages[page].label
    : null
  return (
    <Panel
      title="Settings"
      className="settings-sheet"
      header={false}
      opener={opener}
      close={close}
    >
      <SheetContext.Provider value={sheet}>
        <aside className="settings-side">
          <label className="settings-search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Search"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <nav aria-label="Settings category">
            {nav.length ? (
              nav.map(([label, ids]) => (
                <div className="settings-nav-section" key={label}>
                  <h3 className="settings-nav-label">{label}</h3>
                  {ids.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className="settings-nav-item"
                      aria-current={page === id ? 'page' : undefined}
                      onClick={() => go(id)}
                    >
                      <Glyph icon={pages[id].icon} hue={pages[id].hue} />
                      <span>{pages[id].label}</span>
                    </button>
                  ))}
                </div>
              ))
            ) : (
              <p className="settings-nav-empty">No results</p>
            )}
          </nav>
        </aside>
        <section className="settings-main">
          <header className="settings-bar">
            {frame && (
              <button
                type="button"
                className="set-icon-button settings-back"
                aria-label={`Back to ${crumb}`}
                onClick={() => pop()}
              >
                <Icon name="back" />
              </button>
            )}
            <div className="settings-title">
              {crumb && <span className="settings-crumb">{crumb}</span>}
              <h2 ref={heading} tabIndex={-1}>
                {title}
              </h2>
            </div>
            <div className="settings-tools" ref={setTools} />
            <button
              type="button"
              className="set-icon-button"
              aria-label="Close settings"
              onClick={close}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="settings-scroll" ref={scroller}>
            <div className="settings-page" key={viewKey}>
              {workspaceView && settings.connection && (
                <Callout
                  tone="wait"
                  actions={
                    !ready && (
                      <button
                        className="set-button"
                        onClick={settings.reconnect}
                      >
                        Retry now
                      </button>
                    )
                  }
                >
                  {settings.connection}
                </Callout>
              )}
              {content()}
            </div>
          </div>
          {toast && (
            <output className="settings-toast" key={toast.id}>
              <Icon name="check" weight="bold" />
              {toast.text}
            </output>
          )}
          <div className="settings-overlay" ref={setOverlay} />
        </section>
      </SheetContext.Provider>
    </Panel>
  )
}
