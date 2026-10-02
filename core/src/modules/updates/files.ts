import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const MAX_UPDATE_FILE_BYTES = 1024 * 1024

export async function readUpdateFile(path: string): Promise<unknown | undefined> {
  let file
  try { file = await open(path, 'r') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    if (!(await file.stat()).isFile()) throw new Error('Update file must be a regular file')
    const bytes = Buffer.alloc(MAX_UPDATE_FILE_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size > MAX_UPDATE_FILE_BYTES) throw new Error('Update file exceeds 1 MiB')
    return JSON.parse(bytes.subarray(0, size).toString('utf8')) as unknown
  } finally { await file.close() }
}

export async function writeUpdateFile(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() } finally { await file.close() }
    await rename(temporary, join(directory, name))
    const parent = await open(directory, 'r')
    try { await parent.sync() } finally { await parent.close() }
  } finally { await rm(temporary, { force: true }) }
}
