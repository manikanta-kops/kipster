import { json, record, text, WireError } from './wire.ts'

/** The Kipster Plugins routes Core relays, served from memory with a small catalogue. */
type Method = 'dcr' | 'cimd'
type Plugin = {
  id: string
  name: string
  description: string
  category: string
  website: string
  signIn: Method[]
  available: boolean
  unavailableReason?: string
  probe: {
    result: string
    signIn: Method[]
    checkedOn: string
    reason: string
  } | null
  verification: 'probe' | 'account' | null
  needsAddress: boolean
  addressPrompt?: string
  /** How a sign-in start answers: CIMD services need a loopback return address or a published document. */
  behavior?: 'loopback-only' | 'needs-client-metadata-document'
}
type Account = {
  id: string
  plugin: string
  label: string
  status: 'working' | 'reconnect-needed'
  issuer: string
  identityVerified: boolean
  serverUrl?: string
  createdAt: string
  updatedAt?: string
}
type SignIn = {
  id: string
  plugin: string
  method: Method
  status: 'pending' | 'completed' | 'failed'
  code?: string
  account?: string
  /** The account as it was when the sign-in completed, in case it is removed later. */
  snapshot?: Account & { isDefault: boolean }
  duplicate?: boolean
  address?: string
  returnAddress?: string
  expiresAt: string
  ticks: number
}

const checkedOn = '2026-10-01'
const probe = (signIn: Method[]) => ({
  result: 'ok',
  signIn,
  checkedOn,
  reason: '',
})
const catalogue = (): Plugin[] => [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles.',
    category: 'Project management',
    website: 'https://linear.app',
    signIn: ['dcr'],
    available: true,
    probe: probe(['dcr']),
    verification: 'probe',
    needsAddress: false,
  },
  {
    id: 'jira',
    name: 'Jira',
    description: 'Issues and boards.',
    category: 'Project management',
    website: 'https://www.atlassian.com/software/jira',
    signIn: ['dcr'],
    available: false,
    unavailableReason:
      'Jira changed how it signs people in. Kipster is checking the new sign-in.',
    probe: {
      result: 'sign-in-changed',
      signIn: [],
      checkedOn,
      reason: 'The sign-in metadata no longer offers client registration.',
    },
    verification: 'probe',
    needsAddress: false,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases and comments.',
    category: 'Documents',
    website: 'https://www.notion.so',
    signIn: ['dcr'],
    available: true,
    probe: probe(['dcr']),
    verification: 'account',
    needsAddress: false,
  },
  {
    id: 'canva',
    name: 'Canva',
    description: 'Designs and brand assets.',
    category: 'Design',
    website: 'https://www.canva.com',
    signIn: ['cimd'],
    available: true,
    probe: probe(['cimd']),
    verification: 'probe',
    needsAddress: false,
    behavior: 'needs-client-metadata-document',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Design files, frames and comments.',
    category: 'Design',
    website: 'https://www.figma.com',
    signIn: ['cimd'],
    available: true,
    probe: probe(['cimd']),
    verification: 'probe',
    needsAddress: false,
    behavior: 'loopback-only',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Errors and performance issues.',
    category: 'Developer tools',
    website: 'https://sentry.io',
    signIn: ['dcr'],
    available: true,
    probe: {
      result: 'needs-address',
      signIn: ['dcr'],
      checkedOn,
      reason: '',
    },
    verification: null,
    needsAddress: true,
    addressPrompt: 'Your Sentry address, such as https://acme.sentry.io',
  },
]
const seededAccounts = (): Account[] => [
  {
    id: 'acct-notion-work',
    plugin: 'notion',
    label: 'Work',
    status: 'working',
    issuer: 'https://api.notion.com',
    identityVerified: true,
    createdAt: '2026-09-12T08:30:00.000Z',
  },
  {
    id: 'acct-notion-home',
    plugin: 'notion',
    label: 'Personal',
    status: 'reconnect-needed',
    issuer: 'https://api.notion.com',
    identityVerified: true,
    createdAt: '2026-09-20T18:05:00.000Z',
  },
]
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
/** The fake answers on several demo origins, so any of them, or loopback, counts as Core's own. */
const ownHost = (host: string) =>
  host === 'demo.kipster.invalid' ||
  host.endsWith('.demo.kipster.invalid') ||
  loopbackHosts.has(host)
const signInMinutes = 10

