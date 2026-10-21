import { copyFile, chmod, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { digest, privateDirectory } from '../../installer/src/files.mjs'
import {
  installFfmpeg,
  installTranscriptionRuntime,
  transcriptionRuntime,
} from '../../installer/src/transcription.mjs'
import { checkoutHome } from '../isolation.mjs'

// Startup only inspects local size. The provider checks SHA-256 before loading.
export async function transcriptionOptions(
  home,
  manifest = transcriptionRuntime,
) {
  const model = join(home, 'transcription/models', manifest.model.file)
  const info = await stat(model).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info?.isFile() || info.size !== manifest.model.size) return undefined
  const asset =
    manifest.ffmpeg?.platforms[`${process.platform}-${process.arch}`]
  const ffmpeg = join(home, 'transcription/ffmpeg/ffmpeg')
  const binary = await stat(ffmpeg).catch(() => null)
  return {
    model,
    modelSha256: manifest.model.sha256,
    ...(binary?.isFile() && binary.size === asset?.binary.size
      ? { ffmpeg }
      : {}),
  }
}

/** Explicit preparation only: startup never calls this or downloads a model. */
export async function stageTranscriptionModel(
  home,
  source,
  manifest = transcriptionRuntime,
) {
  if (!source) {
    const runtime = await installTranscriptionRuntime(home, { manifest })
    if (!runtime.available) throw Error(runtime.reason)
    return runtime.options
  }
  const models = join(home, 'transcription/models')
  await privateDirectory(join(home, 'transcription'))
  await privateDirectory(models)
  const target = join(models, manifest.model.file)
  const temporary = join(models, `.model-${randomUUID()}`)
  try {
    await copyFile(resolve(source), temporary)
    await chmod(temporary, 0o600)
    const actual = await digest(temporary)
    if (
      actual.size !== manifest.model.size ||
      actual.sha256 !== manifest.model.sha256
    )
      throw Error('Transcription model size or SHA-256 mismatch')
    await rename(temporary, target)
    const asset =
      manifest.ffmpeg?.platforms[`${process.platform}-${process.arch}`]
    const ffmpeg = asset
      ? await installFfmpeg(join(home, 'transcription'), asset)
      : undefined
    return {
      model: target,
      modelSha256: manifest.model.sha256,
      ...(ffmpeg ? { ffmpeg } : {}),
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length > 3)
    throw Error('Usage: transcription-model.mjs [source-file]')
  const root = resolve(import.meta.dirname, '../..')
  const options = await stageTranscriptionModel(
    checkoutHome(root, 'instance/home'),
    process.argv[2],
  )
  console.log(JSON.stringify({ ...options, verified: true }))
}
