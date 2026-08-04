import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'desktop-workflow.spec.ts',
  timeout: 120_000,
  workers: 1,
  outputDir: '../../test-results/desktop-workflow',
  preserveOutput: 'always',
  retries: 0,
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
