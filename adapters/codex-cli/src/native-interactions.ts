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
  result(answer: ObjectValue): ObjectValue
}
/** Translate provider interactions; Core remains responsible for saving and resolving them. */
export function nativeInteractions(context: ExecutionContext, method: string, params: ObjectValue): NativeInteraction[] {
  const substantive = Object.fromEntries(Object.entries(params).filter(([key]) => !['threadId', 'turnId', 'itemId', 'callId'].includes(key)))
  const approval = (result: (accepted: boolean) => ObjectValue): NativeInteraction => {
    const proposal = canonical({ method, ...substantive })
    const proposalId = `codex:${createHash('sha256').update(proposal).digest('hex')}`
    const saved = context.interactions?.findLast(item => item.kind === 'approval' && item.proposalId === proposalId && item.proposal === proposal)
    return { kind: 'approval', arguments: { proposalId, proposal, prompt: `Codex requests approval: ${String(params.reason ?? params.message ?? method)}\n${proposal}` }, ...(saved ? { saved: object(saved.response.answer) } : {}), result: answer => result(answer.kind === 'approve') }
  }
  const question = (prompt: string, options: { id: string; label: string }[], freeText: boolean, result: NativeInteraction['result']): NativeInteraction => {
    const saved = context.interactions?.findLast(item => item.kind === 'question' && item.prompt === prompt && canonical(item.options) === canonical(options) && item.freeText === freeText)
    return { kind: 'question', arguments: { prompt, options, freeText }, ...(saved ? { saved: object(saved.response.answer) } : {}), result }
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
    if (typeof params.command !== 'string' && !Array.isArray(params.command)) throw new Error('Codex approval omitted the command; cannot bind durable approval')
    return [approval(accepted => ({ decision: method === 'execCommandApproval' ? accepted ? 'approved' : 'denied' : accepted ? 'accept' : 'decline' }))]
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    // A grant for one diff must never authorize a regenerated, different patch.
    if (!params.changes || typeof params.changes !== 'object') throw new Error('Codex approval omitted file changes; cannot bind durable approval')
    return [approval(accepted => ({ decision: method === 'applyPatchApproval' ? accepted ? 'approved' : 'denied' : accepted ? 'accept' : 'decline' }))]
  }
  if (method === 'item/permissions/requestApproval') return [approval(accepted => ({ permissions: accepted ? object(params.permissions) : {}, scope: 'turn' }))]
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
    if (Object.keys(properties).length === 0) return [approval(accepted => ({ action: accepted ? 'accept' : 'decline', content: accepted ? {} : null, _meta: null }))]
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
