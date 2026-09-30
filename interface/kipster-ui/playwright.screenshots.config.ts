import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'
export default defineConfig({
  ...base,
  testMatch: [
    'conversation-visual.spec.ts',
    'conversation-review.spec.ts',
    'media-visual.spec.ts',
  ],
  metadata: { screenshots: true },
})
