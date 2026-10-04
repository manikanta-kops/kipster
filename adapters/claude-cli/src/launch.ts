import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk'
export interface LaunchConfig {
  executable: string
  dataDirectory: string
  permissionMode?: PermissionMode
  environment: Record<string, string>
}
const permissionModes: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']
/** Only this adapter interprets its installation configuration. Paths refer to the execution host. */
export function launchConfig(value: Readonly<Record<string, unknown>> = {}, dataDirectory?: string): LaunchConfig {
  for (const key of Object.keys(value)) if (!['executable', 'permissionMode', 'environment'].includes(key)) throw new Error(`Unknown Claude CLI configuration: ${key}`)
  if (!dataDirectory || !isAbsolute(dataDirectory)) throw new Error('Core must provide an absolute adapter data directory')
  const executable = value.executable ?? 'claude'
  if (typeof executable !== 'string' || !executable.trim() || (executable !== 'claude' && !isAbsolute(executable))) throw new Error('executable must be claude or an absolute executable path')
  const permissionMode = value.permissionMode as PermissionMode | undefined
  if (permissionMode !== undefined && !permissionModes.includes(permissionMode)) throw new Error(`permissionMode must be one of ${permissionModes.join(', ')}`)
  const environment = value.environment ?? {}
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([key, entry]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string' || key === 'HOME')) throw new Error('environment must contain string variables other than HOME')
  return { executable, dataDirectory: resolve(dataDirectory), ...(permissionMode ? { permissionMode } : {}), environment: { ...environment } as Record<string, string> }
}
const inherited = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'AWS_PROFILE', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'CLOUD_ML_REGION', 'GOOGLE_APPLICATION_CREDENTIALS']
/** Kipster owns kip memory, so Claude Code's auto memory stays off. Passing --mcp-config makes the CLI wait for the
 * user's MCP servers before the turn starts; MCP_TIMEOUT bounds that wait for an unreachable server. */
const defaults = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MCP_TIMEOUT: '5000' }
/** A bounded environment: the user's home, shell basics, proxies, certificates and Claude authentication, without Core credentials. */
export function launchEnvironment(config: LaunchConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: homedir(), ...defaults }
  for (const name of inherited) if (process.env[name] !== undefined) env[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) if (name.startsWith('ANTHROPIC_') && value !== undefined) env[name] = value
  return Object.assign(env, config.environment)
}
export function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code }
export function probe(target: number): 'present' | 'absent' | 'denied' {
  try { process.kill(target, 0); return 'present' } catch (error) { return errorCode(error) === 'ESRCH' ? 'absent' : 'denied' }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error(`Unsafe Claude CLI data directory: ${path}`)
  await chmod(path, 0o700)
}
/** A start identity that, with the process ID, names one process and does not change when the wall clock is set.
 * Linux: boot ID plus start time in clock ticks since boot. macOS: the start time fixed at fork. Elsewhere: none. */
export async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]).catch(() => [])
    const ticks = stat?.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    return boot?.trim() && ticks && /^\d+$/.test(ticks) ? `${boot.trim()}:${ticks}` : undefined
  }
  if (process.platform !== 'darwin') return undefined
  return new Promise(resolve => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)))
}
