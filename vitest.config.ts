import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    conditions: ['qagent-source'],
    alias: {
      '@qagent/adapters': resolve(import.meta.dirname, 'packages/adapters/src/index.ts'),
      '@qagent/contracts': resolve(import.meta.dirname, 'packages/contracts/src/index.ts'),
      '@qagent/core': resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@qagent/storage': resolve(import.meta.dirname, 'packages/storage/src/index.ts'),
      '@qagent/mcp': resolve(import.meta.dirname, 'packages/mcp/src/index.ts'),
      '@qagent/cli': resolve(import.meta.dirname, 'packages/cli/src/index.ts'),
    },
  },
  test: {
    coverage: {
      exclude: ['**/*.d.ts', '**/dist/**', 'apps/**', 'fixtures/**'],
      include: ['packages/core/src/**', 'packages/storage/src/**', 'packages/adapters/src/**'],
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        branches: 80,
        lines: 85,
      },
    },
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
