import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['desktop.spec.ts', 'desktop-cockpit.spec.ts'],
  timeout: 120_000,
  workers: 1,
  preserveOutput: 'always',
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
