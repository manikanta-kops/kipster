import { cp, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../src/', import.meta.url))
const destination = fileURLToPath(new URL('../dist/', import.meta.url))

async function copy(relative) {
  const target = path.join(destination, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await cp(path.join(source, relative), target, { recursive: true })
}

async function migrations(relative = '') {
  for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(relative, entry.name)
    if (entry.name === 'migrations') await copy(child)
    else await migrations(child)
  }
}

await migrations()
await copy('starter/playground')
