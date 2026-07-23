import { readFile, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/assert-clean-sarif.mjs <SARIF path>');

const files = await findSarifFiles(resolve(root));
if (files.length === 0) throw new Error(`No SARIF files were found beneath ${root}`);

const findings = [];
for (const file of files) {
  const document = JSON.parse(await readFile(file, 'utf8'));
  for (const run of document.runs ?? []) {
    for (const result of run.results ?? []) {
      const location = result.locations?.[0]?.physicalLocation;
      findings.push({
        rule: result.ruleId ?? 'unknown-rule',
        level: result.level ?? 'warning',
        message: result.message?.text ?? 'CodeQL finding',
        file: location?.artifactLocation?.uri ?? 'unknown-file',
        line: location?.region?.startLine ?? null,
      });
    }
  }
}

if (findings.length > 0) {
  console.error(`CodeQL produced ${findings.length} finding(s):`);
  for (const finding of findings) {
    const line = finding.line === null ? '' : `:${finding.line}`;
    console.error(
      `- [${finding.level}] ${finding.rule} at ${finding.file}${line}: ${finding.message}`
    );
  }
  process.exitCode = 1;
} else {
  console.log(`CodeQL SARIF is clean across ${files.length} result file(s).`);
}

async function findSarifFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await findSarifFiles(candidate)));
    else if (entry.isFile() && ['.sarif', '.json'].includes(extname(entry.name))) {
      files.push(candidate);
    }
  }
  return files;
}
