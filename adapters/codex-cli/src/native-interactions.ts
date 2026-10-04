import { createHash } from 'node:crypto'
import type { ExecutionContext } from '@kipster/core/adapter'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
/** Stable across request IDs and attempts, while retaining every substantive action field. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as ObjectValue)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export interface NativeInteraction {
  kind: 'question' | 'approval'
  arguments: ObjectValue
  saved?: ObjectValue
  /** Answered by a grant or by full access rather than by a card of this run. */
  granted?: boolean
  result(answer: ObjectValue): ObjectValue
}
type Scope = 'conversation' | 'always'
interface Grant { key: string; label: string; scopes: Scope[] }
const clip = (text: string, length: number): string => text.length > length ? `${text.slice(0, length - 1)}…` : text
const lines = (...values: unknown[]): string => values.filter(value => typeof value === 'string' && value.trim()).join('\n')
const commandText = (command: unknown): string => Array.isArray(command) ? command.map(String).join(' ') : String(command)
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
/** Codex stamps tool approvals with call, session and turn IDs that change on every attempt; the action does not. */
function stableMeta(meta: unknown): ObjectValue {
  return Object.fromEntries(Object.entries(object(meta)).filter(([key]) => !['callId', 'x-codex-turn-metadata'].includes(key)))
}
function changedPaths(changes: unknown): string[] {
  const paths = Array.isArray(changes) ? changes.map(change => String(object(change).path ?? '')) : Object.keys(object(changes))
  return [...new Set(paths.filter(Boolean))].sort()
}
function permissionLines(permissions: unknown): string[] {
  const profile = object(permissions), files = object(profile.fileSystem)
  const paths = (Array.isArray(files.entries) ? files.entries.map(entry => { const row = object(entry), path = object(row.path); return `${row.access === 'read' ? 'Read' : 'Write'} ${String(path.path ?? path.pattern ?? object(path.value).kind ?? '')}` }) : [])
    .concat((Array.isArray(files.write) ? files.write : []).map(path => `Write ${String(path)}`), (Array.isArray(files.read) ? files.read : []).map(path => `Read ${String(path)}`))
  return [...(object(profile.network).enabled ? ['Network access'] : []), ...paths]
}
/** A tool approval Codex lets the person remember offers the same reach here; Computer Use is granted per app. */
function toolGrant(params: ObjectValue): Grant | undefined {
  const meta = object(params._meta), persist = Array.isArray(meta.persist) ? meta.persist : []
  if (meta.codex_approval_kind !== 'mcp_tool_call' || typeof meta.tool_name !== 'string' || !persist.length) return undefined
  const scopes: Scope[] = persist.includes('always') ? ['conversation', 'always'] : ['conversation']
  const server = String(meta.connector_name ?? params.serverName), source = `codex-cli:mcp:${String(params.serverName)}:${String(meta.connector_id ?? '')}`
  const app = object(meta.tool_params).app
  if (typeof app === 'string' && app) {
    const shown = (Array.isArray(meta.tool_params_display) ? meta.tool_params_display.map(object) : []).find(row => row.name === 'app')?.value
    return { key: `${source}:app:${app}`, label: clip(`${server} in ${String(shown ?? app)}`, 200), scopes }
  }
  return { key: `${source}:tool:${meta.tool_name}`, label: clip(`${server}: ${String(meta.tool_title ?? meta.tool_name)}`, 200), scopes }
}

