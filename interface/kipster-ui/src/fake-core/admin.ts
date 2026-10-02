/** In-memory implementation of Core's owner administration protocol. */
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const DEMO_IDS = {
  installation: id(1),
  caller: id(2),
  organization: id(10),
  studio: id(11),
  personal: id(12),
  rootAgent: id(20),
  researcher: id(21),
  designer: id(22),
  engineer: id(23),
  archived: id(24),
}
const createdAt = '2026-09-20T09:00:00.000Z'
type Organization = {
  id: string
  name: string
  description: string
  lifecycle: string
  revision: number
  createdAt: string
}
type Agent = Organization & { admin: boolean; deletedAt: string | null }
type Membership = {
  id: string
  organizationId: string
  agentId: string
  revision: number
  createdAt: string
}
type Group = {
  id: string
  organizationId: string
  name: string
  position: number
  revision: number
  appearances: { membershipId: string; agentId: string }[]
}
type Settings = Record<string, unknown>
type SettingsRecord = {
  target: string
  id: string
  revision: number
  settings: Settings
}
type Options = {
  emit?: (
    type: string,
    data: unknown,
    resourceId: string,
    revision: number,
  ) => void
  cursor?: () => string
  onLifecycle?: (
    kind: 'agent' | 'organization',
    id: string,
    action: 'archive' | 'restore' | 'delete',
    options?: { copyFilesToOrganizations?: boolean },
  ) => void
}
type Body = Record<string, unknown>
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
class Fault extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
const invalid = (message = 'Invalid request') => {
  throw new Fault(400, 'invalid', message)
}
const missing = (kind: string): never => {
  throw new Fault(404, 'not-found', `${kind} not found`)
}
const conflict = (message: string): never => {
  throw new Fault(409, 'conflict', message)
}
const text = (value: unknown, max = 200, blank = false): string =>
  typeof value === 'string' && value.length <= max && (blank || !!value.trim())
    ? value
    : invalid()
const list = (value: unknown): string[] =>
  Array.isArray(value) && value.every((x) => typeof x === 'string' && x.length)
    ? value
    : invalid()
const object = (value: unknown): Body =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Body)
    : invalid()
const contentText = (value: unknown) => {
  const valueText = text(value, 65536, true)
  if (new TextEncoder().encode(valueText).length > 65536)
    invalid('Invalid content size')
  return valueText
}
const keys = (body: Body, allowed: string[]) => {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid()
}
const digest = async (content: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  )

