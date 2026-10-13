import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node scripts/dev.mjs',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
