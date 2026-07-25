import { defineConfig, devices } from '@playwright/test'

const PORT = 5299

export default defineConfig({
  testDir: './tests/smoke',
  // Default testMatch only picks up *.spec.ts / *.test.ts; our smoke test
  // is named sidepanel.smoke.ts, so it must be matched explicitly.
  testMatch: '**/*.smoke.ts',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: 'node scripts/serve-dist.mjs',
    url: `http://localhost:${PORT}/manifest.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
})
