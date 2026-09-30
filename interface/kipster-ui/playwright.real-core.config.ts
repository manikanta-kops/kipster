import { defineConfig } from '@playwright/test'
import { backendStorageKey } from './src/data/backend-connection.ts'

const ui = 'http://127.0.0.1:4197'
const core = process.env.KIPSTER_TEST_CORE_URL

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'durable-text.spec.ts',
    'real-voice.spec.ts',
    'management-core.spec.ts',
  ],
  workers: 1,
  timeout: 60000,
  outputDir: 'test-results/real-core',
  use: {
    baseURL: ui,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    ...(core && {
      storageState: {
        cookies: [],
        origins: [
          {
            origin: ui,
            localStorage: [{ name: backendStorageKey, value: core }],
          },
        ],
      },
    }),
  },
  projects: [
    { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
})
