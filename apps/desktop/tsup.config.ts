import { createRequire } from 'node:module';
import { defineConfig, type Options } from 'tsup';

const require = createRequire(import.meta.url);

const base: Options = {
  format: ['cjs'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: true,
  target: 'node24',
};

export default defineConfig([
  {
    ...base,
    entry: { 'utility-bootstrap': 'src/utility-bootstrap.ts' },
    clean: true,
  },
  {
    ...base,
    entry: { 'engine-runtime': 'src/engine-runtime.ts' },
    clean: false,
    external: ['better-sqlite3', 'weave'],
    noExternal: [/^(?!better-sqlite3$|weave$).+/],
  },
  {
    ...base,
    entry: { 'weave-runtime': 'src/weave-runtime.ts' },
    clean: false,
    esbuildOptions(options) {
      options.alias = { ...options.alias, weave: require.resolve('weave') };
    },
    external: ['@openai/agents', '@openai/agents-realtime'],
    noExternal: ['weave'],
  },
]);
