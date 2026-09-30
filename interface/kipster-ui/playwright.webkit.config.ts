import { defineConfig } from '@playwright/test'
import base from './playwright.config.ts'
export default defineConfig({
  ...base,
  use: { ...base.use, browserName: 'webkit' },
})
