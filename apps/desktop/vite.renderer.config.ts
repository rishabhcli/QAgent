import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['qagent-source'] },
  build: { sourcemap: true },
});
