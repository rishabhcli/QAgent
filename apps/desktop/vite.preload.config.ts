import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { conditions: ['qagent-source'] },
  build: { sourcemap: true },
});
