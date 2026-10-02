import { spawn } from 'node:child_process'
import { basename } from 'node:path'

export async function run(program, args, { env = process.env, cwd, timeout = 120000, input, onSpawn, gated = false, inherit = false, label = basename(program), limit = 4 * 1024 * 1024 } = {}) {
  const child = spawn(program, args, { env, cwd, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] })
  let output = '', bytes = 0, failure
  const completion = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error(`${label} could not start. Check its executable and PATH.`)))
    child.once('close', code => code === 0 && !failure ? resolve(output.trim()) : reject(failure ?? new Error(`${label} failed (exit ${code}). Check database permissions and the private host logs.`)))
  })
  // Attach rejection handling before publishing a child PID to the journal.
  void completion.catch(() => {})
  if (!inherit) {
    child.stdout.on('data', chunk => {
      bytes += chunk.length
      if (bytes > limit) { failure = new Error(`${label} output exceeded its limit.`); child.kill('SIGTERM') }
      else output += chunk
    })
    child.stderr.resume() // Commands may include private SQL/configuration: never echo stderr.
    child.stdin.on('error', () => {})
    if (!gated) child.stdin.end(input)
  }
  const timer = setTimeout(() => { failure = new Error(`${label} timed out.`); child.kill('SIGKILL') }, timeout)
  try {
    try { await onSpawn?.(child.pid) }
    catch (error) { child.kill('SIGKILL'); await completion.catch(() => {}); throw error }
    if (gated) child.stdin.end(input)
    return await completion
  }
  finally { clearTimeout(timer) }
}
