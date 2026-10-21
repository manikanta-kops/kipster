import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createTranscriptionProvider } from '../dist/index.js'
import { directory, input } from './helpers.mjs'

const model =
  process.env.KIPSTER_TRANSCRIPTION_TEST_MODEL ??
  join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
    'kipster/transcription-models/parakeet-tdt_ctc-110m-Q8_0.gguf',
  )
const hasSay =
  process.platform === 'darwin' &&
  spawnSync('/usr/bin/say', ['--version'], { stdio: 'ignore' }).error ===
    undefined
const ffmpeg =
  process.env.KIPSTER_TRANSCRIPTION_TEST_FFMPEG ??
  ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(
    existsSync,
  )
const skip = !existsSync(model)
  ? 'small 110m Q8_0 model is absent; set KIPSTER_TRANSCRIPTION_TEST_MODEL'
  : !hasSay
    ? 'macOS say is unavailable'
    : false

test(
  'real 110m Q8_0 model transcribes generated 16 kHz WAV on cold and warm calls',
  { skip, timeout: 180000 },
  async (t) => {
    const provider = createTranscriptionProvider({
      model,
      modelSha256:
        '7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296',
      timeoutMs: 120000,
    })
    t.after(() => provider.close())
    assert.deepEqual(await provider.readiness(), { ready: true })
    const path = join(await directory(t), 'speech.wav')
    const say = spawnSync(
      '/usr/bin/say',
      [
        '-o',
        path,
        '--file-format=WAVE',
        '--data-format=LEI16@16000',
        'The garden is peaceful today. Please bring a glass of water.',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(say.status, 0, say.stderr)
    const size = (await stat(path)).size
    for (const phase of ['cold', 'warm']) {
      const start = performance.now()
      const result = await provider.transcribe(input(path, { size }))
      const elapsedMs = Math.round(performance.now() - start)
      t.diagnostic(
        JSON.stringify({
          phase,
          elapsedMs,
          status: result.status,
          characters: result.text?.length ?? 0,
        }),
      )
      assert.equal(result.status, 'succeeded', JSON.stringify(result))
      assert.ok(result.text.trim().length > 0)
    }
  },
)

test(
  'real 110m Q8_0 model transcribes M4A and MP4 decoded by FFmpeg',
  {
    skip:
      skip ||
      (!ffmpeg && 'FFmpeg is absent; set KIPSTER_TRANSCRIPTION_TEST_FFMPEG'),
    timeout: 180000,
  },
  async (t) => {
    const provider = createTranscriptionProvider({
      model,
      modelSha256:
        '7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296',
      ffmpeg,
      timeoutMs: 120000,
    })
    t.after(() => provider.close())
    const folder = await directory(t)
    const speech = join(folder, 'speech.aiff')
    const say = spawnSync(
      '/usr/bin/say',
      [
        '-o',
        speech,
        'The garden is peaceful today. Please bring a glass of water.',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(say.status, 0, say.stderr)
    for (const [name, mimeType, args] of [
      ['speech.m4a', 'audio/mp4', ['-c:a', 'aac']],
      [
        'speech.mp4',
        'video/mp4',
        ['-f', 'lavfi', '-i', 'color=s=64x64:r=5', '-shortest', '-c:a', 'aac'],
      ],
    ]) {
      const path = join(folder, name)
      const made = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          speech,
          ...args,
          path,
        ],
        { encoding: 'utf8' },
      )
      assert.equal(made.status, 0, made.stderr)
      const result = await provider.transcribe(
        input(path, { size: (await stat(path)).size, mimeType }),
      )
      assert.equal(result.status, 'succeeded', JSON.stringify(result))
      assert.ok(result.text.trim().length > 0)
    }
  },
)