export function createAdministration(options: Options = {}) {
  let serial = 100,
    localCursor = 0
  const next = () => id(serial++)
  const emit = (
    type: string,
    data: unknown,
    resourceId: string,
    revision: number,
  ) => {
    localCursor++
    options.emit?.(type, structuredClone(data), resourceId, revision)
  }
  const cursor = () => options.cursor?.() ?? String(localCursor)
  const organizations: Organization[] = [
    'Kipster',
    'Design studio',
    'Personal',
  ].map((name, i) => ({
    id: id(10 + i),
    name,
    description: [
      'Shared research and delivery',
      'Thoughtful digital products',
      'Ideas and everyday projects',
    ][i],
    lifecycle: 'active',
    revision: 1,
    createdAt,
  }))
  const agents: Agent[] = ['Kip', 'Atlas', 'Mira', 'Rowan', 'Echo'].map(
    (name, i) => ({
      id: id(20 + i),
      name,
      description: [
        'Installation administration',
        'Research and synthesis',
        'Design and storytelling',
        'Engineering and delivery',
        'Archived assistant',
      ][i],
      lifecycle: i === 4 ? 'archived' : 'active',
      revision: 1,
      createdAt,
      admin: i === 0,
      deletedAt: null,
    }),
  )
  const memberships: Membership[] = [
    [10, 21],
    [10, 22],
    [10, 23],
    [10, 24],
    [11, 21],
    [11, 22],
    [12, 23],
  ].map(([org, agent], i) => ({
    id: id(30 + i),
    organizationId: id(org),
    agentId: id(agent),
    revision: 1,
    createdAt,
  }))
  const groups: Group[] = [
    [10, 'Research', [30, 31]],
    [10, 'Delivery', [30, 32]],
    [11, 'Studio', [34, 35]],
    [12, 'Projects', [36]],
  ].map(([org, name, members], i) => ({
    id: id(40 + i),
    organizationId: id(org as number),
    name: name as string,
    position: i === 1 ? 1 : 0,
    revision: 1,
    appearances: (members as number[]).map((n) => ({
      membershipId: id(n),
      agentId: memberships.find((m) => m.id === id(n))!.agentId,
    })),
  }))
  const defaults = {
    adapterId: 'demo',
    modelId: 'demo-model',
    effort: 'medium',
    options: {},
  }
  const settings: SettingsRecord[] = [
    ...organizations.map((o) => ({
      target: 'organization',
      id: o.id,
      revision: 1,
      settings: structuredClone(defaults) as Settings,
    })),
    ...agents.map((a) => ({
      target: 'agent',
      id: a.id,
      revision: 1,
      settings: a.admin ? (structuredClone(defaults) as Settings) : {},
    })),
  ]
  const instructions = new Map(
    organizations.map((o) => [
      o.id,
      `# ${o.name}\n\nWork carefully, explain decisions, and preserve useful context.\n`,
    ]),
  )
  const learning = {
    enabled: true,
    sleepTime: '02:00',
    revision: 1,
    available: true,
  }
  const interfaceChoices = {
    revision: 0,
    palette: null as string | null,
    theme: null as string | null,
    desktopNotifications: null as boolean | null,
  }
  const agentLearning = agents.map((a) => ({
    agentId: a.id,
    enabled: true,
    sleepTime: null as string | null,
    revision: 1,
    effective: true,
  }))
  const identities = new Map<
    string,
    {
      content: string
      backups: {
        id: string
        content: string
        sha256: string
        size: number
        createdAt: string
      }[]
    }
  >()
  const operations = new Map<
    string,
    {
      signature: string
      receipt: Body
      kind: string
      target: { kind: string; id: string }
      state: string
      polls: number
      finish?: () => void
    }
  >()
  const findOrg = (value: string) =>
    organizations.find((o) => o.id === value && o.lifecycle === 'active') ??
    missing('Organization')
  const findAgent = (value: string) =>
    agents.find(
      (a) => a.id === value && ['active', 'archived'].includes(a.lifecycle),
    ) ?? missing('Agent')
  const findGroup = (value: string) => {
    const g = groups.find((g) => g.id === value) ?? missing('Group')
    findOrg(g.organizationId)
    return g
  }
  const changed = (kind: string, resource: { id: string; revision: number }) =>
    emit(`${kind}-changed`, resource, resource.id, resource.revision)
  const touch = (kind: string, resource: { id: string; revision: number }) => {
    resource.revision++
    changed(kind, resource)
  }
  const patch = (target: string, targetId: string, value: unknown) => {
    const input = object(value)
    const record =
      settings.find((s) => s.target === target && s.id === targetId) ??
      missing('Settings')
    const updates = structuredClone(record.settings)
    for (const [key, raw] of Object.entries(input)) {
      if (!['adapterId', 'modelId', 'effort', 'options'].includes(key))
        invalid()
      const op = object(raw)
      if (Object.keys(op).length !== 1) invalid()
      if (op.clear === true) {
        delete updates[key]
      } else if ('set' in op)
        updates[key] = key === 'options' ? object(op.set) : text(op.set, 10000)
      else invalid()
    }
    if (!Object.keys(input).length) return record
    record.settings = updates
    record.revision++
    emit('settings-changed', record, targetId, record.revision)
    return record
  }
  const removeMembership = (m: Membership) => {
    const removed = {
      id: m.id,
      organizationId: m.organizationId,
      agentId: m.agentId,
    }
    memberships.splice(memberships.indexOf(m), 1)
    emit('membership-removed', removed, m.id, m.revision + 1)
    groups.forEach((g) => {
      if (g.appearances.some((a) => a.membershipId === m.id)) {
        g.appearances = g.appearances.filter((a) => a.membershipId !== m.id)
        touch('group', g)
      }
    })
    return removed
  }
  const same = (ids: string[], current: string[]) => {
    if (new Set(ids).size !== ids.length) invalid()
    if (ids.length !== current.length || ids.some((i) => !current.includes(i)))
      conflict('Order no longer matches current items')
  }
  const directory = () =>
    structuredClone({
      version: 1,
      cursor: cursor(),
      organizations: organizations.filter((o) => o.lifecycle !== 'deleted'),
      agents,
      memberships: memberships.filter((m) =>
        organizations.some(
          (o) => o.id === m.organizationId && o.lifecycle === 'active',
        ),
      ),
      groups: groups
        .filter((g) =>
          organizations.some(
            (o) => o.id === g.organizationId && o.lifecycle === 'active',
          ),
        )
        .sort((a, b) => a.position - b.position),
    })
  const bootstrap = () => ({
    version: 1,
    installationId: DEMO_IDS.installation,
    callerId: DEMO_IDS.caller,
    organizationId: DEMO_IDS.organization,
    rootAgentId: DEMO_IDS.rootAgent,
    capabilities: { voiceRecording: true, interfacePreferences: true },
  })
  const adapters = () => ({
    version: 1,
    cursor: cursor(),
    revision: 1,
    adapters: [
      {
        id: 'demo',
        version: '1.0.0',
        available: true,
        reason: null,
        models: [{ id: 'demo-model', efforts: ['low', 'medium', 'high'] }],
        defaultModel: { id: 'demo-model', effort: 'medium' },
        supportedOptions: [],
        capabilities: {
          text: true,
          publication: true,
          cancellation: true,
          steering: false,
          nativeResume: false,
          maintenance: true,
        },
      },
    ],
  })
  async function route(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method
    if (method === 'GET' && path === '/v1/bootstrap') return json(bootstrap())
    if (method === 'GET' && path === '/v1/directory') return json(directory())
    if (method === 'GET' && path === '/v1/settings')
      return json({
        version: 1,
        cursor: cursor(),
        agents: settings.filter(
          (s) =>
            s.target === 'agent' &&
            agents.some(
              (a) =>
                a.id === s.id && ['active', 'archived'].includes(a.lifecycle),
            ),
        ),
        organizations: settings.filter(
          (s) =>
            s.target === 'organization' &&
            organizations.some(
              (o) => o.id === s.id && o.lifecycle === 'active',
            ),
        ),
      })
    if (path === '/v1/execution-adapters' && method === 'GET')
      return json(adapters())
    if (path === '/v1/settings/interface' && method === 'GET')
      return json({ version: 1, ...interfaceChoices })
    if (path === '/v1/settings/interface' && method === 'PUT') {
      const body = object(await request.json())
      if (body.version !== 1) invalid()
      keys(body, ['version', 'palette', 'theme', 'desktopNotifications'])
      const palettes = ['glacier', 'alpenglow', 'pine', 'graphite', 'obsidian']
      if (
        body.palette !== undefined &&
        !palettes.includes(body.palette as string)
      )
        invalid()
      if (
        body.theme !== undefined &&
        !['light', 'dark', 'system'].includes(body.theme as string)
      )
        invalid()
      if (
        body.desktopNotifications !== undefined &&
        typeof body.desktopNotifications !== 'boolean'
      )
        invalid()
      if (
        body.palette === undefined &&
        body.theme === undefined &&
        body.desktopNotifications === undefined
      )
        invalid('Invalid interface preferences: no change given')
      const next = {
        palette:
          (body.palette as string | undefined) ?? interfaceChoices.palette,
        theme: (body.theme as string | undefined) ?? interfaceChoices.theme,
        desktopNotifications:
          (body.desktopNotifications as boolean | undefined) ??
          interfaceChoices.desktopNotifications,
      }
      if (
        next.palette !== interfaceChoices.palette ||
        next.theme !== interfaceChoices.theme ||
        next.desktopNotifications !== interfaceChoices.desktopNotifications
      ) {
        Object.assign(interfaceChoices, next, {
          revision: interfaceChoices.revision + 1,
        })
        emit(
          'interface-changed',
          { ...interfaceChoices },
          DEMO_IDS.installation,
          interfaceChoices.revision,
        )
      }
      return json({ version: 1, ...interfaceChoices })
    }
    const resource = '[0-9a-f-]{36}'
    const routes: [string, string][] = [
      ['GET', '/v1/operations/[^/]{1,600}'],
      ['GET', `/v1/agents/${resource}/effective-settings`],
      ['GET|PUT', `/v1/organizations/${resource}/instructions`],
      ['GET|PUT', '/v1/settings/learning'],
      ['PUT', `/v1/agents/${resource}/learning`],
      [
        'GET|PUT',
        `/v1/agents/${resource}/identity/(AGENTS\\.md|soul\\.md|identity\\.md)`,
      ],
      [
        'GET',
        `/v1/agents/${resource}/identity/(AGENTS\\.md|soul\\.md|identity\\.md)/backups(?:/[^/]+)?`,
      ],
      [
        'POST',
        `/v1/agents/${resource}/identity/(AGENTS\\.md|soul\\.md|identity\\.md)/backups/[^/]+/restore`,
      ],
      ['POST', '/v1/execution-adapters/refresh'],
      ['POST', '/v1/(organizations|agents)'],
      ['PUT|DELETE', `/v1/(organizations|agents)/${resource}`],
      ['PUT', `/v1/(organizations|agents)/${resource}/settings`],
      ['POST', `/v1/agents/${resource}/(archive|restore)`],
      ['POST', `/v1/organizations/${resource}/(memberships|groups)`],
      ['PUT', `/v1/organizations/${resource}/groups/order`],
      ['DELETE', `/v1/memberships/${resource}`],
      ['PUT|DELETE', `/v1/groups/${resource}`],
      ['POST', `/v1/groups/${resource}/appearances`],
      ['PUT', `/v1/groups/${resource}/appearances/order`],
      ['DELETE', `/v1/groups/${resource}/appearances/${resource}`],
    ]
    if (
      !routes.some(
        ([methods, pattern]) =>
          methods.split('|').includes(method) &&
          new RegExp(`^${pattern}$`).test(path),
      )
    )
      return undefined
    const segments = path.split('/').filter(Boolean)
    const [, family, targetId, action, childId, last] = segments
    if (family === 'operations' && method === 'GET') {
      const operationId = text(decodeURIComponent(targetId)),
        op = operations.get(operationId) ?? missing('Operation')
      if (op.finish && op.state !== 'waiting' && ++op.polls >= 2) {
        op.finish()
        op.finish = undefined
        op.state = 'succeeded'
      }
      return json({
        version: 1,
        operationId,
        kind: op.kind,
        target: op.target,
        state: op.state,
        step: op.finish ? 'cleanup' : null,
        waitingFor:
          op.state === 'waiting'
            ? `Waiting for the ${op.kind.startsWith('agent.') ? "agent's" : "organization's"} work to end: 1 runs and 0 memory tasks`
            : null,
        result: op.receipt,
        error: null,
        createdAt,
        updatedAt: createdAt,
      })
    }
    if (
      family === 'agents' &&
      action === 'effective-settings' &&
      method === 'GET'
    ) {
      const agent = findAgent(targetId),
        organizationId = url.searchParams.get('organizationId')
      if (organizationId === '') invalid('Invalid organization ID')
      if (organizationId) findOrg(organizationId)
      else if (!agent.admin) invalid('Organization required for ordinary agent')
      const base =
          settings.find(
            (s) => s.target === 'organization' && s.id === organizationId,
          )?.settings ?? {},
        own = settings.find(
          (s) => s.target === 'agent' && s.id === targetId,
        )!.settings
      const resolved: Settings = { ...base, ...own },
        sources: Record<string, string> = Object.fromEntries(
          Object.keys(resolved).map((k) => [
            k,
            k in own ? 'agent' : 'organization',
          ]),
        )
      // Unset fields come from the default adapter and its default model.
      if (!resolved.adapterId) {
        resolved.adapterId = 'demo'
        sources.adapterId = 'default'
      }
      if (!resolved.modelId && resolved.adapterId === 'demo') {
        resolved.modelId = 'demo-model'
        sources.modelId = 'default'
        if (!resolved.effort) {
          resolved.effort = 'medium'
          sources.effort = 'default'
        }
      }
      const reason =
        !resolved.adapterId || !resolved.modelId
          ? 'Adapter and model must be configured'
          : resolved.adapterId !== 'demo'
            ? 'Adapter is unavailable'
            : resolved.modelId !== 'demo-model'
              ? 'Model is unavailable for adapter'
              : resolved.effort &&
                  !['low', 'medium', 'high'].includes(String(resolved.effort))
                ? 'Effort is unsupported for model'
                : null
      return json({
        version: 1,
        agentId: targetId,
        organizationId,
        status: reason
          ? !resolved.adapterId || !resolved.modelId
            ? 'missing'
            : 'incompatible'
          : 'ready',
        reason,
        settings: resolved,
        sources,
      })
    }
    if (
      family === 'organizations' &&
      action === 'instructions' &&
      method === 'GET'
    ) {
      findOrg(targetId)
      return json({
        version: 1,
        organizationId: targetId,
        content: instructions.get(targetId) ?? '',
      })
    }
    if (path === '/v1/settings/learning' && method === 'GET')
      return json({
        version: 1,
        ...learning,
        agents: agentLearning
          .filter((l) =>
            agents.some(
              (a) =>
                a.id === l.agentId &&
                ['active', 'archived'].includes(a.lifecycle),
            ),
          )
          .map((l) => ({
            ...l,
            effective:
              learning.enabled &&
              l.enabled &&
              agents.some(
                (a) => a.id === l.agentId && a.lifecycle === 'active',
              ),
          })),
      })
    if (family === 'agents' && action === 'identity') {
      const agent = findAgent(targetId)
      if (!['AGENTS.md', 'soul.md', 'identity.md'].includes(childId))
        return undefined
      const key = `${targetId}/${childId}`
      let entry = identities.get(key)
      if (!entry) {
        entry = {
          content: `# ${agent.name}\n\n${agent.description}.\n`,
          backups: [],
        }
        identities.set(key, entry)
      }
      const backupId = segments[6],
        restore = segments[7] === 'restore'
      const read = async (content: string) =>
        json({
          version: 1,
          agentId: targetId,
          file: childId,
          content,
          sha256: await digest(content),
        })
      if (method === 'GET') {
        if (!last) return read(entry.content)
        if (last === 'backups') {
          if (!backupId)
            return json({
              version: 1,
              agentId: targetId,
              file: childId,
              backups: entry.backups.map(({ id, sha256, size, createdAt }) => ({
                id,
                sha256,
                size,
                createdAt,
              })),
            })
          return read(
            (
              entry.backups.find((b) => b.id === backupId) ??
              missing('Identity backup')
            ).content,
          )
        }
      }
      if ((method === 'PUT' && !last) || (method === 'POST' && restore)) {
        if (agent.lifecycle !== 'active') missing('Agent')
        const body = object(await request.json())
        if (body.version !== 1) invalid()
        keys(
          body,
          restore
            ? ['version', 'expectedSha256']
            : ['version', 'expectedSha256', 'content'],
        )
        const current = await digest(entry.content)
        if (text(body.expectedSha256, 1000) !== current)
          conflict('Identity file changed')
        const content = restore
          ? (
              entry.backups.find((b) => b.id === backupId) ??
              missing('Identity backup')
            ).content
          : contentText(body.content)
        if (content !== entry.content) {
          entry.backups.unshift({
            id: String(Number(entry.backups[0]?.id ?? 0) + 1),
            content: entry.content,
            sha256: current,
            size: new TextEncoder().encode(entry.content).length,
            createdAt: new Date().toISOString(),
          })
          entry.backups = entry.backups.slice(0, 5)
          entry.content = content
        }
        return read(content)
      }
      return undefined
    }
    const recognized =
      family === 'organizations' ||
      family === 'agents' ||
      family === 'groups' ||
      family === 'memberships' ||
      path === '/v1/settings/learning' ||
      path === '/v1/execution-adapters/refresh'
    if (!recognized || !['POST', 'PUT', 'DELETE'].includes(method))
      return undefined
    const body = object(await request.json())
    if (body.version !== 1) invalid()
    if (path === '/v1/execution-adapters/refresh' && method === 'POST') {
      keys(body, ['version'])
      return json(adapters())
    }
    if (
      family === 'organizations' &&
      action === 'instructions' &&
      method === 'PUT'
    ) {
      findOrg(targetId)
      keys(body, ['version', 'content'])
      const content = contentText(body.content)
      instructions.set(targetId, content)
      return json({ version: 1, organizationId: targetId, content })
    }
    if (
      path === '/v1/settings/learning' ||
      (family === 'agents' && action === 'learning')
    ) {
      if (method !== 'PUT') return undefined
      keys(body, ['version', 'enabled', 'sleepTime'])
      if (body.enabled === undefined && body.sleepTime === undefined)
        invalid('Invalid learning update')
      const target =
        family === 'agents'
          ? (findAgent(targetId),
            agentLearning.find((a) => a.agentId === targetId) ??
              missing('Agent learning'))
          : learning
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
        invalid()
      if (
        body.sleepTime !== undefined &&
        !(body.sleepTime === null && family === 'agents') &&
        !(
          typeof body.sleepTime === 'string' &&
          /^([01]\d|2[0-3]):[0-5]\d$/.test(body.sleepTime)
        )
      )
        invalid()
      const learningChanged =
        (body.enabled !== undefined && body.enabled !== target.enabled) ||
        (body.sleepTime !== undefined && body.sleepTime !== target.sleepTime)
      if (body.enabled !== undefined) target.enabled = body.enabled as boolean
      if (body.sleepTime !== undefined)
        target.sleepTime = body.sleepTime as string
      if (learningChanged) target.revision++
      if (learningChanged)
        emit(
          'learning-changed',
          {
            target: family === 'agents' ? 'agent' : 'installation',
            enabled: target.enabled,
            sleepTime: target.sleepTime,
          },
          family === 'agents' ? targetId : DEMO_IDS.installation,
          target.revision,
        )
      return family === 'agents'
        ? json({
            version: 1,
            ...target,
            effective: learning.enabled && target.enabled,
          })
        : json({
            version: 1,
            ...learning,
            agents: agentLearning.map((a) => ({
              ...a,
              effective:
                learning.enabled &&
                a.enabled &&
                agents.some(
                  (agent) =>
                    agent.id === a.agentId && agent.lifecycle === 'active',
                ),
            })),
          })
    }
    const allowed = ['version', 'operationId']
    if (action === 'settings') allowed.push('settings')
    else if (family === 'organizations' && action === 'memberships')
      allowed.push('agentId')
    else if (action === 'groups')
      allowed.push(childId === 'order' ? 'groupIds' : 'name')
    else if (family === 'groups' && action === 'appearances') {
      if (method === 'POST') allowed.push('membershipId')
      if (childId === 'order') allowed.push('membershipIds')
    } else if (!action && (method === 'POST' || method === 'PUT')) {
      allowed.push('name')
      if (family !== 'groups') allowed.push('description', 'settings')
      if (family === 'agents' && method === 'POST')
        allowed.push('organizationId')
    } else if (family === 'agents' && method === 'DELETE')
      allowed.push('copyFilesToOrganizations')
    keys(body, allowed)
    if (body.name !== undefined) text(body.name)
    if (body.description !== undefined) text(body.description, 2000, true)
    if (
      body.copyFilesToOrganizations !== undefined &&
      typeof body.copyFilesToOrganizations !== 'boolean'
    )
      invalid()
    if (body.settings !== undefined) {
      for (const [key, raw] of Object.entries(object(body.settings))) {
        if (!['adapterId', 'modelId', 'effort', 'options'].includes(key))
          invalid()
        const operation = object(raw)
        if (Object.keys(operation).length !== 1) invalid()
        if ('set' in operation) {
          if (key === 'options') object(operation.set)
          else text(operation.set, 10000)
        } else if (operation.clear !== true) invalid()
      }
    }
    const operationId = text(body.operationId),
      signature = canonical({ method, path, body }),
      previous = operations.get(operationId)
    if (previous) {
      if (previous.signature !== signature)
        conflict('Operation ID was already used for another request')
      return json({ ...previous.receipt, alreadyApplied: true })
    }
    let result: Body | undefined,
      kind = `${family?.replace(/s$/, '')}.${method.toLowerCase()}`,
      finish: (() => void) | undefined
    if (
      (family === 'organizations' || family === 'agents') &&
      !targetId &&
      method === 'POST'
    ) {
      const name = text(body.name),
        description =
          body.description === undefined
            ? ''
            : text(body.description, 2000, true),
        isAgent = family === 'agents'
      if (body.organizationId !== undefined) findOrg(text(body.organizationId))
      const resource = {
        id: next(),
        name,
        description,
        lifecycle: 'active',
        revision: 1,
        createdAt: new Date().toISOString(),
      }
      if (isAgent) {
        const agent = { ...resource, admin: false, deletedAt: null }
        agents.push(agent)
        agentLearning.push({
          agentId: agent.id,
          enabled: true,
          sleepTime: null,
          revision: 1,
          effective: learning.enabled,
        })
        changed('agent', agent)
        let membership: Membership | null = null
        if (body.organizationId) {
          membership = {
            id: next(),
            organizationId: String(body.organizationId),
            agentId: agent.id,
            revision: 1,
            createdAt: resource.createdAt,
          }
          memberships.push(membership)
          changed('membership', membership)
        }
        result = { agent, membership }
      } else {
        organizations.push(resource)
        changed('organization', resource)
        result = { organization: resource }
      }
      settings.push({
        target: isAgent ? 'agent' : 'organization',
        id: resource.id,
        revision: 0,
        settings: {},
      })
      if (body.settings)
        patch(isAgent ? 'agent' : 'organization', resource.id, body.settings)
      else {
        const record = settings.at(-1)!
        record.revision = 1
        emit('settings-changed', record, resource.id, record.revision)
      }
      kind = `${isAgent ? 'agent' : 'organization'}.create`
    } else if (
      (family === 'agents' || family === 'organizations') &&
      targetId &&
      (action === 'settings' ||
        !action ||
        ['archive', 'restore'].includes(action))
    ) {
      const isAgent = family === 'agents',
        resource = isAgent ? findAgent(targetId) : findOrg(targetId),
        resourceKind = isAgent ? 'agent' : 'organization'
      if (action === 'settings' && method === 'PUT') {
        if (resource.lifecycle !== 'active') missing(resourceKind)
        if (!Object.keys(object(body.settings)).length)
          invalid('Invalid empty update')
        result = { settings: patch(resourceKind, targetId, body.settings) }
        kind = `${resourceKind}.settings`
      } else if (method === 'PUT' && !action) {
        if (resource.lifecycle !== 'active') missing(resourceKind)
        if (
          body.name === undefined &&
          body.description === undefined &&
          (body.settings === undefined ||
            !Object.keys(object(body.settings)).length)
        )
          invalid('Invalid empty update')
        if (body.name !== undefined) resource.name = text(body.name)
        if (body.description !== undefined)
          resource.description = text(body.description, 2000, true)
        if (body.settings) patch(resourceKind, targetId, body.settings)
        if (body.name !== undefined || body.description !== undefined)
          touch(resourceKind, resource)
        result = { [resourceKind]: resource }
        kind = `${resourceKind}.update`
      } else if (
        method === 'POST' &&
        isAgent &&
        ['archive', 'restore'].includes(action)
      ) {
        if (action === 'archive' && (resource as Agent).admin)
          throw new Fault(403, 'forbidden', 'Archive of the admin agent denied')
        resource.lifecycle = action === 'archive' ? 'archived' : 'active'
        touch(resourceKind, resource)
        options.onLifecycle?.(
          resourceKind,
          targetId,
          action as 'archive' | 'restore',
        )
        result = { agent: resource }
        kind = `agent.${action}`
      } else if (method === 'DELETE' && !action) {
        if (
          isAgent &&
          (resource.lifecycle !== 'archived' || (resource as Agent).admin)
        )
          conflict('Agent must be archived before deletion')
        resource.lifecycle = 'deleting'
        touch(resourceKind, resource)
        options.onLifecycle?.(resourceKind, targetId, 'delete', {
          copyFilesToOrganizations: body.copyFilesToOrganizations === true,
        })
        result = { [resourceKind]: resource }
        kind = `${resourceKind}.delete`
        finish = () => {
          resource.lifecycle = 'deleted'
          resource.revision++
          if (isAgent) {
            ;(resource as Agent).deletedAt = new Date().toISOString()
            changed('agent', resource)
          } else
            emit(
              'organization-removed',
              { id: targetId },
              targetId,
              resource.revision,
            )
          memberships
            .filter((m) =>
              isAgent ? m.agentId === targetId : m.organizationId === targetId,
            )
            .forEach(removeMembership)
          if (!isAgent)
            groups
              .filter((g) => g.organizationId === targetId)
              .forEach((g) => {
                groups.splice(groups.indexOf(g), 1)
                emit(
                  'group-removed',
                  { id: g.id, organizationId: targetId },
                  g.id,
                  g.revision + 1,
                )
              })
        }
      }
    } else if (
      family === 'organizations' &&
      action === 'memberships' &&
      method === 'POST'
    ) {
      findOrg(targetId)
      const agent = findAgent(text(body.agentId))
      if (agent.lifecycle !== 'active') missing('Agent')
      let membership = memberships.find(
        (m) => m.organizationId === targetId && m.agentId === agent.id,
      )
      if (!membership) {
        membership = {
          id: next(),
          organizationId: targetId,
          agentId: agent.id,
          revision: 1,
          createdAt: new Date().toISOString(),
        }
        memberships.push(membership)
        changed('membership', membership)
      }
      result = { membership }
      kind = 'membership.add'
    } else if (family === 'memberships' && method === 'DELETE') {
      result = {
        removed: removeMembership(
          memberships.find((m) => m.id === targetId) ?? missing('Membership'),
        ),
      }
      kind = 'membership.remove'
    } else if (family === 'organizations' && action === 'groups') {
      findOrg(targetId)
      if (method === 'POST' && !childId) {
        const group = {
          id: next(),
          organizationId: targetId,
          name: text(body.name),
          position:
            Math.max(
              -1,
              ...groups
                .filter((g) => g.organizationId === targetId)
                .map((g) => g.position),
            ) + 1,
          revision: 1,
          appearances: [],
        }
        groups.push(group)
        changed('group', group)
        result = { group }
        kind = 'group.create'
      } else if (method === 'PUT' && childId === 'order') {
        const order = list(body.groupIds),
          current = groups.filter((g) => g.organizationId === targetId)
        same(
          order,
          current.map((g) => g.id),
        )
        order.forEach((gid, position) => {
          const g = findGroup(gid)
          if (g.position !== position) {
            g.position = position
            touch('group', g)
          }
        })
        result = { groups: current.sort((a, b) => a.position - b.position) }
        kind = 'group.reorder'
      }
    } else if (family === 'groups') {
      const group = findGroup(targetId)
      if (!action && method === 'PUT') {
        group.name = text(body.name)
        touch('group', group)
        result = { group }
        kind = 'group.rename'
      } else if (!action && method === 'DELETE') {
        groups.splice(groups.indexOf(group), 1)
        const removed = { id: group.id, organizationId: group.organizationId }
        emit('group-removed', removed, group.id, group.revision + 1)
        result = { removed }
        kind = 'group.delete'
      } else if (action === 'appearances') {
        if (method === 'POST' && !childId) {
          const member =
            memberships.find(
              (m) =>
                m.id === body.membershipId &&
                m.organizationId === group.organizationId,
            ) ?? missing('Membership')
          if (!group.appearances.some((a) => a.membershipId === member.id)) {
            group.appearances.push({
              membershipId: member.id,
              agentId: member.agentId,
            })
            touch('group', group)
          }
          kind = 'appearance.add'
        } else if (method === 'DELETE' && childId) {
          const before = group.appearances.length
          group.appearances = group.appearances.filter(
            (a) => a.membershipId !== childId,
          )
          if (before !== group.appearances.length) touch('group', group)
          kind = 'appearance.remove'
        } else if (method === 'PUT' && childId === 'order') {
          const order = list(body.membershipIds)
          same(
            order,
            group.appearances.map((a) => a.membershipId),
          )
          group.appearances = order.map((i) =>
            group.appearances.find((a) => a.membershipId === i)!,
          )
          touch('group', group)
          kind = 'appearance.reorder'
        } else return undefined
        result = { group }
      }
    }
    if (!result) return undefined
    const receipt = structuredClone({
      version: 1,
      operationId,
      alreadyApplied: false,
      ...result,
    })
    operations.set(operationId, {
      signature,
      receipt,
      kind,
      target: {
        kind: family?.replace(/s$/, '') ?? '',
        id:
          targetId ??
          String(
            (result.agent as Agent | undefined)?.id ??
              (result.organization as Organization | undefined)?.id ??
              '',
          ),
      },
      state: finish ? 'pending' : 'succeeded',
      polls: 0,
      ...(finish ? { finish } : {}),
    })
    return json(receipt)
  }
  let pending: Promise<unknown> = Promise.resolve()
  return {
    directory,
    bootstrap,
    setOperationWaiting(operationId: string, waiting: boolean) {
      const operation = operations.get(operationId) ?? missing('Operation')
      if (!operation.finish) conflict('Operation is already settled')
      operation.state = waiting ? 'waiting' : 'running'
    },
    async handle(request: Request) {
      const result = pending.then(() => route(request))
      pending = result.catch(() => undefined)
      try {
        return await result
      } catch (error) {
        if (error instanceof Fault)
          return json(
            {
              version: 1,
              code: error.code,
              message: error.message,
              requestId: crypto.randomUUID(),
            },
            error.status,
          )
        if (error instanceof SyntaxError || error instanceof TypeError)
          return json(
            {
              version: 1,
              code: 'invalid',
              message: 'Invalid request',
              requestId: crypto.randomUUID(),
            },
            400,
          )
        throw error
      }
    },
  }
}
