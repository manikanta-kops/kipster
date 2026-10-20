import { join, resolve } from 'node:path'
import { digest, exists, privateDirectory } from './files.mjs'
import { downloadVerified } from './embedding.mjs'

/** Parakeet Ultra Q8_0 (CC-BY-4.0), pinned to the Hugging Face revision and LFS digest. */
export const transcriptionRuntime = {
  platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'],
  model: {
    name: 'Parakeet Ultra Q8_0',
    file: 'parakeet-ultra-Q8_0.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf',
    size: 740363168,
    sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
  },
}
export const transcriptionPackage = '@kipster/transcription-transcribe-cpp'

/** Installs the verified model privately, reusing it only while its size and digest match. */
export async function installTranscriptionRuntime(
  home,
  {
    manifest = transcriptionRuntime,
    platform = process.platform,
    arch = process.arch,
  } = {},
) {
  if (!manifest?.platforms.includes(`${platform}-${arch}`))
    return {
      available: false,
      reason: `transcribe.cpp has no ${platform}-${arch} native package for Kipster's pinned runtime; local transcription is unavailable on this platform.`,
    }
  const root = resolve(home, 'transcription'),
    models = join(root, 'models')
  for (const path of [root, models]) await privateDirectory(path)
  const model = join(models, manifest.model.file)
  const current = (await exists(model)) ? await digest(model) : null
  if (
    current?.size !== manifest.model.size ||
    current?.sha256 !== manifest.model.sha256
  )
    await downloadVerified(manifest.model.url, model, manifest.model)
  return {
    available: true,
    options: { model, modelSha256: manifest.model.sha256 },
  }
}

/** Names the provider only when its channel release and verified local model are available. */
export async function withTranscription(config, home, released, install) {
  const { transcription, ...withoutTranscription } = config
  if (!released)
    return {
      config: withoutTranscription,
      report: `${transcriptionPackage} has no release on this channel yet; local transcription is unavailable.`,
    }
  const runtime = await install()
  if (!runtime.available)
    return { config: withoutTranscription, report: runtime.reason }
  const previous = transcription?.module?.includes(`/${transcriptionPackage}/`)
    ? transcription.options
    : undefined
  return {
    config: {
      ...config,
      transcription: {
        module: resolve(
          home,
          'current/node_modules',
          transcriptionPackage,
          'dist/index.js',
        ),
        options: { ...previous, ...runtime.options },
      },
    },
    report: `Local transcription model ${runtime.options.model} is verified (SHA-256 ${runtime.options.modelSha256}).`,
  }
}
