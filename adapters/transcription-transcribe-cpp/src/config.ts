import { isAbsolute } from 'node:path'

const modelSizes: Readonly<Record<string, number>> = {
  // Parakeet Ultra Q8_0 and the small 110m Q8_0 mechanics-test model.
  '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59': 740363168,
  '7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296': 135373280,
}

export interface Config {
  model: string
  modelSha256: string
  modelSize: number
  ffmpeg?: string
  timeoutMs: number
}

export function configuration(options: unknown): Config {
  const row = options as Record<string, unknown> | null
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof row.model !== 'string' ||
    !isAbsolute(row.model) ||
    row.model.includes('\0') ||
    typeof row.modelSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(row.modelSha256) ||
    (row.ffmpeg !== undefined &&
      (typeof row.ffmpeg !== 'string' ||
        !isAbsolute(row.ffmpeg) ||
        row.ffmpeg.includes('\0'))) ||
    (row.modelSize !== undefined &&
      (!Number.isSafeInteger(row.modelSize) || Number(row.modelSize) < 1)) ||
    (row.timeoutMs !== undefined &&
      (!Number.isSafeInteger(row.timeoutMs) ||
        Number(row.timeoutMs) < 1 ||
        Number(row.timeoutMs) > 600000))
  ) {
    throw new Error(
      'Invalid transcribe.cpp configuration: use absolute model and FFmpeg paths, a SHA-256 and positive integer limits',
    )
  }
  const modelSha256 = row.modelSha256.toLowerCase()
  const pinnedSize = modelSizes[modelSha256]
  const modelSize = pinnedSize ?? (row.modelSize as number | undefined)
  if (
    modelSize === undefined ||
    (pinnedSize !== undefined &&
      row.modelSize !== undefined &&
      row.modelSize !== pinnedSize)
  ) {
    throw new Error(
      'Invalid transcribe.cpp model size: supply modelSize for an unlisted SHA-256; pinned sizes cannot be changed',
    )
  }
  return {
    model: row.model,
    modelSha256,
    modelSize,
    ...(row.ffmpeg ? { ffmpeg: row.ffmpeg as string } : {}),
    timeoutMs: (row.timeoutMs as number | undefined) ?? 120000,
  }
}
