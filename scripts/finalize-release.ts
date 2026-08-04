import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const UPDATE_REPOSITORY = 'rishabhcli/QAgent';
const execFileAsync = promisify(execFile);
const BuildSchema = z.object({
  version: z.literal(3),
  appVersion: z.string().min(1),
  releaseTag: z.string().min(1).nullable(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDirty: z.boolean(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.enum(['arm64', 'x64']),
  signed: z.boolean(),
  notarized: z.boolean(),
  releaseChannel: z.enum(['stable', 'prerelease']),
  updateRepository: z.literal(UPDATE_REPOSITORY),
  updateEnabled: z.boolean(),
});
const TargetSchema = BuildSchema.omit({ version: true }).extend({
  filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  source: z.string().min(1),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ManifestSchema = z.object({
  schemaVersion: z.literal(3),
  build: BuildSchema,
  artifacts: z.array(TargetSchema).min(1),
});
const expectedTargetExtensions: ReadonlyMap<string, readonly string[]> = new Map([
  ['darwin-arm64', ['.dmg', '.zip']],
  ['darwin-x64', ['.dmg', '.zip']],
  ['win32-x64', ['.exe', '.zip']],
  ['linux-x64', ['.deb', '.rpm', '.zip']],
] as const);

const argumentsMap = parseArguments(process.argv.slice(2));
const releaseRoot = resolve(argumentsMap.get('output') ?? 'release');
const artifactsRoot = resolve(argumentsMap.get('artifacts') ?? join(releaseRoot, 'artifacts'));
const requestedTag =
  argumentsMap.get('tag')?.trim() || process.env.QAGENT_RELEASE_TAG?.trim() || null;
const manifestPaths = (await walk(artifactsRoot))
  .filter((path) => basename(path).startsWith('evidence-manifest-'))
  .sort(compareStrings);
if (manifestPaths.length === 0) throw new Error('No release evidence manifests were found');

const manifests = await Promise.all(
  manifestPaths.map(async (path) => ({
    path,
    value: ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8'))),
  }))
);
const expectedTargets = new Set(expectedTargetExtensions.keys());
const observedTargets = new Set(
  manifests.map(({ value }) => `${value.build.platform}-${value.build.arch}`)
);
for (const target of expectedTargets) {
  if (!observedTargets.has(target)) throw new Error(`Missing release target ${target}`);
}
if (observedTargets.size !== expectedTargets.size || manifests.length !== expectedTargets.size) {
  throw new Error('Release evidence contains duplicate or unsupported targets');
}

const referenceBuild = manifests[0]!.value.build;
for (const { value } of manifests) {
  for (const key of [
    'appVersion',
    'releaseTag',
    'commitSha',
    'sourceDirty',
    'releaseChannel',
    'updateRepository',
  ] as const) {
    if (value.build[key] !== referenceBuild[key]) {
      throw new Error(`Release targets disagree on ${key}`);
    }
  }
}
if (requestedTag && referenceBuild.releaseTag !== requestedTag) {
  throw new Error('Release evidence does not match the requested tag');
}
if (referenceBuild.releaseTag && referenceBuild.releaseTag !== `v${referenceBuild.appVersion}`) {
  throw new Error('Release tag does not match the application version');
}
if (referenceBuild.releaseTag && referenceBuild.sourceDirty) {
  throw new Error('Release evidence cannot identify a dirty source tree');
}
const checkoutCommitSha = await currentCommitSha();
if (checkoutCommitSha && checkoutCommitSha !== referenceBuild.commitSha) {
  throw new Error('Release evidence does not match the checked-out commit');
}

const artifacts: Array<{
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
  platform: string;
  arch: string;
}> = [];
const releaseNames = new Set<string>();
for (const { path: manifestPath, value } of manifests) {
  const target = `${value.build.platform}-${value.build.arch}`;
  const expectedExtensions = expectedTargetExtensions.get(target);
  if (!expectedExtensions) throw new Error(`Unsupported release target ${target}`);
  const observedExtensions = value.artifacts.map(({ filename }) => extname(filename).toLowerCase());
  if (
    observedExtensions.length !== expectedExtensions.length ||
    expectedExtensions.some(
      (extension) => observedExtensions.filter((value) => value === extension).length !== 1
    )
  ) {
    throw new Error(`Release target ${target} has an unexpected artifact set`);
  }

  for (const artifact of value.artifacts) {
    assertBuildMatch(value.build, artifact);
    assertTrustLabel(artifact);
    assertCanonicalFilename(artifact);
    if (releaseNames.has(artifact.filename)) {
      throw new Error(`Duplicate release asset name: ${artifact.filename}`);
    }
    releaseNames.add(artifact.filename);

    const path = join(dirname(manifestPath), artifact.filename);
    const fileStat = await stat(path);
    if (!fileStat.isFile() || fileStat.size !== artifact.bytes) {
      throw new Error(`Artifact size changed after collection: ${artifact.filename}`);
    }
    const sha256 = await sha256File(path);
    if (sha256 !== artifact.sha256) {
      throw new Error(`Artifact checksum changed after collection: ${artifact.filename}`);
    }
    artifacts.push({
      filename: artifact.filename,
      path: relative(releaseRoot, path).split(sep).join('/'),
      bytes: artifact.bytes,
      sha256,
      platform: artifact.platform,
      arch: artifact.arch,
    });
  }
}

artifacts.sort((left, right) => compareStrings(left.filename, right.filename));
await writeFile(
  join(releaseRoot, 'SHA256SUMS.txt'),
  artifacts.map(({ filename, sha256 }) => `${sha256}  ${filename}`).join('\n') + '\n',
  'utf8'
);
await writeFile(
  join(releaseRoot, 'release-evidence.json'),
  `${JSON.stringify(
    {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      appVersion: referenceBuild.appVersion,
      releaseTag: referenceBuild.releaseTag,
      commitSha: referenceBuild.commitSha,
      releaseChannel: referenceBuild.releaseChannel,
      updateRepository: referenceBuild.updateRepository,
      targets: manifests
        .map(({ value }) => value.build)
        .sort((left, right) =>
          compareStrings(`${left.platform}-${left.arch}`, `${right.platform}-${right.arch}`)
        ),
      artifacts,
    },
    null,
    2
  )}\n`,
  'utf8'
);
await writeFile(join(releaseRoot, 'RELEASE_TRUST.md'), releaseTrustNotes(manifests), 'utf8');
process.stdout.write(
  `Verified ${artifacts.length} artifacts across ${manifests.length} targets.\n`
);

function assertBuildMatch(
  build: z.infer<typeof BuildSchema>,
  artifact: z.infer<typeof TargetSchema>
): void {
  for (const key of [
    'appVersion',
    'releaseTag',
    'commitSha',
    'sourceDirty',
    'platform',
    'arch',
    'signed',
    'notarized',
    'releaseChannel',
    'updateRepository',
    'updateEnabled',
  ] as const) {
    if (build[key] !== artifact[key]) {
      throw new Error(`${artifact.filename} does not match its ${key} build metadata`);
    }
  }
}

function assertCanonicalFilename(artifact: z.infer<typeof TargetSchema>): void {
  const extension = extname(artifact.filename).toLowerCase();
  const trustMarker = !artifact.signed
    ? '-UNSIGNED'
    : artifact.platform === 'darwin' && !artifact.notarized
      ? '-UNNOTARIZED'
      : '';
  const expected = `QAgent-${artifact.appVersion}-${artifact.platform}-${artifact.arch}${trustMarker}${extension}`;
  if (artifact.filename !== expected) {
    throw new Error(`Release artifact does not use its canonical filename: ${artifact.filename}`);
  }
}

function assertTrustLabel(artifact: z.infer<typeof TargetSchema>): void {
  const unsigned = artifact.filename.includes('-UNSIGNED.');
  const unnotarized = artifact.filename.includes('-UNNOTARIZED.');
  if (!artifact.signed && (!unsigned || unnotarized)) {
    throw new Error(`Unsigned artifact is missing its exact label: ${artifact.filename}`);
  }
  if (artifact.signed && unsigned) {
    throw new Error(`Signed artifact is incorrectly labeled unsigned: ${artifact.filename}`);
  }
  if (artifact.notarized && (artifact.platform !== 'darwin' || !artifact.signed || unnotarized)) {
    throw new Error(`Artifact has invalid notarization metadata: ${artifact.filename}`);
  }
  if (artifact.platform === 'darwin' && artifact.signed && !artifact.notarized && !unnotarized) {
    throw new Error(`Unnotarized macOS artifact is missing its label: ${artifact.filename}`);
  }
  if (artifact.platform !== 'darwin' && unnotarized) {
    throw new Error(`Non-macOS artifact is incorrectly labeled unnotarized: ${artifact.filename}`);
  }
  if (
    artifact.updateEnabled &&
    (!artifact.signed ||
      artifact.releaseChannel !== 'stable' ||
      artifact.releaseTag !== `v${artifact.appVersion}` ||
      artifact.sourceDirty ||
      artifact.platform === 'win32' ||
      artifact.platform === 'linux' ||
      (artifact.platform === 'darwin' && !artifact.notarized))
  ) {
    throw new Error(`Ineligible artifact cannot enable updates: ${artifact.filename}`);
  }
}

function releaseTrustNotes(manifests: Array<{ value: z.infer<typeof ManifestSchema> }>): string {
  const unsigned = manifests
    .filter(({ value }) => !value.build.signed)
    .map(({ value }) => `${value.build.platform}-${value.build.arch}`)
    .sort(compareStrings);
  const unnotarized = manifests
    .filter(
      ({ value }) =>
        value.build.platform === 'darwin' && value.build.signed && !value.build.notarized
    )
    .map(({ value }) => `${value.build.platform}-${value.build.arch}`)
    .sort(compareStrings);
  const lines = ['## Package trust', ''];
  if (unsigned.length > 0) {
    lines.push(
      '> [!WARNING]',
      `> Unsigned testing packages: ${unsigned.join(', ')}.`,
      '> macOS Gatekeeper or Windows SmartScreen may warn or block first launch. Verify the downloaded file against `SHA256SUMS.txt`, then use the operating system security prompt or settings to approve it manually. These packages are not production-signed.',
      ''
    );
  }
  if (unnotarized.length > 0) {
    lines.push(
      '> [!WARNING]',
      `> Signed but unnotarized macOS packages: ${unnotarized.join(', ')}. Gatekeeper may still block first launch.`,
      ''
    );
  }
  if (unsigned.length === 0 && unnotarized.length === 0) {
    lines.push('All package trust properties recorded in the release evidence were verified.', '');
  }
  lines.push(
    'Verify package checksums and provenance before installation. Package labels and `release-evidence.json` are authoritative for each target.',
    ''
  );
  return `${lines.join('\n')}\n`;
}

function parseArguments(arguments_: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const argument of arguments_) {
    const separator = argument.indexOf('=');
    if (!argument.startsWith('--') || separator < 3) continue;
    parsed.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return parsed;
}

async function currentCommitSha(): Promise<string | null> {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD']).catch(() => null);
  const sha = result?.stdout.trim().toLowerCase();
  if (sha && /^[a-f0-9]{40}$/.test(sha)) return sha;
  const environmentSha = process.env.GITHUB_SHA?.toLowerCase();
  return environmentSha && /^[a-f0-9]{40}$/.test(environmentSha) ? environmentSha : null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function walk(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(candidate)));
    else if (entry.isFile() && (await stat(candidate)).size > 0) paths.push(candidate);
  }
  return paths;
}
