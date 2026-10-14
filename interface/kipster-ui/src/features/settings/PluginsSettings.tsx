import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KipsterClientError,
  needsDocumentMessage,
  pluginErrorText,
  pluginProblem,
  remoteHTTPMessage,
  signInPollMs,
  signInReturnAddress,
  type PluginAccount,
  type PluginDetail,
  type PluginSummary,
  type PluginsClient,
} from '../../data/plugins'
import { Icon } from '../../components/Icon'
import { ActionRow, Block, Callout, Confirm, Row, StatusDot } from './ui'
import { useSheet } from './sheet'

const pluginsKey = (client: PluginsClient) => ['plugins', client.endpoint]
/** A stable ref callback, so the field takes focus once, when it appears. */
const focusOnMount = (input: HTMLInputElement | null) => input?.focus()
const timeout = () => AbortSignal.timeout(20000)
const plural = (count: number, one: string) =>
  `${count} ${one}${count === 1 ? '' : 's'}`

function Availability({ plugin }: { plugin: PluginSummary }) {
  if (!plugin.available)
    return (
      <span className="set-status danger">
        <StatusDot tone="danger" />
        Unavailable
        {plugin.accountCount > 0 &&
          ` · ${plural(plugin.accountCount, 'account')}`}
      </span>
    )
  if (plugin.accountCount > 0)
    return (
      <span className="set-status run">
        <StatusDot tone="run" />
        {plural(plugin.accountCount, 'account')}
      </span>
    )
  return <span className="set-status">Available</span>
}

/** The plugin catalogue, searchable and grouped by category. */
export function PluginsPage({ client }: { client: PluginsClient }) {
  const { push } = useSheet()
  const [query, setQuery] = useState('')
  const list = useQuery({
    queryKey: [...pluginsKey(client), 'list'],
    queryFn: ({ signal }) => client.listPlugins({ signal }),
    retry: false,
    gcTime: 0,
  })
  if (list.isPending) return <Callout>Loading plugins…</Callout>
  if (list.isError)
    return (
      <Callout
        tone="danger"
        alert
        actions={
          <button className="set-button" onClick={() => void list.refetch()}>
            Retry
          </button>
        }
      >
        Plugins are unavailable: {pluginErrorText(list.error)}
      </Callout>
    )
  const needle = query.trim().toLowerCase()
  const shown = list.data.plugins.filter(
    (p) =>
      !needle ||
      [p.name, p.description ?? '', p.category].some((field) =>
        field.toLowerCase().includes(needle),
      ),
  )
  const categories = [...new Set(shown.map((p) => p.category))].sort((a, b) =>
    a.localeCompare(b),
  )
  return (
    <>
      <Block foot="Plugins connect kips to your accounts at other services. Kips use them through their tools.">
        <label className="set-row set-plugin-search">
          <Icon name="search" />
          <input
            type="search"
            className="set-field"
            placeholder="Search plugins"
            aria-label="Search plugins"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </Block>
      {!shown.length && (
        <Callout>
          {needle
            ? `No plugins match “${query.trim()}”.`
            : 'No plugins are available.'}
        </Callout>
      )}
      {categories.map((category) => (
        <Block key={category} label={category} region={category}>
          {shown
            .filter((p) => p.category === category)
            .map((p) => (
              <Row
                key={p.id}
                label={p.name}
                sub={
                  p.available
                    ? p.description
                    : (p.unavailableReason ?? 'Unavailable')
                }
                subTone={p.available ? undefined : 'bad'}
                dim={!p.available}
                control={<Availability plugin={p} />}
                chevron
                onClick={() =>
                  push({ kind: 'plugin', pluginId: p.id, title: p.name })
                }
              />
            ))}
        </Block>
      ))}
    </>
  )
}

type Reason =
  | { kind: 'connect' }
  | { kind: 'add' }
  | { kind: 'reconnect'; account: PluginAccount }
type Flow =
  | { step: 'address'; reason: Reason; address: string; error?: string }
  | { step: 'starting'; reason: Reason }
  | {
      step: 'pending'
      reason: Reason
      id: string
      url: string
      expiresAt: string
      blocked: boolean
    }
type Notice = { tone: 'run' | 'danger'; text: string }

/**
 * Connect, add or reconnect an account: ask for an address if the service needs one, start the
 * sign-in with Core's callback on this window's address, open the service's page in a new tab and
 * check the sign-in until it finishes or expires.
 */
