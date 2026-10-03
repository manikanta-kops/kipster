import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { probe } from './launch.js'

export type Message = Record<string, unknown>
/** One `claude -p` process speaking stream-json, in its own process group. */
export class ClaudeProcess {
  private stderr = ''
  private terminated = false
  private closeNotified = false
  private readonly listeners = new Set<(message: Message) => void>()
  private readonly backlog: Message[] = []
  readonly exit: Promise<void>
  readonly child: ChildProcessWithoutNullStreams
  constructor(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const child = this.child
    this.exit = new Promise(resolve => {
      child.once('exit', () => { this.terminated = true; resolve() })
      child.once('error', () => { if (child.pid === undefined) { this.terminated = true; resolve() } })
    })
    createInterface({ input: child.stdout }).on('line', line => {
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      this.emit(value as Message)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4096) })
    child.stdin.on('error', () => undefined)
    void this.exit.then(() => new Promise(resolve => setTimeout(resolve, 50))).then(() => {
      this.closeNotified = true
      this.emit({ type: 'process/exited' })
    })
  }
  get pid(): number | undefined { return this.child.pid }
  private emit(message: Message): void {
    if (!this.listeners.size) { this.backlog.push(message); return }
    for (const listener of this.listeners) listener(message)
  }
  /** Delivers earlier messages first, then each new one. */
  listen(listener: (message: Message) => void): void {
    this.listeners.add(listener)
    for (const message of this.backlog.splice(0)) listener(message)
  }
  get exited(): boolean { return this.closeNotified }
  /** A bounded tail of stderr, for example an authentication or configuration error. */
  diagnostic(): string {
    const lines = this.stderr.replace(/\u001b\[[0-9;]*m/g, '').split('\n').map(line => line.trim()).filter(Boolean)
    return lines.slice(-3).join(' | ').slice(-500)
  }
  send(message: Message): void {
    if (this.terminated || this.child.stdin.destroyed) throw new Error('Claude CLI input is closed')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  endInput(): void { if (!this.child.stdin.destroyed) this.child.stdin.end() }
  /** True once the process has exited and no process remains in its group. A group ID is not reused while the group exists. */
  get ended(): boolean { return this.terminated && (this.child.pid === undefined || probe(-this.child.pid) === 'absent') }
  get running(): boolean { return !this.terminated }
  /** Waits up to `ms` for the process to exit by itself. */
  async settle(ms: number): Promise<void> { await Promise.race([this.exit, new Promise(resolve => setTimeout(resolve, ms))]) }
  /** Terminates the process group. Returns whether the whole group is gone. */
  async stop(): Promise<boolean> {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (this.ended) break
      try { process.kill(-this.child.pid!, signal) } catch { if (!this.terminated) try { this.child.kill(signal) } catch {} }
      const deadline = Date.now() + 2000
      while (!this.ended && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    }
    return this.ended
  }
}
