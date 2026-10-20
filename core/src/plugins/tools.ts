import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Postgres } from '../platform/postgres/public.js'
import { embeddingDocument, embeddingQuery } from '../embedding/index.js'
import { boundedEmbed, type EmbeddingProfile } from '../modules/vectors/public.js'
import { askInteraction } from '../modules/work/public.js'
import { approvalGrantKeys, permissionModeFor } from '../modules/settings/public.js'
import { applyPluginListings, bindPluginApproval, pluginToolByName, pluginToolsOf, pluginToolsToEmbed, savePluginToolEmbedding, searchPluginTools, takePluginApproval, type PluginListing, type PluginTool } from '../modules/plugins/public.js'
import type { PluginAccount } from '../protocol/plugins.js'
import { PluginControlClient } from './client.js'
import { callPluginTool, listPluginTools } from './mcp.js'
import type { PluginServerEndpoint } from './supervisor.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
/** A plugin with at least one account, as kips see it. */
export interface ConnectedPlugin { id: string; name: string; accounts: PluginAccount[] }
/** The run a plugin tool call belongs to. */
export interface PluginCaller { installationId: string; runId: string; threadId: string; attemptId: string; callId: string; outputDirectory: string; onRun(note: string): Promise<void> }

const searchLimit = 8
const refreshAfterMs = 24 * 60 * 60 * 1000
const maxResultText = 50000
const fileTypes: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' }

/** The tool's own name for people: its title, or its name without the plugin prefix. */
export function toolTitle(tool: Pick<PluginTool, 'name' | 'title' | 'pluginName'>): string {
  const title = tool.title ?? tool.name.slice(tool.name.indexOf('__') + 2).replaceAll('_', ' ')
  // Some services start their titles with their own name, which the plugin name already says.
  const prefix = `${tool.pluginName}:`
  return title.toLowerCase().startsWith(prefix.toLowerCase()) && title.length > prefix.length ? title.slice(prefix.length).trim() : title
}
/** JSON with sorted keys, so the same arguments always give the same text. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Json)[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null'

/**
 * The argument the plugin server adds to choose an account once a plugin has two: `account`, or `kipster_account` when
 * the tool declares its own `account`.
 */
const selectorOf = (schema: Json): string => Object.hasOwn(object(schema.properties), 'account') ? 'kipster_account' : 'account'

/** The listed schema without the plugin server's account argument, which kips pass as `account` of run_plugin_tool. */
function ownSchema(schema: Json, accountCount: number): Json {
  const properties = { ...object(schema.properties) }
  if (accountCount < 2) return schema
  const selector = Object.hasOwn(properties, 'kipster_account') ? 'kipster_account' : 'account'
  delete properties[selector]
  return { ...schema, properties, ...(Array.isArray(schema.required) ? { required: schema.required.filter(item => item !== selector) } : {}) }
}

/** Problems with arguments against a tool's schema: missing required fields, unknown fields and wrong basic types. */
function argumentProblems(schema: Json, args: Json): string[] {
  const properties = object(schema.properties)
  const problems: string[] = []
  for (const name of Array.isArray(schema.required) ? schema.required : []) if (typeof name === 'string' && !Object.hasOwn(args, name)) problems.push(`missing ${name}`)
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name]
    if (!property) { if (schema.additionalProperties === false) problems.push(`unknown ${name}`); continue }
    const types = [object(property).type].flat().filter(type => typeof type === 'string')
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value
    if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) problems.push(`${name} must be ${types.join(' or ')}`)
  }
  return problems
}

/**
 * Plugin tools for kips: Core's copy of every connected plugin's tools, kept in sync with the plugin server, found by
 * meaning and keywords, and run through the plugin server after the person approves.
 */
export class PluginToolService {
  readonly #control: PluginControlClient
  #syncing: Promise<void> | undefined
  #syncedKey: string | undefined
  #syncedAt = 0

  constructor(private readonly db: Postgres, private readonly installationId: string, private readonly server: PluginServerEndpoint, private readonly embedding?: EmbeddingProfile, private readonly log: (message: string) => void = message => console.log(message)) {
    this.#control = new PluginControlClient(server, 10000)
  }

