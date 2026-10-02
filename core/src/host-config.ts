import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export interface HostConfig {
  version: 1
  home: string
  databaseUrl: string
  taskDataUrl?: string
  listen: { host: '127.0.0.1' | '::1'; port: number; allowedHosts: string[]; allowedOrigins: string[] }
  adapters: { id: string; root: string; entry: string; config?: Record<string, unknown> }[]
  embedding?: { module: string; options: Record<string, unknown> }
  transcription?: { module: string; options: Record<string, unknown> }
  environment?: Record<string, string>
  executionLimit?: number
  updates?: { channelUrl?: string; managed?: boolean }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim()
const envName = (value: unknown): value is string => text(value) && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value)
const postgresURL = (value: unknown): value is string => {
  if (!text(value)) return false
  try { return ['postgres:', 'postgresql:'].includes(new URL(value).protocol) } catch { return false }
}
export function validateHostConfig(value: unknown): HostConfig {
  if (!object(value) || value.version !== 1 || !text(value.home) || !isAbsolute(value.home) || !postgresURL(value.databaseUrl) || (value.taskDataUrl !== undefined && !postgresURL(value.taskDataUrl))) throw new Error('Invalid host configuration: use version 1, an absolute home and PostgreSQL database URLs.')
  const listen = value.listen
  if (!object(listen) || !['127.0.0.1', '::1'].includes(String(listen.host)) || !Number.isInteger(listen.port) || Number(listen.port) < 1 || Number(listen.port) > 65535 || !Array.isArray(listen.allowedHosts) || !listen.allowedHosts.every(text) || !Array.isArray(listen.allowedOrigins) || !listen.allowedOrigins.every(text)) throw new Error('Configure a loopback listener, port and exact allowedHosts/allowedOrigins arrays.')
  if (!Array.isArray(value.adapters) || !value.adapters.every(item => object(item) && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(item.id) && text(item.root) && isAbsolute(item.root) && text(item.entry) && !isAbsolute(item.entry) && !item.entry.split(/[\\/]/).includes('..') && (item.config === undefined || object(item.config)))) throw new Error('Configure adapter IDs (letters, digits, - and _) with absolute installation roots and relative entries.')
  if (new Set(value.adapters.map(item => item.id)).size !== value.adapters.length) throw new Error('Adapter IDs must be unique.')
  if (value.embedding !== undefined && (!object(value.embedding) || !text(value.embedding.module) || !isAbsolute(value.embedding.module) || !object(value.embedding.options))) throw new Error('Configure an absolute embedding module and explicit options.')
  if (value.transcription !== undefined && (!object(value.transcription) || !text(value.transcription.module) || !isAbsolute(value.transcription.module) || !object(value.transcription.options))) throw new Error('Configure an absolute transcription module and explicit options.')
  if (value.environment !== undefined && (!object(value.environment) || !Object.entries(value.environment).every(([key, item]) => envName(key) && typeof item === 'string'))) throw new Error('Environment must contain explicit string values.')
  if (value.executionLimit !== undefined && (!Number.isSafeInteger(value.executionLimit) || Number(value.executionLimit) < 1 || Number(value.executionLimit) > 1000)) throw new Error('Execution limit must be between 1 and 1000.')
  if (value.updates !== undefined) {
    if (!object(value.updates) || Object.keys(value.updates).some(key => !['channelUrl', 'managed'].includes(key))) throw new Error('Invalid updates configuration: use optional channelUrl and managed.')
    if (value.updates.managed !== undefined && typeof value.updates.managed !== 'boolean') throw new Error('Invalid updates.managed: use a boolean; the default is false.')
    if (value.updates.channelUrl !== undefined) {
      if (!text(value.updates.channelUrl)) throw new Error('Invalid updates.channelUrl.')
      const url = new URL(value.updates.channelUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid updates.channelUrl: use an absolute HTTP(S) base URL without credentials, query or fragment.')
    }
  }
  return value as unknown as HostConfig
}
export async function readHostConfig(path: string): Promise<{ config: HostConfig; path: string }> {
  const absolute = await realpath(resolve(path))
  const bytes = await readFile(absolute)
  if (bytes.length > 65536) throw new Error('Host configuration exceeds 64 KiB.')
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Host configuration must be valid JSON.') }
  return { config: validateHostConfig(value), path: absolute }
}
