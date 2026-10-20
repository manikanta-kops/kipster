import { appendFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
let busy = false
process.on('message', (request) => {
  const mode = basename(request.path)
  appendFileSync(
    join(dirname(request.path), 'calls.jsonl'),
    JSON.stringify({ pid: process.pid, mode, busy }) + '\n',
  )
  if (busy) process.exit(7)
  busy = true
  if (mode === 'die') process.exit(8)
  if (mode === 'hold') return
  if (mode === 'malformed') {
    process.send({ what: 'wrong' })
    return
  }
  setTimeout(
    () => {
      busy = false
      process.send({
        status: 'succeeded',
        text:
          mode === 'empty'
            ? ''
            : mode === 'whitespace'
              ? ' \t\n'
              : ` ${process.pid} `,
        provider: 'transcribe-cpp',
      })
    },
    mode === 'slow' ? 100 : 0,
  )
})
