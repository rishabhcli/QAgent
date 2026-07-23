import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCredentialBackedSmoke } from '../packages/adapters/src/index.js';

const report = await runCredentialBackedSmoke();
const releaseDirectory = resolve('release');
const reportPath = resolve(releaseDirectory, 'adapter-smoke.json');
await mkdir(releaseDirectory, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.integrations.some((integration) => integration.status === 'error')) {
  process.exitCode = 1;
}
