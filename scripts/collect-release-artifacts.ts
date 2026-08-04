import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const UPDATE_REPOSITORY = 'rishabhcli/QAgent';
const supportedExtensions = new Set(['.deb', '.dmg', '.exe', '.rpm', '.zip']);
const expectedExtensions = {
  darwin: ['.dmg', '.zip'],
  win32: ['.exe', '.zip'],
  linux: ['.deb', '.rpm', '.zip'],
} as const;
const BuildMetadataSchema = z.object({
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
const argumentsMap = parseArguments(process.argv.slice(2));
const platform = z.enum(['darwin', 'win32', 'linux']).parse(requiredArgument('platform'));
const arch = z.enum(['arm64', 'x64']).parse(requiredArgument('arch'));
const root = resolve(import.meta.dirname, '..');
const sourceRoot = join(root, 'apps/desktop/out/make');
const destination = join(root, 'release', `${platform}-${arch}`);
const metadata = BuildMetadataSchema.parse(
  JSON.parse(await readFile(join(root, 'apps/desktop/generated/build-metadata.json'), 'utf8'))
);

if (metadata.platform !== platform || metadata.arch !== arch) {
  throw new Error('Build metadata does not match the requested release target');
}
if (metadata.releaseTag && metadata.releaseTag !== `v${metadata.appVersion}`) {
  throw new Error('Build metadata release tag does not match the application version');
}
if (metadata.releaseTag && metadata.sourceDirty) {
  throw new Error('Release metadata cannot identify a dirty source tree');
}
if (metadata.notarized && (platform !== 'darwin' || !metadata.signed)) {
  throw new Error('Only a signed macOS application can be marked notarized');
}
if (platform === 'linux' && metadata.signed) {
  throw new Error('Linux package signing is not configured for this release workflow');
}
if (
  metadata.updateEnabled &&
  (!metadata.signed ||
    metadata.releaseChannel !== 'stable' ||
    metadata.releaseTag !== `v${metadata.appVersion}` ||
    (platform === 'darwin' && !metadata.notarized) ||
    platform === 'win32' ||
    platform === 'linux')
) {
  throw new Error('Build metadata enables updates for an ineligible release');
}

const sourceFiles = (await walk(sourceRoot))
  .filter((path) => supportedExtensions.has(extname(path).toLowerCase()))
  .filter((path) => belongsToTarget(path))
  .sort(compareStrings);
if (sourceFiles.length === 0) throw new Error(`No release artifacts found beneath ${sourceRoot}`);

const filesByExtension = new Map<string, string[]>();
for (const path of sourceFiles) {
  const extension = extname(path).toLowerCase();
  filesByExtension.set(extension, [...(filesByExtension.get(extension) ?? []), path]);
}
for (const extension of expectedExtensions[platform]) {
  const matching = filesByExtension.get(extension) ?? [];
  if (matching.length !== 1) {
    throw new Error(
      `Expected exactly one ${platform}/${arch} ${extension} artifact, found ${matching.length}`
    );
  }
}
if (sourceFiles.length !== expectedExtensions[platform].length) {
  throw new Error(`Found unsupported duplicate artifacts for ${platform}/${arch}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const manifest = [];
for (const source of sourceFiles) {
  const extension = extname(source).toLowerCase();
  const trustMarker = !metadata.signed
    ? '-UNSIGNED'
    : platform === 'darwin' && !metadata.notarized
      ? '-UNNOTARIZED'
      : '';
  const filename = `QAgent-${metadata.appVersion}-${platform}-${arch}${trustMarker}${extension}`;
  const target = join(destination, filename);
  await cp(source, target);
  const targetStat = await stat(target);
  manifest.push({
    filename,
    source: relative(sourceRoot, source).split(sep).join('/'),
    bytes: targetStat.size,
    sha256: await sha256File(target),
    appVersion: metadata.appVersion,
    releaseTag: metadata.releaseTag,
    commitSha: metadata.commitSha,
    sourceDirty: metadata.sourceDirty,
    platform,
    arch,
    signed: metadata.signed,
    notarized: metadata.notarized,
    releaseChannel: metadata.releaseChannel,
    updateRepository: metadata.updateRepository,
    updateEnabled: metadata.updateEnabled,
  });
}

await writeFile(
  join(destination, `evidence-manifest-${platform}-${arch}.json`),
  `${JSON.stringify({ schemaVersion: 3, build: metadata, artifacts: manifest }, null, 2)}\n`,
  'utf8'
);
process.stdout.write(`Collected ${manifest.length} ${platform}/${arch} release artifacts.\n`);

function belongsToTarget(path: string): boolean {
  const normalized = relative(sourceRoot, path).split(sep).join('/');
  const extension = extname(path).toLowerCase();
  if (extension === '.zip') return normalized.startsWith(`zip/${platform}/${arch}/`);
  if (extension === '.dmg') {
    return platform === 'darwin' && basename(path).endsWith(`-${arch}.dmg`);
  }
  if (extension === '.exe') {
    return platform === 'win32' && normalized.startsWith(`squirrel.windows/${arch}/`);
  }
  if (extension === '.deb') {
    return platform === 'linux' && normalized.startsWith(`deb/${arch}/`);
  }
  if (extension === '.rpm') {
    return platform === 'linux' && normalized.startsWith(`rpm/${arch}/`);
  }
  return false;
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

function requiredArgument(name: string): string {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
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