/** Translate provider interactions; Core remains responsible for saving and resolving them. */
export function nativeInteractions(context: ExecutionContext, method: string, params: ObjectValue): NativeInteraction[] {
  // Request IDs, timestamps and the model-written reason change on every retry; the action itself does not.
  const substantive = Object.fromEntries(Object.entries(params).filter(([key]) => !['threadId', 'turnId', 'itemId', 'callId', 'approvalId', 'startedAtMs', 'reason'].includes(key)).map(([key, value]) => [key, key === '_meta' ? stableMeta(value) : value]))
  /** `prompt` is a one-line question, then plain detail lines; the exact request stays in the proposal. */
  const approval = (prompt: string, grant: Grant | undefined, result: (accepted: boolean) => ObjectValue): NativeInteraction => {
    const proposal = canonical({ method, ...substantive })
    const proposalId = `codex:${createHash('sha256').update(proposal).digest('hex')}`
    const accept = { result: (answer: ObjectValue) => result(answer.kind === 'approve') }
    // Core bounds keys; a long command or file list is matched by its digest instead.
    if (grant && grant.key.length > 400) grant = { ...grant, key: `codex-cli:sha256:${createHash('sha256').update(grant.key).digest('hex')}` }
    if (context.permissionMode === 'fullAccess' || grant && context.approvalGrants?.includes(grant.key)) return { kind: 'approval', arguments: {}, saved: { kind: 'approve' }, granted: true, ...accept }
    const saved = context.interactions?.findLast(item => item.kind === 'approval' && item.proposalId === proposalId && item.proposal === proposal)
    return { kind: 'approval', arguments: { proposalId, proposal, prompt: clip(prompt, 8000), ...(grant ? { grant } : {}) }, ...(saved ? { saved: object(saved.response.answer) } : {}), ...accept }
  }
  const question = (prompt: string, options: { id: string; label: string }[], freeText: boolean, result: NativeInteraction['result']): NativeInteraction => {
    const saved = context.interactions?.findLast(item => item.kind === 'question' && item.prompt === prompt && canonical(item.options) === canonical(options) && item.freeText === freeText)
    return { kind: 'question', arguments: { prompt, options, freeText }, ...(saved ? { saved: object(saved.response.answer) } : {}), result }
  }
  const reason = typeof params.reason === 'string' ? params.reason : undefined
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    if (typeof params.command !== 'string' && !Array.isArray(params.command)) throw new Error('Codex approval omitted the command; cannot bind durable approval')
    const command = commandText(params.command)
    const prompt = lines(`Run \`${clip(command, 160)}\`?`, reason, command.length > 160 ? command : undefined, typeof params.cwd === 'string' ? `In ${params.cwd}` : undefined)
    return [approval(prompt, { key: `codex-cli:command:${command}`, label: clip(`Run ${command}`, 200), scopes: ['conversation', 'always'] }, accepted => ({ decision: method === 'execCommandApproval' ? accepted ? 'approved' : 'denied' : accepted ? 'accept' : 'decline' }))]
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    // A grant for one diff must never authorize a regenerated, different patch, so remembering covers the same files
    // in this conversation only.
    if (!params.changes || typeof params.changes !== 'object') throw new Error('Codex approval omitted file changes; cannot bind durable approval')
    const paths = changedPaths(params.changes)
    const named = paths.length === 1 ? base(paths[0]!) : `${paths.length} files`
    const grant: Grant | undefined = paths.length ? { key: `codex-cli:edit:${JSON.stringify(paths)}`, label: clip(`Edit ${paths.length === 1 ? paths[0] : paths.map(base).join(', ')}`, 200), scopes: ['conversation'] } : undefined
    return [approval(lines(`Edit ${named}?`, reason, ...paths.slice(0, 20)), grant, accepted => ({ decision: method === 'applyPatchApproval' ? accepted ? 'approved' : 'denied' : accepted ? 'accept' : 'decline' }))]
  }
  if (method === 'item/permissions/requestApproval') {
    const access = permissionLines(params.permissions)
    const grant: Grant = { key: `codex-cli:permissions:${canonical(params.permissions)}`, label: clip(`Extra access: ${access.join(', ') || 'requested permissions'}`, 200), scopes: ['conversation', 'always'] }
    return [approval(lines('Allow extra access?', reason, ...access), grant, accepted => ({ permissions: accepted ? object(params.permissions) : {}, scope: 'turn' }))]
  }
  if (method === 'item/tool/requestUserInput') {
    if (!Array.isArray(params.questions) || !params.questions.length) throw new Error('Codex question is empty')
    return params.questions.map(raw => {
      const row = object(raw)
      if (typeof row.id !== 'string' || typeof row.question !== 'string' || row.isSecret === true) throw new Error('Unsupported Codex question')
      const options = (Array.isArray(row.options) ? row.options : []).map((option, index) => ({ id: `option-${index + 1}`, label: String(object(option).label ?? '') }))
      if (options.length > 5 || options.some(option => !option.label)) throw new Error('Unsupported Codex choices')
      return question(`${row.question}\n[Codex question ${row.id}]`, options, true, answer => {
        const choice = options.find(option => option.id === answer.optionId)
        const value = answer.kind === 'text' ? String(answer.text ?? '') : answer.kind === 'choice' ? choice?.label : undefined
        return { answers: { [row.id as string]: { answers: value === undefined ? [] : [value] } } }
      })
    })
  }
  if (method === 'mcpServer/elicitation/request') {
    if (params.mode !== 'form') throw new Error('Codex requested an unsupported MCP elicitation mode')
    const schema = object(params.requestedSchema), properties = object(schema.properties)
    if (schema.type !== 'object') throw new Error('Codex requested an unsupported MCP form')
    if (Object.keys(properties).length === 0) {
      const meta = object(params._meta)
      const shown = (Array.isArray(meta.tool_params_display) ? meta.tool_params_display.map(object) : []).map(row => `${String(row.display_name ?? row.name)}: ${String(row.value)}`)
      const prompt = lines(String(params.message ?? `${String(params.serverName)} requests approval`), ...shown, meta.subtitle)
      return [approval(prompt, toolGrant(params), accepted => ({ action: accepted ? 'accept' : 'decline', content: accepted ? {} : null, _meta: null }))]
    }
    const fields = Object.entries(properties)
    if (fields.length > 8) throw new Error('Codex MCP form has too many fields')
    return fields.map(([key, raw]) => {
      const field = object(raw)
      if (!['string', 'boolean', 'number', 'integer'].includes(String(field.type)) || field.format === 'password') throw new Error('Unsupported Codex MCP form field')
      const values = field.type === 'boolean' ? [true, false] : Array.isArray(field.enum) ? field.enum : undefined
      if (values && values.length > 5) throw new Error('Too many Codex MCP choices')
      const options = values?.map((value, index) => ({ id: `option-${index + 1}`, label: String(value) })) ?? []
      const prompt = `${String(params.message ?? 'Codex tool requests input')}\n${String(field.description ?? field.title ?? key)}\n[MCP ${String(params.serverName)} field ${key}: ${canonical(field)}]`
      return question(prompt, options, !values, answer => {
        if (answer.kind === 'dismiss') return { action: 'decline', content: null, _meta: null }
        const index = options.findIndex(option => option.id === answer.optionId)
        let value: unknown = values ? values[index] : answer.text
        if (field.type === 'number' || field.type === 'integer') {
          if (typeof value !== 'string' && typeof value !== 'number' || String(value).trim() === '') throw new Error('Invalid numeric MCP answer')
          value = Number(value)
          if (!Number.isFinite(value) || field.type === 'integer' && !Number.isInteger(value)) throw new Error('Invalid numeric MCP answer')
        }
        if (value === undefined) throw new Error('Invalid MCP answer')
        return { action: 'accept', content: { [key]: value }, _meta: null }
      })
    })
  }
  throw new Error(`Unsupported Codex server request: ${method}`)
}
