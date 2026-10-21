import { randomUUID } from 'node:crypto'
import { chmod, lstat, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digest, exists, privateDirectory } from './files.mjs'
import { downloadVerified } from './embedding.mjs'
import { run } from './process.mjs'

const ffmpegRelease = 'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/'
const ffmpeg = (platform, size, sha256, binarySize, binarySha256) => {
  const name = `jellyfin-ffmpeg_8.1.3-1_portable_${platform}-gpl.tar.xz`
  return { name, url: ffmpegRelease + name, size, sha256, binary: { size: binarySize, sha256: binarySha256 } }
}

/**
 * Parakeet Ultra Q8_0 (CC-BY-4.0), pinned to the Hugging Face revision and LFS digest, and
 * Jellyfin's portable FFmpeg (GPL-3.0) for decoding other formats. Archive digests come from the
 * GitHub release; binary digests from extracting them.
 */
export const transcriptionRuntime = {
  platforms: ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'],
  ffmpeg: {
    version: '8.1.3-1',
    platforms: {
      'darwin-arm64': ffmpeg('macarm64', 32902204, '22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6', 57289880, 'f043b55df439a90743faf539ce88b723c84eb8baa0ae3323a894c87b459b85ef'),
      'darwin-x64': ffmpeg('mac64', 37952072, 'cb2b5c154d49a6b6bfe29fa6c16510e85dcbf60b805764121a167b093d4bb6fb', 78394776, '7fac408456170601ca9a68457e783e954ca87f434ae5c36f8103b599df06ed90'),
      'linux-x64': ffmpeg('linux64', 60368340, 'b86dc023c64a5a9a410e6e3a938a970460214fae78f31c1553c9f88f1c289b6a', 109525528, '79a8d05b3d26859cc5267966a5c7b711f28104c8fd4fa53db8b89e9db00106b5'),
      'linux-arm64': ffmpeg('linuxarm64', 54137808, '7bc8e8d0986f7f4693f63e9728570f671f07b6e21c05d5465dd7ce461d1631dc', 79796424, '1bc789bf624cbe8c3728a7653048d6b39fd098b4503c9abd040dbef7f952a370'),
    },
  },
  model: {
    name: 'Parakeet Ultra Q8_0',
    file: 'parakeet-ultra-Q8_0.gguf',
    url: 'https://huggingface.co/handy-computer/parakeet-ultra-gguf/resolve/a1539be1b849ea7463b88343e5277b373d0c4ea9/parakeet-ultra-Q8_0.gguf',
    size: 740363168,
    sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
  },
}
export const transcriptionPackage = '@kipster/transcription-transcribe-cpp'

const matches = (current, expected) => current?.size === expected.size && current?.sha256 === expected.sha256

/** The installed FFmpeg path when its bytes match the pin, otherwise undefined. */
export async function verifiedFfmpeg(home, asset) {
  const binary = join(resolve(home, 'transcription'), 'ffmpeg', 'ffmpeg')
  return asset && (await exists(binary)) && matches(await digest(binary), asset.binary) ? binary : undefined
}

/** Installs the pinned FFmpeg into `<root>/ffmpeg`, reusing it while its size and digest match. */
export async function installFfmpeg(root, asset) {
  const directory = join(root, 'ffmpeg'), binary = join(directory, 'ffmpeg')
  await privateDirectory(directory)
  if ((await exists(binary)) && matches(await digest(binary), asset.binary)) return binary
  const archive = join(directory, `${randomUUID()}.tar.xz`), staging = join(directory, `staging-${randomUUID()}`)
  try {
    await downloadVerified(asset.url, archive, asset)
    const unpack = (args, options) => run('tar', args, options).catch(() => {
      throw new Error('Unpacking FFmpeg needs xz. Install xz-utils, then update Kipster.')
    })
    const entries = (await unpack(['-tJf', archive])).split('\n')
    if (!entries.includes('ffmpeg')) throw new Error('The FFmpeg archive has no ffmpeg.')
    await privateDirectory(staging)
    await unpack(['-xJf', archive, '-C', staging, '--no-same-owner', 'ffmpeg'], { timeout: 300000 })
    const extracted = join(staging, 'ffmpeg')
    if (!(await lstat(extracted)).isFile() || !matches(await digest(extracted), asset.binary)) throw new Error('The extracted FFmpeg does not match its pinned SHA-256.')
    await chmod(extracted, 0o700)
    await rename(extracted, binary)
    return binary
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

/** Installs the verified model and FFmpeg privately, reusing each only while its size and digest match. */
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
  if (!matches(current, manifest.model))
    await downloadVerified(manifest.model.url, model, manifest.model)
  try {
    const ffmpeg = await installFfmpeg(root, manifest.ffmpeg.platforms[`${platform}-${arch}`])
    return { available: true, options: { model, modelSha256: manifest.model.sha256, ffmpeg } }
  } catch (error) {
    return {
      available: true,
      options: { model, modelSha256: manifest.model.sha256 },
      warning: `FFmpeg could not be installed, so only recorded voice notes can be transcribed: ${error.message}`,
    }
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
  const { ffmpeg: _ffmpeg, ...previous } = transcription?.module?.includes(`/${transcriptionPackage}/`)
    ? transcription.options
    : {}
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
    report: runtime.warning
      ? `Local transcription model ${runtime.options.model} is verified (SHA-256 ${runtime.options.modelSha256}). ${runtime.warning}`
      : `Local transcription model ${runtime.options.model} (SHA-256 ${runtime.options.modelSha256}) and FFmpeg ${runtime.options.ffmpeg} are verified.`,
  }
}
