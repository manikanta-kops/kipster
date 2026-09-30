import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface LaunchConfig {
  executable: string
  codexHome: string
  dataDirectory: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy?: 'never' | 'on-request' | 'untrusted' | 'on-failure'
  environment: Record<string, string>
}
/** Only this adapter interprets its installation configuration. Paths refer to the execution host. */
export function launchConfig(value: Readonly<Record<string, unknown>> = {}, dataDirectory?: string): LaunchConfig {
  const keys = ['executable', 'codexHome', 'sandbox', 'approvalPolicy', 'environment']
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown Codex CLI configuration: ${key}`)
  if (!dataDirectory || !isAbsolute(dataDirectory)) throw new Error('Core must provide an absolute adapter data directory')
  const executable = value.executable ?? 'codex'
  if (typeof executable !== 'string' || !executable.trim() || (executable !== 'codex' && !isAbsolute(executable))) throw new Error('executable must be codex or an absolute executable path')
  const codexHome = value.codexHome ?? (process.env.CODEX_HOME || join(homedir(), '.codex'))
  if (typeof codexHome !== 'string' || !codexHome.trim() || !isAbsolute(codexHome)) throw new Error('codexHome must be an absolute path')
  const sandbox = value.sandbox as LaunchConfig['sandbox']
  if (sandbox !== undefined && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) throw new Error('Invalid Codex sandbox')
  const approvalPolicy = value.approvalPolicy as LaunchConfig['approvalPolicy']
  if (approvalPolicy !== undefined && !['never', 'on-request', 'untrusted', 'on-failure'].includes(approvalPolicy)) throw new Error('Invalid Codex approvalPolicy')
  const environment = value.environment ?? {}
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || ['HOME', 'CODEX_HOME'].includes(key))) throw new Error('environment must contain string variables other than HOME and CODEX_HOME')
  return { executable, codexHome: resolve(codexHome), dataDirectory: resolve(dataDirectory), ...(sandbox ? { sandbox } : {}), ...(approvalPolicy ? { approvalPolicy } : {}), environment: { ...environment } as Record<string, string> }
}
async function codexRoot(config: LaunchConfig): Promise<string> {
  const root = await realpath(config.codexHome)
  if (!(await stat(root)).isDirectory()) throw new Error('codexHome must be a directory')
  return root
}
/** Conversation launches preserve the user home and config, without passing Core database credentials. */
export async function conversationLaunch(config: LaunchConfig): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await codexRoot(config)
  const env: NodeJS.ProcessEnv = { HOME: homedir(), CODEX_HOME: root }
  for (const name of [...inheritedEnvironment, ...credentialEnvironment, 'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[name] !== undefined) env[name] = process.env[name]
  Object.assign(env, config.environment)
  return { root, env }
}
/** Maintenance uses the user's Codex home and login, starting in the adapter's private directory without conversation environment overrides. */
export async function maintenanceLaunch(config: LaunchConfig): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const codexHome = await codexRoot(config)
  await privateDirectory(config.dataDirectory)
  const env: NodeJS.ProcessEnv = { HOME: homedir(), CODEX_HOME: codexHome }
  for (const name of [...inheritedEnvironment, ...credentialEnvironment]) if (process.env[name] !== undefined) env[name] = process.env[name]
  return { root: config.dataDirectory, env }
}
/** Settings that keep ambient Codex configuration, account integrations and project files out of maintenance. */
export const isolationSettings: readonly (readonly [string, string])[] = [
  ['project_doc_max_bytes', '0'],
  ['project_root_markers', '[]'],
  ['skills.bundled.enabled', 'false'],
  ['skills.include_instructions', 'false'],
  ...['apps', 'plugins', 'remote_plugin', 'plugin_sharing', 'tool_suggest', 'skill_mcp_dependency_install', 'hooks', 'memories', 'multi_agent', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'daemon_auto_start'].map(feature => [`features.${feature}`, 'false'] as const),
]
const inheritedEnvironment = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']
const credentialEnvironment = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']
export function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code }
export function probe(target: number): 'present' | 'absent' | 'denied' {
  try { process.kill(target, 0); return 'present' } catch (error) { return errorCode(error) === 'ESRCH' ? 'absent' : 'denied' }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error(`Unsafe Codex data directory: ${path}`)
  await chmod(path, 0o700)
}