export function createFakePlugins(options: {
  enabled: boolean
  origin: string
}) {
  let enabled = options.enabled
  let plugins = catalogue()
  let accounts = seededAccounts()
  let defaults = new Map<string, string | null>([
    ['notion', 'acct-notion-work'],
  ])
  const signIns = new Map<string, SignIn>()
  let serial = 1
  const now = () => new Date().toISOString()

  const plugin = (id: string) => {
    const found = plugins.find((p) => p.id === id)
    if (!found) throw new WireError(404, 'unknown-plugin', 'Unknown plugin')
    return found
  }
  const account = (id: string) => {
    const found = accounts.find((a) => a.id === id)
    if (!found) throw new WireError(404, 'unknown-account', 'Unknown account')
    return found
  }
  const accountView = (a: Account): Account & { isDefault: boolean } => ({
    ...a,
    isDefault: defaults.get(a.plugin) === a.id,
  })
  const accountsOf = (pluginId: string) =>
    accounts.filter((a) => a.plugin === pluginId)
  const summary = (p: Plugin) => {
    const { behavior: _behavior, ...fields } = p
    return { ...fields, accountCount: accountsOf(p.id).length }
  }
  const detail = (p: Plugin) => ({
    ...summary(p),
    accounts: accountsOf(p.id).map(accountView),
  })
  const status = (s: SignIn) => {
    if (s.status === 'pending' && Date.parse(s.expiresAt) <= Date.now())
      Object.assign(s, { status: 'failed', code: 'expired' })
    if (s.status === 'pending')
      return { version: 1, id: s.id, status: 'pending', plugin: s.plugin }
    if (s.status === 'failed')
      return {
        version: 1,
        id: s.id,
        status: 'failed',
        plugin: s.plugin,
        code: s.code,
      }
    const found = accounts.find((a) => a.id === s.account)
    return {
      version: 1,
      id: s.id,
      status: 'completed',
      plugin: s.plugin,
      account: found ? accountView(found) : s.snapshot,
      duplicate: s.duplicate === true,
    }
  }
  /** A label for a new account within the 64-character limit, numbered if the name is taken. */
  const uniqueLabel = (pluginId: string, base: string) => {
    const taken = new Set(
      accountsOf(pluginId).map((a) => a.label.toLowerCase()),
    )
    const fit = (suffix: string) =>
      base.slice(0, 64 - suffix.length).trimEnd() + suffix
    if (!taken.has(fit('').toLowerCase())) return fit('')
    for (let n = 2; ; n++)
      if (!taken.has(fit(` ${n}`).toLowerCase())) return fit(` ${n}`)
  }
  /**
   * Completes a pending sign-in. The provider names the account: an existing one is reconnected
   * (`duplicate`); by default an account that needs reconnecting is the one that signed in again.
   */
  function complete(s: SignIn, existing?: string) {
    if (s.status !== 'pending') throw new Error('Invalid sign-in state')
    const reconnect = existing
      ? account(existing)
      : accountsOf(s.plugin).find((a) => a.status === 'reconnect-needed')
    if (reconnect) {
      if (reconnect.plugin !== s.plugin) throw new Error('Invalid account')
      Object.assign(reconnect, { status: 'working', updatedAt: now() })
      Object.assign(s, {
        status: 'completed',
        account: reconnect.id,
        snapshot: accountView(reconnect),
        duplicate: true,
      })
      return
    }
    const p = plugin(s.plugin)
    const host = s.address ? new URL(s.address).host : undefined
    const created: Account = {
      id: `acct-${s.plugin}-${serial++}`,
      plugin: s.plugin,
      label: uniqueLabel(s.plugin, host ?? p.name),
      status: 'working',
      issuer: s.address ?? p.website,
      identityVerified: true,
      ...(s.address ? { serverUrl: s.address } : {}),
      createdAt: now(),
    }
    accounts.push(created)
    if (!defaults.get(s.plugin)) defaults.set(s.plugin, created.id)
    Object.assign(s, {
      status: 'completed',
      account: created.id,
      snapshot: accountView(created),
      duplicate: false,
    })
  }
  function fail(s: SignIn, code: string) {
    if (s.status !== 'pending') throw new Error('Invalid sign-in state')
    Object.assign(s, { status: 'failed', code })
  }

  async function input(request: Request) {
    const raw = await request.text()
    const row = record(raw ? JSON.parse(raw) : {})
    if (row.version !== undefined && row.version !== 1)
      throw new Error('Invalid protocol version')
    return row
  }
  const optionalText = (value: unknown) =>
    value === undefined ? undefined : text(value)

  async function startSignIn(p: Plugin, request: Request) {
    const row = await input(request)
    if (
      Object.keys(row).some(
        (k) => !['version', 'address', 'returnAddress'].includes(k),
      )
    )
      throw new Error('Invalid fields')
    const address = optionalText(row.address)
    const returnAddress = optionalText(row.returnAddress)
    if (!p.available)
      throw new WireError(
        409,
        'plugin-unavailable',
        p.unavailableReason ?? 'Unavailable',
      )
    let returnURL: URL | undefined
    if (returnAddress !== undefined) {
      try {
        returnURL = new URL(returnAddress)
      } catch {
        throw new WireError(
          400,
          'invalid-return-address',
          'The return address is not a URL',
        )
      }
      if (
        !['http:', 'https:'].includes(returnURL.protocol) ||
        returnURL.pathname !== '/plugins/callback' ||
        returnURL.search ||
        returnURL.hash ||
        returnURL.username ||
        returnURL.password
      )
        throw new WireError(
          400,
          'invalid-return-address',
          'The return address must be Core’s /plugins/callback',
        )
      if (!ownHost(returnURL.hostname))
        throw new WireError(
          400,
          'return-address-refused',
          'The return address is not on Core’s own origin',
        )
      if (
        returnURL.protocol === 'http:' &&
        !loopbackHosts.has(returnURL.hostname)
      )
        throw new WireError(
          400,
          'invalid-return-address',
          'A return address on another computer must use HTTPS',
        )
    }
    if (p.behavior === 'needs-client-metadata-document')
      return json({ version: 1, status: 'needs-client-metadata-document' })
    if (
      p.behavior === 'loopback-only' &&
      !(returnURL && loopbackHosts.has(returnURL.hostname))
    )
      throw new WireError(
        400,
        'loopback-only',
        `${p.name} signs in only from the computer running Kipster`,
      )
    if (p.needsAddress) {
      if (address === undefined)
        throw new WireError(
          400,
          'invalid-address',
          p.addressPrompt ?? 'Enter the address',
        )
      let url: URL
      try {
        url = new URL(address)
      } catch {
        throw new WireError(
          400,
          'invalid-address',
          `Enter an HTTPS address. ${p.addressPrompt ?? ''}`.trim(),
        )
      }
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new WireError(
          400,
          'invalid-address',
          `Enter an HTTPS address. ${p.addressPrompt ?? ''}`.trim(),
        )
    } else if (address !== undefined)
      throw new WireError(
        400,
        'invalid-address',
        `${p.name} does not take an address`,
      )
    const id = `signin-${serial++}`
    const s: SignIn = {
      id,
      plugin: p.id,
      method: p.signIn[0] ?? 'dcr',
      status: 'pending',
      ...(address !== undefined ? { address: new URL(address).origin } : {}),
      ...(returnAddress !== undefined ? { returnAddress } : {}),
      expiresAt: new Date(Date.now() + signInMinutes * 60_000).toISOString(),
      ticks: 0,
    }
    signIns.set(id, s)
    // The demo provider approves at once and sends the browser to the return address.
    const callback = new URL(
      returnAddress ?? `${options.origin}/plugins/callback`,
    )
    callback.search = new URLSearchParams({
      state: id,
      code: 'demo-approved',
    }).toString()
    return json({
      version: 1,
      status: 'redirect',
      id,
      method: s.method,
      authorizationUrl: callback.href,
      ...(s.address ? { serverUrl: s.address } : {}),
      expiresAt: s.expiresAt,
    })
  }

  function page(status: number, title: string, body: string) {
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><p>${body}</p>`,
      {
        status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    )
  }
  /** The browser's return from the provider: `code` completes the sign-in, `error` fails it. */
  function callback(url: URL) {
    const s = signIns.get(url.searchParams.get('state') ?? '')
    if (!s)
      return page(
        404,
        'Sign-in not found',
        'Start connecting again in Kipster.',
      )
    if (s.status === 'pending') {
      if (Date.parse(s.expiresAt) <= Date.now()) fail(s, 'expired')
      else if (url.searchParams.get('error') === 'access_denied')
        fail(s, 'denied')
      else if (url.searchParams.get('code')) complete(s)
      else fail(s, 'failed')
    }
    return s.status === 'completed'
      ? page(200, 'Connected', 'You can close this tab and return to Kipster.')
      : page(
          400,
          'Not connected',
          'You can close this tab and return to Kipster.',
        )
  }

  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    const path = url.pathname,
      method = request.method
    if (path === '/plugins/callback' && method === 'GET') {
      if (!enabled)
        return page(
          503,
          'Plugins are unavailable',
          'Try again when Kipster is running.',
        )
      return callback(url)
    }
    if (path !== '/v1/plugins' && !path.startsWith('/v1/plugins/')) return
    if (!enabled)
      throw new WireError(
        503,
        'plugins-unavailable',
        'Kipster Plugins are not running',
      )
    const parts = path.split('/').slice(3).map(decodeURIComponent)
    if (!parts.length && method === 'GET')
      return json({
        version: 1,
        plugins: [...plugins]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(summary),
      })
    if (parts[0] === 'accounts') {
      if (parts.length === 1 && method === 'GET') {
        const filter = url.searchParams.get('plugin')
        if (filter !== null) plugin(filter)
        return json({
          version: 1,
          accounts: accounts
            .filter((a) => filter === null || a.plugin === filter)
            .map(accountView),
        })
      }
      if (parts.length === 2 && method === 'PATCH') {
        const row = await input(request)
        if (Object.keys(row).some((k) => !['version', 'label'].includes(k)))
          throw new Error('Invalid fields')
        const target = account(parts[1])
        const label = typeof row.label === 'string' ? row.label.trim() : ''
        if (label.length < 1 || label.length > 64)
          throw new WireError(
            400,
            'invalid-label',
            'A label has 1 to 64 characters',
          )
        if (
          accountsOf(target.plugin).some(
            (a) =>
              a.id !== target.id &&
              a.label.toLowerCase() === label.toLowerCase(),
          )
        )
          throw new WireError(400, 'invalid-label', 'Label is taken')
        Object.assign(target, { label, updatedAt: now() })
        return json({ version: 1, account: accountView(target) })
      }
      if (parts.length === 2 && method === 'DELETE') {
        const target = account(parts[1])
        accounts = accounts.filter((a) => a.id !== target.id)
        // The oldest remaining account becomes the default when the default leaves.
        if (defaults.get(target.plugin) === target.id)
          defaults.set(target.plugin, accountsOf(target.plugin)[0]?.id ?? null)
        return json({
          version: 1,
          removed: true,
          revoked: target.status === 'working',
        })
      }
    }
    if (parts[0] === 'sign-ins' && parts.length === 2 && method === 'GET') {
      const s = signIns.get(parts[1])
      if (!s) throw new WireError(404, 'unknown-sign-in', 'Unknown sign-in')
      return json(status(s))
    }
    if (parts.length === 1 && method === 'GET')
      return json({ version: 1, plugin: detail(plugin(parts[0])) })
    if (parts.length === 2 && parts[1] === 'sign-in' && method === 'POST')
      return startSignIn(plugin(parts[0]), request)
    if (parts.length === 2 && parts[1] === 'default-account') {
      const p = plugin(parts[0])
      if (method === 'PUT') {
        const row = await input(request)
        if (Object.keys(row).some((k) => !['version', 'account'].includes(k)))
          throw new Error('Invalid fields')
        if (row.account === null) defaults.set(p.id, null)
        else {
          const target = account(text(row.account))
          if (target.plugin !== p.id)
            throw new WireError(
              404,
              'unknown-account',
              'The account belongs to another plugin',
            )
          defaults.set(p.id, target.id)
        }
        return json({
          version: 1,
          plugin: p.id,
          defaultAccount: defaults.get(p.id) ?? null,
        })
      }
      if (method === 'DELETE') {
        defaults.set(p.id, null)
        return json({ version: 1, plugin: p.id, defaultAccount: null })
      }
    }
    throw new WireError(404, 'not-found', 'Route not found')
  }

  const inspect = () => ({
    enabled,
    defaults: Object.fromEntries(defaults),
    accounts: accounts.map(accountView),
    signIns: [...signIns.values()],
  })

  return {
    handle,
    enabled: () => enabled,
    /** Clock tick for the self-running demo: pending sign-ins complete after two ticks. */
    tick() {
      for (const s of signIns.values())
        if (s.status === 'pending' && ++s.ticks >= 2) complete(s)
    },
    inspect,
    /**
     * `{ enabled }` turns plugins on or off; `{ signIn, outcome, account? }` completes (optionally as an
     * existing account), denies, fails or expires a pending sign-in; `{ account, status }` marks an account.
     */
    control(row: Record<string, unknown>) {
      if (typeof row.enabled === 'boolean') enabled = row.enabled
      if (row.signIn !== undefined) {
        const s = signIns.get(text(row.signIn))
        if (!s) throw new WireError(404, 'not-found', 'Unknown sign-in')
        const outcome = text(row.outcome)
        if (outcome === 'complete') complete(s, optionalText(row.account))
        else if (outcome === 'deny') fail(s, 'denied')
        else if (outcome === 'expire') {
          s.expiresAt = new Date(Date.now() - 1000).toISOString()
          fail(s, 'expired')
        } else if (outcome === 'fail')
          fail(s, optionalText(row.code) ?? 'failed')
        else throw new Error('Invalid outcome')
      } else if (row.account !== undefined) {
        const target = account(text(row.account))
        if (row.status !== 'working' && row.status !== 'reconnect-needed')
          throw new Error('Invalid status')
        target.status = row.status
      }
      return inspect()
    },
    reset() {
      enabled = options.enabled
      plugins = catalogue()
      accounts = seededAccounts()
      defaults = new Map([['notion', 'acct-notion-work']])
      signIns.clear()
      serial = 1
    },
  }
}
