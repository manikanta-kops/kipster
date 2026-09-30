import { createServer, request } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface HostStatus { state: 'starting' | 'running' | 'stopping'; pid: number; instance: string; installationId?: string; url?: string; adapters?: { id: string; available: boolean }[] }
export const controlDirectory = (home: string) => join(home, '.host-control')
async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Host control directory must be owned by this user with mode 0700.')
}
/** Exclusive directory creation is the startup lock. An abandoned lock is never silently removed. */
export async function ownControl(home: string, status: HostStatus, stop: () => void) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const canonical = await realpath(home)
  const directory = controlDirectory(canonical)
  try { await mkdir(directory, { mode: 0o700 }) } catch { throw new Error('Host ownership already exists. Use status/doctor; inspect an unreachable stale lock before manually removing it. No process was signalled.') }
  const token = randomUUID()
  const socket = join(directory, 'control.sock')
  if (Buffer.byteLength(socket) > 103) { await rm(directory, { recursive: true }); throw new Error('Kipster home is too long for the macOS control socket. Choose a shorter home path.') }
  const server = createServer((req, res) => {
    const supplied = req.headers.authorization
    const expected = `Bearer ${token}`
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { res.writeHead(403); res.end(); return }
    if (req.url === '/status' && req.method === 'GET') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(status)); return }
    if (req.url === '/stop' && req.method === 'POST') { stop(); res.end(JSON.stringify({ instance: status.instance, stopping: true })); return }
    res.writeHead(404); res.end()
  })
  server.requestTimeout = 2000; server.headersTimeout = 2000; server.maxHeadersCount = 10
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
    await chmod(socket, 0o600)
    await writeFile(join(directory, 'owner.json'), JSON.stringify({ token, instance: status.instance, pid: status.pid }), { mode: 0o600, flag: 'wx' })
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error }
  let closing: Promise<void> | undefined
  return { close(): Promise<void> {
    return closing ??= (async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      // A replaced ownership record belongs to somebody else, even at the same path.
      const current = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as { token?: string }
      if (current.token !== token) throw new Error('Host ownership changed; replacement was preserved.')
      await rm(directory, { recursive: true, force: true })
    })()
  } }
}
export async function control(home: string, action: 'status' | 'stop'): Promise<HostStatus | { instance: string; stopping: true } | null> {
  const directory = controlDirectory(home)
  try { await privateDirectory(directory) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  const path = join(directory, 'owner.json')
  const stat = await lstat(path).catch(() => { throw new Error('Host startup ownership is incomplete. Wait for startup or inspect the stale lock; no process was signalled.') })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024) throw new Error('Host ownership record is unsafe; no process was signalled.')
  const owner = JSON.parse(await readFile(path, 'utf8')) as { token: unknown; instance: unknown }
  if (typeof owner.token !== 'string' || typeof owner.instance !== 'string') throw new Error('Invalid host ownership record.')
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath: join(directory, 'control.sock'), path: '/' + action, method: action === 'stop' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${owner.token}` }, timeout: 3000 }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(new Error('Host control response exceeded limit.')) })
      res.on('end', () => {
        try {
          const value = JSON.parse(body) as HostStatus
          if (res.statusCode !== 200 || value.instance !== owner.instance) throw new Error('Foreign or invalid host control response; no process was signalled.')
          resolve(value)
        } catch (error) { reject(error) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('Host control timed out.')))
    req.on('error', () => reject(new Error('Host ownership is unreachable. Inspect the stale control directory and process before manual cleanup; no PID or port owner was signalled.')))
    req.end()
  })
}