function useSignIn(
  client: PluginsClient,
  plugin: PluginDetail | undefined,
  refresh: () => void,
) {
  const [flow, setFlow] = useState<Flow | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })
  const returnAddress = signInReturnAddress(client.endpoint)

  function begin(reason: Reason) {
    if (!plugin) return
    setNotice(null)
    if (!returnAddress)
      return setNotice({ tone: 'danger', text: remoteHTTPMessage })
    if (plugin.needsAddress)
      return setFlow({
        step: 'address',
        reason,
        address:
          reason.kind === 'reconnect' ? (reason.account.serverUrl ?? '') : '',
      })
    void start(reason)
  }

  async function start(reason: Reason, address?: string) {
    if (!plugin || !returnAddress) return
    setNotice(null)
    setFlow({ step: 'starting', reason })
    try {
      const result = await client.startPluginSignIn(
        plugin.id,
        { ...(address === undefined ? {} : { address }), returnAddress },
        { signal: timeout() },
      )
      if (result.status === 'redirect' && 'authorizationUrl' in result) {
        const tab = window.open(result.authorizationUrl, '_blank')
        if (tab) tab.opener = null
        setFlow({
          step: 'pending',
          reason,
          id: result.id,
          url: result.authorizationUrl,
          expiresAt: result.expiresAt,
          blocked: !tab,
        })
        return
      }
      setFlow(null)
      setNotice({
        tone: 'danger',
        text:
          result.status === 'needs-client-metadata-document'
            ? needsDocumentMessage
            : 'Core answered with a sign-in this app does not know. Update the app and try again.',
      })
    } catch (error) {
      const code = error instanceof KipsterClientError ? error.code : ''
      if (code === 'invalid-address' && address !== undefined)
        return setFlow({
          step: 'address',
          reason,
          address,
          error: pluginProblem(code, (error as Error).message),
        })
      setFlow(null)
      setNotice({
        tone: 'danger',
        text: code
          ? pluginProblem(code, (error as Error).message)
          : `Sign-in did not start: ${pluginErrorText(error)}`,
      })
    }
  }

  const pending = flow?.step === 'pending' ? flow : null
  useEffect(() => {
    if (!pending) return
    let busy = false
    let stopped = false
    const finish = (next: Notice) => {
      stopped = true
      setFlow(null)
      setNotice(next)
      refreshRef.current()
    }
    const check = async () => {
      if (busy || stopped) return
      if (Date.now() >= Date.parse(pending.expiresAt))
        return finish({ tone: 'danger', text: pluginProblem('expired') })
      busy = true
      try {
        const status = await client.getPluginSignIn(pending.id, {
          signal: timeout(),
        })
        if (stopped) return
        if (status.status === 'completed' && 'account' in status)
          finish({
            tone: 'run',
            text: status.duplicate
              ? `Reconnected ${status.account.label}. This account was already connected.`
              : `Connected ${status.account.label}.`,
          })
        else if (status.status === 'failed' && 'code' in status)
          finish({ tone: 'danger', text: pluginProblem(status.code) })
        else if (status.status !== 'pending')
          finish({ tone: 'danger', text: pluginProblem('failed') })
      } catch (error) {
        // Core may be restarting; keep checking until the sign-in expires.
        if (
          error instanceof KipsterClientError &&
          error.code !== 'plugins-unavailable' &&
          error.status >= 400 &&
          error.status < 500
        )
          finish({ tone: 'danger', text: pluginErrorText(error) })
      } finally {
        busy = false
      }
    }
    const timer = setInterval(() => void check(), signInPollMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [client, pending])

  return {
    flow,
    notice,
    begin,
    start,
    setFlow,
    cancel: () => setFlow(null),
    dismiss: () => setNotice(null),
  }
}

type Action =
  | { kind: 'rename'; accountId: string; label: string }
  | { kind: 'confirm'; account: PluginAccount }
  | { kind: 'busy'; accountId: string }

/** One plugin: connect it, or manage its accounts. */
export function PluginPage({
  client,
  pluginId,
}: {
  client: PluginsClient
  pluginId: string
}) {
  const { toast } = useSheet()
  const queries = useQueryClient()
  const addressId = useId()
  const query = useQuery({
    queryKey: [...pluginsKey(client), 'plugin', pluginId],
    queryFn: ({ signal }) => client.getPlugin(pluginId, { signal }),
    retry: false,
    gcTime: 0,
  })
  const refresh = () =>
    void queries.invalidateQueries({ queryKey: pluginsKey(client) })
  const plugin = query.data?.plugin
  const signIn = useSignIn(client, plugin, refresh)
  const [action, setAction] = useState<Action | null>(null)
  const [problem, setProblem] = useState('')

  if (query.isPending) return <Callout>Loading plugin…</Callout>
  if (query.isError || !plugin)
    return query.error instanceof KipsterClientError &&
      query.error.code === 'unknown-plugin' ? (
      <Callout>This plugin is no longer in the catalogue.</Callout>
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
        This plugin is unavailable: {pluginErrorText(query.error)}
      </Callout>
    )

  const accounts = plugin.accounts
  const flow = signIn.flow
  const signingIn = !!flow
  const busy = (accountId: string) =>
    action?.kind === 'busy' && action.accountId === accountId

  async function act(
    accountId: string,
    run: () => Promise<unknown>,
    done: string,
    failed: string,
  ) {
    setProblem('')
    signIn.dismiss()
    setAction({ kind: 'busy', accountId })
    try {
      await run()
      setAction(null)
      toast(done)
    } catch (error) {
      setAction(null)
      setProblem(`${failed}: ${pluginErrorText(error)}`)
    }
    refresh()
  }
  function rename(event: FormEvent, accountId: string, label: string) {
    event.preventDefault()
    const next = label.trim()
    if (!next || next.length > 64)
      return setProblem('Not renamed: a name has 1 to 64 characters.')
    if (
      accounts.some(
        (a) =>
          a.id !== accountId && a.label.toLowerCase() === next.toLowerCase(),
      )
    )
      return setProblem(`Not renamed: another account is named “${next}”.`)
    void act(
      accountId,
      () => client.renamePluginAccount(accountId, next, { signal: timeout() }),
      'Account renamed',
      'Not renamed',
    )
  }
  async function disconnect(account: PluginAccount) {
    setProblem('')
    signIn.dismiss()
    setAction({ kind: 'busy', accountId: account.id })
    try {
      const result = await client.removePluginAccount(account.id, {
        signal: timeout(),
      })
      setAction(null)
      if (result.revoked) toast('Account disconnected')
      else
        setProblem(
          `${account.label} was disconnected, but ${plugin!.name} did not confirm it revoked Kipster’s access. You can revoke it in your ${plugin!.name} settings.`,
        )
    } catch (error) {
      setAction(null)
      setProblem(`Not disconnected: ${pluginErrorText(error)}`)
    }
    refresh()
  }

  const status = (account: PluginAccount) =>
    account.status === 'working'
      ? 'Working'
      : account.status === 'reconnect-needed'
        ? 'Reconnect needed'
        : 'Status unknown'

  return (
    <>
      {!plugin.available && (
        <Callout tone="danger">
          {plugin.unavailableReason ?? 'This plugin is unavailable.'}
        </Callout>
      )}
      <Block>
        <Row
          className="hero"
          label={<span className="set-hero-title">{plugin.name}</span>}
          sub={[plugin.category, plugin.description]
            .filter(Boolean)
            .join(' · ')}
          control={<Availability plugin={plugin} />}
        />
        {plugin.website && (
          <Row
            label="Website"
            control={
              <a href={plugin.website} target="_blank" rel="noreferrer">
                {new URL(plugin.website).host}
              </a>
            }
          />
        )}
      </Block>
      {signIn.notice && (
        <Callout
          tone={signIn.notice.tone}
          alert={signIn.notice.tone === 'danger'}
          actions={
            <button className="set-button" onClick={signIn.dismiss}>
              Dismiss
            </button>
          }
        >
          {signIn.notice.text}
        </Callout>
      )}
      {flow?.step === 'address' && (
        <form
          className="set-block"
          // Core checks the address and explains what is wrong with it.
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            const address = flow.address.trim()
            if (!address)
              return signIn.setFlow({
                ...flow,
                error: plugin.addressPrompt ?? 'Enter the address.',
              })
            void signIn.start(flow.reason, address)
          }}
        >
          <h4 className="set-label" id={addressId}>
            {plugin.addressPrompt ?? `Your ${plugin.name} address`}
          </h4>
          <div className="set-group">
            <div className="set-row">
              <input
                className="set-field set-plugin-address"
                aria-labelledby={addressId}
                type="url"
                inputMode="url"
                autoComplete="url"
                ref={focusOnMount}
                value={flow.address}
                onChange={(e) =>
                  signIn.setFlow({ ...flow, address: e.target.value })
                }
              />
              <span className="set-control">
                <button
                  type="button"
                  className="set-button"
                  onClick={signIn.cancel}
                >
                  Cancel
                </button>
                <button type="submit" className="set-button primary">
                  Continue
                </button>
              </span>
            </div>
          </div>
          {flow.error && (
            <p role="alert" className="set-alert">
              {flow.error}
            </p>
          )}
        </form>
      )}
      {flow?.step === 'starting' && (
        <Callout tone="wait">Starting sign-in…</Callout>
      )}
      {flow?.step === 'pending' && (
        <Callout
          tone="wait"
          actions={
            <>
              <a
                className="set-button"
                href={flow.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open sign-in page
              </a>
              <button className="set-button" onClick={signIn.cancel}>
                Stop waiting
              </button>
            </>
          }
        >
          {flow.blocked
            ? `This window could not open the ${plugin.name} sign-in page. Open it to continue.`
            : `Finish signing in to ${plugin.name} in the new tab. This page updates when you are done.`}
        </Callout>
      )}
      {accounts.length === 0 ? (
        <Block foot="You sign in at the service. Kipster keeps the account on this computer.">
          <Row
            label={`Connect ${plugin.name}`}
            sub="Kips can use your account once it is connected."
            control={
              <button
                className="set-button primary"
                disabled={!plugin.available || signingIn}
                onClick={() => signIn.begin({ kind: 'connect' })}
              >
                Connect
              </button>
            }
          />
        </Block>
      ) : (
        <Block
          label="Accounts"
          region="Accounts"
          foot="Kips use the default account unless you name another."
        >
          {accounts.map((account) =>
            action?.kind === 'rename' && action.accountId === account.id ? (
              <form
                key={account.id}
                className="set-row"
                onSubmit={(event) => rename(event, account.id, action.label)}
              >
                <input
                  className="set-field set-plugin-label"
                  aria-label={`New name for ${account.label}`}
                  ref={focusOnMount}
                  maxLength={64}
                  value={action.label}
                  onChange={(e) =>
                    setAction({ ...action, label: e.target.value })
                  }
                />
                <span className="set-control">
                  <button
                    type="button"
                    className="set-button"
                    onClick={() => {
                      setAction(null)
                      setProblem('')
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="set-button primary">
                    Save
                  </button>
                </span>
              </form>
            ) : (
              <Row
                key={account.id}
                className="set-plugin-account"
                lead={
                  <StatusDot
                    tone={account.status === 'working' ? 'run' : 'danger'}
                  />
                }
                label={
                  <>
                    {account.label}
                    {account.isDefault && <i className="set-tag">Default</i>}
                  </>
                }
                sub={status(account)}
                subTone={account.status === 'working' ? undefined : 'bad'}
                control={
                  <>
                    {account.status === 'reconnect-needed' && (
                      <button
                        className="set-button primary"
                        aria-label={`Reconnect ${account.label}`}
                        disabled={
                          !plugin.available || signingIn || busy(account.id)
                        }
                        onClick={() =>
                          signIn.begin({ kind: 'reconnect', account })
                        }
                      >
                        Reconnect
                      </button>
                    )}
                    {!account.isDefault && (
                      <button
                        className="set-button"
                        aria-label={`Make ${account.label} the default`}
                        disabled={busy(account.id)}
                        onClick={() =>
                          void act(
                            account.id,
                            () =>
                              client.setDefaultPluginAccount(
                                plugin.id,
                                account.id,
                                { signal: timeout() },
                              ),
                            'Default account changed',
                            'Default not changed',
                          )
                        }
                      >
                        Set default
                      </button>
                    )}
                    <button
                      className="set-button"
                      aria-label={`Rename ${account.label}`}
                      disabled={busy(account.id)}
                      onClick={() => {
                        setProblem('')
                        setAction({
                          kind: 'rename',
                          accountId: account.id,
                          label: account.label,
                        })
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="set-button danger"
                      aria-label={`Disconnect ${account.label}`}
                      disabled={busy(account.id)}
                      onClick={() => {
                        setProblem('')
                        setAction({ kind: 'confirm', account })
                      }}
                    >
                      Disconnect
                    </button>
                  </>
                }
              />
            ),
          )}
          <ActionRow
            disabled={!plugin.available || signingIn}
            onClick={() => signIn.begin({ kind: 'add' })}
          >
            Add another account…
          </ActionRow>
        </Block>
      )}
      {problem && (
        <p role="alert" className="set-alert">
          {problem}
        </p>
      )}
      {action?.kind === 'confirm' && (
        <Confirm
          title={`Disconnect ${action.account.label}?`}
          cancel={() => setAction(null)}
        >
          <div className="set-confirm-form">
            <p>
              Kips can no longer use this {plugin.name} account. Kipster asks{' '}
              {plugin.name} to revoke its access. You can connect the account
              again later.
            </p>
            <div className="set-confirm-actions">
              <button className="set-button" onClick={() => setAction(null)}>
                Cancel
              </button>
              <button
                className="set-button danger solid"
                onClick={() => void disconnect(action.account)}
              >
                Disconnect
              </button>
            </div>
          </div>
        </Confirm>
      )}
    </>
  )
}
