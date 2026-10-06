import { dirname, join, resolve } from 'node:path'

// Construct from an allowlist; provider keys, proxy settings, database overrides,
// npm configuration, NODE_OPTIONS and CLI homes must never be inherited.
export function isolatedEnvironment(home, path = dirname(process.execPath)) {
  return {
    PATH: path,
    HOME: home,
    CODEX_HOME: join(home, 'disabled-codex'),
    CLAUDE_CONFIG_DIR: join(home, 'disabled-claude'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    TMPDIR: '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
  }
}

export function replaceEnvironment(environment) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, environment)
}

export function instanceArguments(args) {
  if (args.length !== 3)
    throw Error('Expected UI port, Core port and factory database URL')
  const [ui, core, connectionString] = args
  const ports = [ui, core].map((value) => {
    if (!/^\d+$/.test(value)) throw Error('Expected allocated numeric ports')
    const port = Number(value)
    if (port < 1024 || port > 65535) throw Error('Invalid allocated port')
    return port
  })
  if (ports[0] === ports[1]) throw Error('Allocated ports must differ')
  const url = new URL(connectionString)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^\/verify_[a-zA-Z0-9_-]+$/.test(url.pathname)
  ) {
    throw Error('Refusing a database outside the factory verify_ namespace')
  }
  return { ports, connectionString }
}

export function connectedHTML(html) {
  if (!html.includes('<head>'))
    throw Error('Production index is missing its head')
  // Run before the production entry: never let discovery probe a fixed local port.
  return html.replace(
    '<head>',
    '<head><script>localStorage.setItem("kipster-backend-url",location.origin)</script>',
  )
}

export function checkoutHome(root, purpose) {
  return resolve(root, 'node_modules/.cache/kipster-factory', purpose)
}
