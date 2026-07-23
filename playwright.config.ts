import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  workers: 1,
  preserveOutput: 'always',
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  webServer: {
    command: 'pnpm --filter @qagent/docs dev --hostname 127.0.0.1 --port 43119',
    url: 'http://127.0.0.1:43119/quickstart/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
