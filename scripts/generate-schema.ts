import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { qagentConfigJsonSchema } from '../packages/contracts/src/config.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = {
  $id: 'https://rishabhcli.github.io/QAgent/schema/v1.json',
  title: 'QAgent project configuration',
  description: 'Configuration contract for QAgent v0.2 projects.',
  ...qagentConfigJsonSchema(),
};
const prettierConfig = (await resolveConfig(root)) ?? {};
const serialized = await format(JSON.stringify(schema), {
  ...prettierConfig,
  parser: 'json',
});
const targets = [
  resolve(root, 'packages/contracts/schema/qagent.schema.json'),
  resolve(root, 'apps/docs/public/schema/v1.json'),
];

for (const target of targets) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized, 'utf8');
}

console.log(`Wrote QAgent configuration schema to ${targets.length} targets.`);