  /**
   * Connected plugins with their accounts, or undefined while the plugin server is not ready. Starts a sync when the
   * accounts changed since the last one or it is a day old.
   */
  async connected(): Promise<ConnectedPlugin[] | undefined> {
    if (!this.server.endpoint()) return undefined
    let accounts: PluginAccount[]
    try { accounts = (await this.#control.listAccounts()).accounts } catch { return undefined }
    const key = JSON.stringify(accounts.map(account => [account.plugin, account.id, account.status]).sort())
    if (key !== this.#syncedKey || Date.now() - this.#syncedAt > refreshAfterMs) void this.sync().catch(error => this.log(`Plugin tools sync failed: ${error instanceof Error ? error.message : String(error)}`))
    const names = await this.#names(accounts.map(account => account.plugin))
    const plugins = new Map<string, ConnectedPlugin>()
    for (const account of accounts) {
      const plugin = plugins.get(account.plugin) ?? { id: account.plugin, name: names.get(account.plugin) ?? account.plugin, accounts: [] }
      plugin.accounts.push(account)
      plugins.set(account.plugin, plugin)
    }
    return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Plugin names: stored with their tools, or from the plugin server for a plugin with none stored yet. */
  async #names(pluginIds: readonly string[]): Promise<Map<string, string>> {
    const names = new Map((await this.db.query<{ plugin_id: string; plugin_name: string }>('SELECT DISTINCT plugin_id, plugin_name FROM kipster.plugin_tools WHERE installation_id=$1', [this.installationId])).rows.map(row => [row.plugin_id, row.plugin_name]))
    if (pluginIds.some(id => !names.has(id))) {
      try { for (const plugin of (await this.#control.listPlugins()).plugins) if (!names.has(plugin.id)) names.set(plugin.id, plugin.name) } catch { /* The ID stands in for the name. */ }
    }
    return names
  }

  /** Lists every connected plugin's tools and embeds the new and changed ones. Concurrent callers share one sync. */
  sync(): Promise<void> {
    this.#syncing ??= this.#sync().finally(() => { this.#syncing = undefined })
    return this.#syncing
  }

  async #sync(): Promise<void> {
    const endpoint = this.server.endpoint()
    if (!endpoint) return
    const accounts = (await this.#control.listAccounts()).accounts
    const counts = new Map<string, number>()
    for (const account of accounts) counts.set(account.plugin, (counts.get(account.plugin) ?? 0) + 1)
    const names = new Map((await this.#control.listPlugins()).plugins.map(plugin => [plugin.id, plugin.name]))
    const listings = new Map<string, PluginListing>()
    for (const listed of await listPluginTools(endpoint)) {
      const count = counts.get(listed.plugin)
      if (!count) continue
      const listing = listings.get(listed.plugin) ?? { pluginId: listed.plugin, pluginName: names.get(listed.plugin) ?? listed.plugin, tools: [] }
      const inputSchema = ownSchema(listed.inputSchema, count)
      const content = { name: listed.name, title: listed.title ?? null, description: listed.description, inputSchema }
      listing.tools.push({ ...content, hash: createHash('sha256').update(canonical(content)).digest('hex') })
      listings.set(listed.plugin, listing)
    }
    await applyPluginListings(this.db, this.installationId, [...counts.keys()], [...listings.values()])
    this.#syncedKey = JSON.stringify(accounts.map(account => [account.plugin, account.id, account.status]).sort())
    this.#syncedAt = Date.now()
    await this.#embed()
  }

  async #embed(): Promise<void> {
    if (!this.embedding) return
    const { profile, embedder } = this.embedding.embeddingConfig()
    for (const tool of await pluginToolsToEmbed(this.db, this.installationId, profile.model)) {
      const properties = Object.entries(object(tool.inputSchema.properties)).map(([name, value]) => `${name}${typeof object(value).description === 'string' ? `: ${object(value).description}` : ''}`)
      const text = [tool.description, ...properties].filter(Boolean).join('\n')
      try {
        const vector = await boundedEmbed(embedder, embeddingDocument(text, `${tool.pluginName}: ${toolTitle(tool)}`), 10000)
        await savePluginToolEmbedding(this.db, this.installationId, tool.name, tool.hash, profile.model, vector)
      } catch (error) {
        // Keyword search still finds tools; the next sync tries again.
        this.log(`Plugin tool embedding stopped: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
  }

  /** `search_plugin_tools`: tools for a request, or every tool of one plugin. */
  async search(args: Json): Promise<unknown> {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const pluginId = typeof args.plugin === 'string' ? args.plugin.trim() : ''
    if (!query && !pluginId) return { error: 'Give a query, a plugin, or both.' }
    const plugins = await this.connected()
    if (!plugins) return { error: 'Plugins are not running right now. Try again shortly.' }
    if (!plugins.length) return { plugins: [], message: 'No plugins are connected. The person can connect services in Plugins.' }
    // A first search waits for the first sync, so tools of a plugin just connected are found.
    await (this.#syncing ?? (this.#syncedKey ? undefined : this.sync().catch(() => undefined)))
    const describe = (plugin: ConnectedPlugin, tools: Json[]) => ({
      plugin: plugin.id, name: plugin.name,
      accounts: plugin.accounts.map(account => ({ id: account.id, label: account.label, default: account.isDefault || plugin.accounts.length === 1, status: account.status === 'working' ? 'connected' : 'needs reconnecting' })),
      tools,
    })
    const plugin = pluginId ? plugins.find(item => item.id === pluginId || item.name.toLowerCase() === pluginId.toLowerCase()) : undefined
    if (pluginId && !plugin) return { error: `No connected plugin ${JSON.stringify(pluginId)}. Connected: ${plugins.map(item => item.name).join(', ')}.` }
    if (plugin && !query) {
      const tools = await pluginToolsOf(this.db, this.installationId, plugin.id)
      return { ...describe(plugin, tools.map(tool => ({ name: tool.name, title: toolTitle(tool), description: tool.description }))), note: 'Search with a tool\'s exact name to get its arguments.' }
    }
    let embedding: { model: string; vector: readonly number[] } | undefined
    if (this.embedding) {
      const { profile, embedder } = this.embedding.embeddingConfig()
      try { embedding = { model: profile.model, vector: await boundedEmbed(embedder, embeddingQuery(query), 3000) } } catch { /* Keywords still match. */ }
    }
    const found = await searchPluginTools(this.db, this.installationId, { query, ...(embedding ? { embedding } : {}), ...(plugin ? { pluginId: plugin.id } : {}), limit: searchLimit })
    if (!found.length) return { plugins: [], message: `No connected plugin tool matched. Connected: ${plugins.map(item => item.name).join(', ')}. List one plugin's tools with \`plugin\`, or tell the person they can connect another service in Plugins.` }
    const grouped = new Map<string, Json[]>()
    for (const tool of found) grouped.set(tool.pluginId, [...grouped.get(tool.pluginId) ?? [], { name: tool.name, title: toolTitle(tool), description: tool.description, inputSchema: tool.inputSchema }])
    return { plugins: [...grouped].map(([id, tools]) => describe(plugins.find(item => item.id === id) ?? { id, name: found.find(tool => tool.pluginId === id)!.pluginName, accounts: [] }, tools)) }
  }

  /** `run_plugin_tool`: runs one call once the person allows it, or raises the approval card. */
  async run(caller: PluginCaller, args: Json): Promise<unknown> {
    const name = typeof args.tool === 'string' ? args.tool : ''
    const callArguments = args.arguments === undefined ? {} : args.arguments
    if (!name || !callArguments || typeof callArguments !== 'object' || Array.isArray(callArguments) || (args.account !== undefined && typeof args.account !== 'string')) return { error: 'Give tool, optional account, and arguments as an object.' }
    let tool = await pluginToolByName(this.db, this.installationId, name)
    if (!tool) {
      await this.sync().catch(() => undefined)
      tool = await pluginToolByName(this.db, this.installationId, name)
    }
    if (!tool) return { error: `No connected plugin tool is named ${name}. Find tools with search_plugin_tools.` }
    const problems = argumentProblems(tool.inputSchema, callArguments as Json)
    if (problems.length) return { error: `Invalid arguments for ${name}: ${problems.join('; ')}.`, inputSchema: tool.inputSchema }
    const plugins = await this.connected()
    if (!plugins) return { error: 'Plugins are not running right now. Try again shortly.' }
    const accounts = plugins.find(plugin => plugin.id === tool.pluginId)?.accounts ?? []
    if (!accounts.length) return { error: `No ${tool.pluginName} account is connected. Ask the person to connect one in Plugins.` }
    const requested = typeof args.account === 'string' ? args.account : undefined
    const account = requested ? accounts.find(item => item.id === requested || item.label === requested) : accounts.find(item => item.isDefault) ?? accounts.find(item => item.status === 'working') ?? accounts[0]
    if (!account) return { error: `${tool.pluginName} has no account ${JSON.stringify(requested)}. Use one of: ${accounts.map(item => `${item.id} (${item.label})`).join(', ')}.` }
    if (account.status !== 'working') return { error: `The ${tool.pluginName} account ${account.label} needs reconnecting. Ask the person to reconnect it in Plugins.` }

    const title = toolTitle(tool)
    const key = `plugin:${tool.name}`
    const callKey = createHash('sha256').update(canonical([tool.name, account.id, callArguments])).digest('hex')
    const allowed = await permissionModeFor(this.db, caller.installationId) === 'fullAccess'
      || (await approvalGrantKeys(this.db, caller.installationId, caller.threadId)).includes(key)
      || await takePluginApproval(this.db, caller.runId, callKey)
    if (!allowed) {
      const shown = JSON.stringify(callArguments, null, 2)
      try {
        const card = await askInteraction(this.db, caller.attemptId, caller.callId, {
          kind: 'approval', prompt: `Use ${title} from ${tool.pluginName} with ${account.label}?`, proposalId: randomUUID(),
          proposal: `${tool.pluginName}: ${title}\nAccount: ${account.label}\n${shown.length > 7000 ? `${shown.slice(0, 7000)}…` : shown}`,
          grant: { key, label: `${tool.pluginName}: ${title}`, scopes: ['conversation', 'always'] },
        }, (client, interactionId) => bindPluginApproval(client, interactionId, caller.runId, callKey))
        return { status: 'pending', interactionId: card.id, message: 'The person now sees an approval card for this call. End your turn; Kipster continues this task when they answer. Once approved, call run_plugin_tool again with the same tool, account and arguments.' }
      } catch (error) {
        return { error: error instanceof Error && error.message === 'An interaction is already pending' ? 'Another approval is already waiting. End your turn and continue after the person answers.' : `The approval could not be requested: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    const endpoint = this.server.endpoint()
    if (!endpoint) return { error: 'Plugins are not running right now. Try again shortly.' }
    await caller.onRun(`${tool.pluginName}: ${title}`)
    let result: Json
    try { result = await callPluginTool(endpoint, tool.name, { ...callArguments as Json, [selectorOf(tool.inputSchema)]: account.label }) }
    catch (error) { return { error: `${tool.pluginName} could not run ${title}: ${error instanceof Error ? error.message : String(error)}` } }
    return this.#result(caller, tool, result)
  }

  /** The call's result for the model: its text, files saved under the attempt's output directory, structured content. */
  async #result(caller: PluginCaller, tool: PluginTool, result: Json): Promise<unknown> {
    const texts: string[] = [], files: string[] = [], links: Json[] = []
    const save = async (data: string, mimeType: string) => {
      await mkdir(caller.outputDirectory, { recursive: true })
      const path = join(caller.outputDirectory, `${tool.pluginId}-${randomUUID().slice(0, 8)}.${fileTypes[mimeType] ?? 'bin'}`)
      await writeFile(path, Buffer.from(data, 'base64'))
      files.push(path)
    }
    for (const raw of Array.isArray(result.content) ? result.content : []) {
      const item = object(raw)
      if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
      else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') await save(item.data, String(item.mimeType ?? ''))
      else if (item.type === 'resource') {
        const resource = object(item.resource)
        if (typeof resource.text === 'string') texts.push(resource.text)
        else if (typeof resource.blob === 'string') await save(resource.blob, String(resource.mimeType ?? ''))
      } else if (item.type === 'resource_link') links.push({ uri: item.uri, ...(item.name ? { name: item.name } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}) })
    }
    let text = texts.join('\n\n')
    if (text.length > maxResultText) {
      await mkdir(caller.outputDirectory, { recursive: true })
      const path = join(caller.outputDirectory, `${tool.pluginId}-${randomUUID().slice(0, 8)}.txt`)
      await writeFile(path, text)
      text = `${text.slice(0, maxResultText)}\n[Truncated. The full result is in ${path}.]`
    }
    return {
      ...(result.isError ? { isError: true } : {}),
      ...(text ? { text } : {}),
      ...(result.structuredContent !== undefined && JSON.stringify(result.structuredContent).length <= maxResultText ? { structuredContent: result.structuredContent } : {}),
      ...(files.length ? { files, note: 'Files are saved at these paths. Send them to the person by attaching them to message_user.' } : {}),
      ...(links.length ? { links } : {}),
    }
  }
}

/** The instructions' plugins section: connected services and how to reach their tools. */
export function pluginGuidance(plugins: readonly ConnectedPlugin[]): string {
  if (!plugins.length) return 'Plugins: no services are connected. If the person asks for one, tell them they can connect it in Plugins.'
  const names = plugins.map(plugin => plugin.accounts.some(account => account.status === 'working') ? plugin.name : `${plugin.name} (needs reconnecting)`)
  return `Plugins: the person connected ${names.join(', ')}. Each service has many tools. Find them with search_plugin_tools, then run one with run_plugin_tool. Search before you say you cannot do something. If no connected service fits, tell the person they can connect one in Plugins.`
}
